'use strict';

const API = 'https://api.scryfall.com';
const DECKS_KEY = 'sparkritual.decks.v2';
const LEGACY_KEY = 'sparkritual.deck.v1';
// Addresses: decks/personal, decks/<id>, users/<name>, account. Served over http they are real paths
// (.htaccess hands them to index.html); opened as a local file they live after a "#/" instead.
const PATH_MODE = location.protocol !== 'file:';
const APP_URL = PATH_MODE ? new URL('.', document.baseURI).href : location.href.split(/[?#]/)[0];
const BASE_PATH = new URL(APP_URL).pathname; // "/" or "/subfolder/"
const hrefFor = path => PATH_MODE ? APP_URL + path : `${APP_URL}#/${path}`;
const APP_TITLE = document.title;

// localStorage can be missing (private mode) or full; every read and write goes through here.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* unavailable or full */ } },
};

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
const WUBRG = 'WUBRG';

const state = {
  id: null,
  name: 'Untitled Deck',
  description: '',
  visibility: 'private',
  commanders: [],      // normalized cards
  cards: {},           // id -> { card, qty }
  sort: 'type',
};
const cache = new Map(); // id -> normalized card (for hover lookups)
const search = { url: null, token: 0, text: '', list: [] };

const $ = id => document.getElementById(id);
const bodyIs = cls => document.body.classList.contains(cls);
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
// Loading indicator: the logo's three circles revolving around their centre (styling in .spinner).
const spinnerHtml = (label = 'Loading...') => `<div class="spinner" role="status"><svg viewBox="-232 -232 464 464" aria-hidden="true"><circle cx="0" cy="-136" r="94"/><circle cx="-117.8" cy="68" r="94" opacity=".7"/><circle cx="117.8" cy="68" r="94" opacity=".4"/></svg><span>${esc(label)}</span></div>`;

// Full-page loading screen (#loading, in the HTML from the first paint). It covers everything until the
// landing page is ready: the sign-in library loaded, the first sync done, and the selected cover drawn.
const LOADING_LINES = ['Floating 3 mana...', 'Holding priority...', 'Untapping lands...', 'In response...'];
let loadingTok = 0, bootDone = false;
function showLoading() {
  const el = $('loading');
  loadingTok++;
  el.querySelector('.loading-text').textContent = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];
  el.classList.remove('out');
  el.hidden = false;
}
function hideLoading() {
  const el = $('loading');
  if (el.hidden) return;
  const tok = ++loadingTok;
  el.classList.add('out'); // fade, then drop out of the layout
  setTimeout(() => { if (tok === loadingTok) { el.hidden = true; el.classList.remove('out'); } }, 300);
}
// Resolves once the selected carousel cover has loaded (or soon enough if it won't).
const coverReady = () => new Promise(res => {
  const img = $('carousel').querySelector('.slide.sel img.cover');
  if (!img || img.complete) return res();
  img.addEventListener('load', res, { once: true });
  img.addEventListener('error', res, { once: true });
  setTimeout(res, 3000);
});
function finishBoot() {
  if (bootDone) return;
  bootDone = true;
  if (!viewing) coverReady().then(hideLoading); // a public profile hides it itself when its decks arrive
}
setTimeout(finishBoot, 8000); // never leave the screen up if the sign-in library stalls
// Memoize a pure function of an object (card or deck) for that object's lifetime.
const memo = fn => { const m = new WeakMap(); return o => { let v = m.get(o); if (v === undefined) m.set(o, v = fn(o)); return v; }; };
// How many copies a deck may hold. Basics and "any number of cards named" (Hare Apparent, Relentless
// Rats...) are unlimited; "up to seven/nine cards named" (Seven Dwarves, Nazgûl) are capped; the rest are singletons.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const maxCopies = memo(c => {
  if (BASICS.has(c.name) || /any number of cards named/i.test(c.oracle_text)) return Infinity;
  const m = /up to (\w+) cards named/i.exec(c.oracle_text);
  return m ? (NUM_WORDS[m[1].toLowerCase()] || parseInt(m[1], 10) || 1) : 1;
});
// Copies of each name in the current deck, commanders included and across printings.
const ownedCounts = () => {
  const m = new Map();
  state.commanders.forEach(c => m.set(c.name, (m.get(c.name) || 0) + 1));
  Object.values(state.cards).forEach(({ card, qty }) => m.set(card.name, (m.get(card.name) || 0) + qty));
  return m;
};
const canAdd = (c, counts = ownedCounts()) => (counts.get(c.name) || 0) < maxCopies(c);
const nameClause = t => t ? ` name:${/\s/.test(t) ? JSON.stringify(t) : t}` : '';

// Status line: an element with class "msg" (or "sync") whose "err" class marks errors.
function setMsg(el, text, bad) {
  if (typeof el === 'string') el = $(el);
  el.textContent = text;
  el.classList.toggle('err', !!bad);
}

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

// Normalize raw Scryfall cards and register them for hover/click lookups.
const intern = raw => raw.map(c => { const n = normalize(c); cache.set(n.id, n); return n; });

async function scry(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 404) return { data: [], next_page: null };
    throw new Error(data.details || 'Scryfall request failed');
  }
  data.data = intern(data.data);
  return data;
}

