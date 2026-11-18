/* 포켓카드 레이더 — 시세 / 이벤트 / 신규카드 / 카드샵 */
const TCG = 'https://api.tcgdex.net/v2/en';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKRW = n => n == null ? '-' : '₩' + Math.round(n).toLocaleString('ko-KR');
const ago = iso => { const m = (Date.now() - new Date(iso)) / 60000; return m < 60 ? `${Math.max(1, m | 0)}분 전` : m < 1440 ? `${(m / 60) | 0}시간 전` : `${(m / 1440) | 0}일 전`; };

// ---------- 저장소 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('pcr:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pcr:' + k, JSON.stringify(v)); } catch {} },
};
const settings = Object.assign({ events: true, newCards: true, price: true, pct: 5, interval: 10, basis: 'median' }, store.get('settings', {}));
let watch = store.get('watch', []);           // [{id,name,img,set,last,history:[{t,v}]}]
const known = { events: new Set(store.get('knownEvents', [])), kr: new Set(store.get('knownKr', [])), sets: new Set(store.get('knownSets', [])) };
const viewed = { events: new Set(store.get('viewedEvents', [])), new: new Set(store.get('viewedNew', [])) };
const saveKnown = () => { store.set('knownEvents', [...known.events].slice(-500)); store.set('knownKr', [...known.kr].slice(-300)); store.set('knownSets', [...known.sets]); };
const saveViewed = () => { store.set('viewedEvents', [...viewed.events].slice(-500)); store.set('viewedNew', [...viewed.new].slice(-300)); };

