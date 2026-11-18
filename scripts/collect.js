// 포켓카드 레이더 — 정적 웹사이트(GitHub Pages)용 데이터 수집기
// 실행: node scripts/collect.js   (결과: site/ 폴더 = public/ 복사본 + site/data/*.json)
// 환경변수 LIMIT=3 → 앞의 3개 세트만 (빠른 테스트용)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const S = require('../server.js');
const { HIT_SETS, EN_SET, EVENT_Q } = require('../public/shared.js');

const OUT = path.join(ROOT, 'site');
const DATA = path.join(OUT, 'data');
const LIMIT = +process.env.LIMIT || HIT_SETS.length;
const BALL_SETS = /151|테라스탈페스타/;
const norm = s => (s || '').replace(/\s/g, '').toLowerCase();
const condOf = c => (c.chips || []).filter(x => /^(Raw|PSA|BGS|CGC|상태)/.test(x)).join(' · ');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 동시에 n개씩 처리
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } }));
  return out;
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

async function addRanges(list, ed) {
  await mapLimit(list.filter(c => c.price || ed === 'kr'), 6, async c => {
    try { c.range = await S.ppRange(c.id, condOf(c), ed); } catch {}
  });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'hits'), { recursive: true });
  const write = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));

  // 1) 기본 데이터: 이름 사전, 공식 신규 제품, 뉴스
  log('이름 사전 · 신규 제품 · 뉴스');
  write('names.json', await S.names());
  write('products.json', await S.products().catch(() => []));
  const news = {};
  for (const q of Object.values(EVENT_Q)) news[q] = await S.news(q).catch(() => []);
  write('news.json', news);

  // 2) 마스터볼·몬스터볼 미러 (151 · 테라스탈 페스타)
  log('마스터볼·몬스터볼 미러');
  const balls = {};
  for (const ball of ['마스터볼', '몬스터볼']) {
    balls[ball] = (await S.pokepolio(ball, 'kr', 3)).filter(c => BALL_SETS.test(norm(c.set)));
  }
  const ballOf = {}; for (const [b, l] of Object.entries(balls)) l.forEach(c => ballOf[c.id] = b);

  // RGB 카드(세트명 검색에 잘 안 잡힘)
  const rgb = {};
  for (const ed of ['kr', 'jp', 'en']) rgb[ed] = await S.pokepolio('RGB', ed, 1).catch(() => []);

  // 3) 세트별 힛카드 (한글판·일본판·북미판)
  const index = new Map(); // 검색용: 모든 카드
  const addIndex = list => list.forEach(c => index.set(c.ed + ':' + c.id, c));
  for (let i = 0; i < Math.min(LIMIT, HIT_SETS.length); i++) {
    const s = HIT_SETS[i];
    const key = norm(s.q);
    const isBall = !!balls[s.q];
    log(`[${i + 1}/${HIT_SETS.length}] ${s.label}`);
    const out = { kr: [], jp: [], en: [] };
    try {
      // 한글판
      let kr = isBall ? balls[s.q].slice() : await S.pokepolio(s.q, 'kr', 3);
      if (!isBall) {
        kr = kr.concat(rgb.kr.filter(c => norm(c.set).includes(key) && !kr.some(x => x.id === c.id)).map(c => ({ ...c, rarity: 'RGB' })));
        kr = kr.concat([...balls.마스터볼, ...balls.몬스터볼].filter(c => norm(c.set).includes(key) && !kr.some(x => x.id === c.id)));
      }
      kr = hitsProcess(kr.map(c => ({ ...c })), key, 'kr', isBall);
      await S.enrichKr(kr, kr.length, true);
      kr.forEach(c => { if (ballOf[c.id]) c.ball = ballOf[c.id]; if (c.rarity === 'UNKNOWN') c.rarity = 'RGB'; });
      await addRanges(kr, 'kr');
      out.kr = kr;

      if (!isBall) {
        // 일본판
        let jp = await S.pokepolio(s.q, 'jp', 3);
        jp = jp.concat(rgb.jp.filter(c => norm(c.set).includes(key) && !jp.some(x => x.id === c.id)));
        jp = hitsProcess(jp.map(c => ({ ...c })), key, 'jp', false);
        await addRanges(jp, 'jp');
        out.jp = jp;

        // 북미판: 세트 이름이 달라서 같은 힛카드 이름으로 검색 → 같은 북미 세트만
        const names = [...new Set([...kr, ...jp].sort((a, b) => (b.price || 0) - (a.price || 0)).map(c => c.name))].slice(0, 10);
        let en = (await Promise.all(names.map(n => S.pokepolio(n, 'en', 1).then(a => a.filter(c => c.name === n)).catch(() => [])))).flat();
        let codes = EN_SET[s.q];
        if (!codes) {
          const cnt = {};
          for (const n of names) new Set(en.filter(c => c.name === n).map(c => c.set)).forEach(code => cnt[code] = (cnt[code] || 0) + 1);
          const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
          codes = best && best[1] >= 2 ? [best[0]] : [];
        }
        en = hitsProcess(en.filter(c => codes.includes(c.set)).map(c => ({ ...c })), key, 'en', false);
        await addRanges(en, 'en');
        out.en = en;
      }
    } catch (e) { log('  실패:', e.message); }
    write(`hits/${i}.json`, out);
    addIndex(out.kr); addIndex(out.jp); addIndex(out.en);
    log(`  한글판 ${out.kr.length} · 일본판 ${out.jp.length} · 북미판 ${out.en.length}`);
  }

  // 미러 카드도 검색·관심 카드용 색인에 포함
  for (const l of Object.values(balls)) for (const c of l) if (!index.has('kr:' + c.id)) index.set('kr:' + c.id, { ...c, ball: ballOf[c.id] });
  write('balls.json', Object.fromEntries(Object.entries(balls).map(([b, l]) => [b, l.map(c => index.get('kr:' + c.id) || c)])));
  write('index.json', [...index.values()]);
  write('meta.json', { updated: new Date().toISOString(), sets: Math.min(LIMIT, HIT_SETS.length), cards: index.size });
  log(`완료: 카드 ${index.size}장 → ${path.relative(ROOT, DATA)}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
