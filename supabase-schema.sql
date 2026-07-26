-- ============================================================
--  「극저온의 세계」 — 기기 간 이어쓰기(공유 코드) 스키마
--
--  왜 필요한가:
--    노트북으로 실험 기록을 쓰고, 사진은 휴대폰으로 찍는다.
--    두 기기가 같은 5자리 코드로 연결되면 한 보고서에 모인다.
--
--  보안 모델 (이 구조를 깨뜨리지 마세요):
--    · 두 테이블 모두 RLS 활성 + 정책 0개  = anon 직접 접근 전면 차단
--    · anon 에게는 아래 함수만 개방한다
--        camp_create_session(jsonb)            -> text    코드 발급
--        camp_save(text, jsonb)                -> timestamptz  기록 저장
--        camp_load(text)                       -> jsonb   기록 복원
--        camp_photo_add(text, text, text)      -> uuid    사진 1장 추가
--        camp_photo_list(text)                 -> jsonb   사진 목록(데이터 제외)
--        camp_photo_get(text, uuid)            -> text    사진 1장 내려받기
--        camp_photo_delete(text, uuid)         -> void    사진 삭제
--    · 따라서 anon 키가 공개돼도 코드를 모르면 아무것도 볼 수 없다.
--
--  개인정보:
--    이름·학교·학년·반은 이 DB에 저장하지 않는다. 기기 안에만 둔다.
--    payload 에는 답변·측정데이터·모둠명 같은 익명 정보만 담는다.
-- ============================================================

-- ---------- 1) 테이블 ----------
create table if not exists public.camp_sessions (
  id         uuid primary key default gen_random_uuid(),
  code       text        not null unique,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create table if not exists public.camp_photos (
  id         uuid primary key default gen_random_uuid(),
  code       text        not null,
  step_id    text        not null,
  data       text        not null,          -- data:image/jpeg;base64,...
  created_at timestamptz not null default now()
);

create index if not exists idx_camp_sessions_code    on public.camp_sessions (code);
create index if not exists idx_camp_sessions_expires on public.camp_sessions (expires_at);
create index if not exists idx_camp_photos_code      on public.camp_photos (code, created_at);

alter table public.camp_sessions enable row level security;
alter table public.camp_photos   enable row level security;
-- 정책을 만들지 않는다 = anon 직접 접근 불가 (함수로만 접근)

-- ---------- 2) 코드 생성기 (5자리, 헷갈리는 0 O 1 I L 제외) ----------
create or replace function public.camp_gen_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';  -- 31자
  result text := '';
  i int;
begin
  for i in 1..5 loop
    result := result || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
  end loop;
  return result;   -- 31^5 = 약 2,860만 가지
end;
$$;

