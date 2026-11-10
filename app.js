'use strict';

const API = 'https://api.scryfall.com';
const DECKS_KEY = 'sparkritual.decks.v2';
const LEGACY_KEY = 'sparkritual.deck.v1';

// Carry over data saved under the old "deckbench." key prefix.
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('deckbench.')) continue;
    const nk = 'sparkritual.' + k.slice('deckbench.'.length);
    if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch { /* storage unavailable */ }
const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest']);
const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
const TYPE_PRIORITY = ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'];
const COLOR_ORDER = ['Colorless', 'White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Land'];
const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

const state = {
  id: null,
  name: 'Untitled Deck',
  description: '',
  music: '',
  visibility: 'private',
  commanders: [],      // normalized cards
  cards: {},           // id -> { card, qty }
  sort: 'type',
};
const cache = new Map(); // id -> normalized card (for hover lookups)
const search = { url: null, token: 0, text: '', list: [] };
let partnerToken = 0;

const $ = id => document.getElementById(id);
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const unlimitedCache = new WeakMap(); // card -> bool (the regex ran on every call before)
const isUnlimited = c => {
  let u = unlimitedCache.get(c);
  if (u === undefined) { u = BASICS.has(c.name) || /any number of cards named/i.test(c.oracle_text); unlimitedCache.set(c, u); }
  return u;
};
const nameClause = t => t ? ` name:${/\s/.test(t) ? JSON.stringify(t) : t}` : '';

/* ---------- Scryfall helpers ---------- */

function normalize(c) {
  const faceSrc = c.card_faces && c.card_faces[0].image_uris ? c.card_faces : [c];
  const faces = faceSrc.map(f => ({
    name: f.name,
    image: (f.image_uris || c.image_uris || {}).normal || '',
    small: (f.image_uris || c.image_uris || {}).small || '',
    mana_cost: f.mana_cost || '',
    type_line: f.type_line || c.type_line || '',
    oracle_text: f.oracle_text || '',
    power: f.power, toughness: f.toughness, loyalty: f.loyalty,
  }));
  const colors = c.colors || (c.card_faces && c.card_faces[0].colors) || [];
  return {
    id: c.id, name: c.name, cmc: c.cmc || 0,
    mana_cost: c.mana_cost || faces[0].mana_cost,
    type_line: c.type_line, colors,
    color_identity: c.color_identity || [],
    keywords: c.keywords || [],
    oracle_text: (c.card_faces ? c.card_faces.map(f => f.oracle_text || '').join('\n') : c.oracle_text) || '',
    faces, set: (c.set || '').toUpperCase(), set_name: c.set_name, rarity: c.rarity,
    collector: c.collector_number || '', released: c.released_at || '',
    prices: c.prices ? { usd: c.prices.usd || c.prices.usd_foil } : {},
    legal: c.legalities && c.legalities.commander,
    game_changer: !!c.game_changer,
  };
}

async function scry(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 404) return { data: [], next_page: null };
    throw new Error(data.details || 'Scryfall request failed');
  }
  data.data = data.data.map(normalize);
  data.data.forEach(c => cache.set(c.id, c));
  return data;
}

async function collection(identifiers) {
  const res = await fetch(`${API}/cards/collection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error('Scryfall request failed');
  const cards = (await res.json()).data.map(normalize);
  cards.forEach(c => cache.set(c.id, c));
  return cards;
}

const searchUrl = q => `${API}/cards/search?unique=cards&order=name&q=${encodeURIComponent(q)}`;
const debounce = (fn, ms) => {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
};

const symbolCache = new Map(); // mana costs and rules lines repeat constantly across renders
function symbols(text) {
  let out = symbolCache.get(text);
  if (out === undefined) {
    out = esc(text).replace(/\{([^}]+)\}/g, (_, s) => {
      const code = s.replace('/', '');
      return `<img class="sym" alt="{${s}}" src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(code)}.svg">`;
    });
    if (symbolCache.size > 3000) symbolCache.clear();
    symbolCache.set(text, out);
  }
  return out;
}

const identitySymbols = ids => symbols(ids.length ? ids.map(x => `{${x}}`).join('') : '{C}');

/* ---------- Commander / partner rules ---------- */

const hasKw = (c, k) => c.keywords.some(keyword => keyword.toLowerCase() === k.toLowerCase());
const isBackground = c => /\bBackground\b/.test(c.type_line);
const isDoctor = c => /Time Lord Doctor/.test(c.type_line);
const partnerWithName = c => hasKw(c, 'Partner with') ? (c.oracle_text.match(/Partner with ([^\n(]+)/) || [])[1]?.trim() : null;

function canPair(a, b) {
  if (a.id === b.id) return false;
  if (hasKw(a, 'Partner') && hasKw(b, 'Partner')) return true;
  const pa = partnerWithName(a), pb = partnerWithName(b);
  if (pa && pa === b.name) return true;
  if (pb && pb === a.name) return true;
  if (hasKw(a, 'Choose a Background') && isBackground(b)) return true;
  if (hasKw(b, 'Choose a Background') && isBackground(a)) return true;
  if (hasKw(a, 'Friends forever') && hasKw(b, 'Friends forever')) return true;
  if (isDoctor(a) && hasKw(b, "Doctor's companion")) return true;
  if (isDoctor(b) && hasKw(a, "Doctor's companion")) return true;
  return false;
}

function pairQuery(a) {
  const parts = [];
  if (hasKw(a, 'Partner')) parts.push('keyword:partner');
  const pw = partnerWithName(a);
  if (pw) parts.push(`!"${pw}"`);
  if (hasKw(a, 'Choose a Background')) parts.push('t:background');
  if (isBackground(a)) parts.push('keyword:"choose a background"');
  if (hasKw(a, 'Friends forever')) parts.push('keyword:"friends forever"');
  if (isDoctor(a)) parts.push(`keyword:"doctor's companion"`);
  if (hasKw(a, "Doctor's companion")) parts.push('t:"time lord doctor"');
  return parts.length ? `(${parts.join(' or ')})` : null;
}

let identityKey = '', identityCache = [];
function identity() {
  const key = state.commanders.map(c => c.id).join();
  if (key !== identityKey) {
    const set = new Set(state.commanders.flatMap(c => c.color_identity));
    identityCache = 'WUBRG'.split('').filter(x => set.has(x));
    identityKey = key;
  }
  return identityCache;
}

const inIdentity = c => c.color_identity.every(x => identity().includes(x));

function secondSlotAvailable() {
  return state.commanders.length === 1 && pairQuery(state.commanders[0]) !== null;
}

/* ---------- Bracket estimate ---------- */

const BRACKET_NAMES = { 2: 'Core', 3: 'Upgraded', 4: 'Optimized', 5: 'cEDH' };
const GC_ICON = '<span class="gc" title="Game Changer">&#9670;</span>';
const LAND_WORDS = /\b(land|plains|island|swamp|mountain|forest)\b/i;

function isTutor(text) {
  const m = text.match(/search your library for ([^.]*)/i);
  return !!m && !/\bnamed\b/i.test(m[1]) && !LAND_WORDS.test(m[1]);
}

// The regex tests only depend on the card, so run them once per card object.
const flagCache = new WeakMap();
function cardFlags(card) {
  let f = flagCache.get(card);
  if (!f) {
    const t = card.oracle_text;
    f = {
      extra: /takes? an extra turn|extra turns? after this one/i.test(t),
      mld: /destroy (all|each) lands?|each player sacrifices? [^.]*lands?/i.test(t),
      tutor: isTutor(t),
    };
    flagCache.set(card, f);
  }
  return f;
}

// Heuristic only: counts Game Changers, extra-turn cards, mass land denial and tutors.
function estimateBracket(commanders = state.commanders, cards = state.cards) {
  const entries = [...commanders.map(card => ({ card, qty: 1 })), ...Object.values(cards)];
  const gcNames = [];
  let extra = 0, mld = 0, tutors = 0;
  for (const { card, qty } of entries) {
    const f = cardFlags(card);
    if (card.game_changer) gcNames.push(card.name);
    if (f.extra) extra += qty;
    if (f.mld) mld += qty;
    if (f.tutor) tutors += qty;
  }
  const gc = gcNames.length;
  let level;
  if (gc > 3) level = gc >= 6 && tutors >= 5 ? 5 : 4;
  else if (mld || extra >= 3) level = 4;
  else if (gc || extra || tutors >= 3) level = 3;
  else level = 2;
  const notes = [`${gc} Game Changer${gc === 1 ? '' : 's'}${gc ? ': ' + gcNames.join(', ') : ''}`,
    `${extra} extra-turn, ${mld} land-denial, ${tutors} tutor cards`, 'Rough estimate only'];
  return { level, gc, notes: notes.join(' | ') };
}

/* ---------- Deck model ---------- */

const totalCards = () => state.commanders.length + Object.values(state.cards).reduce((n, e) => n + e.qty, 0);

function refreshDeck(research) {
  persist(); renderDeck();
  if (research) runSearch(); else renderResultStates();
}

function addCard(card) {
  if (!state.commanders.length || !inIdentity(card)) return;
  const e = Object.values(state.cards).find(x => x.card.name === card.name);
  if (e) { if (isUnlimited(card)) e.qty++; }
  else state.cards[card.id] = { card, qty: 1 };
  refreshDeck();
}

function changeQty(id, d) {
  const e = state.cards[id];
  if (!e) return;
  e.qty += d;
  if (e.qty <= 0) delete state.cards[id];
  refreshDeck();
}

let decks = {}; // id -> { id, name, commanders, cards, sort, updated }

// Writes are coalesced: stringifying every deck on each edit is expensive.
let saveTimer = 0;
function writeDecks() {
  clearTimeout(saveTimer); saveTimer = 0;
  try { localStorage.setItem(DECKS_KEY, JSON.stringify(decks)); } catch { /* storage full */ }
}
function saveDecks() { if (!saveTimer) saveTimer = setTimeout(writeDecks, 400); }
const flushDecks = () => { if (saveTimer) writeDecks(); };
addEventListener('pagehide', flushDecks);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDecks(); });

function persist() {
  if (!state.id) return;
  const { id, name, description, music, visibility, commanders, cards, sort } = state;
  const owner = (decks[id] && decks[id].owner) || (Cloud.user && Cloud.user.id) || undefined;
  decks[id] = { id, name, description, music, visibility, owner, commanders, cards, sort, updated: Date.now() };
  saveDecks();
  if (owner) queueCloud(id);
}