// Batched lookup by id or name; Scryfall accepts at most 75 identifiers per request.
async function collection(identifiers) {
  const out = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    let res;
    try {
      res = await fetch(`${API}/cards/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: identifiers.slice(i, i + 75) }),
      });
    } catch {
      // Browsers hide the real cause (offline, or a Scryfall outage reply without CORS headers).
      throw new Error("Couldn't reach Scryfall, the card database. Please try again in a few minutes.");
    }
    if (!res.ok) throw new Error(`Scryfall couldn't load the cards right now (error ${res.status}). Please try again in a few minutes.`);
    out.push(...intern((await res.json()).data));
  }
  return out;
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
const cardImg = (c, alt = c.name) => `<img loading="lazy" src="${esc(c.faces[0].small)}" alt="${esc(alt)}">`;

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

// Legal commanders (no `first`), or cards that can pair with `first`, optionally filtered by name.
async function searchCommanders(first, text) {
  const q = (first ? `f:commander ${pairQuery(first)}` : 'is:commander -t:background') + nameClause(text);
  const { data } = await scry(searchUrl(q));
  return first ? data.filter(c => canPair(first, c)) : data;
}

// Combined color identity of a set of commanders, in WUBRG order.
const identityOf = commanders => {
  const set = new Set(commanders.flatMap(c => c.color_identity || []));
  return [...WUBRG].filter(x => set.has(x));
};

let identityKey = '', identityCache = [];
function identity() {
  const key = state.commanders.map(c => c.id).join();
  if (key !== identityKey) { identityCache = identityOf(state.commanders); identityKey = key; }
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

// The regex tests only depend on the card, so they run once per card object.
const cardFlags = memo(card => {
  const t = card.oracle_text;
  return {
    extra: /takes? an extra turn|extra turns? after this one/i.test(t),
    mld: /destroy (all|each) lands?|each player sacrifices? [^.]*lands?/i.test(t),
    tutor: isTutor(t),
  };
});

// Commanders count as one copy each alongside the deck's { card, qty } entries.
const deckEntries = (commanders = [], cards = {}) => [...commanders.map(card => ({ card, qty: 1 })), ...Object.values(cards)];
const allCards = (commanders, cards) => deckEntries(commanders, cards).map(e => e.card);

// Heuristic only: counts Game Changers, extra-turn cards, mass land denial and tutors.
function estimateBracket(commanders = state.commanders, cards = state.cards) {
  const gcNames = [];
  let extra = 0, mld = 0, tutors = 0;
  for (const { card, qty } of deckEntries(commanders, cards)) {
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
  if (e) { if (canAdd(card)) e.qty++; }
  else state.cards[card.id] = { card, qty: 1 };
  refreshDeck();
}

function changeQty(id, d) {
  const e = state.cards[id];
  if (!e || (d > 0 && !canAdd(e.card))) return;
  e.qty += d;
  if (e.qty <= 0) delete state.cards[id];
  refreshDeck();
}

let decks = {}; // id -> { id, name, commanders, cards, sort, updated }

// Writes are coalesced: stringifying every deck on each edit is expensive.
let saveTimer = 0;
function writeDecks() {
  clearTimeout(saveTimer); saveTimer = 0;
  store.set(DECKS_KEY, JSON.stringify(decks));
}
function saveDecks() { if (!saveTimer) saveTimer = setTimeout(writeDecks, 400); }
const flushDecks = () => { if (saveTimer) writeDecks(); };
addEventListener('pagehide', flushDecks);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDecks(); });

// persist() replaces the deck object, so anything memoized per deck object (bracket, value) recomputes after an edit.
function persist() {
  if (!state.id) return;
  const { id, name, description, visibility, commanders, cards, sort } = state;
  const owner = decks[id]?.owner || Cloud.user?.id || undefined;
  decks[id] = { id, name, description, visibility, owner, commanders, cards, sort, updated: Date.now() };
  saveDecks();
  if (owner) queueCloud(id);
}

function loadDecks() {
  try { decks = JSON.parse(store.get(DECKS_KEY)) || {}; } catch { decks = {}; }
  // Carry over the single deck saved by earlier versions.
  try {
    const old = JSON.parse(store.get(LEGACY_KEY));
    if (old && (old.commanders || []).length) {
      const id = newId();
      decks[id] = { id, name: old.name || 'Untitled Deck', commanders: old.commanders, cards: old.cards || {}, sort: old.sort || 'type', updated: Date.now() };
      writeDecks(); // immediate: the legacy key is removed right after
    }
    store.set(LEGACY_KEY, null);
  } catch { /* ignore corrupt data */ }
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Navigate within the app. replace: swap the current history entry instead of adding one.
function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', hrefFor(path));
  route();
}
const gotoDeck = id => go(`decks/${encodeURIComponent(id)}`);
// A deck has one address: the editor when it's in this browser, read-only otherwise.
const openDeckPage = d => { if (d) gotoDeck(d.id); };

function createDeck(name, commanders, cards = {}, visibility = 'private') {
  const id = newId();
  const owner = Cloud.user?.id;
  decks[id] = { id, name, commanders, cards, sort: 'type', visibility, owner, updated: Date.now() };
  saveDecks();
  if (owner) queueCloud(id);
  gotoDeck(id);
}

// Fresh selection, test hand and preview for the deck now in `state`.
function resetBuilder() {
  selectedCard = null;
  dealHand();
  showDefaultPreview();
  renderDeck();
}

function openDeck(id) {
  const d = decks[id];
  Object.assign(state, { id, name: d.name, description: d.description || '', visibility: d.visibility || 'private', commanders: d.commanders || [], cards: d.cards || {}, sort: d.sort || 'type' });
  allCards(state.commanders, state.cards).forEach(c => cache.set(c.id, c));
  document.body.classList.remove('home');
  showDeckTitle();
  clearSearch();
  resetBuilder();
  runSearch();
  refreshStale();
}

function showHome() {
  persist();
  state.id = null;
  if (!bootDone) showLoading(); // first visit: keep the loading screen up until finishBoot()
  document.body.classList.add('home');
  homeSel = 0;
  homeList = []; // start on the most recent deck rather than restoring the old selection
  renderHome();
}

// The route in the address bar: "decks/abc", "users/kevin", "account", or "" at the root.
function currentPath() {
  if (!PATH_MODE) return location.hash.startsWith('#/') ? location.hash.slice(2) : '';
  const p = location.pathname.startsWith(BASE_PATH) ? location.pathname.slice(BASE_PATH.length) : '';
  return p === 'index.html' ? '' : p;
}

// Addresses from before path routing (?d=<id>, ?u=<name>, #deck=<id>, #account) still work.
function legacyPath() {
  const q = new URLSearchParams(location.search), h = location.hash;
  if (h.startsWith('#deck=')) return `decks/${encodeURIComponent(h.slice(6))}`;
  if (h === '#account') return 'account';
  if (q.get('d')) return `decks/${encodeURIComponent(q.get('d'))}`;
  if (q.get('u')) return `users/${encodeURIComponent(q.get('u'))}`;
  return null;
}

function route() {
  const legacy = legacyPath();
  if (legacy !== null) return go(legacy, true);
  const path = currentPath();
  let m;
  // Only the landing page and public profiles use the loading screen; every other page shows at once.
  if (path && path !== 'decks/personal' && !path.startsWith('users/')) hideLoading();
  if ((m = path.match(/^users\/([^/]+)$/))) return openProfile(decodeURIComponent(m[1]));
  if ((m = path.match(/^decks\/([^/]+)$/)) && m[1] !== 'personal') {
    const id = decodeURIComponent(m[1]);
    if (!decks[id]) return openShared(id); // not in this browser: someone else's, or yours before it has synced
    leaveViewer();
    profileCache.clear();
    return openDeck(id);
  }
  leaveViewer();
  profileCache.clear();
  if (path === 'account') return showAccount();
  if (path === 'login') return showLogin();
  // A bare root becomes decks/personal at once. A root carrying a query or hash is left alone for now:
  // sign-in returns land there with ?code=, which the Supabase library must read first (Cloud.ready tidies it).
  if (path !== 'decks/personal' && (path || (!location.search && location.hash.length < 2))) return go('decks/personal', true);
  showHome();
}

/* ---------- Landing page: carousel ---------- */

let homeList = [], homeSel = 0, homeRadius = 0;
// Public profile being shown on the landing page (?u=<name>), or null for your own decks.
// { name, owner?, ownerId?, decks: [deck] | null while loading, error? }
let viewing = null;
const profileEmptyText = () => viewing.error || (viewing.decks ? `${viewing.owner} hasn't shared any decks yet.` : 'Loading decks...');
const profileLoading = () => !!viewing && !viewing.decks && !viewing.error;
// homeTarget is where navigation is heading; homeSel walks toward it one slot at a time.
let homeTarget = 0, stepTimer = 0;
const homeSlides = new Map();
const STEP_MS = 160, CATCHUP_MS = 90; // pace for single steps vs. catching up on long jumps

const deckCover = d => d.commanders?.[0]?.faces[0].image;
const commanderName = d => (d.commanders || []).map(c => c.name).join(' + ');
const deckIdentity = d => identityOf(d.commanders || []);

// Cover Flow placement for a slide `o` slots away from the selected one (negative = left).
function slideTransform(o) {
  if (!o) return 'translateZ(calc(var(--w) * .26))';
  const sign = Math.sign(o), a = Math.abs(o);
  return `translateX(calc(${sign} * var(--w) * (0.75 + ${a - 1} * 0.3))) translateZ(calc(var(--w) * -.46)) rotateY(${-sign * 62}deg)`;
}

function createHomeSlide(i) {
  const d = homeList[i];
  const img = deckCover(d);
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
    const o = i - homeSel;
    slide.classList.toggle('sel', o === 0);
    if (!slide.style.zIndex) slide.style.zIndex = 100 - Math.abs(o); // new slides only; restack() owns it after that
    slide.style.transform = slideTransform(o);
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

const EMPTY_GHOSTS = 8; // decorative empty decks per side when there are no decks
const PLUS_ICON = '<svg class="plus-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><path d="M12 7v10M7 12h10"/></svg>';
const infoHtml = (title, rows) => `<div class="info-text"><div class="title-row">${title}</div>${rows.map(([l, v]) => `<div class="meta"><span class="lbl">${l}:</span> ${v}</div>`).join('')}</div>`;

function renderHome() {
  // Keep the same deck selected even if a sync or edit re-sorted the list.
  const keepId = homeList[homeSel]?.id;
  homeList = sortDecks(viewing ? [...(viewing.decks || [])] : Object.values(decks));
  const kept = keepId ? homeList.findIndex(d => d.id === keepId) : -1;
  homeSel = Math.max(0, Math.min(kept >= 0 ? kept : homeSel, homeList.length - 1));
  stopStepping();
  deckMenu.close();
  const carousel = $('carousel');
  homeSlides.clear();
  carousel.replaceChildren();
  $('deckInfo').innerHTML = '';
  $('home').dataset.view = homeView;
  if (homeView === 'gallery') return renderGallery();
  if (homeView === 'list') return renderList();
  if (!homeList.length) {
    // Empty card where the first deck will appear, flanked by decorative empty decks so the
    // carousel doesn't look bare. Only the centre card is clickable; all go away once a deck exists.
    const ghosts = [];
    for (let a = EMPTY_GHOSTS; a >= 1; a--) {
      for (const sign of [-1, 1]) {
        ghosts.push(`<div class="slide ghost" aria-hidden="true" style="z-index: ${100 - a}; transform: ${slideTransform(sign * a)}">
          <div class="cover blank"></div><div class="refl"><div class="blank"></div></div></div>`);
      }
    }
    carousel.innerHTML = ghosts.join('') + (viewing
      ? `<div class="slide sel" aria-hidden="true" style="z-index: 100; transform: ${slideTransform(0)}">`
      : `<div class="slide sel placeholder" role="button" tabindex="0" aria-label="Create a new deck" title="Create a new deck" style="z-index: 100; transform: ${slideTransform(0)}">`)
      + `<div class="cover blank">${viewing ? '' : PLUS_ICON}</div>
      <div class="refl"><div class="blank"></div></div></div>`;
    $('prevBtn').disabled = $('nextBtn').disabled = true;
    $('deckInfo').innerHTML = viewing
      ? (profileLoading() ? spinnerHtml('Loading decks...') : infoHtml(`<div class="title muted">${esc(profileEmptyText())}</div>`, []))
      : infoHtml('<div class="title muted">No decks created.</div>', [['Commander', '--'], ['Bracket', '--'], ['Color Identity', '--']]);
    return;
  }
  const selected = createHomeSlide(homeSel);
  homeSlides.set(homeSel, selected);
  carousel.appendChild(selected);
  updateHomeRadius();
  renderHomeSlides();
  renderInfo();
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
  if (!bodyIs('home') || homeView !== 'carousel' || homeTarget === homeSel) { stepTimer = 0; return; }
  const far = Math.abs(homeTarget - homeSel) > 1;
  deckMenu.close();
  homeSel += Math.sign(homeTarget - homeSel);
  renderHomeSlides();
  renderInfo();
  stepTimer = setTimeout(stepToward, far ? CATCHUP_MS : STEP_MS);
}

// While resizing, slide positions track --w instantly instead of easing behind the window.
let resizeEnd = 0, resizeFrame = 0;
window.addEventListener('resize', () => {
  if (!bodyIs('home') || homeView !== 'carousel' || !homeList.length) return;
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

/* ---------- Landing page: sorting ---------- */

// Per deck object: persist() and sync replace the object after every change, so these never go stale.
const deckBracket = memo(d => estimateBracket(d.commanders, d.cards));
// Total value of the printings in the deck (commanders + every copy), using each printing's USD price.
const deckValue = memo(d => deckEntries(d.commanders, d.cards).reduce((sum, { card, qty }) => sum + (parseFloat(card.prices?.usd) || 0) * qty, 0));

// Deck ids start with Date.now() in base 36 (see newId), so creation time comes free with every deck.
function deckCreated(d) {
  const t = parseInt(String(d.id).slice(0, 8), 36);
  return t > 1.4e12 && t < Date.now() + 864e5 ? t : (d.created || d.updated || 0);
}

// Colorless first, then mono W, U, B, R, G, then pairs (WU, WB, ...), and so on up to five colors.
function colorKey(d) {
  const idx = deckIdentity(d).map(x => WUBRG.indexOf(x));
  return [idx.length, ...idx];
}
const cmpArr = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = (a[i] ?? -1) - (b[i] ?? -1); if (x) return x; } return 0; };
const cmpText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

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
  const saved = JSON.parse(store.get('sparkritual.homeSort'));
  if (saved && HOME_SORTS[saved.key]) homeSort = { key: saved.key, reversed: !!saved.reversed };
} catch { /* keep default */ }

const sortIsDesc = () => !!HOME_SORTS[homeSort.key].desc !== homeSort.reversed;

function sortDecks(list) {
  const dir = sortIsDesc() ? -1 : 1, cmp = HOME_SORTS[homeSort.key].cmp;
  return list.sort((a, b) => dir * cmp(a, b) || cmpText(a.name || '', b.name || '') || (a.id < b.id ? -1 : 1));
}

// Arrow beside bars that grow (ascending) or shrink (descending) in the direction of the arrow.
const SORT_ASC_ICON = '<svg class="sort-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 20V4M3 8l4-4 4 4M12 7h3M12 12h6M12 17h9"/></svg>';
const SORT_DESC_ICON = '<svg class="sort-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16M3 16l4 4 4-4M12 7h9M12 12h6M12 17h3"/></svg>';

function showHomeSort() {
  const desc = sortIsDesc();
  $('homeSort').value = homeSort.key;
  $('homeSortDir').innerHTML = desc ? SORT_DESC_ICON : SORT_ASC_ICON;
  $('homeSortDir').title = `${desc ? 'Descending' : 'Ascending'}: click to reverse`;
  $('homeSortDir').setAttribute('aria-label', `Sort order: ${desc ? 'descending' : 'ascending'}. Click to reverse`);
}

function setHomeSort(key, reversed) {
  homeSort = { key, reversed };
  store.set('sparkritual.homeSort', JSON.stringify(homeSort));
  showHomeSort();
  if (bodyIs('home')) renderHome(); // renderHome keeps the selected deck in view
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
  const rows = [['Commander', esc(commanderName(d))], ['Bracket', deckBracket(d).level], ['Color Identity', identitySymbols(deckIdentity(d))]];
  // Show the value being sorted on when it isn't already one of the standard lines.
  const extra = { cost: ['Value', fmtUsd(deckValue(d))], created: ['Created', fmtDate(deckCreated(d))], recent: ['Last edited', fmtDate(d.updated)] }[homeSort.key];
  if (extra) rows.push([extra[0], esc(extra[1])]);
  $('deckInfo').innerHTML = infoHtml(`<div class="title">${esc(d.name)}</div>${optsBtn(d)}`, rows);
}

const optsBtn = d => viewing ? '' : `<button class="opts-btn" data-deck-menu="${esc(d.id)}" aria-label="Options for ${esc(d.name)}" aria-haspopup="menu" aria-expanded="false">&#8943;</button>`;
const activateSlide = () => openDeckPage(homeList[homeSel]);

function deleteDeck(d) {
  if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
  delete decks[d.id];
  lastPushed.delete(d.id);
  saveDecks();
  if (d.owner && Cloud.user) Cloud.removeDeck(d.id).catch(e => setSync('Online delete failed: ' + e.message, true));
  renderHome();
}

/* ---------- Floating menus ---------- */

// One fixed-position menu reused by every button that opens it. open(btn) anchors it under the
// button (alignRight: flush with the button's right edge); onAct(action, btn) handles a choice.
// It closes on an outside pointerdown, Escape (returning focus to the button), scroll and resize.
function makeMenu(cls, html, onAct) {
  const el = document.createElement('div');
  el.className = cls ? `card-menu ${cls}` : 'card-menu';
  el.hidden = true;
  el.setAttribute('role', 'menu');
  el.innerHTML = html;
  document.body.appendChild(el);
  const m = { anchor: null, isOpen: () => !el.hidden };
  m.open = (btn, alignRight = false) => {
    m.close();
    m.anchor = btn;
    btn.setAttribute('aria-expanded', 'true');
    el.hidden = false;
    const r = btn.getBoundingClientRect();
    el.style.top = `${Math.min(r.bottom + 4, innerHeight - el.offsetHeight - 4)}px`;
    el.style.left = `${Math.max(4, Math.min(alignRight ? r.right - el.offsetWidth : r.left, innerWidth - el.offsetWidth - 4))}px`;
    el.querySelector('button').focus();
  };
  m.close = (refocus = false) => {
    if (el.hidden) return;
    el.hidden = true;
    if (m.anchor) {
      m.anchor.setAttribute('aria-expanded', 'false');
      if (refocus && m.anchor.isConnected) m.anchor.focus();
    }
    m.anchor = null;
  };
  m.toggle = (btn, alignRight) => { if (m.anchor === btn) m.close(); else m.open(btn, alignRight); };
  el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const btn = m.anchor;
    m.close();
    onAct(act.dataset.act, btn);
  });
  document.addEventListener('pointerdown', e => { if (!el.hidden && !el.contains(e.target) && !m.anchor.contains(e.target)) m.close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden) m.close(true); });
  document.addEventListener('scroll', () => m.close(), true); // the menu is fixed, so it would detach from its button
  window.addEventListener('resize', () => m.close());
  return m;
}

