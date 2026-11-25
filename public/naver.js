// 네이버 쇼핑 실시간 판매가 → 카드별 시세로 묶기
// 중계 서버(worker/naver-proxy.js) 주소는 config.js의 naverProxy에 넣음. 비어 있으면 사용 안 함.
(function (root) {
const CFG = root.PCR_CONFIG || {};
const PROXY = (CFG.naverProxy || '').replace(/\/$/, '');

// 카드 1장이 아닌 상품(박스·팩·용품·묶음), 다른 판(일본·영문), 감정 카드는 제외
const JUNK = /박스|BOX|미개봉|낱팩|\d+\s*팩|부스터|슬리브|실드|플레이\s?매트|매트|케이스|탑로더|바인더|파일|앨범|일괄|랜덤|뽑기|가챠|럭키|복권|묶음|([2-9]|\d{2,})\s*장|\d+\s*종|세트판매|프로텍터|코인|데미지|마커|굿즈|스티커|피규어|인형|키링|일본판|일판|일본어|일본\s?정품|JPN|\bJP\b|영문|영어판|북미|미국판|ENG|중국|중문|중판|PSA|BRG|BGS|CGC|감정|그레이딩|구매대행|해외/i;
const RAR_RE = /(?:^|[^A-Z])(MUR|BWR|FUR|RGB|UR|SAR|SSR|CSR|CHR|HR|SR|AR|ACE|RRR|RR|PR)(?![A-Z])/;
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const norm = s => String(s || '').replace(/[\s「」『』\[\]()·.\-_]/g, '').toLowerCase();
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

// 같은 검색어는 10분 동안 브라우저에도 보관 (빠른 재표시 + 호출 절약)
const mem = new Map();
async function shop(q, sort = 'sim') {
  const key = `nv:${sort}:${q}`;
  if (mem.has(key)) return mem.get(key);
  try { const c = JSON.parse(sessionStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 600000) { mem.set(key, Promise.resolve(c.items)); return c.items; } } catch {}
  const p = fetch(`${PROXY}/shop?q=${encodeURIComponent(q)}&sort=${sort}`).then(async r => {
    if (!r.ok) throw new Error('naver ' + r.status);
    const items = ((await r.json()).items || []).map(x => ({
      title: strip(x.title), price: +x.lprice || 0, img: x.image || '', link: x.link || '', mall: x.mallName || '',
    }));
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), items })); } catch {}
    return items;
  });
  mem.set(key, p);
  p.catch(() => mem.delete(key));
  return p;
}

let namesByLen = [];
function setNames(koNames) { namesByLen = [...new Set(koNames)].filter(Boolean).sort((a, b) => b.length - a.length); }
// 한 글자 이름(뮤 등)은 다른 단어 속 글자와 헷갈리지 않게 앞뒤가 한글이 아닐 때만 인정
const findName = (t, n) => {
  if (n.length > 1) return t.indexOf(n);
  const m = new RegExp(`(^|[^가-힣])${n}(?![가-힣])`).exec(t);
  return m ? m.index + m[1].length : -1;
};

// 상품 제목에서 카드 이름 찾기: 포켓몬 이름(+메가·ex·V 등) → 없으면 "○○의 ○○" 같은 트레이너스 카드 이름
function cardName(t) {
  for (const n of namesByLen) {
    const i = findName(t, n);
    if (i < 0) continue;
    const pre = /(메가|빛나는|알로라|가라르|히스이|팔데아|다크)\s?$/.exec(t.slice(Math.max(0, i - 5), i));
    const xy = pre?.[1] === '메가' ? /^\s*([XY])(?![A-Za-z])/.exec(t.slice(i + n.length)) : null; // 메가리자몽X
    const rest = t.slice(i + n.length + (xy ? xy[0].length : 0));
    const suf = /^\s*(ex|EX|GX|VMAX|VSTAR|V|BREAK|LV\.X)(?![A-Za-z])/.exec(rest);
    return `${pre ? pre[1] + ' ' : ''}${n}${xy ? xy[1] : ''}${suf ? ' ' + suf[1] : ''}`.replace(/^(메가) /, '$1');
  }
  const tr = /([가-힣]{1,6}의\s?[가-힣]{2,6})/.exec(t);
  return tr ? tr[1] : '';
}
function rarityOf(t) {
  if (/마스터\s?볼/.test(t)) return '마스터볼';
  if (/몬스터\s?볼/.test(t)) return '몬스터볼';
  const m = RAR_RE.exec(t.toUpperCase());
  if (m) return m[1];
  return /복각/.test(t) ? '복각' : '';
}