function loadDecks() {
  try { decks = JSON.parse(localStorage.getItem(DECKS_KEY)) || {}; } catch { decks = {}; }
  // Carry over the single deck saved by earlier versions.
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (old && (old.commanders || []).length) {
      const id = newId();
      decks[id] = { id, name: old.name || 'Untitled Deck', commanders: old.commanders, cards: old.cards || {}, sort: old.sort || 'type', updated: Date.now() };
      writeDecks(); // immediate: the legacy key is removed right after
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore corrupt data */ }
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function createDeck(name, commanders, cards = {}) {
  const id = newId();
  const owner = Cloud.user ? Cloud.user.id : undefined;
  decks[id] = { id, name, commanders, cards, sort: 'type', visibility: 'private', owner, updated: Date.now() };
  saveDecks();
  if (owner) queueCloud(id);
  location.hash = `deck=${id}`;
}

function openDeck(id) {
  const d = decks[id];
  Object.assign(state, { id, name: d.name, description: d.description || '', music: d.music || '', visibility: d.visibility || 'private', commanders: d.commanders || [], cards: d.cards || {}, sort: d.sort || 'type' });
  [...state.commanders, ...Object.values(state.cards).map(e => e.card)].forEach(c => cache.set(c.id, c));
  document.body.classList.remove('home');
  setMusic(null);
  showDeckTitle();
  $('searchInput').value = '';
  closeDrop();
  previewCard = null; selectedCard = null;
  dealHand();
  showDefaultPreview();
  renderDeck();
  runSearch();
  refreshStale();
}

function showHome() {
  persist();
  state.id = null;
  document.body.classList.add('home');
  homeSel = 0;
  homeList = []; // start on the most recent deck rather than restoring the old selection
  renderHome();
}

function route() {
  const m = location.hash.match(/^#deck=(.+)$/);
  const shared = new URLSearchParams(location.search).get('d');
  if (shared && !m) return openShared(shared);
  if (document.body.classList.contains('shared')) { // leaving a shared page
    document.body.classList.remove('shared');
    sharedInfo = null;
    document.title = 'SparkRitual - Commander Deck Builder';
    history.replaceState(null, '', APP_URL + location.hash);
  }
  if (m && decks[m[1]]) openDeck(m[1]); else showHome();
}

let homeList = [], homeSel = 0, homeRadius = 0;
// homeTarget is where navigation is heading; homeSel walks toward it one slot at a time.
let homeTarget = 0, stepTimer = 0;
const homeSlides = new Map();
const STEP_MS = 160, CATCHUP_MS = 90; // pace for single steps vs. catching up on long jumps

function createHomeSlide(i) {
  const d = homeList[i];
  const img = d.commanders[0] && d.commanders[0].faces[0].image;
  const slide = document.createElement('div');
  slide.className = 'slide';
  slide.dataset.i = i;
  slide.innerHTML = img ? `<img class="cover" src="${esc(img)}" alt="${esc(d.name)}" decoding="async" draggable="false"><div class="refl"><img src="${esc(img)}" alt="" decoding="async" draggable="false"></div>` : '<div class="cover blank"></div>';
  return slide;
}

// Side slides sit 0.3 card-widths apart, so only about half the carousel width / (0.3 * width)
// of them are visible per side. Keeping more alive just costs GPU layers.
function updateHomeRadius() {
  const carousel = $('carousel');
  const slide = homeSlides.values().next().value;
  const width = slide && parseFloat(getComputedStyle(slide).width);
  if (width > 0 && carousel.clientWidth > 0) homeRadius = Math.ceil(carousel.clientWidth / 2 / (width * 0.3)) + 2;
  else homeRadius = 8;
}

function stopStepping() {
  clearTimeout(stepTimer);
  stepTimer = 0;
  homeTarget = homeSel;
}

function renderHomeSlides() {
  const carousel = $('carousel');
  const start = Math.max(0, homeSel - homeRadius);
  const end = Math.min(homeList.length - 1, homeSel + homeRadius);
  for (const [i, slide] of homeSlides) {
    if (i < start || i > end) { slide.remove(); homeSlides.delete(i); }
  }
  for (let i = start; i <= end; i++) {
    let slide = homeSlides.get(i);
    if (!slide) {
      slide = createHomeSlide(i);
      homeSlides.set(i, slide);
      const next = [...carousel.children].find(child => +child.dataset.i > i);
      carousel.insertBefore(slide, next || null);
    }
    const o = i - homeSel, a = Math.abs(o), sign = Math.sign(o);
    slide.classList.toggle('sel', o === 0);
    if (!slide.style.zIndex) slide.style.zIndex = 100 - a; // new slides only; restack() owns it after that
    slide.style.transform = o === 0
      ? 'translateZ(calc(var(--w) * .26))'
      : `translateX(calc(${sign} * var(--w) * (0.75 + ${a - 1} * 0.3))) translateZ(calc(var(--w) * -.46)) rotateY(${-sign * 62}deg)`;
  }
  trackStacking();
}

// Stacking follows where each card actually is on screen, not a timed z-index transition.
// A timed transition makes neighbours briefly share a z-index mid-step; the browser then breaks
// the tie by DOM order, which always favours the right-hand card, so scrolling left made the
// outgoing card flicker in front. Here, every frame while cards move, the card nearest the
// centre is on top, then the next nearest, and so on.
let zFrame = 0, zUntil = 0;
function trackStacking() {
  zUntil = performance.now() + 650; // a little past the 450ms transition
  if (!zFrame) zFrame = requestAnimationFrame(restack);
}
function restack() {
  const c = $('carousel').getBoundingClientRect(), cx = c.left + c.width / 2;
  [...homeSlides.values()]
    .map(el => { const r = el.getBoundingClientRect(); return [el, Math.abs(r.left + r.width / 2 - cx)]; })
    .sort((a, b) => a[1] - b[1])
    .forEach(([el], k) => { const z = String(100 - k); if (el.style.zIndex !== z) el.style.zIndex = z; });
  zFrame = performance.now() < zUntil && homeSlides.size ? requestAnimationFrame(restack) : 0;
}

function renderHome() {
  // Keep the same deck selected even if a sync or edit re-sorted the list.
  const keepId = homeList[homeSel] && homeList[homeSel].id;
  homeList = sortDecks(Object.values(decks));
  const kept = keepId ? homeList.findIndex(d => d.id === keepId) : -1;
  homeSel = Math.max(0, Math.min(kept >= 0 ? kept : homeSel, homeList.length - 1));
  stopStepping();
  closeDeckMenu();
  const carousel = $('carousel');
  homeSlides.clear();
  carousel.replaceChildren();
  $('deckInfo').innerHTML = '';
  $('home').dataset.view = homeView;
  if (homeView === 'gallery') return renderGallery();
  if (homeView === 'list') return renderList();
  if (!homeList.length) {
    // Empty card where the first deck will appear; it goes away as soon as a deck exists.
    carousel.innerHTML = `<div class="slide sel placeholder" role="button" tabindex="0" style="transform: translateZ(calc(var(--w) * .26))">
      <div class="cover blank"><span>Create a New Deck<br>to get started</span></div>
      <div class="refl"><div class="blank"></div></div></div>`;
    $('prevBtn').disabled = $('nextBtn').disabled = true;
    setMusic(null);
    return;
  }
  const selected = createHomeSlide(homeSel);
  homeSlides.set(homeSel, selected);
  carousel.appendChild(selected);
  updateHomeRadius();
  renderHomeSlides();
  renderInfo();
  playDeckMusic();
}

// Cover Flow: the selected deck faces front, the rest fan out rotated and receding.
// Every move is a single-slot step so z-index layering always animates in order;
// long jumps and key repeat just push the target further and the carousel walks to it.
function selectSlide(i) {
  if (!homeList.length) return;
  homeTarget = Math.max(0, Math.min(i, homeList.length - 1));
  if (!stepTimer) stepToward();
}

function stepToward() {
  if (!document.body.classList.contains('home') || homeView !== 'carousel' || homeTarget === homeSel) { stepTimer = 0; return; }
  const far = Math.abs(homeTarget - homeSel) > 1;
  closeDeckMenu();
  homeSel += Math.sign(homeTarget - homeSel);
  renderHomeSlides();
  renderInfo();
  playDeckMusic();
  stepTimer = setTimeout(stepToward, far ? CATCHUP_MS : STEP_MS);
}

// While resizing, slide positions track --w instantly instead of easing behind the window.
let resizeEnd = 0, resizeFrame = 0;
window.addEventListener('resize', () => {
  closeDeckMenu();
  if (!document.body.classList.contains('home') || homeView !== 'carousel' || !homeList.length) return;
  const carousel = $('carousel');
  carousel.classList.add('resizing');
  clearTimeout(resizeEnd);
  resizeEnd = setTimeout(() => carousel.classList.remove('resizing'), 150);
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    updateHomeRadius();
    renderHomeSlides();
  });
});

const bracketCache = new Map();
function deckBracket(d) {
  const key = `${d.id}:${d.updated}`;
  if (!bracketCache.has(key)) bracketCache.set(key, estimateBracket(d.commanders, d.cards));
  return bracketCache.get(key);
}

/* ---------- Carousel sorting ---------- */

const priceCache = new Map();
// Total value of the printings in the deck (commanders + every copy), using each printing's USD price.
function deckValue(d) {
  const key = `${d.id}:${d.updated}`;
  if (!priceCache.has(key)) {
    const entries = [...(d.commanders || []).map(card => ({ card, qty: 1 })), ...Object.values(d.cards || {})];
    priceCache.set(key, entries.reduce((sum, { card, qty }) => sum + (parseFloat(card.prices && card.prices.usd) || 0) * qty, 0));
  }
  return priceCache.get(key);
}

// Deck ids start with Date.now() in base 36 (see newId), so creation time comes free with every deck.
function deckCreated(d) {
  const t = parseInt(String(d.id).slice(0, 8), 36);
  return t > 1.4e12 && t < Date.now() + 864e5 ? t : (d.created || d.updated || 0);
}

const WUBRG = 'WUBRG';
// Colorless first, then mono W, U, B, R, G, then pairs (WU, WB, ...), and so on up to five colors.
function colorKey(d) {
  const ids = new Set((d.commanders || []).flatMap(c => c.color_identity || []));
  const idx = [...WUBRG].map((c, i) => ids.has(c) ? i : -1).filter(i => i >= 0);
  return [idx.length, ...idx];
}
const cmpArr = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = (a[i] ?? -1) - (b[i] ?? -1); if (x) return x; } return 0; };
const cmpText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const commanderName = d => (d.commanders || []).map(c => c.name).join(' + ');

// Each sort has a natural direction (desc = 1 means biggest/newest first); the topbar button reverses it.
const HOME_SORTS = {
  commander: { desc: 0, cmp: (a, b) => cmpText(commanderName(a) || '￿', commanderName(b) || '￿') },
  name:      { desc: 0, cmp: (a, b) => cmpText(a.name || '', b.name || '') },
  created:   { desc: 0, cmp: (a, b) => deckCreated(a) - deckCreated(b) },
  recent:    { desc: 1, cmp: (a, b) => a.updated - b.updated },
  color:     { desc: 0, cmp: (a, b) => cmpArr(colorKey(a), colorKey(b)) },
  bracket:   { desc: 0, cmp: (a, b) => deckBracket(a).level - deckBracket(b).level },
  cost:      { desc: 1, cmp: (a, b) => deckValue(a) - deckValue(b) },
};