// Deck options ("⋯" in every landing view); the button's data-deck-menu holds the deck id.
// Add future deck actions here.
const deckMenu = makeMenu('deck-menu',
  '<button role="menuitem" data-act="edit">Edit</button><button role="menuitem" class="danger" data-act="delete">Delete</button>',
  (act, btn) => {
    const d = decks[btn.dataset.deckMenu];
    if (!d) return;
    if (act === 'edit') openDeckPage(d);
    else if (act === 'delete') deleteDeck(d);
  });

// Card options ("⋯" on a deck row or tile).
const cardMenu = makeMenu('',
  '<button role="menuitem" data-act="print">Switch Printing</button><button role="menuitem" data-act="remove">Remove Card</button>',
  (act, btn) => {
    const id = btn.closest('[data-id]').dataset.id;
    if (act === 'remove') { if (state.cards[id]) changeQty(id, -state.cards[id].qty); }
    else if (cache.get(id)) openPrintings(cache.get(id));
  });

/* ---------- Landing views: carousel (default), gallery, list ---------- */

const HOME_VIEWS = ['carousel', 'gallery', 'list'];
let homeView = 'carousel';
{
  const saved = store.get('sparkritual.homeView');
  if (HOME_VIEWS.includes(saved)) homeView = saved;
}
$('homeView').value = homeView;
$('homeView').addEventListener('change', e => {
  homeView = HOME_VIEWS.includes(e.target.value) ? e.target.value : 'carousel';
  store.set('sparkritual.homeView', homeView);
  $('home').scrollTop = 0;
  if (bodyIs('home')) renderHome();
});

function renderGallery() {
  $('galleryView').innerHTML = homeList.length
    ? homeList.map((d, i) => {
      const img = deckCover(d);
      return `<div class="tile" data-i="${i}">
        <button class="tile-art" data-open title="Open ${esc(d.name)}">${img ? `<img src="${esc(img)}" alt="${esc(d.name)}" loading="lazy" decoding="async" draggable="false">` : '<div class="blank"></div>'}</button>
        <div class="tile-row"><div class="tile-text"><div class="tile-name">${esc(d.name)}</div><div class="tile-sub">${esc(commanderName(d))}</div></div>${optsBtn(d)}</div>
      </div>`;
    }).join('')
    : viewing ? (profileLoading() ? spinnerHtml('Loading decks...') : `<div class="msg">${esc(profileEmptyText())}</div>`)
    : `<div class="tile"><button class="tile-art placeholder" data-new aria-label="Create a new deck" title="Create a new deck">${PLUS_ICON}</button></div>`;
}