async function json(url) {
  if (STATIC && url.startsWith('/api/')) return staticApi(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ---------- 정적 모드 (GitHub Pages) ----------
// 서버 없이 GitHub Actions가 미리 모아 둔 data/*.json 파일로 같은 기능을 제공
let STATIC = false;
const SD = {};
const sdata = name => (SD[name] ??= fetch('data/' + name).then(r => (r.ok ? r.json() : null)).catch(() => null));
const normQ = s => (s || '').replace(/\s/g, '').toLowerCase();
async function staticApi(url) {
  const u = new URL(url, location.href), p = u.searchParams, ep = u.pathname.split('/api/')[1];
  const q = p.get('q') || '', ed = p.get('ed') || 'kr';
  if (ep === 'names') return (await sdata('names.json')) || {};
  if (ep === 'products') return (await sdata('products.json')) || [];
  if (ep === 'news') return ((await sdata('news.json')) || {})[q] || [];
  if (ep === 'kr-prices') return { pokepolio: [], pokazone: [] };
  if (ep === 'pp') {
    const balls = (await sdata('balls.json')) || {};
    if (balls[q]) return ed === 'kr' ? balls[q] : [];
    if (q === 'RGB') return [];
    const k = normQ(q), idx = (await sdata('index.json')) || [];
    return idx.filter(c => c.ed === ed && (normQ(c.name).includes(k) || normQ(c.localName).includes(k) || normQ(c.set).includes(k)));
  }
  if (ep === 'kr-range') {
    const idx = (await sdata('index.json')) || [];
    const c = idx.find(x => x.id === p.get('id') && x.ed === ed);
    return c?.range || { low: null, high: null, count: 0 };
  }
  if (ep === 'geocode') { // 브라우저에서 바로 OpenStreetMap 검색
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=kr&accept-language=ko&q=${encodeURIComponent(q)}`);
    return (await r.json()).map(x => ({ name: x.display_name, lat: +x.lat, lon: +x.lon }));
  }
  if (ep === 'shops') {
    const around = `(around:${Math.min(+p.get('r') || 3000, 15000)},${p.get('lat')},${p.get('lon')})`;
    const oq = `[out:json][timeout:25];(nwr${around}["shop"~"^(games|toys|collector|anime|hobby|trade)$"];nwr${around}["name"~"카드|포켓몬|TCG|tcg|Card|card|보드게임|트레이딩"]["shop"];);out center 200;`;
    const r = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(oq));
    if (!r.ok) throw new Error('overpass');
    return (await r.json()).elements.filter(e => e.tags?.name).map(e => ({
      id: e.type + '/' + e.id, name: e.tags.name, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
      kind: e.tags.shop || '', addr: [e.tags['addr:city'], e.tags['addr:district'], e.tags['addr:street'], e.tags['addr:housenumber']].filter(Boolean).join(' '),
      phone: e.tags.phone || e.tags['contact:phone'] || '', hours: e.tags.opening_hours || '', tcg: /카드|포켓몬|TCG|card/i.test(e.tags.name),
    }));
  }
  throw new Error('정적 모드에서 지원하지 않는 요청: ' + ep);
}

// ---------- 환율 ----------
let fx = { USD: 1400, EUR: 1500, at: null };
async function loadFx() {
  try {
    const d = await json('https://open.er-api.com/v6/latest/USD');
    fx = { USD: d.rates.KRW, EUR: d.rates.KRW / d.rates.EUR, at: d.time_last_update_utc };
    $('#priceHint').textContent = `TCGplayer(미국)·Cardmarket(유럽) 원화 환산 · 환율 $1=₩${Math.round(fx.USD).toLocaleString()} / €1=₩${Math.round(fx.EUR).toLocaleString()}`;
  } catch {}
}

// ---------- 한글 ↔ 영문 이름 ----------
let ko2en = {}, en2ko = {}, enNamesByLen = [];
const SUFFIX = { '메가': 'Mega', '알로라': 'Alolan', '가라르': 'Galarian', '히스이': 'Hisuian', '팔데아': 'Paldean', '다크': 'Dark', '빛나는': 'Radiant' };
async function loadNames() {
  try {
    ko2en = await json('/api/names');
    for (const [k, v] of Object.entries(ko2en)) en2ko[v] = k;
    enNamesByLen = Object.keys(en2ko).sort((a, b) => b.length - a.length);
  } catch {}
}
function toEnglish(q) {
  return q.trim().split(/\s+/).map(tok => {
    if (!/[가-힣]/.test(tok)) return tok;
    if (ko2en[tok]) return ko2en[tok];
    if (SUFFIX[tok]) return SUFFIX[tok];
    for (const [k, v] of Object.entries(SUFFIX)) if (tok.startsWith(k) && ko2en[tok.slice(k.length)]) return v + ' ' + ko2en[tok.slice(k.length)];
    // 리자몽ex 처럼 붙여 쓴 경우
    for (let i = tok.length - 1; i > 0; i--) if (ko2en[tok.slice(0, i)]) return ko2en[tok.slice(0, i)] + ' ' + tok.slice(i);
    return tok;
  }).join(' ');
}
function toKorean(name) {
  const hit = enNamesByLen.find(n => name === n || name.startsWith(n + ' ') || name.includes(' ' + n + ' ') || name.endsWith(' ' + n) || name.includes(n + "'s"));
  return hit ? name.replace(hit, en2ko[hit]) : null;
}

// ---------- 세트 정보(발매일 순위) ----------
let setRank = {}, setsSorted = [];
async function loadSets() {
  setsSorted = await json(`${TCG}/sets?sort:field=releaseDate&sort:order=DESC`);
  setsSorted.forEach((s, i) => setRank[s.id] = i);
}

// ---------- 가격 계산 ----------
function priceOf(card) {
  const p = card.pricing || {};
  let usd = null, eur = null;
  if (p.tcgplayer) for (const [k, v] of Object.entries(p.tcgplayer)) {
    if (v && typeof v === 'object') { const m = v.marketPrice ?? v.midPrice; if (m != null && (usd == null || m > usd)) usd = m; }
  }
  if (p.cardmarket) { const c = p.cardmarket; eur = Math.max(c.trend ?? 0, c['trend-holo'] ?? 0, c.avg ?? 0) || null; }
  const krw = usd != null ? usd * fx.USD : eur != null ? eur * fx.EUR : null;
  return { usd, eur, krw, src: usd != null ? 'TCGplayer' : eur != null ? 'Cardmarket' : null };
}
// TCGdex 이미지가 아직 없는 신규 카드는 Scrydex 이미지로 대체 (세트 id: me06 → me6, sv03.5 → sv3pt5)
const scrydexId = c => {
  const setId = c.set?.id || c.id.split('-').slice(0, -1).join('-');
  const num = String(c.localId || c.id.split('-').at(-1)).replace(/^0+(?=\d)/, '');
  return `${setId.replace(/^([a-z]+)0+(\d)/i, '$1$2').replace('.5', 'pt5')}-${num}`;
};
const imgUrl = (c, q = 'low') => c.image ? `${c.image}/${q}.webp` : `https://images.scrydex.com/pokemon/${scrydexId(c)}/${q === 'high' ? 'large' : 'medium'}`;
const isPocket = c => (c.image || '').includes('/tcgp/') || /^(A\d|P-A|B\d)/.test(c.id);

// ---------- 카드 렌더 ----------
function cardTile(c, opts = {}) {
  const pr = c.pricing ? priceOf(c) : null;
  const ko = toKorean(c.name);
  const w = watch.find(x => x.id === c.id);
  let delta = '';
  if (w && w.history?.length > 1) {
    const a = w.history[w.history.length - 2].v, b = w.history[w.history.length - 1].v;
    if (a && b && a !== b) { const pct = (b - a) / a * 100; delta = `<span class="delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(1)}%</span>`; }
  }
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <img loading="lazy" src="${esc(imgUrl(c))}" alt="${esc(c.name)}" onerror="this.outerHTML='<div class=&quot;noimg&quot;>이미지 준비중</div>'">
    <button class="star ${w ? 'on' : ''}" title="관심 카드">${w ? '★' : '☆'}</button>
    <div class="info">
      <div class="name">${esc(ko || c.name)}</div>
      <div class="meta">${ko ? esc(c.name) + ' · ' : ''}${esc(c.set?.name || '')} ${esc(c.localId || '')}</div>
      ${opts.noPrice ? '<div class="meta">탭하여 시세 보기</div>' :
        `<div class="price">${pr?.krw != null ? fmtKRW(pr.krw) : '<small>시세 없음</small>'} ${delta}</div>
         ${pr?.src ? `<div class="meta">${pr.src}${pr.usd != null ? ` $${pr.usd.toFixed(2)}` : ` €${pr.eur.toFixed(2)}`}</div>` : ''}`}
    </div>`;
  el.addEventListener('click', e => { if (e.target.closest('.star')) return; openCard(c.id); });
  el.querySelector('.star').addEventListener('click', async () => {
    const full = c.pricing ? c : await json(`${TCG}/cards/${c.id}`);
    toggleWatch(full); el.replaceWith(cardTile(full, opts));
  });
  return el;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } }));
  return out;
}

// ---------- 국내 시세 ----------
function krLinks(q) {
  const k = encodeURIComponent(q);
  return `<div class="links">
    <a target="_blank" rel="noopener" href="https://content.kream.co.kr/tcg-chart/pokemon">KREAM 시세표</a>
    <a target="_blank" rel="noopener" href="https://www.pokepolio.com/search?q=${k}">포케폴리오</a>
    <a target="_blank" rel="noopener" href="https://collectory.cc/">콜렉토리</a>
    <a target="_blank" rel="noopener" href="https://pokazone.com/page/search.php?q=${k}">포카존</a>
    <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${encodeURIComponent('포카트레이드 ' + q)}">포카트레이드</a>
    <a target="_blank" rel="noopener" href="https://www.cardnyang.com/">카드냥</a>
    <a target="_blank" rel="noopener" href="https://search.naver.com/search.naver?where=article&query=${encodeURIComponent(q + ' 시세')}">네이버 카페(MVC·TCG 커뮤니티)</a>
    <a target="_blank" rel="noopener" href="https://m.bunjang.co.kr/search/products?q=${encodeURIComponent('포켓몬카드 ' + q)}">번개장터</a>
  </div>`;
}
// 판(에디션)별 시세 — 포케폴리오 한글판 / 일본판 / 북미판
const EDS = {
  kr: { flag: '🇰🇷', label: '한글판', cls: 'ed-kr' },
  jp: { flag: '🇯🇵', label: '일본판', cls: 'ed-jp' },
  en: { flag: '🇺🇸', label: '북미판', cls: 'ed-en' },
};
const watchId = c => c.ed && c.ed !== 'kr' ? `pp:${c.ed}:${c.id}` : 'pp:' + c.id;
const condOf = c => (c.chips || []).filter(x => /^(Raw|PSA|BGS|CGC|상태)/.test(x)).join(' · ');

function priceTile(c, rank) {
  const rar = remapRarity(c, c.rarity || rarityOf(c.chips));
  const ed = EDS[c.ed || 'kr'];
  const w = watch.find(x => x.id === watchId(c));
  const hist = w?.history || [];
  let delta = '';
  if (hist.length > 1) { const a = hist.at(-2).v, b = hist.at(-1).v; if (a && b && a !== b) { const pct = (b - a) / a * 100; delta = `<span class="delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(1)}%</span>`; } }
  const el = document.createElement('div');
  el.className = 'card ptile';
  el.innerHTML = `
    ${rank ? `<span class="rank">${rank}</span>` : ''}
    <div class="imgwrap"></div>
    <button class="star ${w ? 'on' : ''}" title="관심 카드">${w ? '★' : '☆'}</button>
    <div class="info">
      <div class="name"><span class="edtag ${ed.cls}">${ed.flag} ${ed.label}</span> ${esc(c.name)}</div>
      ${c.localName ? `<div class="meta">${esc(c.localName)}</div>` : ''}
      <div class="meta" title="${esc(c.set)}">${esc(c.set)}${c.number ? ' · ' + esc(c.number) : ''}</div>
      ${rar || (c.chips || []).length ? `<div class="tags">${rar ? `<span class="rar">${esc(rar)}</span>` : ''}${(c.chips || []).filter(x => !RARITY_ORDER.includes(x.toUpperCase())).map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="price">${c.price ? fmtKRW(c.price) : '<small>시세 없음</small>'} ${c.orig ? `<small>${esc(c.orig)}</small>` : ''} ${delta}</div>
      <div class="range loading"><div><span>최저</span><b>…</b></div><div><span>최고</span><b>…</b></div></div>
      <div class="range-note">최근 시세 범위 확인 중…</div>
    </div>`;
  setTileImage(el.querySelector('.imgwrap'), c, ed);
  el.dataset.rarity = rar;
  el.dataset.cond = condKind(c.chips);
  el.addEventListener('click', e => { if (!e.target.closest('.star')) window.open(c.url, '_blank', 'noopener'); });
  el.querySelector('.star').addEventListener('click', () => {
    const id = watchId(c), i = watch.findIndex(x => x.id === id);
    if (i >= 0) { watch.splice(i, 1); toast(`관심 카드에서 뺐어요: ${c.name}`); }
    else {
      watch.push({ id, kr: c, ed: c.ed || 'kr', query: c.name, name: c.name, last: c.price, history: [{ t: Date.now(), v: c.price }] });
      toast(`⭐ ${c.name} (${ed.label}) 관심 카드 추가! 시세가 ${settings.pct}% 이상 변하면 알려드려요.`); askPermissionSoft();
    }
    store.set('watch', watch); renderWatch(); el.replaceWith(priceTile(c, rank));
  });
  loadRange(c, el);
  return el;
}
// ---- 등급(레어도)·상태 필터 ----
const RARITY_ORDER = ['MUR', 'BWR', 'FUR', 'RGB', '복각', '마스터볼', '몬스터볼', 'UR', 'SAR', 'SSR', 'CSR', 'HR', 'SR', 'CHR', 'AR', 'ACE', 'MA', 'S', 'RRR', 'RR', 'R', 'PR', 'U', 'C'];
// 30주년(30th CELEBRATION): 출처에서 UR로 묶인 카드를 실제 구분(FUR / RGB / 복각)으로 나눔
const is30th = c => /30th/i.test(c.set || '') || /^(M6A|30C)$/i.test(c.set || '');
// 마스터볼·몬스터볼 미러: 포케폴리오에서 별도 카드(고유 ID)로 관리됨 → 미러 검색 결과로 ID 표를 만들어 표시
const BALL_SETS = /151|테라스탈페스타/;
let ballMap = {}, ballCards = { 마스터볼: [], 몬스터볼: [] };
async function loadBalls() {
  await Promise.all(Object.keys(ballCards).map(async ball => {
    try {
      const list = (await json(`/api/pp?q=${encodeURIComponent(ball)}&ed=kr&pages=3`)).filter(c => BALL_SETS.test(c.set.replace(/\s/g, '')));
      ballCards[ball] = list; list.forEach(c => ballMap[c.id] = ball);
    } catch {}
  }));
}
function remapRarity(c, r) {
  if (ballMap[c.id]) return ballMap[c.id];
  r = (r || '').toUpperCase();
  if (!is30th(c)) return r;
  if (/FUR/i.test(c.name)) return 'FUR';
  // 30주년에서 UR 등급인 신형 ex(소문자 ex: 뮤츠 ex·뮤 ex)는 FUR (일본판 134·135, 북미판 157·158)
  if (r === 'UR' && /ex(\s|$)/.test(c.localName || c.name)) return 'FUR';
  if (r === 'RGB' || r === 'UNKNOWN') return 'RGB';
  if (r === 'UR') return '복각';
  return r;
}
const rarityOf = chips => (chips || []).map(x => x.toUpperCase()).find(x => RARITY_ORDER.includes(x)) || '';
const condKind = chips => { const g = (chips || []).map(x => x.match(/^(PSA|BGS|CGC)\s?(\d+(?:\.5)?)/)).find(Boolean); return g ? `${g[1]} ${g[2]}` : 'Raw'; };
function refreshGradeBar() {
  const bar = $('#gradeBar'); if (!bar || !board) return;
  const tiles = [...document.querySelectorAll('#krGrid .ptile')];
  const rar = RARITY_ORDER.filter(r => tiles.some(t => t.dataset.rarity === r) || r === board.pinGrade);
  const conds = [...new Set(tiles.map(t => t.dataset.cond).concat(board.pinCond ? [board.pinCond] : []))].sort((a, b) => (a === 'Raw' ? -1 : b === 'Raw' ? 1 : b.localeCompare(a, 'en', { numeric: true })));
  const f = board.filter;
  if (f.rarity !== '전체' && !rar.includes(f.rarity)) f.rarity = '전체';
  if (f.cond !== '전체' && !conds.includes(f.cond)) f.cond = '전체';
  const chip = (k, v) => `<button type="button" class="chip ${f[k] === v ? 'on' : ''}" data-k="${k}" data-v="${esc(v)}">${esc(v)}${v === '전체' ? '' : ` <i>${tiles.filter(t => t.dataset[k] === v).length}</i>`}</button>`;
  bar.innerHTML = `
    <div class="grow"><span class="chip-label">💎 등급</span>${['전체', ...rar].map(v => chip('rarity', v)).join('')}</div>
    ${conds.length > 1 ? `<div class="grow"><span class="chip-label">🏷️ 상태</span>${['전체', ...conds].map(v => chip('cond', v)).join('')}</div>` : ''}`;
  let shown = 0;
  tiles.forEach(t => { const ok = (f.rarity === '전체' || t.dataset.rarity === f.rarity) && (f.cond === '전체' || t.dataset.cond === f.cond); t.hidden = !ok; if (ok) shown++; });
  let empty = $('#krGrid .filter-empty');
  if (!shown && tiles.length) { if (!empty) $('#krGrid').insertAdjacentHTML('beforeend', '<div class="empty filter-empty">선택한 등급의 카드가 없어요.</div>'); }
  else empty?.remove();
}

// 이미지: 판 공식 이미지 → 없으면 원본 사진(라벨 표시) → 그래도 없으면 안내 문구
function setTileImage(wrap, c, ed) {
  const cands = [];
  if (c.img) cands.push({ src: c.img, badge: '' });
  if (c.imgAlt) cands.push({ src: c.imgAlt, badge: c.imgAltLabel || '참고 이미지' });
  const next = () => {
    const x = cands.shift();
    if (!x) {
      const rgb = remapRarity(c, c.rarity) === 'RGB';
      wrap.innerHTML = `<div class="noimg">${esc(c.name)}<br>${rgb ? 'RGB 카드<br><small>출처(포케폴리오)에 사진이 없어요</small>' : `${ed.label} 이미지 준비중`}</div>`;
      return;
    }
    const img = new Image();
    img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.alt = c.name;
    img.onerror = next;
    img.src = x.src;
    wrap.innerHTML = ''; wrap.appendChild(img);
    if (x.badge) wrap.insertAdjacentHTML('beforeend', `<span class="imgbadge">${esc(x.badge)}</span>`);
  };
  next();
}
// 같은 상태끼리만, 최근 30일(부족하면 90일), 중앙값에서 크게 벗어난 거래 제외 → 최저~최고가
const rangeQueue = []; let rangeActive = 0;
function loadRange(c, el) {
  rangeQueue.push(async () => {
    const box = el.querySelector('.range'), note = el.querySelector('.range-note');
    try {
      const r = await json(`/api/kr-range?id=${c.id}&ed=${c.ed || 'kr'}&cond=${encodeURIComponent(condOf(c))}`);
      if (r.rarity && !el.dataset.rarity) {
        el.dataset.rarity = remapRarity(c, r.rarity);
        let tags = el.querySelector('.tags');
        if (!tags) { el.querySelector('.price').insertAdjacentHTML('beforebegin', '<div class="tags"></div>'); tags = el.querySelector('.tags'); }
        tags.insertAdjacentHTML('afterbegin', `<span class="rar">${esc(el.dataset.rarity)}</span>`);
        refreshGradeBar();
      }
      if (!r.low) { box.remove(); note.textContent = '최근 거래 기록이 부족해요'; return; }
      // 대표 시세 = 최근 거래 중앙값 (한 건짜리 마지막 거래보다 안정적). 마지막 체결가는 작게 따로 표시
      const priceEl = el.querySelector('.price');
      const trend = r.prev && r.median !== r.prev
        ? `<span class="delta ${r.median > r.prev ? 'up' : 'down'}">${r.median > r.prev ? '▲' : '▼'}${Math.abs((r.median - r.prev) / r.prev * 100).toFixed(0)}%</span>` : '';
      // 대표 시세 기준 (설정에서 변경): 중앙값 / 상태 좋은 카드(상위 25%) / 최근 최고가
      const BASIS = { median: ['중앙값', r.median], p75: ['상태 좋은 카드 기준', r.p75 || r.median], high: ['최근 최고가', r.high] };
      const [basisLabel, headline] = BASIS[settings.basis] || BASIS.median;
      priceEl.innerHTML = `${fmtKRW(headline)} ${trend}`;
      priceEl.insertAdjacentHTML('afterend', `<div class="meta">시세(${basisLabel})${c.price && c.price !== headline ? ` · 마지막 체결 ${fmtKRW(c.price)}${c.orig ? ' ' + esc(c.orig) : ''}` : ''}${r.prev ? ` · ${r.prevLabel || '한 달 전'} ${fmtKRW(r.prev)}` : ''}</div>`);
      box.classList.remove('loading');
      box.innerHTML = `<div class="lo"><span>최저</span><b>${fmtKRW(r.low)}</b></div><div class="hi"><span>최고</span><b>${fmtKRW(r.high)}</b></div>`;
      note.textContent = `${r.windowDays ? `최근 ${r.windowDays}일` : "전체 기간"} · ${r.count}건${r.cond ? ' · ' + r.cond : ''}${r.latest ? ` · 마지막 거래 ${r.latest.slice(5).replace('-', '/')}` : ''}`;
    } catch { box.remove(); note.textContent = ''; }
  });
  pumpRange();
}
async function pumpRange() {
  while (rangeActive < 4 && rangeQueue.length) {
    const job = rangeQueue.shift(); rangeActive++;
    job().finally(() => { rangeActive--; pumpRange(); });
  }
}

// 시세 보드: 검색어(또는 세트)로 한글판/일본판/북미판을 각각 불러와 탭으로 보여줌
let board = null;
async function priceBoard({ title, sub, q, hitsKey, grade, cond }) {
  const token = Symbol(); board = { token, ed: board?.ed || 'kr', data: {}, filter: { rarity: grade || '전체', cond: cond || '전체' }, hitsKey, pinGrade: grade, pinCond: cond };
  $('#krBox').innerHTML = `
    <h3 class="sub">${title} <small>${sub || ''}</small></h3>
    <div class="edtabs" role="tablist">${Object.entries(EDS).map(([k, e]) =>
      `<button type="button" role="tab" data-ed="${k}" class="${e.cls} ${k === board.ed ? 'on' : ''}">${e.flag} ${e.label} <i>…</i></button>`).join('')}</div>
    <div class="gradebar" id="gradeBar"></div>
    <div class="grid" id="krGrid">${Array(6).fill('<div class="skeleton"></div>').join('')}</div>
    <details class="morelinks"><summary>다른 시세 사이트에서 보기</summary>${krLinks(q)}</details>
    <div id="pzBox"></div>`;
  $('#gradeBar').onclick = e => { const b = e.target.closest('[data-k]'); if (b) { board.filter[b.dataset.k] = b.dataset.v; refreshGradeBar(); } };
  $('#krBox .edtabs').onclick = e => { const b = e.target.closest('[data-ed]'); if (b) { board.ed = b.dataset.ed; drawBoard(hitsKey); } };
  // enrich=false: 목록을 먼저 빠르게 표시 → enrich=true: 한글판 등급·공식 이미지를 채워서 다시 그림
  const load = async (ed, enrich = false) => {
    let list = [];
    if (STATIC && hitsKey) { // 정적 모드: 수집기가 미리 처리해 둔 세트별 힛카드 파일
      const i = HIT_SETS.findIndex(h => h.q === hitsKey);
      const h = await sdata(`hits/${i}.json`);
      if (board.token !== token) return;
      board.data[ed] = (h && h[ed]) || [];
      board.pending = !h || h.pending; // 아직 수집 전인 세트
      const tab = $(`#krBox .edtabs [data-ed="${ed}"] i`); if (tab) tab.textContent = board.data[ed].length;
      if (ed === board.ed) drawBoard(hitsKey);
      return;
    }
    if (hitsKey && ballCards[hitsKey] && ed !== 'kr') { // 미러 카드는 한글판 데이터만 구분됨
      board.data[ed] = [];
      const tab = $(`#krBox .edtabs [data-ed="${ed}"] i`); if (tab) tab.textContent = 0;
      if (ed === board.ed) drawBoard(hitsKey);
      return;
    }
    if (hitsKey && ed === 'en') {
      // 북미판은 세트 이름·구성이 달라 세트명으로 검색되지 않음 → 한글판/일본판 힛카드와 같은 카드 이름으로 검색
      const names = [...new Set([...(board.data.kr || []), ...(board.data.jp || [])].sort((a, b) => b.price - a.price).map(c => c.name))].slice(0, 10);
      const res = await Promise.all(names.map(n => json(`/api/pp?q=${encodeURIComponent(n)}&ed=en`).then(a => a.filter(c => c.name === n)).catch(() => [])));
      list = res.flat();
      // 같은 이름의 다른 세트 카드가 섞이지 않게: 알려진 북미 세트 코드가 있으면 그것만,
      // 없으면 여러 힛카드 이름에 공통으로 가장 많이 나온 세트(= 같은 세트의 북미판)만 남김
      const known = EN_SET[hitsKey];
      let codes = known;
      if (!codes) {
        const cnt = {};
        for (const n of names) new Set(list.filter(c => c.name === n).map(c => c.set)).forEach(code => cnt[code] = (cnt[code] || 0) + 1);
        const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
        codes = best && best[1] >= 2 ? [best[0]] : [];
      }
      list = list.filter(c => codes.includes(c.set));
    } else {
      const rgbReq = hitsKey ? json(`/api/pp?q=RGB&ed=${ed}${ed === 'kr' && enrich ? '&rarity=12' : ''}`).catch(() => []) : null; // 동시에 요청
      try { list = await json(`/api/pp?q=${encodeURIComponent(q)}&ed=${ed}${hitsKey ? '&pages=3' : ''}${ed === 'kr' && enrich ? '&rarity=' + (hitsKey ? 90 : 24) : ''}`); } catch {}
      if (hitsKey) {
        // RGB 카드는 세트명 검색에 잘 안 잡혀서 따로 검색 후 같은 세트만 합침
        try {
          const key = hitsKey.replace(/\s/g, '').toLowerCase();
          const rgb = (await rgbReq)
            .filter(c => c.set.replace(/\s/g, '').toLowerCase().includes(key) && !list.some(x => x.id === c.id))
            .map(c => ({ ...c, rarity: !c.rarity || c.rarity === 'UNKNOWN' ? 'RGB' : c.rarity }));
          list = list.concat(rgb);
        } catch {}
        if (ed === 'kr') {
          const key = hitsKey.replace(/\s/g, '').toLowerCase();
          const balls = [...ballCards.마스터볼, ...ballCards.몬스터볼];
          if (ballCards[hitsKey]) list = balls.filter(c => ballMap[c.id] === hitsKey); // '마스터볼 미러' / '몬스터볼 미러' 세트
          else list = list.concat(balls.filter(c => c.set.replace(/\s/g, '').toLowerCase().includes(key) && !list.some(x => x.id === c.id)));
        }
      }
    }
    if (!hitsKey && ed === 'kr' && ballCards[grade]) { // "피카츄 마스터볼" → 마스터볼 미러 카드 합치기
      const k = q.replace(/\s/g, '');
      list = list.concat(ballCards[grade].filter(c => c.name.replace(/\s/g, '').includes(k) && !list.some(x => x.id === c.id)));
    }
    if (board.token !== token) return;
    if (hitsKey) {
      // 힛카드: 같은 카드는 가장 비싼 것 하나만, 한글판은 해당 세트 카드만
      const key = hitsKey.replace(/\s/g, '').toLowerCase();
      const inSet = ed === 'en' || ballCards[hitsKey] ? [] : list.filter(c => c.set.replace(/\s/g, '').toLowerCase().includes(key));
      const best = new Map();
      (inSet.length ? inSet : list).forEach(c => { const k = c.id; /* 같은 이름이라도 UR·SAR 등 레어도가 다르면 다른 카드(고유 ID 기준) */ if (!best.has(k) || best.get(k).price < c.price) best.set(k, c); });
      const all = [...best.values()].sort((a, b) => (b.price || 0) - (a.price || 0));
      list = [...all.filter(c => c.price).slice(0, 30), ...all.filter(c => !c.price).sort((x, y) => (remapRarity(y, y.rarity) === 'RGB') - (remapRarity(x, x.rarity) === 'RGB')).slice(0, 12)]; // 시세 있는 상위 30장 + 아직 시세 없는 카드(RGB 등)
    }
    board.data[ed] = list;
    const tab = $(`#krBox .edtabs [data-ed="${ed}"] i`); if (tab) tab.textContent = list.length;
    if (ed === board.ed) drawBoard(hitsKey);
    if (ed === 'kr' && !enrich && !STATIC) load('kr', true); // 등급·공식 이미지는 뒤에서 채운 뒤 다시 그림
  };
  if (hitsKey) { await Promise.all([load('kr'), load('jp')]); await load('en'); }
  else { await Promise.all(Object.keys(EDS).map(load)); krPazone(q, token); }
}
function drawBoard(hitsKey) {
  document.querySelectorAll('#krBox .edtabs button').forEach(b => b.classList.toggle('on', b.dataset.ed === board.ed));
  const grid = $('#krGrid'); const list = board.data[board.ed];
  if (!list) { grid.innerHTML = Array(6).fill('<div class="skeleton"></div>').join(''); return; }
  rangeQueue.length = 0; grid.innerHTML = '';
  if (!list.length && board.pending) { grid.innerHTML = `<div class="empty">⏳ 이 세트는 아직 수집 대기 중이에요.<br><small>사이트 부담을 줄이려고 2시간마다 8개 세트씩 차례로 모으고 있어요. 하루 안에 채워져요.</small></div>`; refreshGradeBar(); return; }
  if (!list.length) { grid.innerHTML = `<div class="empty">${EDS[board.ed].label} 시세 데이터가 없어요.${hitsKey && board.ed === "en" ? "<br>북미판은 세트 구성이 달라서, 카드 이름(예: 리자몽 ex)으로 검색하면 볼 수 있어요." : ""}</div>`; return; }
  // 시세 있는 카드(가격 높은 순)만 먼저 보여주고, 시세 없는 카드는 버튼으로 펼침 (RGB는 시세가 없어도 표시)
  const isRgb = c => remapRarity(c, c.rarity) === 'RGB';
  const shown = list.filter(c => c.price || isRgb(c)).sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, 42);
  const hidden = list.filter(c => !c.price && !isRgb(c));
  if (!shown.length) grid.innerHTML = `<div class="empty">최근 거래 시세가 있는 ${EDS[board.ed].label} 카드가 없어요.</div>`;
  shown.forEach((c, i) => grid.appendChild(priceTile(c, hitsKey && i < 3 && c.price ? i + 1 : 0)));
  if (hidden.length) {
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'ghost show-unpriced';
    more.textContent = `시세 없는 카드 ${hidden.length}장 보기 (거래 기록 없음)`;
    more.onclick = () => { more.remove(); hidden.forEach(c => grid.appendChild(priceTile(c, 0))); refreshGradeBar(); };
    grid.appendChild(more);
  }
  refreshGradeBar();
}
async function krPazone(q, token) {
  try {
    const d = await json('/api/kr-prices?q=' + encodeURIComponent(q));
    if (board.token !== token || !d.pokazone.length) return;
    $('#pzBox').innerHTML = `<h3 class="sub">🛒 포카존 최근 거래글 <small>(판매/구매 희망가)</small></h3>
      <ul class="feed">${d.pokazone.slice(0, 8).map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">
        <span class="tagnew" style="background:${x.type === '판매' ? 'var(--accent)' : 'var(--down)'}">${esc(x.type || '거래')}</span>${esc(x.title)}</a>
        <div class="m"><b>${x.price ? fmtKRW(x.price) : '가격 문의'}</b> · ${esc(x.kind)} · ${esc(x.status)}${x.date ? ' · ' + esc(x.date) : ''}</div></li>`).join('')}</ul>`;
  } catch {}
}
function krSearch(q, grade, cond) {
  return priceBoard({ title: `💰 "${esc(q)}"${grade ? ' ' + esc(grade) : ''}${cond ? ' ' + esc(cond) : ''} 시세`, sub: '(포케폴리오 실거래 · MVC 네이버카페 등)', q, grade, cond });
}
// 검색어에서 등급(SAR·마스터볼 등)과 감정 등급(PSA10 등)을 분리: "리자몽 ex SAR" → 이름 "리자몽 ex" + 등급 SAR
function parseGradeQuery(q) {
  let grade = null, cond = null; const rest = [];
  const toks = q.trim().replace(/(PSA|BGS|BRG|CGC)\s+(\d+(?:\.5)?)/gi, '$1$2').split(/\s+/);
  for (const t of toks) {
    const T = t.toUpperCase().replace(/미러$/, '');
    const g = /^(PSA|BGS|BRG|CGC)(\d+(?:\.5)?)$/i.exec(t);
    if (!cond && g) { cond = `${g[1].toUpperCase()} ${g[2]}`; continue; }
    // 한 글자 등급(R·U·C·S)은 카드 이름과 헷갈려서 제외
    if (!grade && T.length >= 2 && RARITY_ORDER.includes(T)) { grade = T; continue; }
    if (!grade && ['마스터볼', '몬스터볼', '복각'].includes(T)) { grade = T; continue; }
    rest.push(t);
  }
  return { name: rest.join(' '), grade, cond };
}

// ---------- 시세 검색 ----------
let lastResults = [];
async function search(q) {
  if (!q.trim()) return;
  addHistory(q.trim());
  document.querySelectorAll('#hitChips .chip').forEach(c => c.classList.remove('on'));
  const pq = parseGradeQuery(q);
  if (pq.name) q = pq.name; // 이름 없이 등급만 입력하면 그대로 검색
  const en = toEnglish(q);
  krSearch(/[가-힣]/.test(q) ? q.trim() : (toKorean(q.trim()) || q.trim()), pq.name ? pq.grade : null, pq.name ? pq.cond : null);
  const box = $('#results'); $('#globalBox').hidden = false; $('#resultTitle').hidden = false;
  $('#resultTitle').textContent = `TCGplayer·Cardmarket 상세 · "${q}"${en !== q ? ` → ${en}` : ''}`;
  box.innerHTML = Array(6).fill('<div class="skeleton"></div>').join('');
  try {
    if (/[가-힣]/.test(en)) throw new Error('KO');
    let list = (await json(`${TCG}/cards?name=${encodeURIComponent(en)}&pagination:itemsPerPage=80`)).filter(c => !isPocket(c));
    list.sort((a, b) => (setRank[a.id.split('-').slice(0, -1).join('-')] ?? 999) - (setRank[b.id.split('-').slice(0, -1).join('-')] ?? 999));
    list = list.slice(0, 36);
    const full = (await mapLimit(list, 8, c => json(`${TCG}/cards/${c.id}`))).filter(Boolean);
    lastResults = full; renderResults();
  } catch (e) {
    box.innerHTML = `<div class="empty">${e.message === 'KO' ? '해당 한글 이름을 찾지 못했어요. 영어 이름으로도 검색해 보세요 (예: Charizard ex).' : '검색 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'}</div>`;
  }
}
function renderResults() {
  const box = $('#results'); box.innerHTML = '';
  const sort = $('#sortSel').value;
  const arr = [...lastResults];
  if (sort === 'price') arr.sort((a, b) => (priceOf(b).krw ?? -1) - (priceOf(a).krw ?? -1));
  if (sort === 'priceAsc') arr.sort((a, b) => (priceOf(a).krw ?? 1e12) - (priceOf(b).krw ?? 1e12));
  if (sort === 'new') arr.sort((a, b) => (setRank[a.set?.id] ?? 999) - (setRank[b.set?.id] ?? 999));
  if (!arr.length) box.innerHTML = '<div class="empty">검색 결과가 없어요.</div>';
  arr.forEach(c => box.appendChild(cardTile(c)));
}

// ---------- 카드 상세 ----------
async function openCard(id) {
  const dlg = $('#cardDlg'), body = $('#cardDlgBody');
  body.innerHTML = '<div class="detail"><div class="skeleton" style="height:200px"></div></div>';
  dlg.showModal();
  try {
    const c = await json(`${TCG}/cards/${id}`);
    const pr = priceOf(c), ko = toKorean(c.name);
    const tp = c.pricing?.tcgplayer, cm = c.pricing?.cardmarket;
    const VAR = { normal: '일반', holofoil: '홀로', 'reverse-holofoil': '리버스홀로', '1st-edition-holofoil': '1판 홀로', '1st-edition': '1판', unlimited: '언리미티드' };
    let rows = '';
    if (tp) for (const [k, v] of Object.entries(tp)) if (v && typeof v === 'object')
      rows += `<tr><td>${VAR[k] || k}</td><td class="n">${v.lowPrice != null ? fmtKRW(v.lowPrice * fx.USD) : '-'}</td><td class="n">${v.marketPrice != null ? fmtKRW(v.marketPrice * fx.USD) : '-'}<br><small>$${v.marketPrice ?? '-'}</small></td><td class="n">${v.highPrice != null ? fmtKRW(v.highPrice * fx.USD) : '-'}</td></tr>`;
    const trend = cm && cm.avg30 && cm.avg7 ? (cm.avg7 - cm.avg30) / cm.avg30 * 100 : null;
    const kw = encodeURIComponent(`포켓몬카드 ${ko || c.name} ${c.localId}`);
    const enkw = encodeURIComponent(`pokemon ${c.name} ${c.set?.name} ${c.localId}`);
    const w = watch.find(x => x.id === c.id);
    body.innerHTML = `<div class="detail">
      <div class="head">
        ${imgUrl(c, 'high') ? `<img src="${esc(imgUrl(c, 'high'))}" alt="">` : ''}
        <div>
          <h2>${esc(ko || c.name)}</h2>
          <div class="hint">${esc(c.name)} · ${esc(c.set?.name)} #${esc(c.localId)}<br>${esc(c.rarity || '')} ${c.illustrator ? '· 일러스트 ' + esc(c.illustrator) : ''}</div>
          <div class="price" style="font-size:24px;font-weight:800">${fmtKRW(pr.krw)}</div>
          <div class="hint">${pr.src ? pr.src + ' 기준' : '해외 시세 데이터 없음'}${tp?.updated ? ' · ' + ago(tp.updated) + ' 갱신' : ''}</div>
          ${trend != null ? `<div class="delta ${trend > 0 ? 'up' : 'down'}">유럽 7일 평균 vs 30일 평균 ${trend > 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}%</div>` : ''}
          <p><button class="primary" id="dlgWatch">${w ? '★ 관심 카드 해제' : '☆ 관심 카드 (가격 알림)'}</button></p>
        </div>
      </div>
      ${rows ? `<h3 class="sub">TCGplayer (미국)</h3><table><tr><th>버전</th><th class="n">최저</th><th class="n">시장가</th><th class="n">최고</th></tr>${rows}</table>` : ''}
      ${cm ? `<h3 class="sub">Cardmarket (유럽)</h3><table>
        <tr><th>구분</th><th class="n">1일 평균</th><th class="n">7일 평균</th><th class="n">30일 평균</th><th class="n">추세</th></tr>
        <tr><td>일반</td><td class="n">${cm.avg1 != null ? fmtKRW(cm.avg1 * fx.EUR) : '-'}</td><td class="n">${cm.avg7 != null ? fmtKRW(cm.avg7 * fx.EUR) : '-'}</td><td class="n">${cm.avg30 != null ? fmtKRW(cm.avg30 * fx.EUR) : '-'}</td><td class="n">${cm.trend != null ? fmtKRW(cm.trend * fx.EUR) : '-'}</td></tr>
        ${cm['avg7-holo'] != null ? `<tr><td>홀로</td><td class="n">${cm['avg1-holo'] != null ? fmtKRW(cm['avg1-holo'] * fx.EUR) : '-'}</td><td class="n">${fmtKRW(cm['avg7-holo'] * fx.EUR)}</td><td class="n">${cm['avg30-holo'] != null ? fmtKRW(cm['avg30-holo'] * fx.EUR) : '-'}</td><td class="n">${cm['trend-holo'] != null ? fmtKRW(cm['trend-holo'] * fx.EUR) : '-'}</td></tr>` : ''}
      </table>` : ''}
      <h3 class="sub">🇰🇷 국내 거래가 확인</h3>
      ${krLinks(ko || c.name)}
      <div class="links">
        <a target="_blank" rel="noopener" href="https://search.shopping.naver.com/search/all?query=${kw}">네이버쇼핑</a>
        <a target="_blank" rel="noopener" href="https://www.daangn.com/kr/buy-sell/?search=${kw}">당근</a>
        <a target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${enkw}&LH_Sold=1&LH_Complete=1">eBay 판매완료</a>
      </div>
      <p style="text-align:right"><button class="ghost" onclick="this.closest('dialog').close()">닫기</button></p>
    </div>`;
    $('#dlgWatch').onclick = () => { toggleWatch(c); dlg.close(); };
  } catch { body.innerHTML = '<div class="detail"><div class="empty">카드 정보를 불러오지 못했어요.</div></div>'; }
}
$('#cardDlg').addEventListener('click', e => { if (e.target.id === 'cardDlg') e.target.close(); });

// ---------- 관심 카드 ----------
function toggleWatch(c) {
  const i = watch.findIndex(x => x.id === c.id);
  if (i >= 0) { watch.splice(i, 1); toast(`관심 카드에서 뺐어요: ${toKorean(c.name) || c.name}`); }
  else {
    const p = priceOf(c).krw;
    watch.push({ id: c.id, name: c.name, image: c.image, set: c.set, localId: c.localId, pricing: c.pricing, last: p, history: [{ t: Date.now(), v: p }] });
    toast(`⭐ 관심 카드 추가! 가격이 ${settings.pct}% 이상 변하면 알려드려요.`);
    askPermissionSoft();
  }
  store.set('watch', watch); renderWatch();
}
function renderWatch() {
  const box = $('#watchList'); box.innerHTML = '';
  if (!watch.length) { box.innerHTML = '<div class="empty">카드를 검색하고 ☆를 눌러 관심 카드로 등록하세요.</div>'; return; }
  watch.forEach(w => box.appendChild(w.kr ? priceTile({ ...w.kr, ed: w.ed || 'kr', price: w.history?.at(-1)?.v ?? w.kr.price }) : cardTile(w)));
}
async function checkWatch(manual) {
  if (!watch.length) return;
  for (const w of watch) {
    try {
      let now;
      if (w.kr) {
        const list = await json(`/api/pp?q=${encodeURIComponent(w.query)}&ed=${w.ed || 'kr'}`);
        const hit = list.find(x => watchId(x) === w.id);
        if (!hit) continue;
        now = hit.price; w.kr = hit;
      } else {
        const c = await json(`${TCG}/cards/${w.id}`);
        now = priceOf(c).krw; w.pricing = c.pricing;
      }
      if (now == null) continue;
      const lastHist = w.history[w.history.length - 1];
      if (!lastHist || lastHist.v !== now) w.history.push({ t: Date.now(), v: now });
      w.history = w.history.slice(-60);
      if (w.last && settings.price) {
        const pct = (now - w.last) / w.last * 100;
        if (Math.abs(pct) >= settings.pct) {
          notify(`${pct > 0 ? '📈' : '📉'} ${w.kr ? w.name + '(' + EDS[w.ed || 'kr'].label + ')' : toKorean(w.name) || w.name} 가격 ${pct > 0 ? '상승' : '하락'} ${Math.abs(pct).toFixed(1)}%`, `${fmtKRW(w.last)} → ${fmtKRW(now)}`, 'price');
          w.last = now;
        }
      } else if (w.last == null) w.last = now;
    } catch {}
  }
  store.set('watch', watch); renderWatch();
  if (manual) toast('관심 카드 시세를 갱신했어요.');
}

// ---------- 뉴스(이벤트 / 한국 발매) ----------
const { EVENT_Q } = window.PCR_SHARED;
const KR_NEW_Q = ['포켓몬카드 확장팩', '포켓몬 카드게임 발매', '포켓몬카드 신상품'];
let eventFilter = '전체', eventItems = [];

async function fetchEvents() {
  const keys = Object.keys(EVENT_Q);
  const res = await Promise.all(keys.map(k => json('/api/news?q=' + encodeURIComponent(EVENT_Q[k])).then(a => a.map(x => ({ ...x, cat: k }))).catch(() => [])));
  const seen = new Set(), all = [];
  for (const it of res.flat().sort((a, b) => b.date.localeCompare(a.date))) {
    const key = it.title.replace(/\s/g, '').slice(0, 40);
    if (seen.has(key)) continue; seen.add(key); it.key = key; all.push(it);
  }
  return all.filter(x => Date.now() - new Date(x.date) < 120 * 864e5).slice(0, 80);
}
async function checkEvents(render) {
  try {
    const items = await fetchEvents(); if (!items.length) return;
    const first = known.events.size === 0;
    const fresh = items.filter(x => !known.events.has(x.key));
    fresh.forEach(x => known.events.add(x.key));
    if (first) items.forEach(x => viewed.events.add(x.key));
    else if (fresh.length && settings.events) {
      fresh.slice(0, 3).forEach(x => notify(`🎉 새 이벤트 소식 · ${x.cat}`, x.title, 'events', x.link));
      if (fresh.length > 3) notify('🎉 포켓몬카드 이벤트 소식', `새 소식 ${fresh.length}건이 올라왔어요`, 'events');
    }
    eventItems = items; saveKnown(); saveViewed(); updateBadges();
    if (render || activeTab === 'events') renderEvents();
  } catch {}
}
function renderEvents() {
  const ul = $('#eventList');
  const items = eventItems.filter(x => eventFilter === '전체' || x.cat === eventFilter);
  ul.innerHTML = items.length ? items.map(x => `<li class="${viewed.events.has(x.key) ? '' : 'new'}">
      <a href="${esc(x.link)}" target="_blank" rel="noopener">${viewed.events.has(x.key) ? '' : '<span class="tagnew">NEW</span>'}${esc(x.title)}</a>
      <div class="m">${esc(x.cat)} · ${esc(x.source)} · ${ago(x.date)}</div></li>`).join('') : '<li>소식을 불러오는 중이거나 없어요.</li>';
  if (activeTab === 'events') { eventItems.forEach(x => viewed.events.add(x.key)); saveViewed(); updateBadges(); }
}
$('#eventFilters').innerHTML = ['전체', ...Object.keys(EVENT_Q)].map(k => `<button class="chip ${k === '전체' ? 'on' : ''}" data-f="${k}">${k}</button>`).join('');
$('#eventFilters').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  eventFilter = b.dataset.f; document.querySelectorAll('#eventFilters .chip').forEach(c => c.classList.toggle('on', c === b)); renderEvents();
});

// ---------- 신규 카드 ----------
let krNew = [], latestSets = [];
const dday = date => { const d = Math.round((new Date(date + 'T00:00:00+09:00') - Date.now()) / 864e5); return d > 0 ? `발매 D-${d}` : d === 0 ? '오늘 발매' : ''; };
async function checkNew(render) {
  try {
    const [prods] = await Promise.all([json('/api/products').catch(() => []), setsSorted.length ? null : loadSets()]);
    // 공식 사이트 제품 = 한국 정식 발매 세트·상품
    krNew = prods.map(p => ({ ...p, key: 'prod:' + p.id }));
    if (!render) await loadSets(); // 주기 확인 시 해외 세트 목록 갱신
    const cand = setsSorted.slice(0, 14);
    const det = (await mapLimit(cand, 6, s => json(`${TCG}/sets/${s.id}`))).filter(s => s && s.serie?.id !== 'tcgp');
    latestSets = det.slice(0, 8);

    const first = known.sets.size === 0 && known.kr.size === 0;
    const freshSets = latestSets.filter(s => !known.sets.has(s.id));
    const freshKr = krNew.filter(x => !known.kr.has(x.key));
    freshSets.forEach(s => known.sets.add(s.id)); freshKr.forEach(x => known.kr.add(x.key));
    if (first) { latestSets.forEach(s => viewed.new.add('set:' + s.id)); krNew.forEach(x => viewed.new.add(x.key)); }
    else if (settings.newCards) {
      freshKr.filter(x => x.kind === 'set').slice(0, 3).forEach(x => notify('✨ 새 세트 발매 발표!', `${x.name} · ${x.date} 발매${x.price ? ' · ' + x.price.toLocaleString() + '원' : ''}`, 'new', x.url));
      freshSets.forEach(s => notify('🌏 해외 새 확장팩', `${s.name} (${s.releaseDate})`, 'new'));
    }
    saveKnown(); saveViewed(); updateBadges();
    if (render || activeTab === 'new') renderNew();
  } catch (e) { console.warn(e); }
}
function renderNew() {
  const goods = $('#showGoods').checked;
  const list = krNew.filter(x => goods || x.kind === 'set').slice(0, 30);
  $('#krNewList').innerHTML = list.length ? list.map(x => {
    const name = x.name.replace(/^포켓몬 카드 게임\s*/, '');
    const inner = (name.match(/「([^」]+)」/) || [])[1] || '';
    const hit = HIT_SETS.findIndex(h => inner && (h.label === inner || h.q === inner || inner.replace(/\s/g, '').includes(h.q.replace(/\s/g, ''))));
    const dd = dday(x.date);
    return `<div class="prod ${viewed.new.has(x.key) ? '' : 'new'}">
      <a href="${esc(x.url)}" target="_blank" rel="noopener" class="prod-img">${x.img ? `<img loading="lazy" src="${esc(x.img)}" alt="">` : ''}${dd ? `<span class="dday">${dd}</span>` : ''}</a>
      <div class="prod-info">
        <div class="prod-name">${viewed.new.has(x.key) ? '' : '<span class="tagnew">NEW</span>'}${esc(name)}</div>
        <div class="m">📅 ${esc(x.date)} 발매${x.price ? ` · ${x.price.toLocaleString()}원` : ''}${x.kind === 'goods' ? ' · 굿즈' : ''}</div>
        ${x.kind === 'set' && inner ? `<button type="button" class="chip hot" data-hit="${hit}" data-q="${esc(inner)}">💰 힛카드 시세 보기</button>` : ''}
      </div></div>`;
  }).join('') : '<div class="empty">공식 사이트에서 제품 정보를 불러오는 중이에요…</div>';
  const sl = $('#setList');
  sl.innerHTML = latestSets.map(s => `<div class="set" data-id="${esc(s.id)}">
    ${s.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy">` : '<div style="height:56px"></div>'}
    <div class="t">${viewed.new.has('set:' + s.id) ? '' : '<span class="tagnew">NEW</span>'}${esc(s.name)}</div>
    <div class="m">${esc(s.serie?.name || '')} · ${esc(s.releaseDate)} · ${s.cardCount?.total ?? '?'}장</div></div>`).join('');
  if (activeTab === 'new') { krNew.forEach(x => viewed.new.add(x.key)); latestSets.forEach(s => viewed.new.add('set:' + s.id)); saveViewed(); updateBadges(); }
  if (!$('#setCards').children.length && latestSets[0]) showSet(latestSets[0].id);
}
$('#krNewList').addEventListener('click', e => {
  const b = e.target.closest('[data-q]'); if (!b) return;
  showTab('price');
  const i = +b.dataset.hit;
  if (i >= 0) showHits(i); else { $('#q').value = b.dataset.q; search(b.dataset.q); }
});
$('#showGoods').addEventListener('change', renderNew);
$('#setList').addEventListener('click', e => { const s = e.target.closest('.set'); if (s) showSet(s.dataset.id); });
async function showSet(id) {
  const s = latestSets.find(x => x.id === id); if (!s) return;
  document.querySelectorAll('.set').forEach(el => el.classList.toggle('sel', el.dataset.id === id));
  $('#setCardsTitle').hidden = false; $('#setCardsTitle').textContent = `${s.name} 수록 카드 (희귀도 높은 카드부터)`;
  const box = $('#setCards'); box.innerHTML = '';
  // 번호가 큰 카드(시크릿/일러스트 레어)가 보통 비싸므로 역순으로 보여줌
  [...s.cards].reverse().slice(0, 60).forEach(c => box.appendChild(cardTile({ ...c, set: { name: s.name, id: s.id } }, { noPrice: true })));
}

// ---------- 카드샵 ----------
let map, layer, center = { lat: 37.5665, lon: 126.978, label: '서울시청' };
function initMap() {
  if (map || !window.L) return;
  map = L.map('map').setView([center.lat, center.lon], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', e => { center = { lat: e.latlng.lat, lon: e.latlng.lng, label: '선택한 위치' }; findShops(); });
}
const dist = (a, b) => { const R = 6371e3, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
function mapLinks() {
  const area = center.label && !['선택한 위치', '내 위치'].includes(center.label) ? center.label.split(',')[0] + ' ' : '';
  const q = encodeURIComponent(area + '포켓몬카드샵');
  $('#mapLinks').innerHTML = `
    <a target="_blank" rel="noopener" href="https://map.naver.com/p/search/${q}?c=${center.lon},${center.lat},15,0,0,0,dh">네이버지도</a>
    <a target="_blank" rel="noopener" href="https://map.kakao.com/?q=${q}">카카오맵</a>
    <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/${encodeURIComponent('포켓몬 카드샵')}/@${center.lat},${center.lon},15z">구글지도</a>`;
}
async function findShops() {
  initMap(); mapLinks();
  const r = +$('#radiusSel').value;
  map.setView([center.lat, center.lon], r > 7000 ? 11 : r > 3000 ? 12 : 14);
  layer.clearLayers();
  L.circle([center.lat, center.lon], { radius: r, color: '#e3350d', weight: 1, fillOpacity: .05 }).addTo(layer);
  L.circleMarker([center.lat, center.lon], { radius: 7, color: '#fff', fillColor: '#1f6feb', fillOpacity: 1, weight: 2 }).addTo(layer).bindPopup(esc(center.label));
  $('#shopHint').textContent = `"${center.label}" 주변 카드샵 검색 중…`; $('#shopList').innerHTML = '';
  try {
    const shops = await json(`/api/shops?lat=${center.lat}&lon=${center.lon}&r=${r}`);
    shops.forEach(s => s.d = dist(center, s));
    shops.sort((a, b) => (b.tcg - a.tcg) || a.d - b.d);
    $('#shopHint').textContent = shops.length
      ? `${shops.length}곳 발견 (OpenStreetMap 기준 · 노란 표시는 카드 전문점). 지도에 없는 매장은 네이버/카카오 지도에서 확인하세요.`
      : '이 반경에는 등록된 매장이 없어요. 반경을 넓히거나 네이버/카카오 지도 링크를 이용하세요.';
    $('#shopList').innerHTML = shops.map((s, i) => `<li class="shop" data-i="${i}">
      <a href="https://map.naver.com/p/search/${encodeURIComponent(s.name)}?c=${s.lon},${s.lat},17,0,0,0,dh" target="_blank" rel="noopener">${esc(s.name)}</a>${s.tcg ? '<span class="tcg">카드</span>' : ''}
      <div class="m">${(s.d / 1000).toFixed(1)}km${s.addr ? ' · ' + esc(s.addr) : ''}${s.hours ? ' · 🕒 ' + esc(s.hours) : ''}${s.phone ? ' · ☎ ' + esc(s.phone) : ''}</div></li>`).join('');
    shops.forEach((s, i) => {
      L.circleMarker([s.lat, s.lon], { radius: s.tcg ? 9 : 6, color: '#222', weight: 1, fillColor: s.tcg ? '#ffcb05' : '#e3350d', fillOpacity: .95 })
        .addTo(layer).bindPopup(`<b>${esc(s.name)}</b><br>${(s.d / 1000).toFixed(1)}km`);
    });
    $('#shopList').onclick = e => { const li = e.target.closest('li'); if (li && e.target.tagName !== 'A') { const s = shops[+li.dataset.i]; map.setView([s.lat, s.lon], 17); } };
  } catch {
    $('#shopHint').textContent = '지도 데이터 서버(OpenStreetMap)가 응답하지 않아요. 위의 네이버지도·카카오맵 버튼으로 바로 찾아보세요.';
  }
}
$('#placeForm').addEventListener('submit', async e => {
  e.preventDefault(); const q = $('#placeQ').value.trim(); if (!q) return;
  try {
    const r = await json('/api/geocode?q=' + encodeURIComponent(q));
    if (!r.length) return toast('장소를 찾지 못했어요.');
    center = { lat: r[0].lat, lon: r[0].lon, label: q }; findShops();
  } catch { toast('장소 검색 실패'); }
});
$('#myLocBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('이 브라우저는 위치를 지원하지 않아요.');
  navigator.geolocation.getCurrentPosition(p => { center = { lat: p.coords.latitude, lon: p.coords.longitude, label: '내 위치' }; findShops(); },
    () => toast('위치 권한이 없어요. 지역 이름으로 검색해 주세요.'), { enableHighAccuracy: true, timeout: 10000 });
});
$('#radiusSel').addEventListener('change', () => map && findShops());

// ---------- 알림 ----------
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 5000);
}
function notify(title, body, tab, link) {
  toast(`${title} — ${body}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, icon: 'icon.svg', tag: title + body });
      n.onclick = () => { window.focus(); if (link) window.open(link, '_blank'); else if (tab) showTab(tab === 'price' ? 'price' : tab); n.close(); };
    } catch {}
  }
}
function askPermissionSoft() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(updatePerm);
}
function updatePerm() {
  const p = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#permState').textContent = { granted: '✅ 브라우저 알림이 켜져 있어요.', denied: '🚫 알림이 차단되어 있어요. 주소창 왼쪽 자물쇠 → 알림 허용으로 바꿔 주세요.', default: '알림을 받으려면 아래 버튼을 눌러 허용해 주세요.', unsupported: '이 브라우저는 알림을 지원하지 않아요(앱 안 알림만 표시).' }[p];
  $('#permBtn').hidden = p !== 'default';
  $('#bellDot').hidden = p === 'granted';
}
$('#bellBtn').onclick = () => {
  $('#optEvents').checked = settings.events; $('#optNew').checked = settings.newCards; $('#optPrice').checked = settings.price;
  $('#optPct').value = settings.pct; $('#optInterval').value = settings.interval; $('#optBasis').value = settings.basis; updatePerm(); $('#settingsDlg').showModal();
};
$('#permBtn').onclick = () => Notification.requestPermission().then(updatePerm);
$('#testNotify').onclick = () => notify('🔔 포켓카드 레이더', '알림이 정상적으로 동작해요!');
$('#settingsDlg').addEventListener('close', () => {
  Object.assign(settings, { events: $('#optEvents').checked, newCards: $('#optNew').checked, price: $('#optPrice').checked, pct: +$('#optPct').value, interval: +$('#optInterval').value, basis: $('#optBasis').value });
  if (board) drawBoard(board.hitsKey); // 시세 기준이 바뀌면 다시 그림
  store.set('settings', settings); schedule();
});

let timer;
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { checkEvents(); checkNew(); checkWatch(); }, settings.interval * 60000);
}
function updateBadges() {
  const ev = eventItems.filter(x => !viewed.events.has(x.key)).length;
  const nw = krNew.filter(x => !viewed.new.has(x.key)).length + latestSets.filter(s => !viewed.new.has('set:' + s.id)).length;
  const set = (id, n) => { const b = $(id); b.hidden = !n; b.textContent = n > 99 ? '99+' : n; };
  set('#badge-events', ev); set('#badge-new', nw);
}

// ---------- 탭 ----------
let activeTab = 'price';
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'events') renderEvents();
  if (name === 'new') renderNew();
  if (name === 'shops') { initMap(); setTimeout(() => map.invalidateSize(), 50); if (!layer.getLayers().length) findShops(); }
  store.set('tab', name);
  scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
document.querySelectorAll('[data-refresh]').forEach(b => b.onclick = () => b.dataset.refresh === 'events' ? checkEvents(true) : checkNew(true));

$('#searchForm').addEventListener('submit', e => { e.preventDefault(); search($('#q').value); });
$('#sortSel').addEventListener('change', renderResults);
// ---------- 세트별 힛카드 ----------
const { HIT_SETS, EN_SET } = window.PCR_SHARED; // public/shared.js
const HIT_SHOW = 8; // 처음엔 8개만, '더보기'로 전체
let hitsExpanded = false;
function renderHitChips(active) {
  const chip = i => `<button class="chip hot ${i === active ? 'on' : ''}" type="button" data-i="${i}">${esc(HIT_SETS[i].label)}</button>`;
  const toggle = `<button class="chip more" type="button" data-more="1">${hitsExpanded ? '접기 ▲' : `+${HIT_SETS.length - HIT_SHOW}개 세트 더보기 ▼`}</button>`;
  if (!hitsExpanded) {
    const idx = [...Array(HIT_SHOW).keys()];
    if (active >= HIT_SHOW) idx.push(active); // 선택한 세트는 접어도 보이게
    $('#hitChips').innerHTML = idx.map(chip).join('') + toggle;
    return;
  }
  // 펼치면 시리즈별로 묶어서 표시
  const series = [...new Set(HIT_SETS.map(x => x.s))];
  $('#hitChips').innerHTML = series.map(name => `<div class="series"><span class="series-name">${esc(name)}</span>${HIT_SETS.map((x, i) => x.s === name ? chip(i) : '').join('')}</div>`).join('') + toggle;
}
let activeHit = 0;
$('#hitChips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  if (b.dataset.more) { hitsExpanded = !hitsExpanded; return renderHitChips(activeHit); }
  showHits(+b.dataset.i);
});
function showHits(i) {
  const s = HIT_SETS[i]; activeHit = i; renderHitChips(i);
  $('#globalBox').hidden = true;
  priceBoard({ title: `🔥 ${esc(s.label)} 힛카드`, sub: '(시세 높은 순 · 판별로 보기)', q: s.q, hitsKey: s.q });
}
renderHitChips(0);

// ---------- 최근 검색 (따로 저장) ----------
let searchHistory = store.get('history', []);
function addHistory(q) {
  searchHistory = [q, ...searchHistory.filter(h => h !== q)].slice(0, 10);
  store.set("history", searchHistory); renderHistory();
}
function renderHistory() {
  $('#historyRow').hidden = !searchHistory.length;
  $('#historyChips').innerHTML = searchHistory.map(h => `<button class="chip" type="button" data-q="${esc(h)}">${esc(h)}<span class="x" data-del="${esc(h)}" title="삭제">×</span></button>`).join('')
    + (searchHistory.length ? '<button class="chip clear" type="button" data-clear="1">전체 삭제</button>' : '');
}
$('#historyChips').addEventListener('click', e => {
  const del = e.target.closest('[data-del]'), clr = e.target.closest('[data-clear]'), b = e.target.closest('[data-q]');
  if (del) { searchHistory = searchHistory.filter(h => h !== del.dataset.del); store.set("history", searchHistory); return renderHistory(); }
  if (clr) { searchHistory = []; store.set("history", searchHistory); return renderHistory(); }
  if (b) { $('#q').value = b.dataset.q; search(b.dataset.q); }
});
renderHistory();

// ---------- 시작 ----------
(async function start() {
  // data/meta.json이 있으면 정적 모드(GitHub Pages)
  const meta = await fetch('data/meta.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (meta) {
    STATIC = true;
    const d = new Date(meta.updated);
    $('.brand').insertAdjacentHTML('beforeend', `<small class="updated" title="GitHub Actions가 자동으로 모은 데이터">시세 갱신 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</small>`);
  }
  renderWatch(); updatePerm();
  await Promise.all([loadFx(), loadNames(), loadSets().catch(() => {}), loadBalls()]);
  renderWatch();
  checkEvents(); checkNew(); checkWatch();
  schedule();
  showHits(0); // 첫 화면: 30주년 힛카드
  const t = store.get('tab', 'price'); if (t !== 'price') showTab(t);
})();