let homeSort = { key: 'recent', reversed: false };
try {
  const saved = JSON.parse(localStorage.getItem('sparkritual.homeSort'));
  if (saved && HOME_SORTS[saved.key]) homeSort = { key: saved.key, reversed: !!saved.reversed };
} catch { /* keep default */ }

function sortDecks(list) {
  const s = HOME_SORTS[homeSort.key];
  const dir = (s.desc ? -1 : 1) * (homeSort.reversed ? -1 : 1);
  return list.sort((a, b) => dir * s.cmp(a, b) || cmpText(a.name || '', b.name || '') || (a.id < b.id ? -1 : 1));
}

function showHomeSort() {
  const s = HOME_SORTS[homeSort.key];
  const desc = !!s.desc !== homeSort.reversed;
  $('homeSort').value = homeSort.key;
  $('homeSortDir').textContent = desc ? '↓' : '↑';
  $('homeSortDir').title = `${desc ? 'Descending' : 'Ascending'}: click to reverse`;
}

function setHomeSort(key, reversed) {
  homeSort = { key, reversed };
  try { localStorage.setItem('sparkritual.homeSort', JSON.stringify(homeSort)); } catch { /* not critical */ }
  showHomeSort();
  if (document.body.classList.contains('home')) renderHome(); // renderHome keeps the selected deck in view
}

$('homeSort').addEventListener('change', e => setHomeSort(e.target.value, false));
$('homeSortDir').addEventListener('click', () => setHomeSort(homeSort.key, !homeSort.reversed));
showHomeSort();

const fmtUsd = n => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function renderInfo() {
  const d = homeList[homeSel];
  $('prevBtn').disabled = homeSel === 0;
  $('nextBtn').disabled = homeSel === homeList.length - 1;
  const br = deckBracket(d);
  // Show the value being sorted on when it isn't already one of the standard lines.
  const extra = { cost: ['Value', fmtUsd(deckValue(d))], created: ['Created', fmtDate(deckCreated(d))], recent: ['Last edited', fmtDate(d.updated)] }[homeSort.key];
  $('deckInfo').innerHTML = `<div class="info-text"><div class="title-row"><div class="title">${esc(d.name)}</div>${optsBtn(d)}</div>
    <div class="meta"><span class="lbl">Commander:</span> ${esc(commanderName(d))}</div>
    <div class="meta"><span class="lbl">Bracket:</span> ${br.level}</div>
    <div class="meta"><span class="lbl">Color Identity:</span> ${identitySymbols(deckIdentity(d))}</div>
    ${extra ? `<div class="meta"><span class="lbl">${extra[0]}:</span> ${esc(extra[1])}</div>` : ''}</div>`;
}

const deckIdentity = d => { const ids = new Set((d.commanders || []).flatMap(c => c.color_identity || [])); return [...WUBRG].filter(x => ids.has(x)); };
const deckCover = d => d.commanders && d.commanders[0] && d.commanders[0].faces[0].image;
const optsBtn = d => `<button class="opts-btn" data-deck-menu="${esc(d.id)}" aria-label="Options for ${esc(d.name)}" aria-haspopup="menu" aria-expanded="false">&#8943;</button>`;
const openDeckPage = d => { if (d) location.hash = `deck=${d.id}`; };

function activateSlide() { openDeckPage(homeList[homeSel]); }

function deleteDeck(d) {
  if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
  delete decks[d.id];
  lastPushed.delete(d.id);
  saveDecks();
  if (d.owner && Cloud.user) Cloud.removeDeck(d.id).catch(e => setSync('Online delete failed: ' + e.message, true));
  renderHome();
}

/* ---------- Deck options menu ("⋯" in every landing view) ---------- */

// One floating menu shared by every ⋯ button; the button's data-deck-menu holds the deck id.
// Add future deck actions here and handle them in the click listener below.
const deckMenu = document.createElement('div');
deckMenu.className = 'card-menu deck-menu';
deckMenu.hidden = true;
deckMenu.setAttribute('role', 'menu');
deckMenu.innerHTML = '<button role="menuitem" data-act="edit">Edit</button><button role="menuitem" class="danger" data-act="delete">Delete</button>';
document.body.appendChild(deckMenu);
let deckMenuFor = null; // the ⋯ button the menu belongs to

