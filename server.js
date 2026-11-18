// 포켓카드 레이더 - 로컬 서버 (Node.js 18+, 외부 패키지 없음)
// 실행: node server.js  →  http://localhost:5178
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5178;
const PUBLIC = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = 'PokeCardRadar/1.0 (local hobby app)';
const memo = new Map();    // 메모리 캐시 {key: {t, data}}
const pending = new Map(); // 같은 요청이 동시에 들어오면 한 번만 가져옴
const crypto = require('crypto');
const diskFile = key => path.join(CACHE_DIR, 'c-' + crypto.createHash('md5').update(key).digest('hex') + '.json');

// 메모리 → 디스크 순으로 캐시 확인. 디스크에 저장해 두어 서버를 다시 켜도 빠르게 열림
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  try {
    const d = JSON.parse(fs.readFileSync(diskFile(key), 'utf8'));
    if (Date.now() - d.t < ttlMs) { memo.set(key, d); return d.data; }
  } catch {}
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const data = await fn();
    const entry = { t: Date.now(), data };
    memo.set(key, entry);
    fs.writeFile(diskFile(key), JSON.stringify(entry), () => {});
    return data;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

// 사이트에 부담을 주지 않도록: 같은 사이트에는 THROTTLE_MS(기본 0, 수집기는 1500ms) 간격으로만 요청
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastHit = {};
async function politeWait(url) {
  const gap = +process.env.THROTTLE_MS || 0;
  if (!gap) return;
  const host = new URL(url).host;
  const now = Date.now(), at = Math.max(now, (lastHit[host] || 0) + gap);
  lastHit[host] = at;
  if (at > now) await sleep(at - now);
}
class RateLimited extends Error {}
async function get(url, opts = {}, timeoutMs = 20000) {
  for (let attempt = 0; ; attempt++) {
    await politeWait(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      if (res.status === 429) { // "요청이 너무 많음" → 알려준 시간(없으면 30초·60초…)만큼 쉬고 재시도, 3번 넘으면 중단
        if (attempt >= 3) throw new RateLimited(`HTTP 429 ${url}`);
        const wait = (+res.headers.get('retry-after') || 30 * (attempt + 1)) * 1000;
        console.log(`  429 응답 → ${wait / 1000}초 쉬었다가 다시 시도`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } finally { clearTimeout(timer); }
  }
}

// ---------- Google 뉴스 RSS → JSON ----------
function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}
async function news(q) {
  return cached('news:' + q, 5 * 60 * 1000, async () => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
    const xml = await (await get(url)).text();
    const items = xml.split('<item>').slice(1).map(chunk => {
      const title = tag(chunk, 'title');
      const source = tag(chunk, 'source');
      return {
        title: source && title.endsWith(' - ' + source) ? title.slice(0, -(source.length + 3)) : title,
        link: tag(chunk, 'link'),
        date: new Date(tag(chunk, 'pubDate')).toISOString(),
        source,
      };
    });
    return items.sort((a, b) => b.date.localeCompare(a.date));
  });
}

