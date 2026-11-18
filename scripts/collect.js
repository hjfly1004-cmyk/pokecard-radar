// 포켓카드 레이더 — 정적 웹사이트(GitHub Pages)용 데이터 수집기
// 실행: node scripts/collect.js   (결과: site/ 폴더 = public/ 복사본 + site/data/*.json)
// 사이트에 부담을 주지 않도록 한 번에 BATCH개(기본 8) 세트만 새로 모으고, 나머지는 이전 결과(cache/store)를 그대로 씀
// 환경변수: BATCH=8, THROTTLE_MS=1500 (같은 사이트에 보내는 요청 사이 간격)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
if (!process.env.THROTTLE_MS) process.env.THROTTLE_MS = '1500';

const S = require('../server.js');
const { HIT_SETS, EN_SET, EVENT_Q } = require('../public/shared.js');

const OUT = path.join(ROOT, 'site');
const DATA = path.join(OUT, 'data');
const STORE = path.join(ROOT, 'cache', 'store'); // GitHub Actions 캐시로 다음 실행까지 보관
const BATCH = +process.env.BATCH || 8;
const BALL_SETS = /151|테라스탈페스타/;
const norm = s => (s || '').replace(/\s/g, '').toLowerCase();
const condOf = c => (c.chips || []).filter(x => /^(Raw|PSA|BGS|CGC|상태)/.test(x)).join(' · ');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const slug = q => crypto.createHash('md5').update(q).digest('hex').slice(0, 12);
const readStore = name => { try { return JSON.parse(fs.readFileSync(path.join(STORE, name), 'utf8')); } catch { return null; } };
const writeStore = (name, obj) => {
  const f = path.join(STORE, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
};

// 동시에 n개씩 처리 (요청 제한에 걸리면 바로 멈춤)
async function mapLimit(items, n, fn) {
  let i = 0, stop = null;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && !stop) {
      const k = i++;
      try { await fn(items[k]); } catch (e) { if (e instanceof S.RateLimited) stop = e; }
    }
  }));
  if (stop) throw stop;
}

// 앱(public/app.js)의 힛카드 처리와 같은 규칙: 같은 세트만, 고유 ID 기준, 시세 상위 30장 + 시세 없는 카드 12장(RGB 우선)
function hitsProcess(list, key, ed, isBall) {
  const inSet = ed === 'en' || isBall ? [] : list.filter(c => norm(c.set).includes(key));
  const best = new Map();
  (inSet.length ? inSet : list).forEach(c => { if (!best.has(c.id) || (best.get(c.id).price || 0) < (c.price || 0)) best.set(c.id, c); });
  const all = [...best.values()].sort((a, b) => (b.price || 0) - (a.price || 0));
  const isRgb = c => c.rarity === 'RGB' || c.rarity === 'UNKNOWN';
  return [...all.filter(c => c.price).slice(0, 30), ...all.filter(c => !c.price).sort((x, y) => isRgb(y) - isRgb(x)).slice(0, 12)];
}

// 최저·최고가 계산: 한글판은 등급 확인 때 받은 페이지를 재사용(추가 요청 없음), 일본판·북미판은 시세 상위 15장만
async function addRanges(list, ed) {
  const targets = ed === 'kr' ? list.filter(c => c.price) : list.filter(c => c.price).slice(0, 15);
  await mapLimit(targets, 3, async c => { c.range = await S.ppRange(c.id, condOf(c), ed); });
}