function openDeckMenu(btn) {
  closeDeckMenu();
  deckMenuFor = btn;
  btn.setAttribute('aria-expanded', 'true');
  deckMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  deckMenu.style.top = `${Math.min(r.bottom + 4, innerHeight - deckMenu.offsetHeight - 4)}px`;
  deckMenu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - deckMenu.offsetWidth - 4))}px`;
  deckMenu.querySelector('button').focus();
}
function closeDeckMenu(refocus = false) {
  if (deckMenu.hidden) return;
  deckMenu.hidden = true;
  if (deckMenuFor) {
    deckMenuFor.setAttribute('aria-expanded', 'false');
    if (refocus && deckMenuFor.isConnected) deckMenuFor.focus();
  }
  deckMenuFor = null;
}
const deckMenuOpen = () => !deckMenu.hidden;
document.addEventListener('pointerdown', e => {
  if (deckMenuOpen() && !deckMenu.contains(e.target) && !e.target.closest('[data-deck-menu]')) closeDeckMenu();
});
$('home').addEventListener('scroll', () => closeDeckMenu(), true); // the menu is fixed, so it would detach from its button
deckMenu.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const d = deckMenuFor && decks[deckMenuFor.dataset.deckMenu];
  closeDeckMenu();
  if (!d) return;
  if (act === 'edit') openDeckPage(d);
  else if (act === 'delete') deleteDeck(d);
});

/* ---------- Landing views: carousel (default), gallery, list ---------- */

const HOME_VIEWS = ['carousel', 'gallery', 'list'];
let homeView = 'carousel';
try {
  const saved = localStorage.getItem('sparkritual.homeView');
  if (HOME_VIEWS.includes(saved)) homeView = saved;
} catch { /* keep default */ }
$('homeView').value = homeView;
$('homeView').addEventListener('change', e => {
  homeView = HOME_VIEWS.includes(e.target.value) ? e.target.value : 'carousel';
  try { localStorage.setItem('sparkritual.homeView', homeView); } catch { /* not critical */ }
  $('home').scrollTop = 0;
  if (document.body.classList.contains('home')) renderHome();
});

function renderGallery() {
  setMusic(null);
  $('galleryView').innerHTML = homeList.length
    ? homeList.map((d, i) => {
      const img = deckCover(d);
      return `<div class="tile" data-i="${i}">
        <button class="tile-art" data-open title="Open ${esc(d.name)}">${img ? `<img src="${esc(img)}" alt="${esc(d.name)}" loading="lazy" decoding="async" draggable="false">` : '<div class="blank"></div>'}</button>
        <div class="tile-row"><div class="tile-text"><div class="tile-name">${esc(d.name)}</div><div class="tile-sub">${esc(commanderName(d))}</div></div>${optsBtn(d)}</div>
      </div>`;
    }).join('')
    : '<div class="tile"><button class="tile-art placeholder" data-new><span>Create a New Deck<br>to get started</span></button></div>';
}

// Columns map onto the sort keys, so clicking a header sorts by it (again to reverse).
const LIST_COLS = [
  ['name', 'Deck Name'], ['commander', 'Commander'], ['color', 'Color Identity'], ['bracket', 'Bracket'],
  ['cost', 'Value'], ['created', 'Created'], ['recent', 'Last Edited'],
];
let homePreview = { deck: null, face: 0 };

function renderList() {
  setMusic(null);
  const desc = !!HOME_SORTS[homeSort.key].desc !== homeSort.reversed;
  const head = LIST_COLS.map(([k, label]) => {
    const on = k === homeSort.key;
    return `<th class="c-${k}" aria-sort="${on ? (desc ? 'descending' : 'ascending') : 'none'}"><button data-sort="${k}">${label}<span class="dir">${on ? (desc ? '↓' : '↑') : ''}</span></button></th>`;
  }).join('');
  const body = homeList.length
    ? homeList.map((d, i) => `<tr data-i="${i}"${i === homeSel ? ' class="sel"' : ''}>
        <td class="c-name">${esc(d.name)}</td>
        <td class="c-commander">${esc(commanderName(d))}</td>
        <td class="c-color">${identitySymbols(deckIdentity(d))}</td>
        <td class="c-bracket">${deckBracket(d).level}</td>
        <td class="c-cost">${fmtUsd(deckValue(d))}</td>
        <td class="c-created">${fmtDate(deckCreated(d))}</td>
        <td class="c-recent">${fmtDate(d.updated)}</td>
        <td class="c-opts">${optsBtn(d)}</td>
      </tr>`).join('')
    : `<tr><td colspan="${LIST_COLS.length + 1}" class="list-empty">No decks yet. <button data-new>Create a New Deck</button> to get started.</td></tr>`;
  $('deckTable').innerHTML = `<thead><tr>${head}<th class="c-opts"><span class="sr-only">Options</span></th></tr></thead><tbody>${body}</tbody>`;
  homePreview = { deck: null, face: 0 }; // force a redraw (null never matches a deck or the empty-list undefined)
  showHomePreview(homeList[homeSel]);
}

// The list's preview panel shows the deck's commander, like the builder's card preview.
// Without an explicit face, re-showing the deck already on screen is a no-op (keeps a flipped card flipped).
function showHomePreview(d, face) {
  if (homePreview.deck === d && (face === undefined || homePreview.face === face)) return;
  face = face || 0;
  homePreview = { deck: d, face };
  const c = d && d.commanders && d.commanders[0];
  $('homePreview').innerHTML = c
    ? previewHtml(c, face, { identity: true })
    : `<div class="preview-empty">${homeList.length ? 'Hover over a deck to preview its commander.' : 'Your decks will appear here.'}</div>`;
}

function selectListRow(i) {
  if (!homeList.length) return;
  homeSel = homeTarget = Math.max(0, Math.min(i, homeList.length - 1));
  const rows = $('deckTable').tBodies[0].rows;
  for (const r of rows) r.classList.toggle('sel', +r.dataset.i === homeSel);
  if (rows[homeSel]) rows[homeSel].scrollIntoView({ block: 'nearest' });
  showHomePreview(homeList[homeSel]);
}

// Same as the deck editor: the preview follows the hovered row, and anywhere else (header, empty space,
// outside the table) it snaps back to the selected deck.
$('deckTableWrap').addEventListener('mouseover', e => {
  const row = e.target.closest('tr[data-i]');
  showHomePreview(homeList[row ? +row.dataset.i : homeSel]);
});
$('deckTableWrap').addEventListener('mouseleave', () => showHomePreview(homeList[homeSel]));
$('deckTable').addEventListener('dblclick', e => {
  const row = e.target.closest('tr[data-i]');
  if (row && !e.target.closest('button')) openDeckPage(homeList[+row.dataset.i]);
});
$('homePreview').addEventListener('click', e => {
  const c = homePreview.deck && homePreview.deck.commanders[0];
  if (c && e.target.closest('[data-flip]')) showHomePreview(homePreview.deck, (homePreview.face + 1) % c.faces.length);
});

// Clicks shared by all three views.
$('home').addEventListener('click', e => {
  const menuBtn = e.target.closest('[data-deck-menu]');
  if (menuBtn) { deckMenuFor === menuBtn ? closeDeckMenu() : openDeckMenu(menuBtn); return; }
  if (e.target.closest('[data-new]')) { $('newBtn').click(); return; }
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) { const k = sortBtn.dataset.sort; setHomeSort(k, k === homeSort.key ? !homeSort.reversed : false); return; }
  const open = e.target.closest('#galleryView [data-open]');
  if (open) { openDeckPage(homeList[+open.closest('[data-i]').dataset.i]); return; }
  const row = e.target.closest('#deckTable tr[data-i]');
  if (row) selectListRow(+row.dataset.i);
});

$('carousel').addEventListener('click', e => {
  if (swipeSuppressClick) { swipeSuppressClick = false; return; }
  const s = e.target.closest('.slide');
  if (!s) return;
  if (s.classList.contains('placeholder')) { $('newBtn').click(); return; }
  if (+s.dataset.i === homeSel) activateSlide(); else selectSlide(+s.dataset.i);
});

// Wheel: always consume the event (no page scroll or swipe-back leaking through),
// normalize line/page deltas to pixels, and accumulate so one flick moves a predictable amount.
const WHEEL_STEP_PX = 60;
let wheelAcc = 0, wheelIdle = 0;
$('carousel').addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * k;
  clearTimeout(wheelIdle);
  wheelIdle = setTimeout(() => { wheelAcc = 0; }, 120);
  if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0; // direction change starts fresh
  wheelAcc += d;
  if (Math.abs(wheelAcc) >= WHEEL_STEP_PX) {
    selectSlide(homeTarget + Math.sign(wheelAcc));
    wheelAcc = 0;
  }
}, { passive: false });

// Swipe / drag: horizontal movement past a threshold steps through decks.
let swipe = null, swipeSuppressClick = false;
$('carousel').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
$('carousel').addEventListener('pointerup', e => {
  if (!swipe || swipe.id !== e.pointerId) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
  swipeSuppressClick = true; // the click that follows a drag shouldn't open/select a slide
  setTimeout(() => { swipeSuppressClick = false; }, 0);
  const slide = homeSlides.get(homeSel);
  const spacing = (slide ? slide.offsetWidth : 200) * 0.3;
  const steps = Math.max(1, Math.round(Math.abs(dx) / Math.max(spacing, 60)));
  selectSlide(homeTarget - Math.sign(dx) * steps);
});
$('carousel').addEventListener('pointercancel', () => { swipe = null; });

$('prevBtn').addEventListener('click', () => selectSlide(homeTarget - 1));
$('nextBtn').addEventListener('click', () => selectSlide(homeTarget + 1));

document.addEventListener('keydown', e => {
  if (!document.body.classList.contains('home') || document.querySelector('dialog[open]')) return;
  if (deckMenuOpen()) { // the open options menu takes the keyboard; Escape closes it
    if (e.key === 'Escape') closeDeckMenu(true);
    return;
  }
  if (e.target.closest && e.target.closest('select, input, textarea')) return; // let the sort dropdown use its keys
  if (homeView === 'gallery') return; // tiles are buttons; Tab + Enter opens a deck
  if (homeView === 'list') {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); selectListRow(homeSel + step); }
    else if (e.key === 'Home') { e.preventDefault(); selectListRow(0); }
    else if (e.key === 'End') { e.preventDefault(); selectListRow(homeList.length - 1); }
    else if (e.key === 'Enter' && !e.target.closest('button')) homeList.length ? activateSlide() : $('newBtn').click();
    return;
  }
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (step) { e.preventDefault(); selectSlide(homeTarget + step); }
  else if (e.key === 'Home') selectSlide(0);
  else if (e.key === 'End') selectSlide(homeList.length - 1);
  else if (e.key === 'Enter' && !e.target.closest('button')) homeList.length ? activateSlide() : $('newBtn').click();
});
window.addEventListener('hashchange', route);

// Decks saved before a field existed are re-fetched to fill it in.
async function refreshStale() {
  const all = [...state.commanders, ...Object.values(state.cards).map(e => e.card)];
  const stale = all.filter(c => c.game_changer === undefined);
  try {
    for (let i = 0; i < stale.length; i += 75) {
      (await collection(stale.slice(i, i + 75).map(c => ({ id: c.id })))).forEach(n => {
        if (state.cards[n.id]) state.cards[n.id].card = n;
        const k = state.commanders.findIndex(c => c.id === n.id);
        if (k >= 0) state.commanders[k] = n;
      });
    }
  } catch { return; }
  if (stale.length) { persist(); renderDeck(); }
}

/* ---------- Sorting / grouping ---------- */

const primaryCache = new WeakMap();
function primaryType(c) {
  let p = primaryCache.get(c);
  if (p === undefined) {
    const front = c.type_line.split(' // ')[0];
    p = TYPE_PRIORITY.find(t => front.includes(t)) || 'Other';
    primaryCache.set(c, p);
  }
  return p;
}

function colorGroup(c) {
  if (primaryType(c) === 'Land') return 'Land';
  if (c.colors.length === 0) return 'Colorless';
  if (c.colors.length > 1) return 'Multicolor';
  return COLOR_NAMES[c.colors[0]];
}

const collator = new Intl.Collator(); // same ordering as localeCompare, far cheaper per comparison
const byName = (a, b) => collator.compare(a.name, b.name);
const byCmcName = (a, b) => a.cmc - b.cmc || byName(a, b);

function groupCards(entries) {
  const groups = new Map();
  const put = (key, e) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e); };
  let order, cmp = byCmcName;
  switch (state.sort) {
    case 'name': entries.forEach(e => put('All Cards', e)); order = ['All Cards']; cmp = byName; break;
    case 'cmc': entries.forEach(e => put(e.card.cmc >= 7 ? '7+' : String(e.card.cmc), e)); order = ['0', '1', '2', '3', '4', '5', '6', '7+']; cmp = byName; break;
    case 'color': entries.forEach(e => put(colorGroup(e.card), e)); order = COLOR_ORDER; break;
    default: entries.forEach(e => put(primaryType(e.card), e)); order = [...TYPE_ORDER, 'Other']; cmp = byName;
  }
  return order.filter(k => groups.has(k)).map(k => [k, groups.get(k).sort((a, b) => cmp(a.card, b.card))]);
}

/* ---------- Rendering: deck ---------- */

function renderCommanders() {
  const box = $('commanderSlots');
  const slots = [];
  state.commanders.forEach((c, i) => {
    slots.push(`<div class="slot filled" data-id="${c.id}">
      <span class="nm">${esc(c.name)}</span><span class="cost">${symbols(c.mana_cost)}</span>
      <button data-remove-cmd="${i}" title="Remove">&times;</button></div>`);
  });
  if (!state.commanders.length) {
    slots.push(`<div class="slot"><span class="nm label">No commander set. Use New Deck to choose one.</span></div>`);
  } else if (secondSlotAvailable()) {
    slots.push(`<div class="slot"><span class="nm label">Partner / Background (optional)</span><button data-pick-cmd>Add</button></div>`);
  }
  box.innerHTML = slots.join('');
  $('identityLabel').innerHTML = state.commanders.length ? 'Identity: ' + identitySymbols(identity()) : '';
}

function renderDeck() {
  renderCommanders();
  setSearchEnabled();
  const entries = Object.values(state.cards);
  const total = totalCards();
  const bad = entries.filter(e => !inIdentity(e.card)).length;
  const cls = total === 100 && !bad ? 'ok' : total > 100 || bad ? 'bad' : '';
  const br = estimateBracket();
  $('deckStatus').innerHTML = `<span class="${cls}">${total} / 100 cards</span>` +
    (state.commanders.length ? `<span title="${esc(br.notes)}">Bracket ~${br.level} (${BRACKET_NAMES[br.level]})${br.gc ? ` &middot; ${br.gc} ${GC_ICON}` : ''}</span>` : '') +
    (bad ? `<span class="bad">${bad} outside color identity</span>` : '') +
    (state.commanders.length ? '' : '<span class="bad">Commander required</span>');

  const html = groupCards(entries).map(([name, list]) => {
    const n = list.reduce((s, e) => s + e.qty, 0);
    const cardView = viewMode.startsWith('grid');
    return `<div class="group"><h3>${esc(name)} (${n})</h3><div class="items">${list.map(cardView ? deckTile : deckRow).join('')}</div></div>`;
  }).join('');
  $('deckList').className = `view-${viewMode}${viewStack && viewMode.startsWith('grid') ? ' stacked' : ''}`;
  $('deckList').innerHTML = html || '<div class="msg">Deck is empty.</div>';
  $('sortSelect').value = state.sort;
  renderCurve();
}

/* ---------- Test hand ---------- */

const hand = { cards: [], library: [] };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealHand() {
  const lib = Object.values(state.cards).flatMap(({ card, qty }) => Array(qty).fill(card));
  hand.library = shuffle(lib);
  hand.cards = hand.library.splice(0, 7);
  renderHand();
}

function renderHand() {
  const has = hand.cards.length > 0;
  const info = has ? `${hand.library.length} cards in library` : '';
  const cards = hand.cards.map(c => `<div class="hc" data-id="${c.id}">
    <img src="${esc(c.faces[0].small)}" alt="${esc(c.name)}"></div>`).join('');
  $('handActions').innerHTML = `<span class="hand-info">${info}</span>
    <button data-h="new">New Hand</button>
    <button data-h="draw" ${has && hand.library.length ? '' : 'disabled'}>Draw Card</button>`;
  $('hand').innerHTML = `<div class="hand-cards">${cards || '<div class="hand-empty">Draw a random 7-card hand from your deck.</div>'}</div>`;
  fitHand();
}

// Cards keep their size; once the row is full they overlap to fit.
function fitHand() {
  const box = document.querySelector('#hand .hand-cards');
  const n = hand.cards.length;
  const W = box ? box.clientWidth : 0;
  if (!n || W <= 0 || box.clientHeight <= 0) return;
  const gap = 6, ratio = 488 / 680;
  const h = box.clientHeight;
  const cw = h * ratio;
  const step = n > 1 ? Math.min(cw + gap, (W - cw) / (n - 1)) : 0;
  box.style.setProperty('--ch', `${h}px`);
  box.style.setProperty('--gap', `${step - cw}px`);
}
new ResizeObserver(fitHand).observe($('hand'));

$('handActions').addEventListener('click', e => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  if (b.dataset.h === 'new') dealHand();
  else if (hand.library.length) { hand.cards.push(hand.library.shift()); renderHand(); }
});

/* ---------- Mana curve ---------- */

$('trayToggle').addEventListener('click', () => {
  const c = $('tray').classList.toggle('collapsed');
  const t = $('trayToggle');
  t.title = c ? 'Show' : 'Hide';
  t.setAttribute('aria-label', c ? 'Show panel' : 'Hide panel');
  t.setAttribute('aria-expanded', String(!c));
  fitHand();
});

$('tray').addEventListener('click', e => {
  const b = e.target.closest('.tabs [data-tab]');
  if (!b) return;
  $('tray').dataset.tab = b.dataset.tab;
  document.querySelectorAll('#tray .tabs button').forEach(t => t.classList.toggle('active', t === b));
  fitHand();
});

function renderCurve() {
  const bins = Array(8).fill(0);
  let sum = 0, n = 0;
  for (const { card, qty } of Object.values(state.cards)) {
    if (primaryType(card) === 'Land') continue;
    bins[Math.min(7, Math.floor(card.cmc))] += qty;
    sum += card.cmc * qty; n += qty;
  }
  const max = Math.max(1, ...bins);
  const bars = bins.map((c, i) => `<div class="bar"><div class="track"><div class="fill" style="height:${c / max * 100}%"><span class="cnt">${c || ''}</span></div></div><span class="lbl">${i === 7 ? '7+' : i}</span></div>`).join('');
  $('curve').innerHTML = `<div class="curve-title"><span>${n ? `Avg MV ${(sum / n).toFixed(2)} &middot; ${n} nonland` : 'No nonland cards'}</span></div>
    <div class="bars">${bars}</div>`;
}

let viewMode = localStorage.getItem('sparkritual.view') || 'list2';
if (!['list', 'list2', 'grid-s', 'grid-m', 'grid-l'].includes(viewMode)) viewMode = 'list2';
let viewStack = localStorage.getItem('sparkritual.stack') === '1';

function deckTile({ card, qty }) {
  const basic = isUnlimited(card);
  return `<div class="tile ${inIdentity(card) ? '' : 'illegal'} ${selectedCard && selectedCard.id === card.id ? 'sel' : ''}" data-id="${card.id}">
    <img loading="lazy" src="${esc(card.faces[0].image || card.faces[0].small)}" alt="${esc(card.name)}">
    ${qty > 1 ? `<span class="tq">${qty}</span>` : ''}
    <span class="acts">${basic ? `<button data-qty="1" title="Add one">+</button>` : ''}<button data-menu title="Options">&#8943;</button></span></div>`;
}

