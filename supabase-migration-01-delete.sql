-- ============================================================
--  추가 마이그레이션 01 — 「내 정보 모두 지우기」용 삭제 함수
--
--  이미 supabase-schema.sql 을 실행한 프로젝트에 이것만 더 실행하세요.
--  (Supabase 대시보드 → SQL Editor 에 붙여넣고 Run)
--
--  하는 일: 코드 하나에 딸린 사진과 기록을 서버에서 완전히 지웁니다.
--          학생이 실험을 마치고 스스로 지우게 해서 DB가 쌓이지 않게 합니다.
-- ============================================================

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

grant execute on function public.camp_delete_session(text) to anon, authenticated;