async function collectSet(s, balls, ballOf, rgb) {
  const key = norm(s.q);
  const isBall = !!balls[s.q];
  const out = { kr: [], jp: [], en: [] };

  // 한글판
  let kr = isBall ? balls[s.q].slice() : await S.pokepolio(s.q, 'kr', 3);
  if (!isBall) {
    kr = kr.concat(rgb.kr.filter(c => norm(c.set).includes(key) && !kr.some(x => x.id === c.id)).map(c => ({ ...c, rarity: 'RGB' })));
    kr = kr.concat([...balls.마스터볼, ...balls.몬스터볼].filter(c => norm(c.set).includes(key) && !kr.some(x => x.id === c.id)));
  }
  kr = hitsProcess(kr.map(c => ({ ...c })), key, 'kr', isBall);
  await S.enrichKr(kr, 42); // 시세 있는 카드만 상세 페이지 확인 (등급·번호·공식 이미지)
  kr.forEach(c => { if (ballOf[c.id]) c.ball = ballOf[c.id]; if (c.rarity === 'UNKNOWN') c.rarity = 'RGB'; });
  await addRanges(kr, 'kr');
  out.kr = kr;
  if (isBall) return out;

  // 일본판
  let jp = await S.pokepolio(s.q, 'jp', 3);
  jp = jp.concat(rgb.jp.filter(c => norm(c.set).includes(key) && !jp.some(x => x.id === c.id)));
  jp = hitsProcess(jp.map(c => ({ ...c })), key, 'jp', false);
  await addRanges(jp, 'jp');
  out.jp = jp;

  // 북미판: 세트 이름이 달라서 같은 힛카드 이름으로 검색 → 같은 북미 세트만
  const names = [...new Set([...kr, ...jp].sort((a, b) => (b.price || 0) - (a.price || 0)).map(c => c.name))].slice(0, 6);
  let en = [];
  for (const n of names) en = en.concat((await S.pokepolio(n, 'en', 1)).filter(c => c.name === n));
  let codes = EN_SET[s.q];
  if (!codes) {
    const cnt = {};
    for (const n of names) new Set(en.filter(c => c.name === n).map(c => c.set)).forEach(code => { cnt[code] = (cnt[code] || 0) + 1; });
    const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    codes = best && best[1] >= 2 ? [best[0]] : [];
  }
  en = hitsProcess(en.filter(c => codes.includes(c.set)).map(c => ({ ...c })), key, 'en', false);
  await addRanges(en, 'en');
  out.en = en;
  return out;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'hits'), { recursive: true });
  const write = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));
  let limited = false;

  // 1) 기본 데이터: 이름 사전, 공식 신규 제품, 뉴스 (실패하면 이전 것 사용)
  log('이름 사전 · 신규 제품 · 뉴스');
  const keep = async (name, fn) => {
    try { const v = await fn(); writeStore(name, v); return v; }
    catch (e) { log('  ' + name + ' 실패, 이전 데이터 사용:', e.message); return readStore(name); }
  };
  write('names.json', (await keep('names.json', () => S.names())) || {});
  write('products.json', (await keep('products.json', () => S.products())) || []);
  write('news.json', (await keep('news.json', async () => {
    const n = {};
    for (const q of Object.values(EVENT_Q)) n[q] = await S.news(q);
    return n;
  })) || {});

  // 2) 마스터볼·몬스터볼 미러 (하루에 한 번만 새로)
  let ballStore = readStore('balls.json');
  if (!ballStore || Date.now() - ballStore.t > 24 * 3600e3) {
    log('마스터볼·몬스터볼 미러');
    try {
      const b = {};
      for (const ball of ['마스터볼', '몬스터볼']) b[ball] = (await S.pokepolio(ball, 'kr', 3)).filter(c => BALL_SETS.test(norm(c.set)));
      ballStore = { t: Date.now(), data: b };
      writeStore('balls.json', ballStore);
    } catch (e) { log('  실패:', e.message); limited = e instanceof S.RateLimited; }
  }
  const balls = ballStore?.data || { 마스터볼: [], 몬스터볼: [] };
  const ballOf = {};
  for (const [b, l] of Object.entries(balls)) l.forEach(c => { ballOf[c.id] = b; });

  // RGB 카드 (세트명 검색에 잘 안 잡힘)
  const rgb = readStore('rgb.json') || { kr: [], jp: [] };
  if (!limited) {
    try { for (const ed of ['kr', 'jp']) rgb[ed] = await S.pokepolio('RGB', ed, 1); writeStore('rgb.json', rgb); }
    catch (e) { limited = e instanceof S.RateLimited; }
  }

  // 3) 이번에 새로 모을 세트: 한 번도 안 모았거나 가장 오래된 순서로 BATCH개
  const order = HIT_SETS.map(s => ({ s, t: readStore('hits/' + slug(s.q) + '.json')?.t || 0 })).sort((a, b) => a.t - b.t);
  let done = 0;
  for (const { s } of order.slice(0, BATCH)) {
    if (limited) break;
    log(`${s.label} 수집`);
    try {
      const out = await collectSet(s, balls, ballOf, rgb);
      writeStore('hits/' + slug(s.q) + '.json', { t: Date.now(), data: out });
      done++;
      log(`  한글판 ${out.kr.length} · 일본판 ${out.jp.length} · 북미판 ${out.en.length}`);
    } catch (e) {
      log('  실패:', e.message);
      if (e instanceof S.RateLimited) { limited = true; log('  요청 제한에 걸려 이번 수집은 여기서 멈춤 (다음 실행 때 이어서)'); }
    }
  }

  // 4) 보관된 결과 전체로 사이트 데이터 만들기
  const index = new Map();
  let ready = 0;
  HIT_SETS.forEach((s, i) => {
    const st = readStore('hits/' + slug(s.q) + '.json');
    if (st) {
      ready++;
      write(`hits/${i}.json`, { ...st.data, updated: st.t });
      for (const ed of ['kr', 'jp', 'en']) (st.data[ed] || []).forEach(c => index.set(c.ed + ':' + c.id, c));
    } else {
      write(`hits/${i}.json`, { pending: true, kr: [], jp: [], en: [] });
    }
  });
  for (const l of Object.values(balls)) for (const c of l) if (!index.has('kr:' + c.id)) index.set('kr:' + c.id, { ...c, ball: ballOf[c.id] });
  write('balls.json', Object.fromEntries(Object.entries(balls).map(([b, l]) => [b, l.map(c => index.get('kr:' + c.id) || c)])));
  write('index.json', [...index.values()]);
  write('meta.json', { updated: new Date().toISOString(), ready, total: HIT_SETS.length, cards: index.size });
  log(`이번에 ${done}개 세트 갱신 · 전체 ${ready}/${HIT_SETS.length}개 세트 준비됨 · 카드 ${index.size}장`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