function deckRow({ card, qty }) {
  const basic = isUnlimited(card);
  return `<div class="row ${inIdentity(card) ? '' : 'illegal'} ${selectedCard && selectedCard.id === card.id ? 'sel' : ''}" data-id="${card.id}">
    <span class="qty">${qty}</span><span class="nm">${esc(card.name)}</span>${card.game_changer ? GC_ICON : ''}
    <span class="cost">${symbols(card.mana_cost)}</span>
    <span class="price">${card.prices.usd ? '$' + esc(card.prices.usd) : '&mdash;'}</span>
    <span class="acts">${basic ? `<button data-qty="1" title="Add one">+</button>` : ''}<button data-menu title="Options">&#8943;</button></span></div>`;
}

/* ---------- Rendering: preview ---------- */

let previewCard = null, previewFace = 0, selectedCard = null;

function previewHtml(card, face, { identity = false, change = false } = {}) {
  const f = card.faces[face] || card.faces[0];
  const rules = f.oracle_text.split('\n').map(p => `<p>${symbols(p)}</p>`).join('');
  const stats = f.power != null ? `${esc(f.power)}/${esc(f.toughness)}` : f.loyalty ? `Loyalty ${esc(f.loyalty)}` : '';
  return `<div class="pv">
    <div class="pv-art">
      ${f.image ? `<img class="art" src="${esc(f.image)}" alt="${esc(f.name)}">` : ''}
      ${card.faces.length > 1 ? '<button class="flip" data-flip>Flip card</button>' : ''}
      ${change ? '<button class="print-btn" data-print>Change Printing</button>' : ''}
    </div>
    <div class="pv-text"><div class="pv-text-inner">
      <h2><span>${esc(f.name)}</span><span>${symbols(f.mana_cost)}</span></h2>
      <div class="type">${esc(f.type_line)}</div>
      <div class="rules">${rules || '<p>&nbsp;</p>'}</div>
      <dl>
        ${stats ? `<dt>P/T</dt><dd>${stats}</dd>` : ''}
        ${identity ? `<dt>Identity</dt><dd>${identitySymbols(card.color_identity)}</dd>` : ''}
        <dt>Set</dt><dd>${esc(card.set_name)} (${esc(card.set)}${card.collector ? ' #' + esc(card.collector) : ''}), ${esc(cap(card.rarity))}</dd>
      </dl>
    </div>
    </div></div>`;
}

const inDeck = c => !!state.cards[c.id] || state.commanders.some(x => x.id === c.id);

function showPreview(card, face = 0) {
  previewCard = card; previewFace = face;
  $('preview').innerHTML = previewHtml(card, face, { change: inDeck(card) });
}

// With nothing selected, the preview falls back to the commander.
function showDefaultPreview() {
  const c = state.commanders[0];
  if (c) return showPreview(c);
  previewCard = null;
  $('preview').innerHTML = '<div class="preview-empty">Hover over a card to preview it.</div>';
}

/* ---------- Search ---------- */

function buildQuery(text) {
  return `id<=${identity().join('') || 'c'} f:commander ${text}`;
}

function rank(list, text) {
  const t = text.toLowerCase();
  const score = c => { const n = c.name.toLowerCase(); return n === t ? 0 : n.startsWith(t) ? 1 : n.includes(t) ? 2 : 3; };
  return list.map(c => [score(c), c]).sort((a, b) => a[0] - b[0]).map(x => x[1]); // score once per card
}

function resetResults() {
  $('searchResults').innerHTML = '';
  $('moreBtn').hidden = true;
  search.list = [];
}

async function runSearch() {
  const msg = $('searchMsg');
  const text = $('searchInput').value.trim();
  search.text = text;
  resetResults();
  const token = ++search.token;
  if (!state.commanders.length || !text) { msg.className = 'msg'; msg.textContent = ''; return []; }
  msg.className = 'msg'; msg.textContent = 'Searching...';
  try {
    const data = await scry(searchUrl(buildQuery(text)));
    if (token !== search.token) return [];
    const list = rank(data.data, text);
    search.list = list;
    msg.textContent = list.length ? '' : 'No cards found.';
    search.url = data.next_page;
    appendResults(list);
    return list;
  } catch (e) {
    if (token === search.token) { msg.className = 'msg err'; msg.textContent = e.message; }
    return [];
  }
}

async function loadMore() {
  if (!search.url) return;
  const token = search.token;
  $('moreBtn').disabled = true;
  try {
    const data = await scry(search.url);
    if (token !== search.token) return;
    search.url = data.next_page;
    appendResults(data.data);
  } catch (e) {
    $('searchMsg').className = 'msg err'; $('searchMsg').textContent = e.message;
  } finally { $('moreBtn').disabled = false; }
}

function appendResults(cards) {
  $('searchResults').insertAdjacentHTML('beforeend', cards.map(resultRow).join(''));
  $('moreBtn').hidden = !search.url;
  renderResultStates();
}

function resultRow(c) {
  return `<div class="row" data-id="${c.id}">
    <span class="nm">${esc(c.name)}</span>${c.game_changer ? GC_ICON : ''}<span class="set">${esc(c.set)}</span>
    <span class="cost">${symbols(c.mana_cost)}</span></div>`;
}

const ownedNames = () => new Set([...Object.values(state.cards).map(e => e.card.name), ...state.commanders.map(c => c.name)]);
const canAdd = (c, owned = ownedNames()) => isUnlimited(c) || !owned.has(c.name);

function renderResultStates() {
  const owned = ownedNames();
  let top = null;
  for (const row of $('searchResults').children) {
    const addable = canAdd(cache.get(row.dataset.id), owned);
    row.classList.toggle('owned', !addable);
    const isTop = addable && !top;
    if (isTop) top = row;
    row.classList.toggle('top', isTop);
  }
}

/* ---------- Partner / Background dialog ---------- */

const dlg = $('cmdDialog');

function openPartnerDialog() {
  $('cmdInput').value = '';
  dlg.showModal();
  searchPartners();
}

async function searchPartners() {
  const first = state.commanders[0];
  const text = $('cmdInput').value.trim();
  const msg = $('cmdMsg');
  const q = `f:commander ${pairQuery(first)}${nameClause(text)}`;
  msg.className = 'msg'; msg.textContent = 'Searching...';
  const token = ++partnerToken;
  try {
    const data = await scry(searchUrl(q));
    if (token !== partnerToken) return;
    const list = data.data.filter(c => canPair(first, c)).slice(0, 60);
    msg.textContent = list.length ? '' : 'No matching cards.';
    $('cmdResults').innerHTML = list.map(c => `<button class="cmd-card" data-cmd="${c.id}" title="${esc(c.name)}">
      <img loading="lazy" src="${esc(c.faces[0].small)}" alt="${esc(c.name)}"><div>${esc(c.name)}</div></button>`).join('');
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
}

function setPartner(card) {
  state.commanders.push(card);
  delete state.cards[card.id];
  dlg.close();
  refreshDeck(true);
}

/* ---------- Printings ---------- */

const printDlg = $('printDialog');
const printsCache = new Map(); // card name -> all printings
let printTarget = null, printList = [];

async function openPrintings(card) {
  printTarget = card;
  $('printTitle').textContent = `Choose Printing: ${card.name}`;
  $('printFilter').value = '';
  $('printGrid').innerHTML = '';
  $('printMsg').className = 'msg'; $('printMsg').textContent = 'Loading...';
  printDlg.showModal();
  try {
    if (!printsCache.has(card.name)) {
      const all = [];
      let url = `${API}/cards/search?unique=prints&order=released&dir=desc&include_extras=true&q=${encodeURIComponent(`!"${card.name.replace(/"/g, '\\"')}"`)}`;
      while (url && all.length < 700) { const d = await scry(url); all.push(...d.data); url = d.next_page; }
      printsCache.set(card.name, all);
    }
    printList = printsCache.get(card.name);
    renderPrintings();
  } catch (e) { $('printMsg').className = 'msg err'; $('printMsg').textContent = e.message; }
}

