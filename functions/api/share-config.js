/**
 * Cloudflare Pages Function — /api/share-config
 *
 * Supabase 접속 정보를 환경변수에서 읽어 브라우저로 내려줍니다.
 * 키를 저장소에 커밋하지 않기 위한 장치입니다.
 *
 * Cloudflare 대시보드 → Settings → Environment variables 에 등록:
 *   SUPABASE_URL       https://xxxxx.supabase.co
 *   SUPABASE_ANON_KEY  sb_publishable_...
 *
 * ※ 환경변수는 배포 시점에 주입됩니다. 값을 저장한 뒤 반드시 재배포해야 반영됩니다.
 * ※ 값이 없으면 {configured:false} 를 내려주고, 앱은 공유 기능만 조용히 끕니다.
 */
export function onRequestGet({ env }) {
  const url = normalizeUrl(env.SUPABASE_URL);
  const anonKey = (env.SUPABASE_ANON_KEY || '').trim();

  const body = (url && anonKey)
    ? { configured: true, url, anonKey }
    : { configured: false };

  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/** 대시보드에서 복사하면 뒤에 /rest/v1 이나 슬래시가 붙어 오는 경우가 많습니다 */
function normalizeUrl(raw) {
  return (raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '')
    .replace(/\/+$/, '');
}