-- 코드가 살아 있는지 확인하고 정규화해서 돌려준다 (내부용)
create or replace function public.camp_check(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
begin
  if not exists (select 1 from camp_sessions
                 where code = v_code and expires_at > now()) then
    raise exception '코드를 찾을 수 없거나 사용 기간이 지났습니다.';
  end if;
  return v_code;
end;
$$;

-- ---------- 3) 코드 발급 ----------
create or replace function public.camp_create_session(p_payload jsonb default '{}'::jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_try  int := 0;
begin
  if pg_column_size(p_payload) > 400000 then
    raise exception '기록이 너무 큽니다.';
  end if;

  loop
    v_try := v_try + 1;
    v_code := camp_gen_code();
    begin
      insert into camp_sessions (code, payload) values (v_code, coalesce(p_payload, '{}'::jsonb));
      return v_code;
    exception when unique_violation then
      if v_try >= 15 then
        raise exception '코드 생성에 실패했습니다. 다시 시도해 주세요.';
      end if;
    end;
  end loop;
end;
$$;

-- ---------- 4) 기록 저장 (덮어쓰기) ----------
create or replace function public.camp_save(p_code text, p_payload jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := camp_check(p_code);
  v_now  timestamptz := now();
begin
  if pg_column_size(p_payload) > 400000 then
    raise exception '기록이 너무 큽니다.';
  end if;

  update camp_sessions
     set payload = coalesce(p_payload, '{}'::jsonb),
         updated_at = v_now
   where code = v_code;

  return v_now;
end;
$$;

-- ---------- 5) 기록 복원 ----------
create or replace function public.camp_load(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := camp_check(p_code);
  r camp_sessions%rowtype;
begin
  select * into r from camp_sessions where code = v_code;
  return jsonb_build_object(
    'code',       r.code,
    'payload',    r.payload,
    'updatedAt',  r.updated_at,
    'expiresAt',  r.expires_at,
    'photoCount', (select count(*) from camp_photos where code = v_code)
  );
end;
$$;

-- ---------- 6) 사진 ----------
-- 사진 1장 추가. 용량은 약 400KB(base64 기준)까지.
create or replace function public.camp_photo_add(p_code text, p_step_id text, p_data text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := camp_check(p_code);
  v_id   uuid;
begin
  if p_data is null or length(p_data) < 32 then
    raise exception '사진 데이터가 올바르지 않습니다.';
  end if;
  if length(p_data) > 400000 then
    raise exception '사진 용량이 너무 큽니다.';
  end if;
  if (select count(*) from camp_photos where code = v_code) >= 60 then
    raise exception '사진은 한 코드당 60장까지 올릴 수 있습니다.';
  end if;

  insert into camp_photos (code, step_id, data)
  values (v_code, left(coalesce(p_step_id, 'etc'), 40), p_data)
  returning id into v_id;

  update camp_sessions set updated_at = now() where code = v_code;
  return v_id;
end;
$$;

-- 사진 목록 (데이터는 빼고 가볍게)
create or replace function public.camp_photo_list(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := camp_check(p_code);
begin
  return coalesce(
    (select jsonb_agg(jsonb_build_object('id', id, 'stepId', step_id, 'createdAt', created_at)
                      order by created_at)
       from camp_photos where code = v_code),
    '[]'::jsonb);
end;
$$;

-- 사진 1장 내려받기
create or replace function public.camp_photo_get(p_code text, p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := camp_check(p_code);
  v_data text;
begin
  select data into v_data from camp_photos where code = v_code and id = p_id;
  if v_data is null then
    raise exception '사진을 찾을 수 없습니다.';
  end if;
  return v_data;
end;
$$;

-- 사진 삭제
create or replace function public.camp_photo_delete(p_code text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := camp_check(p_code);
begin
  delete from camp_photos where code = v_code and id = p_id;
  update camp_sessions set updated_at = now() where code = v_code;
end;
$$;

-- ---------- 6-1) 코드 통째로 삭제 (학생이 "내 정보 모두 지우기") ----------
-- 실험이 끝난 학생이 스스로 지우게 해서 DB가 쌓이지 않도록 합니다.
create or replace function public.camp_delete_session(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code   text := camp_check(p_code);
  v_photos int;
begin
  delete from camp_photos where code = v_code;
  get diagnostics v_photos = row_count;

  delete from camp_sessions where code = v_code;

  return jsonb_build_object('deleted', true, 'code', v_code, 'photos', v_photos);
end;
$$;

-- ---------- 7) 만료 정리 ----------
create or replace function public.camp_cleanup()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.camp_photos
   where code in (select code from public.camp_sessions where expires_at < now());
  delete from public.camp_sessions where expires_at < now();
$$;

-- ---------- 8) 권한: 학생용 함수만 anon 에게 ----------
revoke execute on function public.camp_gen_code()        from public, anon, authenticated;
revoke execute on function public.camp_check(text)       from public, anon, authenticated;
revoke execute on function public.camp_cleanup()         from public, anon, authenticated;

grant execute on function public.camp_create_session(jsonb)          to anon, authenticated;
grant execute on function public.camp_save(text, jsonb)              to anon, authenticated;
grant execute on function public.camp_load(text)                     to anon, authenticated;
grant execute on function public.camp_photo_add(text, text, text)    to anon, authenticated;
grant execute on function public.camp_photo_list(text)               to anon, authenticated;
grant execute on function public.camp_photo_get(text, uuid)          to anon, authenticated;
grant execute on function public.camp_photo_delete(text, uuid)       to anon, authenticated;
grant execute on function public.camp_delete_session(text)           to anon, authenticated;

-- ---------- 9) (선택) 자동 정리 ----------
-- Dashboard → Database → Extensions 에서 pg_cron 활성화 후:
-- select cron.schedule('camp-cleanup', '0 4 * * *', $$ select public.camp_cleanup(); $$);