function renderPrintings() {
  const q = $('printFilter').value.trim().toLowerCase();
  const rows = printList.filter(c => !q || `${c.set_name} ${c.set} ${c.collector} ${c.released.slice(0, 4)}`.toLowerCase().includes(q));
  $('printMsg').textContent = rows.length ? `${rows.length} printing${rows.length === 1 ? '' : 's'}` : 'No matching printings.';
  $('printGrid').innerHTML = rows.map(c => `<button class="cmd-card ${c.id === printTarget.id ? 'cur' : ''}" data-id="${c.id}">
    <img loading="lazy" src="${esc(c.faces[0].small)}" alt="${esc(c.set_name)}">
    <div class="pcap">${esc(c.set_name)}<br>${esc(c.set)} #${esc(c.collector)} &middot; ${c.prices.usd ? '$' + esc(c.prices.usd) : 'n/a'}</div></button>`).join('');
}

function swapPrinting(oldCard, nu) {
  const e = state.cards[oldCard.id];
  if (e) { delete state.cards[oldCard.id]; state.cards[nu.id] = { card: nu, qty: e.qty }; }
  else {
    const i = state.commanders.findIndex(c => c.id === oldCard.id);
    if (i < 0) return;
    state.commanders[i] = nu;
  }
  refreshDeck();
  if (selectedCard && selectedCard.id === oldCard.id) selectedCard = nu;
  showPreview(nu, 0);
}

$('printFilter').addEventListener('input', renderPrintings);
$('printClose').addEventListener('click', () => printDlg.close());
$('printGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-id]');
  const nu = b && cache.get(b.dataset.id);
  if (nu && nu.id !== printTarget.id) swapPrinting(printTarget, nu);
  printDlg.close();
});

/* ---------- Events ---------- */

function hoverHandler(e) {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const c = cache.get(row.dataset.id);
  if (c && c !== previewCard) showPreview(c);
}

['deckList', 'searchResults', 'commanderSlots', 'hand'].forEach(id => {
  $(id).addEventListener('mouseover', hoverHandler);
  $(id).addEventListener('mouseleave', () => {
    const back = selectedCard || state.commanders[0];
    if (back && back !== previewCard) selectedCard ? showPreview(back) : showDefaultPreview();
  });
});

const cardMenu = document.createElement('div');
cardMenu.className = 'card-menu';
cardMenu.hidden = true;
cardMenu.innerHTML = '<button data-act="print">Switch Printing</button><button data-act="remove">Remove Card</button>';
document.body.appendChild(cardMenu);
let menuId = null;
const closeMenu = () => { cardMenu.hidden = true; menuId = null; };
document.addEventListener('click', e => { if (!cardMenu.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu(); });
cardMenu.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = menuId;
  closeMenu();
  if (act.dataset.act === 'remove') {
    if (state.cards[id]) changeQty(id, -state.cards[id].qty);
  } else if (cache.get(id)) openPrintings(cache.get(id));
});
$('preview').addEventListener('click', e => {
  if (e.target.closest('[data-print]')) return openPrintings(previewCard);
  if (e.target.closest('[data-flip]')) showPreview(previewCard, (previewFace + 1) % previewCard.faces.length);
});

function clearSearch() {
  onSearchInput.cancel();
  $('searchInput').value = '';
  search.text = '';
  resetResults();
  $('searchMsg').textContent = '';
  closeDrop();
}

$('searchResults').addEventListener('click', e => {
  const row = e.target.closest('[data-id]');
  if (!row || row.classList.contains('owned')) return;
  addCard(cache.get(row.dataset.id));
  clearSearch();
});

// Clicking anywhere that isn't a card or an interactive element deselects the selected card.
document.addEventListener('click', e => {
  if (!selectedCard || document.body.classList.contains('home')) return;
  if (e.target.closest('[data-id], [data-menu], button, input, textarea, select, a, label, summary, [tabindex], dialog, .card-menu')) return;
  selectedCard = null;
  document.querySelectorAll('#builder .sel').forEach(x => x.classList.remove('sel'));
  showDefaultPreview();
});

$('deckList').addEventListener('click', e => {
  const m = e.target.closest('[data-menu]');
  if (m) {
    const r = m.getBoundingClientRect();
    menuId = m.closest('[data-id]').dataset.id;
    cardMenu.hidden = false;
    cardMenu.style.top = `${Math.min(r.bottom + 2, innerHeight - cardMenu.offsetHeight - 4)}px`;
    cardMenu.style.left = `${Math.max(4, Math.min(r.right - cardMenu.offsetWidth, innerWidth - cardMenu.offsetWidth - 4))}px`;
    return;
  }
  const b = e.target.closest('[data-qty]');
  if (b) return changeQty(b.closest('[data-id]').dataset.id, +b.dataset.qty);
  const item = e.target.closest('[data-id]');
  const c = item && cache.get(item.dataset.id);
  if (!c) return;
  selectedCard = c;
  showPreview(c);
  document.querySelectorAll('#deckList .sel').forEach(x => x.classList.remove('sel'));
  item.classList.add('sel');
});

$('commanderSlots').addEventListener('click', e => {
  if (e.target.closest('[data-pick-cmd]')) return openPartnerDialog();
  const r = e.target.closest('[data-remove-cmd]');
  if (r) {
    const i = +r.dataset.removeCmd;
    // Removing the first commander drops any dependent partner.
    state.commanders.splice(i, i === 0 ? state.commanders.length : 1);
    refreshDeck(true);
  }
});

$('cmdResults').addEventListener('click', e => {
  const b = e.target.closest('[data-cmd]');
  if (b) setPartner(cache.get(b.dataset.cmd));
});
$('cmdClose').addEventListener('click', () => dlg.close());
$('cmdInput').addEventListener('input', debounce(searchPartners, 300));

const onSearchInput = debounce(runSearch, 350);
$('searchInput').addEventListener('input', () => { $('searchInput').value.trim() ? openDrop() : closeDrop(); onSearchInput(); });
$('searchInput').addEventListener('focus', () => { if ($('searchInput').value.trim()) openDrop(); });
$('searchInput').addEventListener('keydown', async e => {
  if (e.key === 'Escape') return closeDrop();
  if (e.key !== 'Enter') return;
  e.preventDefault();
  onSearchInput.cancel();
  if ($('searchInput').value.trim() !== search.text) await runSearch();
  const owned = ownedNames();
  const hit = search.list.find(c => canAdd(c, owned));
  if (!hit) return;
  addCard(hit);
  clearSearch();
});
$('searchBar').addEventListener('focusout', e => { if (!$('searchBar').contains(e.relatedTarget)) closeDrop(); });
// Keep input focus when clicking inside the dropdown.
$('searchDrop').addEventListener('mousedown', e => e.preventDefault());

function openDrop() { $('searchDrop').classList.add('open'); }
function closeDrop() { $('searchDrop').classList.remove('open'); }
$('moreBtn').addEventListener('click', loadMore);

$('viewBtn').addEventListener('click', () => {
  document.querySelector(`input[name="viewMode"][value="${viewMode}"]`).checked = true;
  $('viewStack').checked = viewStack;
  $('viewDialog').showModal();
});
$('viewClose').addEventListener('click', () => $('viewDialog').close());
$('viewDialog').addEventListener('change', e => {
  if (e.target.id === 'viewStack') {
    viewStack = e.target.checked;
    localStorage.setItem('sparkritual.stack', viewStack ? '1' : '0');
    return renderDeck();
  }
  viewMode = e.target.value;
  localStorage.setItem('sparkritual.view', viewMode);
  renderDeck();
  $('viewDialog').close();
});

$('sortSelect').addEventListener('change', e => { state.sort = e.target.value; persist(); renderDeck(); });

/* ---------- Background music (landing page) ---------- */

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

// Only a bare 11-character video ID is ever embedded, never the raw URL.
function ytId(url) {
  try {
    const u = new URL(url);
    if (!YT_HOSTS.has(u.hostname)) return null;
    const id = u.hostname === 'youtu.be' ? u.pathname.slice(1)
      : u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/) || [])[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

let yt = null, ytReady = false, ytWanted = null, ytApi = null;

function loadYtApi() {
  if (!ytApi) {
    ytApi = new Promise(resolve => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }
  return ytApi;
}

function showMusicError(text) {
  $('musicMsg').textContent = text;
  $('musicMsg').hidden = !text;
  $('musicToggle').hidden = !!text;
}

function applyMusic() {
  if (!ytReady) return;
  if (ytWanted) {
    if (yt.getVideoData().video_id !== ytWanted) { showMusicError(''); yt.loadVideoById(ytWanted); } else yt.playVideo();
  } else yt.pauseVideo();
}

async function setMusic(id) {
  ytWanted = id;
  $('musicBox').hidden = !id;
  if (!id) { playDeckMusic.cancel(); applyMusic(); return; }
  // Error 153: YouTube needs a real http(s) origin to validate the embedding page.
  if (!/^https?:$/.test(location.protocol)) {
    showMusicError('YouTube blocks embeds on file:// pages. Serve this folder (e.g. python -m http.server) and open http://localhost:8000.');
    return;
  }
  if (yt) return applyMusic();
  await loadYtApi();
  if (yt) return;
  yt = new YT.Player('ytPlayer', {
    width: 200, height: 200, videoId: ytWanted,
    playerVars: { autoplay: 1, loop: 1, playlist: ytWanted, playsinline: 1, origin: location.origin },
    events: {
      onReady: () => { ytReady = true; applyMusic(); },
      onError: e => showMusicError([101, 150].includes(e.data) ? 'The video owner does not allow embedding.' : 'This video cannot be played.'),
    },
  });
}

const playDeckMusic = debounce(() => {
  if (!document.body.classList.contains('home')) return;
  const d = homeView === 'carousel' && homeList[homeSel]; // the player box would cover the gallery and list
  setMusic(d && d.music ? ytId(d.music) : null);
}, 600); // longer than the 450ms slide transition so YouTube loading never lands mid-animation

$('musicToggle').addEventListener('click', () => {
  if (!ytReady) return;
  const muted = yt.isMuted();
  if (muted) yt.unMute(); else yt.mute();
  $('musicToggle').textContent = muted ? 'Mute' : 'Unmute';
});

// Browsers block sound until the page has had a user gesture; retry once on the first one.
function resumeOnGesture() { if (ytReady && ytWanted) yt.playVideo(); }
document.addEventListener('pointerdown', resumeOnGesture, { once: true });
document.addEventListener('keydown', resumeOnGesture, { once: true });

/* ---------- Deck settings ---------- */

function showDeckTitle() {
  $('deckTitle').textContent = state.name;
  $('deckTitle').title = state.description;
}

$('settingsBtn').addEventListener('click', () => {
  $('setName').value = state.name;
  $('setDesc').value = state.description;
  $('setMusic').value = state.music;
  $('setMsg').textContent = '';
  $('shareBox').hidden = !(Cloud.enabled && Cloud.user);
  $('setVis').value = state.visibility;
  $('shareLink').value = `${APP_URL}?d=${state.id}`;
  $('settingsDialog').showModal();
});
$('settingsClose').addEventListener('click', () => $('settingsDialog').close());
$('settingsSave').addEventListener('click', () => {
  const music = $('setMusic').value.trim();
  if (music && !ytId(music)) {
    $('setMsg').className = 'msg err';
    $('setMsg').textContent = 'Enter a valid YouTube video link.';
    return;
  }
  state.name = $('setName').value.trim() || 'Untitled Deck';
  state.description = $('setDesc').value.trim();
  state.music = music;
  state.visibility = $('setVis').value;
  persist();
  flushDeck(state.id); // so a freshly copied share link works immediately
  showDeckTitle();
  $('settingsDialog').close();
});

/* ---------- Import / export ---------- */

const listDlg = $('listDialog');

function exportText() {
  const lines = [];
  if (state.commanders.length) lines.push('Commander', ...state.commanders.map(c => `1 ${c.name}`), '', 'Deck');
  Object.values(state.cards).sort((a, b) => byName(a.card, b.card)).forEach(e => lines.push(`${e.qty} ${e.card.name}`));
  return lines.join('\n');
}

// Accepts "2 Name", "2x Name (SET) 123" and Commander/Deck headings; ignores sideboard sections.
function parseList(text) {
  const out = { commanders: [], cards: [] };
  let section = 'deck';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const head = line.toLowerCase().replace(/:$/, '');
    if (head === 'commander' || head === 'commanders') { section = 'commander'; continue; }
    if (['deck', 'main', 'mainboard'].includes(head)) { section = 'deck'; continue; }
    if (['sideboard', 'maybeboard', 'companion'].includes(head)) { section = 'skip'; continue; }
    if (section === 'skip') continue;
    const m = line.match(/^(?:(\d+)x?\s+)?(.+?)(?:\s+\([^)]*\).*)?$/);
    if (!m) continue;
    if (section === 'commander') out.commanders.push(m[2].trim());
    else out.cards.push({ name: m[2].trim(), qty: m[1] ? +m[1] : 1 });
  }
  return out;
}

