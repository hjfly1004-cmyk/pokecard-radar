// 네이버 쇼핑 검색 API 중계 서버 (Cloudflare Worker)
// - 네이버 API 키는 Worker 비밀값(NAVER_ID, NAVER_SECRET)에만 저장되고 브라우저에는 노출되지 않음
// - 같은 검색어는 10분 동안 캐시 → 네이버 하루 호출 한도(25,000회)를 아낌
// - 허용한 사이트(ALLOWED_ORIGINS)에서만 브라우저 호출 허용
const DEFAULT_ORIGINS = 'https://hjfly1004-cmyk.github.io,http://localhost:5178,http://localhost:5179';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (origin && !allowed.includes(origin)) return new Response('forbidden', { status: 403, headers: cors });
    if (url.pathname === '/') return new Response('ok', { headers: cors });
    if (url.pathname !== '/shop' || req.method !== 'GET') return new Response('not found', { status: 404, headers: cors });
    if (!env.NAVER_ID || !env.NAVER_SECRET) return json({ error: 'NAVER_ID / NAVER_SECRET 비밀값이 설정되지 않았어요' }, 500, cors);

    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (!q) return json({ error: 'q가 필요해요' }, 400, cors);
    const sort = ['sim', 'date', 'asc', 'dsc'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'sim';
    const start = Math.min(Math.max(parseInt(url.searchParams.get('start')) || 1, 1), 1000);

    const cacheKey = new Request(`https://naver-cache.local/shop?q=${encodeURIComponent(q)}&sort=${sort}&start=${start}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, cors);

    const api = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=100&start=${start}&sort=${sort}&exclude=used:rental`;
    const r = await fetch(api, { headers: { 'X-Naver-Client-Id': env.NAVER_ID, 'X-Naver-Client-Secret': env.NAVER_SECRET } });
    const body = await r.text();
    const res = new Response(body, {
      status: r.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': r.ok ? 'public, max-age=600' : 'no-store' },
    });
    if (r.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return withCors(res, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
}
function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}