// Columns map onto the sort keys, so clicking a header sorts by it (again to reverse).
const LIST_COLS = [
  ['name', 'Deck Name'], ['commander', 'Commander'], ['color', 'Color Identity'], ['bracket', 'Bracket'],
  ['cost', 'Value'], ['created', 'Created'], ['recent', 'Last Edited'],
];

function renderList() {
  const desc = sortIsDesc();
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
    : `<tr><td colspan="${LIST_COLS.length + 1}" class="list-empty">${viewing ? (profileLoading() ? spinnerHtml('Loading decks...') : esc(profileEmptyText())) : 'No decks yet. <button data-new>Create a New Deck</button> to get started.'}</td></tr>`;
  $('deckTable').innerHTML = `<thead><tr>${head}<th class="c-opts"><span class="sr-only">Options</span></th></tr></thead><tbody>${body}</tbody>`;
  listDeck = null; // force a redraw (null never matches a deck or the empty-list undefined)
  showHomePreview(homeList[homeSel]);
}

// The list's preview panel shows the deck's commander, like the builder's card preview.
// Re-showing the deck already on screen is a no-op (keeps a flipped card flipped).
let listDeck = null;
function showHomePreview(d) {
  if (listDeck === d) return;
  listDeck = d;
  const c = d?.commanders?.[0];
  if (c) listPreview.show(c);
  else listPreview.clear(homeList.length ? 'Hover over a deck to preview its commander.' : viewing ? profileEmptyText() : 'Your decks will appear here.');
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

// Clicks shared by all three views.
$('home').addEventListener('click', e => {
  const menuBtn = e.target.closest('[data-deck-menu]');
  if (menuBtn) { deckMenu.toggle(menuBtn); return; }
  if (e.target.closest('[data-new]')) { openNewDeck(); return; }
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
  if (s.classList.contains('placeholder')) { openNewDeck(); return; }
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

// Keyboard navigation for the carousel (arrows in any direction) and the list (up/down).
// The gallery's tiles are buttons, so Tab + Enter already opens a deck there.
const CAROUSEL_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
const LIST_KEYS = { ArrowDown: 1, ArrowUp: -1 };
document.addEventListener('keydown', e => {
  if (!bodyIs('home') || document.querySelector('dialog[open]') || deckMenu.isOpen()) return; // an open options menu takes the keyboard
  if (e.target.closest && e.target.closest('select, input, textarea')) return; // let the sort dropdown use its keys
  if (homeView === 'gallery') return;
  const list = homeView === 'list';
  const select = list ? selectListRow : selectSlide;
  const step = (list ? LIST_KEYS : CAROUSEL_KEYS)[e.key];
  if (step) { e.preventDefault(); select(homeTarget + step); }
  else if (e.key === 'Home') { e.preventDefault(); select(0); }
  else if (e.key === 'End') { e.preventDefault(); select(homeList.length - 1); }
  else if (e.key === 'Enter' && !e.target.closest('button')) {
    if (homeList.length) activateSlide(); else if (!viewing) openNewDeck();
  }
});
window.addEventListener('popstate', route); // Back / Forward (also fires for hand-edited hashes)

// Decks saved before a field existed are re-fetched to fill it in.
async function refreshStale() {
  const stale = allCards(state.commanders, state.cards).filter(c => c.game_changer === undefined);
  if (!stale.length) return;
  try {
    (await collection(stale.map(c => ({ id: c.id })))).forEach(n => {
      if (state.cards[n.id]) state.cards[n.id].card = n;
      const k = state.commanders.findIndex(c => c.id === n.id);
      if (k >= 0) state.commanders[k] = n;
    });
  } catch { return; }
  persist(); renderDeck();
}

/* ---------- Sorting / grouping ---------- */

const primaryType = memo(c => {
  const front = c.type_line.split(' // ')[0];
  return TYPE_PRIORITY.find(t => front.includes(t)) || 'Other';
});

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
  const slots = state.commanders.map((c, i) => `<div class="slot filled${selectedCard?.id === c.id ? ' sel' : ''}" data-id="${c.id}">
      <span class="nm">${esc(c.name)}</span><span class="cost">${symbols(c.mana_cost)}</span>
      <button class="x-btn" data-remove-cmd="${i}" title="Remove" aria-label="Remove"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg></button></div>`);
  if (!state.commanders.length) {
    slots.push('<div class="slot"><span class="nm label">No commander set.</span><button data-pick-cmd>Add</button></div>');
  } else if (secondSlotAvailable()) {
    slots.push('<div class="slot"><span class="nm label">Partner / Background (optional)</span><button data-pick-cmd>Add</button></div>');
  }
  $('commanderSlots').innerHTML = slots.join('');
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

  const grid = viewMode.startsWith('grid');
  const item = grid ? deckTile : deckRow;
  const html = groupCards(entries).map(([name, list]) => {
    const n = list.reduce((s, e) => s + e.qty, 0);
    return `<div class="group"><h3>${esc(name)} (${n})</h3><div class="items">${list.map(item).join('')}</div></div>`;
  }).join('');
  $('deckList').className = `view-${viewMode}${viewStack && grid ? ' stacked' : ''}`;
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
  const cards = hand.cards.map(c => `<div class="hc" data-id="${c.id}"><img src="${esc(c.faces[0].small)}" alt="${esc(c.name)}"></div>`).join('');
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

const VIEW_MODES = ['list', 'list2', 'grid-s', 'grid-m', 'grid-l'];
let viewMode = store.get('sparkritual.view');
if (!VIEW_MODES.includes(viewMode)) viewMode = 'list2';
let viewStack = store.get('sparkritual.stack') === '1';

// Shared by rows and tiles: legality + selection classes, and the hover action buttons.
const itemClass = card => `${inIdentity(card) ? '' : ' illegal'}${selectedCard?.id === card.id ? ' sel' : ''}`;
const itemActs = card => `<span class="acts">${maxCopies(card) > 1 && canAdd(card) ? '<button data-qty="1" title="Add one">+</button>' : ''}<button data-menu title="Options" aria-haspopup="menu" aria-expanded="false">&#8943;</button></span>`;

function deckTile({ card, qty }) {
  return `<div class="tile${itemClass(card)}" data-id="${card.id}">
    <img loading="lazy" src="${esc(card.faces[0].image || card.faces[0].small)}" alt="${esc(card.name)}">
    ${qty > 1 ? `<span class="tq">${qty}</span>` : ''}${itemActs(card)}</div>`;
}

function deckRow({ card, qty }) {
  return `<div class="row${itemClass(card)}" data-id="${card.id}">
    <span class="qty">${qty}</span><span class="nm">${esc(card.name)}</span>${card.game_changer ? GC_ICON : ''}
    <span class="cost">${symbols(card.mana_cost)}</span>
    <span class="price">${card.prices.usd ? '$' + esc(card.prices.usd) : '&mdash;'}</span>${itemActs(card)}</div>`;
}

/* ---------- Rendering: preview ---------- */

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

// A card preview panel. show(card, face) renders it, clear(text) shows a hint instead, and a click
// on its Flip button turns the card over. `opts` are previewHtml options, or a function of the card.
function makePreview(id, opts) {
  const el = $(id);
  const pv = { card: null, face: 0 };
  pv.show = (card, face = 0) => {
    pv.card = card; pv.face = face;
    el.innerHTML = previewHtml(card, face, typeof opts === 'function' ? opts(card) : opts);
  };
  pv.clear = text => { pv.card = null; pv.face = 0; el.innerHTML = `<div class="preview-empty">${text}</div>`; };
  el.addEventListener('click', e => {
    if (pv.card && e.target.closest('[data-flip]')) pv.show(pv.card, (pv.face + 1) % pv.card.faces.length);
  });
  return pv;
}

const inDeck = c => !!state.cards[c.id] || state.commanders.some(x => x.id === c.id);
const preview = makePreview('preview', card => ({ change: inDeck(card) }));   // deck builder
const listPreview = makePreview('homePreview', { identity: true });           // landing page, list view
const draftPreview = makePreview('newPreview', { identity: true });           // new deck dialog
let selectedCard = null;

// With nothing hovered, the preview shows the selected card, else the commander, else a hint.
function showDefaultPreview() {
  const c = selectedCard || state.commanders[0];
  if (c) preview.show(c); else preview.clear('Hover over a card to preview it.');
}

// Clicking a deck card or commander pins it in the preview panel.
function selectCard(c, el) {
  selectedCard = c;
  preview.show(c);
  document.querySelectorAll('#builder .sel').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
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
  const text = $('searchInput').value.trim();
  search.text = text;
  resetResults();
  const token = ++search.token;
  if (!state.commanders.length || !text) { setMsg('searchMsg', ''); return []; }
  setMsg('searchMsg', 'Searching...');
  try {
    const data = await scry(searchUrl(buildQuery(text)));
    if (token !== search.token) return [];
    const list = rank(data.data, text);
    search.list = list;
    setMsg('searchMsg', list.length ? '' : 'No cards found.');
    search.url = data.next_page;
    appendResults(list);
    return list;
  } catch (e) {
    if (token === search.token) setMsg('searchMsg', e.message, true);
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
    setMsg('searchMsg', e.message, true);
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

function renderResultStates() {
  const owned = ownedCounts();
  let top = null;
  for (const row of $('searchResults').children) {
    const addable = canAdd(cache.get(row.dataset.id), owned);
    row.classList.toggle('owned', !addable);
    const isTop = addable && !top;
    if (isTop) top = row;
    row.classList.toggle('top', isTop);
  }
}

function pickResult(card) {
  addCard(card);
  clearSearch();
}

/* ---------- Partner / Background dialog ---------- */

const dlg = $('cmdDialog');
let partnerToken = 0;

// Opens the commander picker: for the main commander when the deck has none, otherwise for a partner/background.
function openPartnerDialog() {
  $('cmdTitle').textContent = state.commanders.length ? 'Choose Partner / Background' : 'Choose Commander';
  $('cmdInput').value = '';
  $('cmdResults').innerHTML = '';
  dlg.showModal();
  searchPartners();
}

async function searchPartners() {
  setMsg('cmdMsg', 'Searching...');
  const token = ++partnerToken;
  try {
    const list = (await searchCommanders(state.commanders[0], $('cmdInput').value.trim())).slice(0, 60);
    if (token !== partnerToken) return;
    setMsg('cmdMsg', list.length ? '' : 'No matching cards.');
    $('cmdResults').innerHTML = list.map(c => `<button class="cmd-card" data-cmd="${c.id}" title="${esc(c.name)}">${cardImg(c)}<div>${esc(c.name)}</div></button>`).join('');
  } catch (e) { if (token === partnerToken) setMsg('cmdMsg', e.message, true); }
}

function setPartner(card) {
  state.commanders.push(card);
  delete state.cards[card.id];
  dlg.close();
  refreshDeck(true);
  if (!selectedCard) showDefaultPreview();
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
  setMsg('printMsg', 'Loading...');
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
  } catch (e) { setMsg('printMsg', e.message, true); }
}

function renderPrintings() {
  const q = $('printFilter').value.trim().toLowerCase();
  const rows = printList.filter(c => !q || `${c.set_name} ${c.set} ${c.collector} ${c.released.slice(0, 4)}`.toLowerCase().includes(q));
  setMsg('printMsg', rows.length ? `${rows.length} printing${rows.length === 1 ? '' : 's'}` : 'No matching printings.');
  $('printGrid').innerHTML = rows.map(c => `<button class="cmd-card ${c.id === printTarget.id ? 'cur' : ''}" data-id="${c.id}">${cardImg(c, c.set_name)}
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
  if (selectedCard?.id === oldCard.id) selectedCard = nu;
  preview.show(nu);
}

$('printFilter').addEventListener('input', renderPrintings);
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
  if (c && c !== preview.card) preview.show(c);
}

['deckList', 'searchResults', 'commanderSlots', 'hand'].forEach(id => {
  $(id).addEventListener('mouseover', hoverHandler);
  $(id).addEventListener('mouseleave', () => {
    const back = selectedCard || state.commanders[0];
    if (back && back !== preview.card) showDefaultPreview();
  });
});

$('preview').addEventListener('click', e => {
  if (e.target.closest('[data-print]')) openPrintings(preview.card);
});

function clearSearch() {
  onSearchInput.cancel();
  $('searchInput').value = '';
  search.text = '';
  resetResults();
  setMsg('searchMsg', '');
  setDrop(false);
}

$('searchResults').addEventListener('click', e => {
  const row = e.target.closest('[data-id]');
  if (row && !row.classList.contains('owned')) pickResult(cache.get(row.dataset.id));
});

// Clicking anywhere that isn't a card or an interactive element deselects the selected card.
document.addEventListener('click', e => {
  if (!selectedCard || bodyIs('home')) return;
  if (e.target.closest('[data-id], [data-menu], button, input, textarea, select, a, label, summary, [tabindex], dialog, .card-menu')) return;
  selectedCard = null;
  document.querySelectorAll('#builder .sel').forEach(x => x.classList.remove('sel'));
  showDefaultPreview();
});

$('deckList').addEventListener('click', e => {
  const m = e.target.closest('[data-menu]');
  if (m) return cardMenu.toggle(m, true);
  const b = e.target.closest('[data-qty]');
  if (b) return changeQty(b.closest('[data-id]').dataset.id, +b.dataset.qty);
  const item = e.target.closest('[data-id]');
  const c = item && cache.get(item.dataset.id);
  if (c) selectCard(c, item);
});

$('commanderSlots').addEventListener('click', e => {
  if (e.target.closest('[data-pick-cmd]')) return openPartnerDialog();
  const r = e.target.closest('[data-remove-cmd]');
  if (r) {
    const i = +r.dataset.removeCmd;
    // Removing the first commander drops any dependent partner.
    const removed = state.commanders.splice(i, i === 0 ? state.commanders.length : 1);
    if (removed.some(c => c.id === selectedCard?.id)) selectedCard = null;
    refreshDeck(true);
    showDefaultPreview();
    return;
  }
  // Clicking a commander selects it for the preview panel, like a deck card.
  const slot = e.target.closest('.slot[data-id]');
  const c = slot && cache.get(slot.dataset.id);
  if (c) selectCard(c, slot);
});

$('cmdResults').addEventListener('click', e => {
  const b = e.target.closest('[data-cmd]');
  if (b) setPartner(cache.get(b.dataset.cmd));
});
$('cmdInput').addEventListener('input', debounce(searchPartners, 300));

const setDrop = open => $('searchDrop').classList.toggle('open', open);
const onSearchInput = debounce(runSearch, 350);
$('searchInput').addEventListener('input', () => { setDrop(!!$('searchInput').value.trim()); onSearchInput(); });
$('searchInput').addEventListener('focus', () => { if ($('searchInput').value.trim()) setDrop(true); });
$('searchInput').addEventListener('keydown', async e => {
  if (e.key === 'Escape') return setDrop(false);
  if (e.key !== 'Enter') return;
  e.preventDefault();
  onSearchInput.cancel();
  if ($('searchInput').value.trim() !== search.text) await runSearch();
  const owned = ownedCounts();
  const hit = search.list.find(c => canAdd(c, owned));
  if (hit) pickResult(hit);
});
$('searchBar').addEventListener('focusout', e => { if (!$('searchBar').contains(e.relatedTarget)) setDrop(false); });
// Keep input focus when clicking inside the dropdown.
$('searchDrop').addEventListener('mousedown', e => e.preventDefault());
$('moreBtn').addEventListener('click', loadMore);

/* ---------- Dialog plumbing ---------- */

// Every Close/Cancel button carries data-close; a button with data-dialog opens that dialog.
// Dialogs that need setup before opening have their own handlers below.
document.addEventListener('click', e => {
  const close = e.target.closest('dialog [data-close]');
  if (close) return close.closest('dialog').close();
  const open = e.target.closest('[data-dialog]');
  if (open) $(open.dataset.dialog).showModal();
});

// Copy button beside a text field; the label reports the result for a moment.
function bindCopy(btnId, srcId, label) {
  const b = $(btnId), src = $(srcId);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(src.value); b.textContent = 'Copied!'; }
    catch { src.select(); b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { b.textContent = label; }, 1500);
  });
}

$('viewBtn').addEventListener('click', () => {
  document.querySelector(`input[name="viewMode"][value="${viewMode}"]`).checked = true;
  $('viewStack').checked = viewStack;
  $('viewDialog').showModal();
});
$('viewDialog').addEventListener('change', e => {
  if (e.target.id === 'viewStack') {
    viewStack = e.target.checked;
    store.set('sparkritual.stack', viewStack ? '1' : '0');
    return renderDeck();
  }
  viewMode = e.target.value;
  store.set('sparkritual.view', viewMode);
  renderDeck();
  $('viewDialog').close();
});

$('sortSelect').addEventListener('change', e => { state.sort = e.target.value; persist(); renderDeck(); });

/* ---------- Deck settings ---------- */

function showDeckTitle() {
  $('deckTitle').textContent = state.name;
  $('deckTitle').title = state.description;
  if (document.activeElement !== $('deckNameInput')) $('deckNameInput').value = state.name;
  sizeDeckNameInput();
}

// Grow/shrink the inline name input to fit its text (CSS caps it at 50vw).
const nameCtx = document.createElement('canvas').getContext('2d');
function sizeDeckNameInput() {
  const input = $('deckNameInput');
  const cs = getComputedStyle(input);
  nameCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const text = nameCtx.measureText(input.value || input.placeholder).width;
  const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  input.style.width = `${Math.ceil(text + chrome) + 2}px`;
}

function commitDeckName() {
  const input = $('deckNameInput');
  const name = input.value.trim() || 'Untitled Deck';
  input.value = name;
  if (name !== state.name && state.id) {
    state.name = name;
    persist();
  }
  showDeckTitle();
}

$('deckNameInput').placeholder = 'Untitled Deck';
$('deckNameInput').addEventListener('input', sizeDeckNameInput);
$('deckNameInput').addEventListener('change', commitDeckName);
$('deckNameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('deckNameInput').blur(); }
  else if (e.key === 'Escape') { $('deckNameInput').value = state.name; sizeDeckNameInput(); $('deckNameInput').blur(); }
});
$('deckNameInput').addEventListener('focus', () => $('deckNameInput').select());

$('settingsBtn').addEventListener('click', () => {
  $('setName').value = state.name;
  $('setDesc').value = state.description;
  $('shareBox').hidden = !(Cloud.enabled && Cloud.user);
  $('setVis').value = state.visibility;
  $('shareHidden').hidden = Cloud.profile?.decks_visible !== false;
  $('settingsDialog').showModal();
});
$('settingsSave').addEventListener('click', () => {
  state.name = $('setName').value.trim() || 'Untitled Deck';
  state.description = $('setDesc').value.trim();
  state.visibility = $('setVis').value;
  persist();
  flushDeck(state.id); // so a visibility change reaches the server right away
  showDeckTitle();
  $('settingsDialog').close();
});
$('shareHidden').querySelector('a').href = hrefFor('account');
$('shareHidden').addEventListener('click', e => {
  if (!e.target.closest('a')) return;
  e.preventDefault();
  $('settingsDialog').close();
  go('account');
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
  (await collection(unique.map(name => ({ name })))).forEach(c => {
    c.name.toLowerCase().split(' // ').concat(c.name.toLowerCase()).forEach(k => byKey.set(k, c));
  });
  return byKey;
}

// entries: [{ card, qty }] where card may be undefined (not found). Quantities are clamped to each
// card's copy limit; a line with no room left counts as a duplicate.
function buildCards(entries, cmdIds) {
  const cards = {};
  let dupes = 0;
  for (const { card: c, qty } of entries) {
    if (!c || cmdIds.has(c.id)) continue;
    const have = cards[c.id]?.qty || 0, room = maxCopies(c) - have;
    if (room <= 0) { dupes++; continue; }
    const add = Math.min(qty, room);
    if (cards[c.id]) cards[c.id].qty += add; else cards[c.id] = { card: c, qty: add };
  }
  return { cards, dupes };
}

// Parses the list in `textId`, looks every name up on Scryfall and hands the result to `apply`:
// { parsed, find(name), missing: [names], entries: [{ card, qty }] }. Progress and errors go to `msgId`.
async function importList(textId, msgId, btnId, apply) {
  const msg = $(msgId), btn = $(btnId);
  const parsed = parseList($(textId).value);
  const names = [...parsed.commanders, ...parsed.cards.map(c => c.name)];
  if (!names.length) return setMsg(msg, 'Nothing to import.');
  setMsg(msg, 'Importing...'); btn.disabled = true;
  try {
    const found = await fetchByNames(names);
    const find = n => found.get(n.toLowerCase());
    const missing = [...new Set(names.filter(n => !find(n)))];
    const entries = parsed.cards.map(e => ({ card: find(e.name), qty: e.qty }));
    await apply({ parsed, find, missing, entries });
  } catch (e) {
    setMsg(msg, e.message, true);
  } finally { btn.disabled = false; }
}

function applyList() {
  return importList('listText', 'listMsg', 'listApply', ({ parsed, find, missing, entries }) => {
    const commanders = parsed.commanders.length ? parsed.commanders.map(find).filter(Boolean).slice(0, 2) : state.commanders;
    if (!commanders.length) throw new Error('A valid commander is required (add a "Commander" heading).');
    if (commanders.length === 2 && !canPair(commanders[0], commanders[1])) throw new Error('Those two commanders cannot be paired.');
    const { cards, dupes } = buildCards(entries, new Set(commanders.map(c => c.id)));
    Object.assign(state, { commanders, cards });
    refreshDeck(true);
    const notes = [];
    if (missing.length) notes.push(`Not found: ${missing.join(', ')}`);
    if (dupes) notes.push(`${dupes} duplicate(s) skipped (copy limit)`);
    if (notes.length) { setMsg('listMsg', `Imported. ${notes.join('. ')}.`); $('listText').value = exportText(); }
    else listDlg.close();
  });
}

$('listBtn').addEventListener('click', () => {
  $('listText').value = exportText();
  setMsg('listMsg', '');
  listDlg.showModal();
});
$('listApply').addEventListener('click', applyList);
bindCopy('listCopy', 'listText', 'Copy');

/* ---------- New deck dialog ---------- */

const newDlg = $('newDialog');
const draft = { card: null, partner: null, target: 'cmd', token: 0, importText: '', imported: [] };

function restoreDraftPreview() {
  const selected = (draft.target === 'partner' && draft.partner) || draft.card;
  if (selected && selected !== draftPreview.card) draftPreview.show(selected);
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
  Object.assign(draft, { card: null, partner: null, target: 'cmd', importText: '', imported: [] });
  $('newName').value = '';
  $('newSearch').value = '';
  $('newVis').value = 'public';
  $('newVis').hidden = !(Cloud.enabled && Cloud.user); // visibility only means something for online decks
  updateDraftUi();
  draftPreview.clear('Hover over a commander to preview it.');
  newDlg.showModal();
  searchNewCommander();
  $('newName').focus();
}

async function searchNewCommander() {
  const second = draft.target === 'partner' && draft.card;
  setMsg('newMsg', 'Searching...');
  const token = ++draft.token;
  try {
    const list = (await searchCommanders(second || null, $('newSearch').value.trim())).slice(0, 80);
    if (token !== draft.token) return;
    const picked = second ? draft.partner : draft.card;
    setMsg('newMsg', list.length ? '' : 'No legal matches found.');
    $('newResults').innerHTML = list.map(c => `<div class="row${picked?.id === c.id ? ' sel' : ''}" data-id="${c.id}">
      <span class="nm">${esc(c.name)}</span>
      <span class="cost">${identitySymbols(c.color_identity)}</span></div>`).join('');
  } catch (e) {
    if (token === draft.token) setMsg('newMsg', e.message, true);
  }
}

$('newBtn').addEventListener('click', openNewDeck);
$('newSearch').addEventListener('input', debounce(searchNewCommander, 300));
$('tabCmd').addEventListener('click', () => setDraftTarget('cmd'));
$('tabPartner').addEventListener('click', () => setDraftTarget('partner'));

$('newResults').addEventListener('mouseover', e => {
  const row = e.target.closest('[data-id]');
  const c = row && cache.get(row.dataset.id);
  if (c && c !== draftPreview.card) draftPreview.show(c);
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
    draft.partner = draft.partner?.id === c.id ? null : c;
  } else {
    draft.card = c;
    if (draft.partner && !canPair(c, draft.partner)) draft.partner = null;
  }
  const picked = draft.target === 'partner' ? draft.partner : draft.card;
  document.querySelectorAll('#newResults .row').forEach(r => r.classList.toggle('sel', !!picked && r.dataset.id === picked.id));
  updateDraftUi();
  draftPreview.show(c);
});

$('newCreate').addEventListener('click', () => {
  if (!draft.card) return;
  const commanders = draft.partner ? [draft.card, draft.partner] : [draft.card];
  newDlg.close();
  const { cards } = buildCards(draft.imported, new Set(commanders.map(c => c.id)));
  createDeck($('newName').value.trim() || 'Untitled Deck', commanders, cards, $('newVis').hidden ? 'private' : $('newVis').value);
});

const importDlg = $('newImportDialog');

function applyNewImport() {
  return importList('newImportText', 'newImportMsg', 'newImportApply', ({ parsed, find, missing, entries }) => {
    if (!draft.card && parsed.commanders.length) {
      const [first, second] = parsed.commanders.map(find).filter(Boolean);
      if (first) {
        draft.card = first;
        draft.partner = second && canPair(first, second) ? second : null;
        setDraftTarget('cmd');
      }
    }
    draft.importText = $('newImportText').value;
    draft.imported = entries.filter(e => e.card);
    updateDraftUi();
    if (missing.length) setMsg('newImportMsg', `Not found: ${missing.join(', ')}. The rest will be added when the deck is created.`, true);
    else importDlg.close();
  });
}

$('newImport').addEventListener('click', () => {
  $('newImportText').value = draft.importText;
  setMsg('newImportMsg', '');
  importDlg.showModal();
});
$('newImportClear').addEventListener('click', () => {
  $('newImportText').value = '';
  draft.importText = ''; draft.imported = [];
  setMsg('newImportMsg', '');
  updateDraftUi();
});
$('newImportApply').addEventListener('click', applyNewImport);

function setSearchEnabled() {
  const on = state.commanders.length > 0;
  $('searchInput').disabled = !on;
  $('searchInput').placeholder = on ? 'Search for cards to add to the deck' : 'Create a deck to start searching';
}

/* ---------- Online decks (Supabase) ---------- */

const cloudTimers = new Map(); // deck id -> pending push timer
const lastPushed = new Map();  // deck id -> signature of the last row we know the server has
let sharedInfo = null, sharedTok = 0, sharedId = null;

const rowSig = row => JSON.stringify({ ...row, updated_at: 0 });
const setSync = (text, bad) => setMsg('syncState', text, bad);

// Hamburger menu: Account Settings near the top, and Log in / Sign out swapping at the bottom.
function updateAuthUi() {
  $('accountBtn').hidden = !(Cloud.enabled && Cloud.user);
  $('loginBtn').hidden = !Cloud.enabled || !!Cloud.user;
  $('logoutBtn').hidden = !Cloud.user;
  updateCopyBtn();
}

function updateCopyBtn() {
  if (!sharedInfo) return;
  const own = Cloud.user?.id === sharedInfo.ownerId;
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
  await collection(ids.filter(id => !cache.has(id)).map(id => ({ id })));
  const cards = {};
  for (const [id, qty] of Object.entries(row.cards)) if (cache.has(id)) cards[id] = { card: cache.get(id), qty };
  return {
    id: row.id, name: row.name, description: row.description, visibility: row.visibility,
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
    if (bodyIs('home')) renderHome();
    if (bodyIs('shared') && sharedId && decks[sharedId]) route(); // your own deck, opened before it synced: switch to the editor
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
  if (bodyIs('shared')) return;
  if (bodyIs('account')) { go('decks/personal', true); return; } // the account page is signed-in only
  if (state.id && !decks[state.id]) {
    state.id = null;
    go('decks/personal', true);
  } else if (bodyIs('home')) renderHome();
}

/* Read-only views of other people's decks: a shared deck (?d=<id>) and a public profile (?u=<name>) */

// Resets whatever a shared-deck or profile view changed. Bumping the tokens drops their pending loads.
function leaveViewer() {
  document.body.classList.remove('shared', 'profile');
  setPage('account', false);
  setPage('login', false);
  sharedInfo = null;
  sharedId = null;
  viewing = null;
  sharedTok++;
  profileTok++;
  document.title = APP_TITLE;
}

// Public profile: the landing page, read-only, listing the account's Unlisted and Public decks.
let profileTok = 0;
const profileCache = new Map(); // lower-case name -> loaded profile, so Back from one of its decks is instant

function showProfileTitle() {
  const text = viewing.error ? 'Player not found' : `${viewing.owner || viewing.name}'s decks`;
  $('profileTitle').textContent = text;
  document.title = `${text} - SparkRitual`;
}

async function openProfile(name) {
  persist();
  leaveViewer();
  const tok = ++profileTok, key = name.toLowerCase();
  state.id = null;
  document.body.classList.add('home', 'profile');
  viewing = profileCache.get(key) || { name, decks: null };
  if (!viewing.decks) showLoading();
  showProfileTitle();
  homeSel = 0;
  homeList = [];
  renderHome();
  if (viewing.decks) return hideLoading();
  try {
    await Cloud.ready;
    if (!Cloud.enabled) throw new Error('Online decks are not set up on this site.');
    const p = await Cloud.getProfile(name);
    if (!p) throw new Error(`There's no public page for "${name}". The name may be wrong, or this player keeps their decks hidden.`);
    // One batched card lookup for every deck, then each deck builds from the cache.
    const ids = [...new Set(p.decks.flatMap(r => [...r.commanders, ...Object.keys(r.cards)]))].filter(id => !cache.has(id));
    await collection(ids.map(id => ({ id })));
    const list = (await Promise.all(p.decks.map(r => hydrate(r).catch(() => null)))).filter(Boolean);
    if (tok !== profileTok) return;
    viewing = { name, owner: p.owner, ownerId: p.owner_id, decks: list };
    profileCache.set(key, viewing);
  } catch (e) {
    if (tok !== profileTok) return;
    viewing = { name, decks: null, error: e.message };
  }
  showProfileTitle();
  renderHome();
  coverReady().then(hideLoading);
}

async function openShared(id) {
  persist();
  leaveViewer();
  sharedId = id;
  const tok = ++sharedTok;
  document.body.classList.remove('home');
  document.body.classList.add('shared');
  state.id = null; // nothing from this view is ever saved locally
  $('deckTitle').textContent = 'Loading deck...';
  $('sharedDesc').textContent = '';
  $('deckList').innerHTML = spinnerHtml('Loading deck...');
  $('commanderSlots').innerHTML = $('deckStatus').innerHTML = '';
  try {
    await Cloud.ready;
    if (!Cloud.enabled) throw new Error('Online decks are not set up on this site.');
    const row = await Cloud.getDeck(id);
    if (!row) throw new Error('This deck was not found, or it is private.');
    const d = await hydrate(row);
    if (tok !== sharedTok) return;
    Object.assign(state, { id: null, name: d.name, description: d.description, visibility: d.visibility, commanders: d.commanders, cards: d.cards, sort: d.sort || 'type' });
    sharedInfo = { source: d, owner: row.owner, ownerId: row.owner_id };
    document.title = `${d.name} - SparkRitual`;
    $('deckTitle').textContent = `${d.name} by ${row.owner}`;
    $('sharedDesc').textContent = d.description || '';
    resetBuilder();
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
  const own = Cloud.user?.id === s.ownerId;
  const id = own ? s.source.id : newId();
  if (!decks[id]) {
    const d = structuredClone(s.source);
    Object.assign(d, { id, name: own ? d.name : `${d.name} (copy)`, visibility: own ? d.visibility : 'private', owner: Cloud.user?.id, updated: Date.now() });
    decks[id] = d;
    writeDecks();
    if (d.owner) queueCloud(id);
  }
  gotoDeck(id);
});

// The logo is "your decks". Clicking it while already there just re-renders rather than piling up history.
const homeLink = document.querySelector('.topbar h1 a');
homeLink.href = hrefFor('decks/personal');
homeLink.addEventListener('click', e => {
  e.preventDefault();
  go('decks/personal', currentPath() === 'decks/personal');
});

/* Hamburger menu */

// A modal <dialog> sliding in from the left: the browser handles the backdrop, focus trapping and Escape.
const sideNav = $('sideNav');
$('menuBtn').addEventListener('click', () => {
  deckMenu.close();
  sideNav.showModal();
  $('menuBtn').setAttribute('aria-expanded', 'true');
});
sideNav.addEventListener('close', () => $('menuBtn').setAttribute('aria-expanded', 'false'));
sideNav.addEventListener('click', e => {
  // The panel's content fills the dialog, so a click landing on the dialog itself is on the backdrop.
  if (e.target === sideNav) return sideNav.close();
  // Picking an item closes the panel first, so the dialog the item opens isn't stacked on top of it.
  if (e.target.closest('.side-nav-item')) sideNav.close();
}, true);

// Dark mode is the default; only the light choice is stored (index.html applies it before first paint).
$('darkModeToggle').checked = document.documentElement.dataset.theme !== 'light';
$('darkModeToggle').addEventListener('change', e => {
  const dark = e.target.checked;
  if (dark) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = 'light';
  store.set('sparkritual.theme', dark ? null : 'light');
});

/* Login page (/login): Google or Discord */

const loginMsg = (t, bad) => setMsg('loginMsg', t, bad);
let loginNotice = null; // [text, bad] to show when the page next opens

// A page's hidden attribute keeps it out of view even if a stale stylesheet is cached.
function setPage(id, on) {
  document.body.classList.toggle(id, on);
  $(id).hidden = !on;
}

// Sends a signed-out visitor to the login page with a note saying why.
function requireLogin(msg, bad) {
  loginNotice = msg ? [msg, bad] : null;
  go('login', true);
}

async function showLogin() {
  persist();
  state.id = null;
  document.body.classList.remove('home');
  setPage('login', true);
  loginMsg(...(loginNotice || ['']));
  loginNotice = null;
  setOAuthBusy(false);
  await Cloud.ready;
  if (!bodyIs('login')) return; // navigated away while loading
  if (Cloud.user || !Cloud.enabled) go('decks/personal', true); // already signed in, or nothing to sign in to
}

$('accountBtn').addEventListener('click', () => go('account'));
$('loginBtn').addEventListener('click', () => go('login'));
$('logoutBtn').addEventListener('click', async () => {
  for (const id of [...cloudTimers.keys()]) { clearTimeout(cloudTimers.get(id)); await pushNow(id); } // don't lose pending edits
  try { await Cloud.signOut(); } catch (e) { alert(`Sign-out failed: ${e.message}`); }
});

const oauthBtns = $('login').querySelectorAll('[data-provider]');
const setOAuthBusy = on => oauthBtns.forEach(x => { x.disabled = on; });
oauthBtns.forEach(b => b.addEventListener('click', async () => {
  setOAuthBusy(true);
  loginMsg('Redirecting...');
  // On success the browser leaves the page, so only the failure path needs to reset.
  try { await Cloud.signInOAuth(b.dataset.provider); }
  catch (e) { setOAuthBusy(false); loginMsg(e.message, true); }
}));

/* Account settings page (#account, signed in only) */

const PROVIDERS = { google: 'Google', discord: 'Discord' };
const LINKING_KEY = 'sparkritual-linking'; // provider being linked, so we can confirm after the redirect
const NAME_HINT = 'Shown on decks you share.';
const acctMsg = (t, bad) => setMsg('acctMsg', t, bad);
const linkMsg = (t, bad) => setMsg('acctLinkMsg', t, bad);
let acctSaved = null;  // profile values as stored on the server
let acctNotice = null; // [text, bad] for the sign-in methods section, shown on the next visit
let nameOk = true, nameTimer = 0, nameTok = 0, linkTok = 0;

async function showAccount() {
  persist();
  state.id = null;
  document.body.classList.remove('home');
  setPage('account', true);
  await Cloud.ready;
  if (!bodyIs('account')) return; // navigated away while loading
  if (!Cloud.user) {
    if (Cloud.enabled) requireLogin('Sign in to see your account settings.'); else go('decks/personal', true);
    return;
  }
  loadAccountForm();
  linkMsg(...(acctNotice || ['']));
  acctNotice = null;
  renderLinks();
}

// Staged form: nothing is saved until "Save changes".
const acctForm = () => ({
  display_name: $('acctName').value.trim(),
  decks_visible: document.querySelector('input[name="acctVis"]:checked')?.value !== '0',
});
function acctChanges() {
  const form = acctForm(), changes = {};
  for (const k in form) if (form[k] !== acctSaved[k]) changes[k] = form[k];
  return changes;
}
function updateAcctActions() {
  const dirty = Object.keys(acctChanges()).length > 0;
  $('acctSave').disabled = !dirty || !nameOk;
  $('acctDiscard').disabled = !dirty;
}
function setNameMsg(text, state) { // state: undefined | 'ok' | 'bad'
  setMsg('acctNameMsg', text, state === 'bad');
  $('acctNameMsg').classList.toggle('ok', state === 'ok');
}
function loadAccountForm() {
  acctSaved = { display_name: Cloud.profile?.display_name || '', decks_visible: Cloud.profile?.decks_visible !== false };
  $('acctName').value = acctSaved.display_name;
  document.querySelector(`input[name="acctVis"][value="${acctSaved.decks_visible ? 1 : 0}"]`).checked = true;
  $('acctEmail').textContent = Cloud.user.email ? `Signed in as ${Cloud.user.email}` : '';
  // The public page link reflects what's saved, not what's being edited.
  const pub = acctSaved.decks_visible && !!acctSaved.display_name;
  $('acctPublic').hidden = !pub;
  $('acctPublicLink').value = pub ? hrefFor(`users/${encodeURIComponent(acctSaved.display_name)}`) : '';
  clearTimeout(nameTimer);
  nameTok++;
  nameOk = true;
  setNameMsg(NAME_HINT);
  acctMsg('');
  updateAcctActions();
}

// Live uniqueness check (ignores case). The database's unique index is the final word on save.
$('acctName').addEventListener('input', () => {
  clearTimeout(nameTimer);
  const tok = ++nameTok, name = $('acctName').value.trim();
  if (name === acctSaved.display_name) { nameOk = true; setNameMsg(NAME_HINT); }
  else if (!Cloud.validName(name)) { nameOk = false; setNameMsg(Cloud.NAME_RULE, 'bad'); }
  else {
    nameOk = false;
    setNameMsg('Checking availability...');
    nameTimer = setTimeout(async () => {
      let free;
      try { free = await Cloud.nameAvailable(name); }
      catch (e) { if (tok === nameTok) setNameMsg(`Couldn't check this name: ${e.message}`, 'bad'); return; }
      if (tok !== nameTok) return;
      nameOk = free;
      setNameMsg(free ? `"${name}" is available.` : `"${name}" is already taken.`, free ? 'ok' : 'bad');
      updateAcctActions();
    }, 400);
  }
  updateAcctActions();
});
$('acctName').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('acctSave').disabled) $('acctSave').click(); });
document.querySelectorAll('input[name="acctVis"]').forEach(r => r.addEventListener('change', updateAcctActions));

$('acctSave').addEventListener('click', async () => {
  const changes = acctChanges();
  if (!Object.keys(changes).length || !nameOk) return;
  $('acctSave').disabled = $('acctDiscard').disabled = true;
  acctMsg('Saving...');
  try {
    await Cloud.updateProfile(changes);
    loadAccountForm();
    updateAuthUi();
    acctMsg('Saved.');
  } catch (e) {
    acctMsg(e.message, true);
    if ('display_name' in changes && /taken/.test(e.message)) { nameOk = false; setNameMsg(e.message, 'bad'); }
    updateAcctActions();
  }
});
$('acctDiscard').addEventListener('click', loadAccountForm);
bindCopy('acctPublicCopy', 'acctPublicLink', 'Copy link');

/* Linked sign-in methods (take effect immediately, not staged) */

async function renderLinks() {
  const box = $('authLinks'), tok = ++linkTok;
  box.innerHTML = spinnerHtml();
  let ids;
  try { ids = await Cloud.identities(); }
  catch (e) { if (tok === linkTok) box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
  if (tok !== linkTok) return;
  box.innerHTML = Object.entries(PROVIDERS).map(([p, label]) => {
    const id = ids.find(i => i.provider === p);
    const detail = id ? (id.identity_data?.email || 'Linked') : 'Not linked';
    const btn = !id ? `<button data-link="${p}">Link</button>`
      : ids.length < 2 ? '<button disabled title="This is your only sign-in method">Unlink</button>'
      : `<button data-unlink="${p}">Unlink</button>`;
    return `<div class="link-row"><svg aria-hidden="true"><use href="#ico-${p}"/></svg>`
      + `<span class="who">${label}<small>${esc(detail)}</small></span>${btn}</div>`;
  }).join('');
}

$('authLinks').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const { link, unlink } = b.dataset;
  if (link) {
    if (Object.keys(acctChanges()).length && !confirm('Linking leaves this page. Your unsaved changes will be lost. Continue?')) return;
    $('authLinks').querySelectorAll('button').forEach(x => { x.disabled = true; });
    linkMsg('Redirecting...');
    try { sessionStorage.setItem(LINKING_KEY, link); } catch { /* only used for the success message */ }
    try { await Cloud.linkOAuth(link); }
    catch (err) { linkMsg(err.message, true); renderLinks(); }
  } else if (unlink) {
    if (!confirm(`Unlink ${PROVIDERS[unlink]}? You won't be able to sign in with it until you link it again.`)) return;
    b.disabled = true;
    try {
      const id = (await Cloud.identities()).find(i => i.provider === unlink);
      if (id) await Cloud.unlink(id);
      linkMsg(`${PROVIDERS[unlink]} unlinked.`);
    } catch (err) { linkMsg(err.message, true); }
    renderLinks();
  }
});

// Coming back with the Back button can restore the page from cache with buttons still disabled.
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  setOAuthBusy(false);
  loginMsg('');
  try { sessionStorage.removeItem(LINKING_KEY); } catch { /* ignore */ }
  if (bodyIs('account') && Cloud.user) { linkMsg(''); renderLinks(); }
});