async function fetchByNames(names) {
  const unique = [...new Set(names.map(n => n.toLowerCase()))];
  const byKey = new Map();
  for (let i = 0; i < unique.length; i += 75) {
    (await collection(unique.slice(i, i + 75).map(name => ({ name })))).forEach(c => {
      c.name.toLowerCase().split(' // ').concat(c.name.toLowerCase()).forEach(k => byKey.set(k, c));
    });
  }
  return byKey;
}

// entries: [{ card, qty }] where card may be undefined (not found). Enforces singleton except for unlimited cards.
function buildCards(entries, cmdIds) {
  const cards = {};
  let dupes = 0;
  for (const { card: c, qty } of entries) {
    if (!c || cmdIds.has(c.id)) continue;
    if (cards[c.id] && !isUnlimited(c)) { dupes++; continue; }
    const add = isUnlimited(c) ? qty : 1;
    if (cards[c.id]) cards[c.id].qty += add; else cards[c.id] = { card: c, qty: add };
  }
  return { cards, dupes };
}

async function applyList() {
  const msg = $('listMsg'), btn = $('listApply');
  const parsed = parseList($('listText').value);
  const names = [...parsed.commanders, ...parsed.cards.map(c => c.name)];
  msg.className = 'msg';
  if (!names.length) { msg.textContent = 'Nothing to import.'; return; }
  msg.textContent = 'Importing...'; btn.disabled = true;
  try {
    const found = await fetchByNames(names);
    const find = n => found.get(n.toLowerCase());
    const missing = names.filter(n => !find(n));
    let commanders = parsed.commanders.length ? parsed.commanders.map(find).filter(Boolean).slice(0, 2) : state.commanders;
    if (!commanders.length) throw new Error('A valid commander is required (add a "Commander" heading).');
    if (commanders.length === 2 && !canPair(commanders[0], commanders[1])) throw new Error('Those two commanders cannot be paired.');
    const cmdIds = new Set(commanders.map(c => c.id));
    const { cards, dupes } = buildCards(parsed.cards.map(e => ({ card: find(e.name), qty: e.qty })), cmdIds);
    Object.assign(state, { commanders, cards });
    refreshDeck(true);
    const notes = [];
    if (missing.length) notes.push(`Not found: ${[...new Set(missing)].join(', ')}`);
    if (dupes) notes.push(`${dupes} duplicate(s) skipped (singleton)`);
    if (notes.length) { msg.textContent = `Imported. ${notes.join('. ')}.`; $('listText').value = exportText(); }
    else listDlg.close();
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  } finally { btn.disabled = false; }
}

$('listBtn').addEventListener('click', () => {
  $('listText').value = exportText();
  $('listMsg').textContent = '';
  listDlg.showModal();
});
$('listClose').addEventListener('click', () => listDlg.close());
$('listApply').addEventListener('click', applyList);
$('listCopy').addEventListener('click', async () => {
  const b = $('listCopy');
  try { await navigator.clipboard.writeText($('listText').value); b.textContent = 'Copied!'; }
  catch { b.textContent = 'Copy failed'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});

/* ---------- New deck dialog ---------- */

const newDlg = $('newDialog');
const draft = { card: null, partner: null, target: 'cmd', face: 0, shown: null, token: 0, importText: '', imported: [] };

function showDraftPreview(card, face = 0) {
  draft.shown = card; draft.face = face;
  $('newPreview').innerHTML = previewHtml(card, face, { identity: true });
}

function restoreDraftPreview() {
  const selected = (draft.target === 'partner' && draft.partner) || draft.card;
  if (selected && selected !== draft.shown) showDraftPreview(selected);
}

function updateDraftUi() {
  const canPartner = draft.card && pairQuery(draft.card) !== null;
  $('tabPartner').hidden = !canPartner;
  $('tabCmd').textContent = draft.card ? `Commander: ${draft.card.name}` : 'Commander';
  $('tabPartner').textContent = draft.partner ? `Partner: ${draft.partner.name}` : 'Partner / Background (optional)';
  $('tabCmd').classList.toggle('active', draft.target === 'cmd');
  $('tabPartner').classList.toggle('active', draft.target === 'partner');
  $('newSearch').placeholder = draft.target === 'cmd' ? 'Search for a commander' : 'Search for a partner or background';
  $('newImport').textContent = draft.imported.length ? `Import cards (${draft.imported.length})` : 'Import cards';
  $('newCreate').disabled = !draft.card;
}

function setDraftTarget(t) {
  draft.target = t;
  $('newSearch').value = '';
  updateDraftUi();
  restoreDraftPreview();
  searchNewCommander();
}

function openNewDeck() {
  Object.assign(draft, { card: null, partner: null, target: 'cmd', shown: null, importText: '', imported: [] });
  $('newName').value = '';
  $('newSearch').value = '';
  updateDraftUi();
  $('newPreview').innerHTML = '<div class="preview-empty">Hover over a commander to preview it.</div>';
  newDlg.showModal();
  searchNewCommander();
  $('newName').focus();
}

async function searchNewCommander() {
  const text = $('newSearch').value.trim();
  const second = draft.target === 'partner' && draft.card;
  const q = (second ? `f:commander ${pairQuery(draft.card)}` : 'is:commander -t:background') + nameClause(text);
  const msg = $('newMsg');
  msg.className = 'msg'; msg.textContent = 'Searching...';
  const token = ++draft.token;
  try {
    const data = await scry(searchUrl(q));
    if (token !== draft.token) return;
    const list = (second ? data.data.filter(c => canPair(draft.card, c)) : data.data).slice(0, 80);
    const picked = second ? draft.partner : draft.card;
    msg.textContent = list.length ? '' : 'No legal matches found.';
    $('newResults').innerHTML = list.map(c => `<div class="row ${picked && picked.id === c.id ? 'selected' : ''}" data-id="${c.id}">
      <span class="nm">${esc(c.name)}</span>
      <span class="cost">${identitySymbols(c.color_identity)}</span></div>`).join('');
  } catch (e) {
    if (token === draft.token) { msg.className = 'msg err'; msg.textContent = e.message; }
  }
}

$('newBtn').addEventListener('click', openNewDeck);
$('newCancel').addEventListener('click', () => newDlg.close());
$('newSearch').addEventListener('input', debounce(searchNewCommander, 300));
$('tabCmd').addEventListener('click', () => setDraftTarget('cmd'));
$('tabPartner').addEventListener('click', () => setDraftTarget('partner'));

$('newResults').addEventListener('mouseover', e => {
  const row = e.target.closest('[data-id]');
  const c = row && cache.get(row.dataset.id);
  if (c && c !== draft.shown) showDraftPreview(c);
});
$('newResults').addEventListener('mouseout', e => {
  const row = e.target.closest('[data-id]');
  const nextRow = e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-id]');
  if (row && (!nextRow || !$('newResults').contains(nextRow))) restoreDraftPreview();
});
$('newResults').addEventListener('click', e => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const c = cache.get(row.dataset.id);
  if (draft.target === 'partner') {
    // Clicking the chosen partner again clears it.
    draft.partner = draft.partner && draft.partner.id === c.id ? null : c;
  } else {
    draft.card = c;
    if (draft.partner && !canPair(c, draft.partner)) draft.partner = null;
  }
  const picked = draft.target === 'partner' ? draft.partner : draft.card;
  document.querySelectorAll('#newResults .row').forEach(r => r.classList.toggle('selected', !!picked && r.dataset.id === picked.id));
  updateDraftUi();
  showDraftPreview(c);
});
$('newPreview').addEventListener('click', e => {
  if (e.target.closest('[data-flip]')) showDraftPreview(draft.shown, (draft.face + 1) % draft.shown.faces.length);
});

$('newCreate').addEventListener('click', () => {
  if (!draft.card) return;
  const commanders = draft.partner ? [draft.card, draft.partner] : [draft.card];
  newDlg.close();
  const { cards } = buildCards(draft.imported, new Set(commanders.map(c => c.id)));
  createDeck($('newName').value.trim() || 'Untitled Deck', commanders, cards);
});

const importDlg = $('newImportDialog');