// 판매 글들을 같은 카드(이름+등급)끼리 묶어 시세 계산. 너무 싸거나 비싼 글(오기재·다른 상품)은 중앙값 기준으로 제외
function group(items, { setKeys = [], needRarity = true, setLabel = '' } = {}) {
  const groups = new Map();
  for (const it of items) {
    const t = it.title;
    if (!it.price || JUNK.test(t)) continue;
    if (setKeys.length && !setKeys.some(k => norm(t).includes(k))) continue;
    const rar = rarityOf(t);
    if (needRarity && !rar) continue;
    const name = cardName(t);
    if (!name) continue;
    const key = `${name}|${rar}`;
    if (!groups.has(key)) groups.set(key, { name, rar, items: [] });
    groups.get(key).items.push(it);
  }
  const cards = [];
  for (const [key, g] of groups) {
    const m0 = median(g.items.map(x => x.price));
    const ok = g.items.filter(x => x.price >= m0 * 0.4 && x.price <= m0 * 2.5);
    if (!ok.length) continue;
    const prices = ok.map(x => x.price), med = median(prices);
    const pic = ok.slice().sort((a, b) => Math.abs(a.price - med) - Math.abs(b.price - med))[0];
    const nums = {}; ok.forEach(x => { const n = /\b(\d{2,3}\/\d{2,3})\b/.exec(x.title)?.[1]; if (n) nums[n] = (nums[n] || 0) + 1; });
    const num = Object.entries(nums).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; // 판매 글에 가장 많이 적힌 카드 번호
    const q = [g.name, g.rar, setLabel].filter(Boolean).join(' ');
    cards.push({
      id: 'nv:' + norm(setLabel) + ':' + key, ed: 'kr', source: 'naver',
      name: g.name, set: setLabel || '네이버 쇼핑', number: num,
      rarity: g.rar, chips: g.rar ? [g.rar] : [],
      img: '', imgAlt: pic.img, imgAltLabel: '판매 사진',
      url: `https://search.shopping.naver.com/search/all?query=${encodeURIComponent('포켓몬카드 ' + q)}`,
      price: med,
      nv: { low: Math.min(...prices), high: Math.max(...prices), median: med, count: ok.length, malls: [...new Set(ok.map(x => x.mall))].slice(0, 3) },
    });
  }
  return cards.sort((a, b) => b.price - a.price);
}

const HIT_RARITIES = ['SAR', 'SR', 'UR', 'AR', 'MUR', 'BWR', 'CHR', 'CSR', 'HR', 'SSR', 'RGB', 'FUR', '복각', '마스터볼'];
// 세트 힛카드: "포켓몬카드 <세트> <등급>"을 여러 번 검색해 합친 뒤 묶음
async function setCards(set) {
  const label = set.label, keys = [...new Set([norm(set.label), norm(set.q)])];
  if (/30주년|30th/i.test(label + set.q)) keys.push('30주년', '30th');
  const qs = [`포켓몬카드 ${label}`, ...HIT_RARITIES.map(r => `포켓몬카드 ${label} ${r}`)];
  const res = await Promise.all(qs.map(q => shop(q).catch(() => [])));
  const seen = new Set(), all = [];
  for (const it of res.flat()) { if (!seen.has(it.link)) { seen.add(it.link); all.push(it); } }
  return group(all, { setKeys: keys, setLabel: label });
}
// 카드 검색: "리자몽 ex SAR" → 판매 글을 카드(이름+등급)별로 묶음
async function searchCards(q, grade) {
  const qq = `포켓몬카드 ${q}${grade ? ' ' + grade : ''}`;
  const res = await Promise.all([shop(qq), shop(qq, 'asc')].map(p => p.catch(() => [])));
  const seen = new Set(), all = [];
  for (const it of res.flat()) { if (!seen.has(it.link)) { seen.add(it.link); all.push(it); } }
  const k = norm(q.split(/\s+/)[0]);
  return group(all.filter(it => norm(it.title).includes(k)), { needRarity: false, setLabel: '' })
    .filter(c => !grade || c.rarity === grade);
}

root.Naver = { enabled: !!PROXY, shop, setNames, setCards, searchCards, _group: group, _cardName: cardName, _rarityOf: rarityOf };
})(typeof window !== 'undefined' ? window : globalThis);