// ---------- 포켓몬 한글 이름 → 영문 이름 사전 (PokeAPI CSV) ----------
async function names() {
  const file = path.join(CACHE_DIR, 'names-ko-en.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const csv = await (await get('https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv', {}, 60000)).text();
  const ko = {}, en = {};
  for (const line of csv.split('\n').slice(1)) {
    const [id, lang, name] = line.split(',');
    if (lang === '3') ko[id] = name;
    if (lang === '9') en[id] = name;
  }
  const map = {};
  for (const id of Object.keys(ko)) if (en[id]) map[ko[id]] = en[id];
  fs.writeFileSync(file, JSON.stringify(map));
  return map;
}

// ---------- 카드샵 (OpenStreetMap Overpass, 여러 미러 시도) ----------
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
async function shops(lat, lon, r) {
  const key = `shops:${(+lat).toFixed(3)},${(+lon).toFixed(3)},${r}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const around = `(around:${r},${lat},${lon})`;
    const q = `[out:json][timeout:25];(
      nwr${around}["shop"~"^(games|toys|collector|anime|hobby|trade)$"];
      nwr${around}["name"~"카드|포켓몬|TCG|tcg|Card|card|보드게임|트레이딩"]["shop"];
      nwr${around}["leisure"="adult_gaming_centre"]["name"~"카드|TCG"];
    );out center 200;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const res = await get(url + '?data=' + encodeURIComponent(q), {}, 12000);
        const json = await res.json();
        return json.elements.filter(e => e.tags && e.tags.name).map(e => ({
          id: e.type + '/' + e.id,
          name: e.tags.name,
          lat: e.lat ?? e.center?.lat,
          lon: e.lon ?? e.center?.lon,
          kind: e.tags.shop || e.tags.leisure || '',
          addr: [e.tags['addr:city'], e.tags['addr:district'], e.tags['addr:street'], e.tags['addr:housenumber']].filter(Boolean).join(' '),
          phone: e.tags.phone || e.tags['contact:phone'] || '',
          hours: e.tags.opening_hours || '',
          tcg: /카드|포켓몬|TCG|card/i.test(e.tags.name),
        }));
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Overpass 실패');
  });
}
async function geocode(q) {
  return cached('geo:' + q, 24 * 3600 * 1000, async () => {
    const res = await get(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=kr&accept-language=ko&q=${encodeURIComponent(q)}`);
    return (await res.json()).map(p => ({ name: p.display_name, lat: +p.lat, lon: +p.lon }));
  });
}

// ---------- 국내 시세: 포케폴리오 (MVC 네이버카페 등 국내 거래가 집계) ----------
const BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 PokeCardRadar' };
function nextFlight(html) {
  let t = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) { try { t += JSON.parse('"' + m[1] + '"'); } catch {} }
  return t;
}
const pick = (s, re) => { const m = s.match(re); return m ? m[1] : ''; };
const won = s => +String(s).replace(/[^\d]/g, '') || null;
// 한글판 공식 이미지(포켓몬코리아)만 사용. 일본 마켓(snkrdunk) 이미지는 같은 세트·번호의 한글판 공식 이미지로 변환,
// 그 외(쿠팡 등 출처 불명 사진)는 판 구분이 안 되므로 쓰지 않음.
const KR_IMG = 'https://cards.image.pokemonkorea.co.kr/data/wmimages/';
const proxied = url => `https://www.pokepolio.com/api/card-image?src=${encodeURIComponent(url)}&w=360`;
function koreanImage(encSrc) {
  if (!encSrc) return '';
  const src = decodeURIComponent(encSrc);
  if (src.startsWith(KR_IMG)) return proxied(src.split('?')[0] + '?w=512');
  const m = src.match(/pkmn-tcg-([A-Za-z]+\d*[a-zA-Z]?)-(\d+)/);
  if (m && src.includes('snkrdunk')) {
    const set = m[1], num = m[2].padStart(3, '0');
    const series = /^M/.test(set) ? 'MEGA' : /^SV/.test(set) ? 'SV' : /^SM/.test(set) ? 'SM' : /^S/.test(set) ? 'S' : null;
    if (series) return proxied(`${KR_IMG}${series}/${set}/${set}_${num}.png?w=512`);
  }
  return '';
}
// ed: '' = 한글판, 'jp' = 일본판, 'en' = 북미판
const ED_PATH = { kr: '', jp: 'jp/', en: 'en/' };
function altImage(src) {
  if (src.startsWith(KR_IMG)) return {};
  const label = /snkrdunk|limitless|pokemon-card\.com/.test(src) ? '일본판 이미지' : /pokemontcg\.io|tcgplayer/.test(src) ? '북미판 이미지' : '판매자 사진';
  return { imgAlt: proxied(src), imgAltLabel: label };
}
// 여러 페이지(1페이지당 30장)를 이어 붙임
async function pokepolio(q, ed = 'kr', pages = 1) {
  const out = [], seen = new Set();
  for (let pg = 1; pg <= pages; pg++) {
    const part = await pokepolioPage(q, ed, pg);
    part.forEach(c => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } });
    if (part.length < 30) break;
  }
  return out;
}
async function pokepolioPage(q, ed, pg) {
  const pre = ED_PATH[ed] ?? '';
  return cached(`pp:${ed}:${q}:${pg}`, 10 * 60 * 1000, () => ppLimit(async () => {
    const html = await (await get(`https://www.pokepolio.com/${pre}search?q=${encodeURIComponent(q)}${pg > 1 ? '&page=' + pg : ''}`, { headers: BROWSER_UA }, 25000)).text();
    const t = nextFlight(html);
    const seen = new Set();
    return t.split(`"href":"/${pre}cards/`).slice(1).map(seg => {
      seg = seg.slice(0, 4000);
      const id = seg.slice(0, seg.indexOf('"'));
      const ii = seg.indexOf('card-grid-info');
      if (ii < 0 || seen.has(id)) return null;
      seen.add(id);
      const src = pick(seg, /"src":"\/api\/card-image\?src=([^&"]+)/);
      const info = seg.slice(ii);
      const priceRaw = info.slice(info.indexOf('card-grid-price'), info.indexOf('card-grid-price') + 300);
      const yen = pick(priceRaw, /"(¥[\d,]+)"/);
      const usd = pick(info, /"판매가 \$","([\d,.]+)"/);
      return {
        id, ed, url: `https://www.pokepolio.com/${pre}cards/${id}`,
        name: pick(info, /"strong",null,\{"children":"([^"]*)"/) || pick(seg, /"alt":"([^"]*)"/),
        localName: pick(info, /"jp-card-name-en","children":"([^"]*)"/),
        set: pick(info, /\["\$","span",null,\{"children":"([^"]*)"\}\]/)
          || pick(info, /\["\$","span",null,\{"children":\["([^"]*)"," · ","[^"]*"\]\}\]/),
        number: pick(info, /\["\$","span",null,\{"children":\["[^"]*"," · ","([^"]*)"\]\}\]/),
        img: ed === 'kr' ? koreanImage(src) : (src ? proxied(decodeURIComponent(src)) : ''),
        // 한글판 공식 이미지가 없을 때 대신 보여줄 원본 사진 (어떤 사진인지 라벨로 표시)
        ...(ed === 'kr' && src ? altImage(decodeURIComponent(src)) : {}),
        chips: [...info.matchAll(/chip chip--[a-z-]+","children":"([^"]*)"/g)].map(m => m[1])
          .concat([...info.matchAll(/grade-badge[^"]*","style":\{[^}]*\},"children":"([^"]*)"/g)].map(m => '상태 ' + m[1])),
        price: won(pick(priceRaw, /children":\[?"([\d,]+)/)),
        orig: yen || (usd ? '$' + usd : ''),
        source: ed === 'en' ? 'TCGplayer 등 북미 시세' : pick(info, /card-grid-source","children":"([^"]*)"/) || (ed === 'jp' ? '일본 마켓' : ''),
      };
    }).filter(c => c && c.id && c.name);
  }));
}

// ---------- 국내 시세: 카드별 최저가/최고가 (같은 상태끼리, 이상치 제거) ----------
let ppActive = 0; const ppQueue = [];
async function ppLimit(fn) { // 포케폴리오에 동시 요청 6개까지만
  if (ppActive >= 6) await new Promise(r => ppQueue.push(r));
  ppActive++;
  try { return await fn(); } finally { ppActive--; ppQueue.shift()?.(); }
}
// 환율 (엔·달러 → 원), 6시간 캐시
async function fxRates() {
  return cached('fx', 6 * 3600 * 1000, async () => {
    try { const r = (await (await get('https://open.er-api.com/v6/latest/USD')).json()).rates; return { USD: r.KRW, JPY: r.KRW / r.JPY }; }
    catch { return { USD: 1400, JPY: 9 }; }
  });
}
// 카드 상세 페이지에서 판별 거래 기록 추출 → [{label, trades:[{date, price(원), n}]}]
async function ppHistory(id, ed) {
  return cached(`ppc:${ed}:${id}`, 60 * 60 * 1000, () => ppLimit(async () => {
    const html = await (await get(`https://www.pokepolio.com/${ED_PATH[ed] ?? ''}cards/${id}`, { headers: BROWSER_UA }, 25000)).text();
    const t = nextFlight(html), fx = await fxRates();
    const rarity = pick(html, /<title>[^<]*\(([A-Za-z]{1,8})\)\s*\|/);
    const number = pick(t, /\b(\d{3}\/\d{3})\b/); // 예: "130/103"
    return { rarity, number, variants: parseVariants(t, ed, fx) };
  }));
}
function parseVariants(t, ed, fx) {
    if (ed === 'kr') { // 한글판: 상태별 일자 집계 (원)
      return t.split('"className":"price-chart-variant","children":[["$","h3",null,{"children":"').slice(1).map(seg => ({
        label: seg.slice(0, seg.indexOf('"')),
        trades: [...seg.slice(0, 60000).matchAll(/"price_date":"([\d-]+)","trade_count":(\d+),"min_price":(\d+),"median_price":(\d+),"max_price":(\d+)/g)]
          .flatMap(m => [{ date: m[1], price: +m[3], n: +m[2] }, { date: m[1], price: +m[4], n: 0 }, { date: m[1], price: +m[5], n: 0 }]),
      }));
    }
    if (ed === 'jp') { // 일본판: 상태별 개별 체결가 (엔 → 원)
      return t.split('{"className":"price-chart-variant","children":').slice(1).map(seg => {
        seg = seg.slice(0, 80000);
        const trades = [...seg.matchAll(/"price":(\d+(?:\.\d+)?),"currency":"(JPY|USD|KRW)","condition":"([^"]*)"[^}]*?"observed_at":"(\d{4}-\d\d-\d\d)/g)]
          .map(m => ({ date: m[4], price: Math.round(+m[1] * (m[2] === 'JPY' ? fx.JPY : m[2] === 'USD' ? fx.USD : 1)), n: 1, cond: m[3] }));
        return { label: trades[0]?.cond || '', trades };
      }).filter(v => v.trades.length);
    }
    // 북미판: Raw 호가 중앙값 추이 (달러 → 원)
    const year = new Date().getFullYear();
    const trades = [...t.matchAll(/"title":"(\d+)월 (\d+)일: \$([\d,.]+)"/g)].map(m => {
      let d = new Date(year, +m[1] - 1, +m[2]); if (d > new Date()) d = new Date(year - 1, +m[1] - 1, +m[2]);
      return { date: d.toISOString().slice(0, 10), price: Math.round(+m[3].replace(/,/g, '') * fx.USD), n: 1 };
    });
    return trades.length ? [{ label: 'Raw (eBay 호가)', trades }] : [];
}
async function ppRange(id, cond, ed = 'kr') {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad id');
  const { variants, rarity } = await ppHistory(id, ed);
  // 등급 카드(PSA·BRG 등)와 무등급(Raw)은 섞지 않음.
  // 한글판·북미판 무등급은 Raw 계열을 모두 합쳐 표본을 늘리고, 일본판은 상태(A/B/C…)별 가격 차이가 커서 같은 상태만 사용.
  const GRADED = /PSA|BRG|BGS|CGC|ARS/;
  const norm = x => x.replace(/[\s·]|상태/g, '');
  const want = norm(cond || ''), grade = (cond.match(/상태\s*(\S+)/) || [])[1];
  let pool, label;
  if (GRADED.test(cond)) {
    const v = variants.find(x => norm(x.label) === want);
    pool = v ? v.trades : []; label = v?.label || cond;
  } else if (ed === 'jp') {
    const v = variants.find(x => x.label === (grade || 'A')) || variants.find(x => x.label === 'A') || variants.find(x => !GRADED.test(x.label));
    pool = v ? v.trades : []; label = v ? '상태 ' + v.label : '';
  } else {
    pool = variants.filter(x => !GRADED.test(x.label)).flatMap(x => x.trades); label = ed === 'en' ? 'Raw (eBay 호가)' : 'Raw';
  }
  if (!pool.length) { // 무등급 거래가 없으면 거래가 가장 많은 등급 카드 시세라도 보여줌 (라벨로 구분)
    const v = [...variants].sort((a, b) => b.trades.length - a.trades.length)[0];
    if (v?.trades.length) { pool = v.trades; label = v.label + ' (등급 카드)'; }
  }
  if (!pool.length) return { cond: label, rarity, low: null, high: null, count: 0 };
  const latest = pool.map(d => d.date).sort().at(-1);
  const daysBefore = n => new Date(new Date(latest) - n * 864e5).toISOString().slice(0, 10);
  const medianOf = arr => { const p = arr.map(d => d.price).filter(Boolean).sort((x, y) => x - y); return p[Math.floor(p.length / 2)]; };
  // 최근 30일 기준 (새 세트는 시세가 빨리 변하므로). 거래가 3건 미만이면 90일로 넓힘
  let windowDays = 30, recent = pool.filter(d => d.date > daysBefore(30));
  if (recent.reduce((n, d) => n + (d.n || 0), 0) < 3) { windowDays = 90; recent = pool.filter(d => d.date > daysBefore(90)); }
  if (!recent.length) { windowDays = 0; recent = pool; } // 90일 안에도 없으면 전체 기간
  const median = medianOf(recent);
  // 이상치 제거: 중앙값의 0.75배 ~ 1.35배 범위만 남김 (오타·특이 거래로 차이가 과하게 벌어지는 것 방지)
  const prices = recent.map(d => d.price).filter(p => p && p >= median * 0.75 && p <= median * 1.35).sort((x, y) => x - y);
  // 한 달 전 시세 (추세 비교용)
  // 비교 기간: 직전 한 달(30~60일 전) → 거래가 없으면 현재 기간 이전 최대 120일 안의 거래
  const winStart = windowDays ? daysBefore(windowDays) : null;
  let older = windowDays === 30 ? pool.filter(d => d.date <= daysBefore(30) && d.date > daysBefore(60)) : [];
  let prevLabel = '한 달 전';
  if (!older.length && winStart) { older = pool.filter(d => d.date <= winStart && d.date > daysBefore(windowDays + 120)); prevLabel = '이전'; }
  return { prevLabel,
    cond: label, rarity, median, low: prices[0], high: prices.at(-1), windowDays,
    p75: prices[Math.floor((prices.length - 1) * 0.75)] || median, // 상위 25% (상태 좋은 카드 기준)
    count: recent.reduce((n, d) => n + (d.n || 0), 0), latest,
    prev: older.length ? medianOf(older) : null,
  };
}

// ---------- 국내 시세: 포카존 거래게시판 ----------
async function pokazone(q) {
  return cached('pz:' + q, 10 * 60 * 1000, async () => {
    const html = await (await get(`https://pokazone.com/page/search.php?q=${encodeURIComponent(q)}`, { headers: BROWSER_UA }, 25000)).text();
    const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return html.split('class="trade-item ').slice(1).map(seg => ({
      url: 'https://pokazone.com' + pick(seg, /href="(\/trade\/trade_view\.php\?idx=\d+)"/),
      type: strip(pick(seg, /class="trade-type[^"]*">([\s\S]*?)<\/span>/)),
      kind: strip(pick(seg, /class="item-kind-chip[^"]*">([\s\S]*?)<\/span>/)),
      status: strip(pick(seg, /class="deal-status[^"]*">([\s\S]*?)<\/span>/)),
      img: pick(seg, /class="trade-image"\s+src="([^"]+)"/),
      title: decodeEntities(strip(pick(seg, /class="trade-title">([\s\S]*?)<\/p>/))),
      price: won(strip(pick(seg, /class="trade-price">([\s\S]*?)<\/div>/))),
      date: pick(seg, /<span>·\s*(\d{1,2}\/\d{1,2})<\/span>/),
    })).filter(x => x.title);
  });
}
async function krPrices(q) {
  const [pp, pz] = await Promise.allSettled([pokepolio(q), pokazone(q).then(r => r.length || !q.includes(' ') ? r : pokazone(q.split(' ')[0]))]);
  return {
    pokepolio: pp.status === 'fulfilled' ? pp.value : [], pokepolioError: pp.status === 'rejected' ? pp.reason.message : null,
    pokazone: pz.status === 'fulfilled' ? pz.value : [], pokazoneError: pz.status === 'rejected' ? pz.reason.message : null,
  };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// ---------- 신규 세트·상품: 포켓몬 카드 게임 공식 사이트(pokemoncard.co.kr) 제품 페이지 ----------
const PC = 'https://pokemoncard.co.kr';
async function product(n) {
  return cached('prod:' + n, 24 * 3600 * 1000, async () => {
    await politeWait(`${PC}/card/${n}`);
    const res = await fetch(`${PC}/card/${n}`, { headers: BROWSER_UA, redirect: 'manual' });
    if (res.status !== 200) return null;
    const html = await res.text();
    const name = decodeEntities(pick(html, /class="medium-title[^"]*">([^<]+)</)).trim();
    const date = pick(html, /<b>발매일<\/b>\s*([\d-]{10})/);
    if (!name || !date) return null; // 행사·공지 페이지는 제외
    const img = pick(html, /class="poster_wrap[^"]*">\s*<img src="([^"]+)"/);
    return {
      id: n, name, date, url: `${PC}/card/${n}`,
      price: won(pick(html, /<b>가격<\/b>\s*([\d,]+)원/)),
      img: img ? PC + img.replace(/&amp;/g, '&') : '',
    };
  });
}
// 카드 세트(팩·덱)인지, 굿즈(플레이매트·슬리브·덱 케이스 등)인지 구분
const productKind = name => !/플레이매트|슬리브|실드|케이스|홀더|파일|코인|데미지|마커|바인더|스토리지|굿즈|가방|파우치/.test(name)
  && /확장팩|하이클래스팩|스타터|스타트|덱|BOX|박스|컬렉션|프리미엄|트레이너|세트/i.test(name) ? 'set' : 'goods';
async function products() {
  return cached('products-v2', 3 * 3600 * 1000, async () => {
    // 최신 제품 번호 찾기 (메인·목록 페이지의 링크 중 가장 큰 번호)
    const pages = await Promise.all(['/main', '/card'].map(p => get(PC + p, { headers: BROWSER_UA }).then(r => r.text()).catch(() => '')));
    const max = Math.max(...pages.flatMap(h => [...h.matchAll(/card\/(\d+)/g)].map(m => +m[1])));
    if (!isFinite(max)) throw new Error('공식 사이트 응답 없음');
    const ids = Array.from({ length: 160 }, (_, i) => max + 5 - i); // 최근 약 160개 제품 (제품별 24시간 캐시)
    const out = [];
    for (let i = 0; i < ids.length; i += 6) out.push(...(await Promise.all(ids.slice(i, i + 6).map(n => product(n).catch(() => null)))));
    return out.filter(Boolean).map(p => ({ ...p, kind: productKind(p.name) })).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  });
}

// 세트 이름 → 공식 한글판 이미지 코드 (예: 「30th CELEBRATION」 → MEGA/M6a). 모든 세트에서 배운 걸 저장해 두고 재사용
const SETCODE_FILE = path.join(CACHE_DIR, 'setcodes.json');
let SET_CODES = {};
try { SET_CODES = JSON.parse(fs.readFileSync(SETCODE_FILE, 'utf8')); } catch {}
function learnSetCodes(list) {
  let changed = false;
  for (const c of list) {
    const m = decodeURIComponent(c.img || '').match(/wmimages\/([^/]+)\/([^/]+)\/\2_\d+\.png/);
    if (m && c.set && !SET_CODES[c.set]) { SET_CODES[c.set] = { series: m[1], code: m[2] }; changed = true; }
  }
  if (changed) fs.writeFile(SETCODE_FILE, JSON.stringify(SET_CODES), () => {});
}
// 한글판 목록에 레어도·카드 번호·공식 이미지 채우기 (시세 있는 상위 n장, all=true면 시세 없는 카드도)
async function enrichKr(list, n, all = false) {
  learnSetCodes(list);
  const top = (all ? [...list] : list.filter(c => c.price)).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, n);
  await Promise.all(top.map(async c => {
    try {
      const h = await ppHistory(c.id, 'kr');
      c.rarity = h.rarity || '';
      // 희귀도를 모르는 카드(RGB 등)는 상세 페이지의 번호가 다른 카드 것일 수 있어 이미지 생성에 쓰지 않음
      if (h.number && c.rarity && c.rarity !== 'UNKNOWN') c.number = h.number;
      // 공식 한글판 이미지가 없던 카드 → 카드 번호로 공식 이미지 경로 생성 (없으면 앱에서 원본 사진으로 대체)
      const sc = SET_CODES[c.set];
      if (!c.img && sc && c.number) c.img = proxied(`${KR_IMG}${sc.series}/${sc.code}/${sc.code}_${c.number.split('/')[0]}.png?w=512`);
    } catch (e) { if (e instanceof RateLimited) throw e; }
  }));
  return list;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.searchParams;
  try {
    if (u.pathname === '/api/news') return send(res, 200, await news(p.get('q') || '포켓몬카드'));
    if (u.pathname === '/api/kr-prices') return send(res, 200, await krPrices((p.get('q') || '').trim().slice(0, 50)));
    if (u.pathname === '/api/kr-range') return send(res, 200, await ppRange(p.get('id') || '', p.get('cond') || '', p.get('ed') || 'kr'));
    if (u.pathname === '/api/pp') {
      const ed = p.get('ed') || 'kr';
      const list = await pokepolio((p.get('q') || '').trim().slice(0, 50), ed, Math.min(+p.get('pages') || 1, 3));
      // 한글판은 검색 결과에 레어도(SAR·SR…)가 없어서 카드 페이지에서 채워 넣음 (상위 N장, 캐시 공유)
      const n = Math.min(+p.get('rarity') || 0, 90);
      if (ed === 'kr' && n) await enrichKr(list, n);
      return send(res, 200, list);
    }
    if (u.pathname === '/api/products') return send(res, 200, await products());
    if (u.pathname === '/api/names') return send(res, 200, await names());
    if (u.pathname === '/api/shops') return send(res, 200, await shops(p.get('lat'), p.get('lon'), Math.min(+p.get('r') || 3000, 15000)));
    if (u.pathname === '/api/geocode') return send(res, 200, await geocode(p.get('q') || ''));

    // 정적 파일
    let file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    console.error(u.pathname, err.message);
    send(res, 502, { error: err.message });
  }
});

// 직접 실행하면 서버 시작, 다른 스크립트(수집기)에서 불러오면 함수만 사용
if (require.main === module) server.listen(PORT, () => console.log(`포켓카드 레이더 실행 중 → http://localhost:${PORT}`));
module.exports = { RateLimited, pokepolio, enrichKr, learnSetCodes, ppRange, news, names, fxRates, products, ppHistoryRaw: id => ppHistory(id, "kr") };