async function applyNewImport() {
  const msg = $('newImportMsg'), btn = $('newImportApply');
  const parsed = parseList($('newImportText').value);
  const names = [...parsed.commanders, ...parsed.cards.map(c => c.name)];
  msg.className = 'msg';
  if (!names.length) { msg.textContent = 'Nothing to import.'; return; }
  msg.textContent = 'Importing...'; btn.disabled = true;
  try {
    const found = await fetchByNames(names);
    const find = n => found.get(n.toLowerCase());
    const missing = names.filter(n => !find(n));
    if (!draft.card && parsed.commanders.length) {
      const [first, second] = parsed.commanders.map(find).filter(Boolean);
      if (first) {
        draft.card = first;
        draft.partner = second && canPair(first, second) ? second : null;
        draft.target = 'cmd';
        $('newSearch').value = '';
        searchNewCommander();
      }
    }
    draft.importText = $('newImportText').value;
    draft.imported = parsed.cards.map(e => ({ card: find(e.name), qty: e.qty })).filter(e => e.card);
    updateDraftUi();
    if (missing.length) {
      msg.className = 'msg err';
      msg.textContent = `Not found: ${[...new Set(missing)].join(', ')}. The rest will be added when the deck is created.`;
    } else importDlg.close();
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  } finally { btn.disabled = false; }
}

$('newImport').addEventListener('click', () => {
  $('newImportText').value = draft.importText;
  $('newImportMsg').textContent = '';
  importDlg.showModal();
});
$('newImportClose').addEventListener('click', () => importDlg.close());
$('newImportClear').addEventListener('click', () => {
  $('newImportText').value = '';
  draft.importText = ''; draft.imported = [];
  $('newImportMsg').textContent = '';
  updateDraftUi();
});
$('newImportApply').addEventListener('click', applyNewImport);

function setSearchEnabled() {
  const on = state.commanders.length > 0;
  $('searchInput').disabled = !on;
  $('searchInput').placeholder = on ? 'Search for cards to add to the deck' : 'Create a deck to start searching';
}
/* ---------- Online decks (Supabase) ---------- */

const APP_URL = location.href.split(/[?#]/)[0];
const cloudTimers = new Map(); // deck id -> pending push timer
const lastPushed = new Map();  // deck id -> signature of the last row we know the server has
let sharedInfo = null, sharedTok = 0;

const rowSig = row => JSON.stringify({ ...row, updated_at: 0 });

function setSync(text, bad) {
  const s = $('syncState');
  s.textContent = text;
  s.classList.toggle('bad', !!bad);
}

function updateAuthUi() {
  $('authBtn').hidden = !Cloud.enabled;
  $('authBtn').textContent = Cloud.user ? ((Cloud.profile && Cloud.profile.display_name) || 'Account') : 'Sign in';
}

function updateCopyBtn() {
  if (!sharedInfo) return;
  const own = !!Cloud.user && Cloud.user.id === sharedInfo.ownerId;
  $('copyBtn').textContent = own ? 'Open in editor' : 'Copy to my decks';
}

function queueCloud(id) {
  if (!Cloud.user) return;
  clearTimeout(cloudTimers.get(id));
  cloudTimers.set(id, setTimeout(() => pushNow(id), 1500));
}

function flushDeck(id) {
  if (!Cloud.user) return;
  clearTimeout(cloudTimers.get(id));
  pushNow(id);
}

async function pushNow(id) {
  cloudTimers.delete(id);
  const d = decks[id];
  if (!d || !Cloud.user || d.owner !== Cloud.user.id) return;
  const row = Cloud.toRow(d), sig = rowSig(row);
  if (lastPushed.get(id) === sig) return; // nothing changed since the last upload
  setSync('Saving...');
  try {
    await Cloud.pushRow(row);
    lastPushed.set(id, sig);
    setSync('Saved online');
  } catch (e) {
    setSync('Online save failed, retrying', true);
    cloudTimers.set(id, setTimeout(() => pushNow(id), 15000));
  }
}

// Rows hold only Scryfall ids; rebuild full card objects (cache first, then batched lookups).
async function hydrate(row) {
  const ids = [...new Set([...row.commanders, ...Object.keys(row.cards)])];
  const need = ids.filter(id => !cache.has(id));
  for (let i = 0; i < need.length; i += 75) await collection(need.slice(i, i + 75).map(id => ({ id })));
  const cards = {};
  for (const [id, qty] of Object.entries(row.cards)) if (cache.has(id)) cards[id] = { card: cache.get(id), qty };
  return {
    id: row.id, name: row.name, description: row.description, music: row.music, visibility: row.visibility,
    commanders: row.commanders.map(id => cache.get(id)).filter(Boolean), cards, sort: row.sort,
    updated: Date.parse(row.updated_at) || Date.now(),
  };
}

// Last write wins per deck. askUpload is only true right after an actual sign-in.
async function syncDown(askUpload) {
  const user = Cloud.user;
  if (!user) return;
  setSync('Syncing...');
  try {
    const rows = await Cloud.listDecks();
    for (const row of rows) {
      const local = decks[row.id], t = Date.parse(row.updated_at);
      if (local && local.owner !== user.id) continue;
      if (!local || (local.updated < t - 1000 && state.id !== row.id)) {
        try {
          const d = { ...(await hydrate(row)), owner: user.id };
          decks[row.id] = d;
          lastPushed.set(row.id, rowSig(Cloud.toRow(d)));
        } catch { /* skip a deck that fails to load; the rest still sync */ }
      } else if (local.updated > t + 1000) queueCloud(row.id);
    }
    const remote = new Set(rows.map(r => r.id));
    Object.values(decks).forEach(d => { if (d.owner === user.id && !remote.has(d.id)) queueCloud(d.id); });
    const guest = Object.values(decks).filter(d => !d.owner);
    if (askUpload && guest.length && confirm(`Upload ${guest.length} deck${guest.length === 1 ? '' : 's'} saved in this browser to your account?`)) {
      guest.forEach(d => { d.owner = user.id; queueCloud(d.id); });
    }
    writeDecks();
    if (document.body.classList.contains('home')) renderHome();
    setSync('Synced');
  } catch (e) { setSync('Sync failed: ' + e.message, true); }
}

// Account decks are removed from this browser on sign-out so the next person doesn't inherit them.
function signedOutCleanup() {
  lastPushed.clear();
  cloudTimers.forEach(clearTimeout);
  cloudTimers.clear();
  const mine = Object.keys(decks).filter(id => decks[id].owner);
  mine.forEach(id => delete decks[id]);
  if (mine.length) writeDecks();
  setSync('');
  if (document.body.classList.contains('shared')) return updateCopyBtn();
  if (state.id && !decks[state.id]) {
    state.id = null;
    if (location.hash) location.hash = ''; else route();
  } else if (document.body.classList.contains('home')) renderHome();
}

/* Shared (read-only) deck page: ?d=<deck id> */

async function openShared(id) {
  const tok = ++sharedTok;
  document.body.classList.remove('home');
  document.body.classList.add('shared');
  setMusic(null);
  state.id = null; // nothing from this view is ever saved locally
  $('deckTitle').textContent = 'Loading deck...';
  $('sharedDesc').textContent = '';
  $('deckList').innerHTML = $('commanderSlots').innerHTML = $('deckStatus').innerHTML = '';
  try {
    await Cloud.ready;
    if (!Cloud.enabled) throw new Error('Online decks are not set up on this site.');
    const row = await Cloud.getDeck(id);
    if (!row) throw new Error('This deck was not found, or it is private.');
    const d = await hydrate(row);
    if (tok !== sharedTok) return;
    Object.assign(state, { id: null, name: d.name, description: d.description, music: '', visibility: d.visibility, commanders: d.commanders, cards: d.cards, sort: d.sort || 'type' });
    sharedInfo = { source: d, owner: row.owner, ownerId: row.owner_id };
    document.title = `${d.name} - SparkRitual`;
    $('deckTitle').textContent = `${d.name} by ${row.owner}`;
    $('sharedDesc').textContent = d.description || '';
    previewCard = null; selectedCard = null;
    dealHand();
    showDefaultPreview();
    renderDeck();
    updateCopyBtn();
  } catch (e) {
    if (tok !== sharedTok) return;
    $('deckTitle').textContent = 'Deck unavailable';
    $('deckList').innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
  }
}

$('copyBtn').addEventListener('click', () => {
  const s = sharedInfo;
  if (!s) return;
  const own = !!Cloud.user && Cloud.user.id === s.ownerId;
  const id = own ? s.source.id : newId();
  if (!decks[id]) {
    const d = structuredClone(s.source);
    Object.assign(d, { id, name: own ? d.name : `${d.name} (copy)`, visibility: own ? d.visibility : 'private', owner: Cloud.user ? Cloud.user.id : undefined, updated: Date.now() });
    decks[id] = d;
    writeDecks();
    if (d.owner) queueCloud(id);
  }
  location.hash = `deck=${id}`;
});

document.querySelector('.topbar h1 a').addEventListener('click', e => {
  if (!document.body.classList.contains('shared')) return;
  e.preventDefault();
  history.replaceState(null, '', APP_URL);
  route();
});

/* Account dialog */

const authDlg = $('authDialog');
const authMsg = (t, bad) => { $('authMsg').textContent = t; $('authMsg').className = 'msg' + (bad ? ' err' : ''); };

$('authBtn').addEventListener('click', () => {
  const on = !!Cloud.user;
  $('authTitle').textContent = on ? 'Account' : 'Sign in';
  $('authOut').hidden = on;
  $('authIn').hidden = !on;
  $('authName').value = (Cloud.profile && Cloud.profile.display_name) || '';
  authMsg('');
  authDlg.showModal();
});
$('authClose').addEventListener('click', () => authDlg.close());
$('authSend').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  if (!email) return authMsg('Enter your email address.', true);
  $('authSend').disabled = true;
  authMsg('Sending...');
  try { await Cloud.signInEmail(email); authMsg('Check your email for a sign-in link, and open it in this browser.'); }
  catch (e) { authMsg(e.message, true); }
  finally { $('authSend').disabled = false; }
});
authDlg.querySelectorAll('[data-provider]').forEach(b =>
  b.addEventListener('click', () => Cloud.signInOAuth(b.dataset.provider).catch(e => authMsg(e.message, true))));
$('authSave').addEventListener('click', async () => {
  try { await Cloud.setDisplayName($('authName').value.trim()); updateAuthUi(); authMsg('Saved.'); }
  catch (e) { authMsg(e.message, true); }
});
$('authOutBtn').addEventListener('click', async () => {
  for (const id of [...cloudTimers.keys()]) { clearTimeout(cloudTimers.get(id)); await pushNow(id); } // don't lose pending edits
  try { await Cloud.signOut(); authDlg.close(); } catch (e) { authMsg(e.message, true); }
});

$('shareCopy').addEventListener('click', async () => {
  const b = $('shareCopy');
  try { await navigator.clipboard.writeText($('shareLink').value); b.textContent = 'Copied!'; }
  catch { $('shareLink').select(); b.textContent = 'Press Ctrl+C'; }
  setTimeout(() => { b.textContent = 'Copy link'; }, 1500);
});

Cloud.onAuth(async user => {
  updateAuthUi();
  updateCopyBtn();
  if (user) await syncDown(true); else signedOutCleanup();
});
Cloud.ready.then(() => { updateAuthUi(); updateCopyBtn(); syncDown(false); });

loadDecks();
route();