Cloud.onAuth(async user => {
  updateAuthUi();
  if (user && bodyIs('login')) go('decks/personal', true); // e.g. signed in from another tab
  if (user) await syncDown(true); else signedOutCleanup();
});
Cloud.ready.then(async () => {
  updateAuthUi();
  if (!currentPath()) go('decks/personal', true); // the sign-in library has read the address; drop its leftovers (?code=, a bare #)
  await syncDown(false);
  finishBoot();
  let linking = null;
  try { linking = sessionStorage.getItem(LINKING_KEY); sessionStorage.removeItem(LINKING_KEY); } catch { /* ignore */ }
  if (!Cloud.enabled) return;
  // Report how a redirect to Google/Discord turned out.
  if (!Cloud.user) {
    if (Cloud.authError) requireLogin(`Sign-in failed: ${Cloud.authError}`, true);
    return;
  }
  if (Cloud.authError) acctNotice = [`Linking failed: ${Cloud.authError}`, true];
  else if (linking) {
    // Confirm it really linked (the flag can be stale if the user abandoned the redirect).
    const ids = await Cloud.identities().catch(() => []);
    if (ids.some(i => i.provider === linking)) acctNotice = [`${PROVIDERS[linking] || linking} linked. You can now sign in with it.`];
  }
  if (!acctNotice) return;
  if (bodyIs('account')) { linkMsg(...acctNotice); acctNotice = null; }
  else go('account');
});

loadDecks();
route();
