'use strict';

// Thin wrapper around Supabase. With no credentials in config.js everything
// here is inert and the app stays local-only.
const Cloud = (() => {
  const cfg = window.SPARKRITUAL_CONFIG || {};
  const api = { enabled: !!(cfg.supabaseUrl && cfg.supabaseAnonKey), user: null, profile: null };
  const listeners = [];
  let sb = null;

  // Providers send the user back to the app's root, whatever page they started from.
  const redirect = () => new URL('.', document.baseURI).href;
  const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  // A failed OAuth sign-in comes back as ?error=... (or #error=...). Grab the message
  // and strip those params now, before app.js routes on the URL.
  api.authError = (() => {
    const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
    const p = q.has('error') ? q : h.has('error') ? h : null;
    if (!p) return null;
    const msg = p.get('error_description') || p.get('error');
    ['error', 'error_code', 'error_description'].forEach(k => p.delete(k));
    const s = q.toString(), hs = p === h ? h.toString() : location.hash.slice(1);
    history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + (hs ? '#' + hs : ''));
    return msg;
  })();

  async function setUser(user) {
    api.user = user;
    api.profile = null;
    if (user) {
      const { data } = await sb.from('profiles').select('display_name, decks_visible').eq('id', user.id).maybeSingle();
      api.profile = data;
    }
  }

  api.onAuth = fn => listeners.push(fn);

  api.ready = !api.enabled ? Promise.resolve() : new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Supabase library'));
    document.head.appendChild(s);
  }).then(async () => {
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { flowType: 'pkce' } });
    const { data } = await sb.auth.getSession();
    await setUser(data.session ? data.session.user : null);
    sb.auth.onAuthStateChange((_event, session) => {
      const user = session ? session.user : null;
      if ((user && user.id) === (api.user && api.user.id)) return;
      // Deferred: calling Supabase from inside this callback can deadlock.
      setTimeout(async () => { await setUser(user); listeners.forEach(fn => fn(user)); }, 0);
    });
  }).catch(e => { api.enabled = false; console.warn(e); });

  api.signInOAuth = async provider => check(await sb.auth.signInWithOAuth({ provider, options: { redirectTo: redirect() } }));
  api.signOut = async () => check(await sb.auth.signOut());

  // Identity linking. Needs "Allow manual linking" turned on in the Supabase dashboard.
  api.identities = async () => check(await sb.auth.getUserIdentities()).identities;
  api.linkOAuth = async provider => check(await sb.auth.linkIdentity({ provider, options: { redirectTo: redirect() } }));
  api.unlink = async identity => check(await sb.auth.unlinkIdentity(identity));

  // Display names: 2-32 letters, numbers or underscores, unique ignoring case.
  api.NAME_RULE = 'Use 2-32 letters, numbers or underscores.';
  api.validName = name => /^\w{2,32}$/.test(name);
  api.nameAvailable = async name => check(await sb.rpc('display_name_available', { p_name: name }));

  // changes: any of { display_name, decks_visible }.
  api.updateProfile = async changes => {
    if ('display_name' in changes && !api.validName(changes.display_name)) throw new Error(api.NAME_RULE);
    const { error } = await sb.from('profiles').update(changes).eq('id', api.user.id);
    if (error) throw new Error(error.code === '23505' ? 'That name is already taken.' : error.message);
    api.profile = { ...api.profile, ...changes };
  };

  // Decks are stored as ids and quantities only; card data is re-fetched from Scryfall.
  api.toRow = d => ({
    id: d.id,
    owner_id: api.user.id,
    name: (d.name || 'Untitled Deck').slice(0, 80),
    description: (d.description || '').slice(0, 5000),
    visibility: d.visibility || 'private',
    sort: d.sort || 'type',
    commanders: d.commanders.map(c => c.id),
    cards: Object.fromEntries(Object.values(d.cards).map(e => [e.card.id, e.qty]).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    updated_at: new Date(d.updated || Date.now()).toISOString(),
  });

  api.listDecks = async () => check(await sb.from('decks').select('*').eq('owner_id', api.user.id));
  api.pushRow = async row => check(await sb.from('decks').upsert(row));
  api.removeDeck = async id => check(await sb.from('decks').delete().eq('id', id));
  api.getDeck = async id => check(await sb.rpc('get_deck', { p_id: id }));
  // { owner, owner_id, decks: [row] } for a Visible account, or null.
  api.getProfile = async name => check(await sb.rpc('get_profile_decks', { p_name: name }));

  return api;
})();
