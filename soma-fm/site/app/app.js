// Christmas Lounge (site/app): the new site, built from the approved Pocket v2 design (HANDOFF.md §8d).
// The database (Cloudflare D1, through /api) is the one copy of everything: this page keeps nothing of Dan's data in the
// browser. It asks /api for the plays, the synced document and the playlist, works out each song's status with the
// checker's own tested modules (window.XM: Matcher, History, Stats, Shuffle, Sync…), and sends each change (a mark, a
// favorite, a note…) as it happens, merged on the server with the same rules today's site syncs with. Only settings
// (theme, filters, per page, Live) and Shuffle's sign-in and unfinished job stay on the device.
'use strict';
(() => {
  const X = window.XM;
  if (!X || !X.Sync) { document.getElementById('app').innerHTML = '<div class="boot err">The page\'s scripts didn\'t load. Try reloading.</div>'; return; }
  const { History, Archive, Stats, Shuffle, Sync, Backup, Reader, Cloud } = X;
  const M = X;   // Matcher's functions are at the top level: check, markKey, applyMark, searchQuery, suggest, searchItems

  /* ---------- Settings ---------- */
  const PLAYLIST_ID = 'PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt', PLAYLIST_NAME = 'Xmas Mixed', CHANNEL = 'christmas';
  const LIVE_SECONDS = 60, STATE_MINUTES = 2, PLAYLIST_MINUTES = 15;
  const PAGE_SIZES = [25, 50, 100, 250];
  const CATS = [['band', 'Band/Swing', 'Swing'], ['classics', 'Classics', 'Classics'], ['dance', 'Dance', 'Dance'], ['jazz', 'Jazz/Piano', 'Jazz'], ['mellow', 'Mellow', 'Mellow'], ['soul', 'Soul/Funk', 'Funk']];
  const CATS2 = CATS.concat([['uncat', 'No category', 'None']]);
  const CAT = {}, CATSH = {}; for (const [k, n, sh] of CATS) { CAT[k] = n; CATSH[k] = sh; }
  const LABEL = { have: 'In playlist', other: 'Other version', none: 'Not in playlist', gone: 'Gone from playlist', disliked: 'Disliked', unknown: '—' };
  const STATUS = [['none', 'Not in playlist'], ['other', 'Other version'], ['have', 'In playlist'], ['disliked', 'Disliked']];
  const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
  const UNKNOWN = { status: 'unknown' };
  const THEMES = ['candy', 'evergreen'];   // besides Midnight, the default

  /* ---------- Small helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('en-US');
  const time = at => new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const time24 = at => { const d = new Date(at * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };   // 24-hour hh:mm, for the lists on phones (Dan, Nov 4)
  const day = at => new Date(at * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const short = at => new Date(at * 1000).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  const when = at => History.formatDate(at) + ' ' + History.formatTime(at);
  const ago = ms => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
  const numsBold = text => esc(text).replace(/\d[\d.,]*/g, '<b>$&</b>');   // "13 h 19 min": the figures bold, the words not (Dan, Nov 4)
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '0%';
  const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : (many || one + 's'));
  // 34320 -> "9 h 32 min", the units smaller (Dan, Nov 4; was "9:32" with "(h:mm)" under it)
  const hmin = secs => { const m = Math.round(secs / 60); return `${Math.floor(m / 60)}<small class="u"> h</small> ${m % 60}<small class="u"> min</small>`; };
  const backText = secs => secs < 3600 ? Stats.formatSpan(secs) : (secs / 3600).toFixed(1) + ' h';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ytWatch = id => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&list=${PLAYLIST_ID}`;
  const ytSearch = q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
  const noTopic = ch => String(ch || '').replace(/\s*-\s*Topic\s*$/i, '');
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Settings kept on this device
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('xl:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v === undefined || v === null) localStorage.removeItem('xl:' + k); else localStorage.setItem('xl:' + k, JSON.stringify(v)); } catch (e) { /* private mode: kept for this visit only */ } },
  };
  const $ = sel => document.querySelector(sel);
  let toastTimer = null;
  function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }
  // "Working…" after a short wait, for actions that go over the network
  let busyN = 0;
  async function busy(fn) {
    busyN++; $('#working').classList.add('on');
    try { return await fn(); } finally { if (--busyN <= 0) { busyN = 0; $('#working').classList.remove('on'); } }
  }

  /* ---------- Google sign-in return (for Shuffle) ---------- */
  // Google sends the sign-in back to this site's /. With the sign-in kept on the server (keepsSignIn; Dan, Nov 4) it
  // brings a one-time ?code=, which the server exchanges for a lasting permission and a one-hour key; otherwise a
  // one-hour key in the #fragment. If it's the sign-in this device started, the key is kept for the page that asked,
  // and the sign-in window closes.
  let connecting = null;   // a code being exchanged, when the sign-in came back in this tab (popups blocked)
  async function connectWith(code, error) {
    let t;
    if (!code) t = { error: error === 'access_denied' ? 'you chose not to allow it' : error || 'no code came back', at: Date.now() };
    else {
      try {
        const d = (await api('/youtube/connect', { method: 'POST', body: { code } })).data;
        t = { token: d.access_token, at: Date.now(), exp: Date.now() + ((Number(d.expires_in) || 3600) - 120) * 1000, kept: !!d.kept };
      } catch (e) { t = { error: e.message, at: Date.now() }; }
    }
    LS.set('signin:token', t);
    return t;
  }
  function catchSignIn() {
    const q = new URLSearchParams(location.search), viaCode = q.has('state') && (q.has('code') || q.has('error'));
    if (!viaCode && !/[#&]state=/.test(location.hash)) return false;
    const p = viaCode ? q : new URLSearchParams(location.hash.slice(1)), asked = LS.get('signin:pending', null);
    if (!asked || p.get('state') !== asked.state) return false;
    history.replaceState(null, '', asked.popup ? '/' : '/shuffle');
    LS.set('signin:pending', null);
    if (viaCode) {
      const done = connectWith(p.get('code'), p.get('error'));
      if (!asked.popup) { connecting = done; return false; }   // signed in in this tab: Shuffle waits for it
      document.getElementById('app').innerHTML = '<div class="boot">Signing in…</div>';
      done.then(t => {
        window.close();
        document.getElementById('app').innerHTML = `<div class="boot">${t.token ? 'Signed in. You can close this window and go back to Shuffle.' : `Sign-in didn't complete (${esc(t.error)}). Close this window and try again.`}</div>`;
      });
      return true;
    }
    const token = p.get('access_token');
    LS.set('signin:token', token ? { token, at: Date.now(), exp: Date.now() + ((Number(p.get('expires_in')) || 3600) - 120) * 1000 } : { error: p.get('error') || 'no access key came back', at: Date.now() });
    if (!asked.popup) return false;   // signed in in this tab: carry on, on the Shuffle page
    window.close();
    document.getElementById('app').innerHTML = `<div class="boot">${token ? 'Signed in. You can close this window and go back to Shuffle.' : "Sign-in didn't complete. Close this window and try again."}</div>`;
    return true;
  }
  if (catchSignIn()) return;

  // Listening to the station here (Dan, Nov 5): off, loading (connecting or buffering) or on
  const player = { audio: null, state: 'off', at: 0, tries: 0, key: '', log: [], fail: null };

  /* ---------- What's kept on the server, as last read ---------- */
  const D = {
    plays: [], breaks: [], through: 0, lastRun: null, recording: true, playsAt: 0,
    doc: Sync.clean(null), version: 0, stateAt: 0,
    items: [], hidden: 0, playlistAt: 0, playlistError: '', playlistLoading: true, archiveNote: '',
    nowAt: null, clientId: '', keepsSignIn: false,
    err: { plays: '', state: '', feed: '', save: '' },
    loaded: { plays: false, state: false },
  };
  let stateReady; const stateLoaded = new Promise(r => { stateReady = r; });

  async function api(path, opts = {}) {
    let r;
    // Reads give up after 30 s (one frozen in a sleeping tab would otherwise hang on); changes and playlist reads get 2 minutes
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, cut = ctl && setTimeout(() => ctl.abort(), (opts.method && opts.method !== 'GET') || /^\/playlist/.test(path) ? 120000 : 30000);
    try {
      r = await fetch('/api' + path, { method: opts.method || 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
        headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch (e) { throw new Error(ctl && ctl.signal.aborted ? 'the site took too long to answer' : "the site couldn't be reached (if the sign-in ran out, reload the page)"); }
    finally { clearTimeout(cut); }
    if (r.status === 401) throw new Error('the sign-in ran out: reload the page');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'the site answered ' + r.status), { status: r.status });
    return { data: d, headers: r.headers };
  }

  /* ---------- Working out each song's status (cached per song) ---------- */
  const statusCache = new Map();
  let rowsCache = null, counts = new Map(), latestRow = new Map(), statsCache = null, measured = null, goneCache = null;
  const goneItems = () => goneCache || (goneCache = Archive.goneList(D.doc.archive));
  function statusOf(key, artist, title) {
    if (D.playlistError || !D.items.length) return UNKNOWN;
    let r = statusCache.get(key);
    if (!r) {
      r = M.applyMark(M.check(artist, title, D.items), D.doc.marks[key], !!D.doc.dislikes[key], D.items);
      r = Archive.applyGone(r, artist, title, goneItems());
      statusCache.set(key, r);
    }
    return r;
  }
  // Display rows from the plays, newest first; rebuilt only when the plays change
  function rows() {
    if (rowsCache) return rowsCache;
    rowsCache = [];
    counts = new Map(); latestRow = new Map();
    for (const p of D.plays) {
      const r = { at: p[0], artist: p[1], title: p[2], album: p[3] || '', gap: !!p[4], key: M.markKey(p[1], p[2]) };
      rowsCache.push(r);
      counts.set(r.key, (counts.get(r.key) || 0) + 1);
      if (!latestRow.has(r.key)) latestRow.set(r.key, r);
    }
    return rowsCache;
  }
  function playsChanged() { rowsCache = null; statsCache = null; measured = null; }
  function stats() {
    if (!statsCache) {
      const ok = !D.playlistError && D.items.length;
      rows();
      statsCache = Stats.compute(D.plays, ok ? D.items : [], (a, t, k) => ok ? statusOf(k, a, t) : UNKNOWN);
    }
    return statsCache;
  }
  // A song's length: your playlist video's when it's that recording, otherwise measured from SomaFM's play times (~)
  function songLength(key, r) {
    if (r && r.status === 'have' && r.item && Number(r.item.secs) > 0) return { secs: Number(r.item.secs), measured: false };
    if (!measured) measured = History.measuredLengths(D.plays, D.breaks, M.markKey);
    const m = measured.get(key);
    return m ? { secs: m, measured: true } : null;
  }
  const isFav = id => !!(id && D.doc.favorites[id] && D.doc.favorites[id].on);
  const catOf = id => (id && D.doc.categories[id] && CAT[D.doc.categories[id].c] ? D.doc.categories[id].c : '');
  const noteOf = key => (D.doc.notes[key] && typeof D.doc.notes[key].t === 'string' ? D.doc.notes[key].t : '');
  const inList = r => r.status === 'have' && !!r.item;
  // Open the video you have: not for songs marked "not this one", disliked, or gone
  const canOpen = r => !!r.item && r.status !== 'unknown' && r.status !== 'gone' && r.marked !== 'not' && !r.disliked;
  const statusText = r => r.status === 'other' && r.reason === 'sameArtistOtherMix' ? 'Different mix' : LABEL[r.status] || '';

  // A new document (from the server, or a change made here): only what changed is matched again
  function setDoc(next) {
    const before = D.doc;
    D.doc = next;
    let status = false;
    for (const part of ['marks', 'dislikes']) {
      const a = before[part] || {}, b = next[part] || {};
      for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) if (Sync.canon(a[k]) !== Sync.canon(b[k])) { statusCache.delete(k); status = true; }
    }
    if (!Sync.samePart(before, next, 'archive')) {
      const was = goneItems().map(g => g.id).join();
      goneCache = null;
      if (goneItems().map(g => g.id).join() !== was) { statusCache.clear(); status = true; }
    }
    if (status) statsCache = null;
  }
  function useItems(list) {
    const a = D.items, same = a.length === list.length && a.every((x, i) => x.id === list[i].id && x.title === list[i].title && x.ch === list[i].ch && (x.secs || 0) === (list[i].secs || 0));
    if (same) return;
    D.items = list; statusCache.clear(); statsCache = null;
  }

  /* ---------- Sending changes: one at a time, merged as they wait ---------- */
  // Each change shows at once (merged here with the same rules), then goes to /api/change, which merges it into the
  // stored document and answers with the whole document. Changes made meanwhile wait and go together next.
  let queued = null, inflight = null, sendTimer = null, sendTries = 0;
  const withUnsent = doc => { let d = doc; if (inflight) d = Sync.merge(d, inflight); if (queued) d = Sync.merge(d, queued); return d; };
  function change(patch, wait) {
    const p = Sync.clean(patch);
    setDoc(Sync.merge(D.doc, p));
    queued = queued ? Sync.merge(queued, p) : p;
    // wait: at most that long (Shuffle's quota count changes with every move); otherwise now
    if (wait) { if (!sendTimer) sendTimer = setTimeout(sendNow, wait); }
    else { clearTimeout(sendTimer); sendTimer = null; send(); }
  }
  function sendNow() { sendTimer = null; send(); }
  async function send() {
    if (inflight || !queued) return;
    inflight = queued; queued = null;
    try {
      const d = (await api('/change', { method: 'POST', body: { patch: inflight } })).data;
      inflight = null;
      D.version = d.version; D.stateAt = Date.now();
      setDoc(withUnsent(Sync.clean(d.state)));
      D.err.save = ''; sendTries = 0;
      if (queued) send();
    } catch (e) {
      queued = queued ? Sync.merge(inflight, queued) : inflight;
      inflight = null;
      D.err.save = e.message;
      const waits = [3, 10, 30, 60];
      clearTimeout(sendTimer);
      sendTimer = setTimeout(sendNow, waits[Math.min(sendTries++, waits.length - 1)] * 1000);
    }
    quietRender();
  }
  addEventListener('beforeunload', e => { if (queued || inflight) { e.preventDefault(); e.returnValue = ''; } });
  const now = () => Date.now();
  function setMark(key, v, id) {
    if (v) change({ marks: { [key]: id ? { v, at: now(), id } : { v, at: now() } } });
    else change({ removed: { marks: { [key]: now() } } });   // cleared: remembered, so a device merging later doesn't bring it back
  }
  function setDislike(key, on) { change(on ? { dislikes: { [key]: now() } } : { removed: { dislikes: { [key]: now() } } }); }
  const setFav = (id, on) => change({ favorites: { [id]: { on, at: now() } } });
  const setCat = (id, c) => change({ categories: { [id]: { c, at: now() } } });
  const setNote = (key, t) => change({ notes: { [key]: { t, at: now() } } });
  function dismissGone(id) { const a = D.doc.archive[id]; if (a) change({ archive: { [id]: Object.assign({}, a, { dismissed: now() }) } }); }

  /* ---------- Reading from the server ---------- */
  async function loadState() {
    try {
      const d = (await api('/state')).data;
      D.version = d.version; D.stateAt = Date.now();
      setDoc(withUnsent(Sync.clean(d.state)));
      D.err.state = ''; D.loaded.state = true;
      stateReady(true);
    } catch (e) { D.err.state = e.message; }
  }
  // Plays stored or changed since a little before the last ask (all of them the first time)
  async function loadPlays() {
    try {
      const d = (await api(`/plays?channel=${CHANNEL}&since=${Cloud.sinceFor(D.through)}`)).data;
      D.recording = d.recording !== false;
      D.lastRun = d.lastRun || null;
      const u = History.union(D.plays, History.dropFuture(Cloud.cleanPlays(d.plays), Date.now() / 1000), Infinity);
      if (u.added || u.filled) { D.plays = History.repair(u.plays); playsChanged(); }
      const nb = History.mergeBreaks(D.breaks, Cloud.cleanBreaks(d.breaks), 5000);
      if (nb !== D.breaks) { D.breaks = nb; measured = null; }
      if (Number(d.now) > 0) D.through = Number(d.now);
      D.playsAt = Date.now(); D.err.plays = ''; D.loaded.plays = true;
    } catch (e) { D.err.plays = e.message; }
  }
  // SomaFM's list read now (the server records its plays on the way through); it says which song is playing
  // pending: a read already asked for (at start, sent alongside the first reads and worked out once the plays are in)
  async function loadFeed(pending) {
    try {
      const { data, headers } = await (pending || api(`/feed?channel=${CHANNEL}`));
      const served = Date.parse(headers.get('Date') || '');
      const fetched = History.fromFeed(data.songs, (isFinite(served) ? served : Date.now()) / 1000, D.plays);
      D.nowAt = fetched.length ? fetched[0][0] : null;
      D.err.feed = '';
    } catch (e) { D.err.feed = e.message; }
  }
  async function loadConfig() { try { const c = (await api('/config')).data; D.clientId = c.clientId || ''; D.keepsSignIn = !!c.keepsSignIn; } catch (e) { /* asked again when Shuffle needs it */ } }

  // The playlist: the server's last read when it's recent (each read costs quota units Shuffle shares), else read now.
  // Songs that left it are noticed only from a complete read, and never when too many vanish at once (Archive.update).
  let playlistRead = null;
  function loadPlaylist(force) {
    if (!playlistRead) playlistRead = readPlaylistNow(force).finally(() => { playlistRead = null; });
    return playlistRead;
  }
  async function readPlaylistNow(force) {
    const prev = D.items.length ? D.items : null;
    let n = 0;
    const once = async () => (await api(`/playlist?list=${PLAYLIST_ID}` + (force || n++ ? '' : '&within=' + PLAYLIST_MINUTES * 60))).data;
    try {
      const fresh = await Reader.readRetry(once, f => f.complete && Reader.consistent(f.items, prev), [5000, 15000], sleep);
      D.playlistError = '';
      if (!fresh.complete && prev && prev.length > fresh.items.length) {
        D.archiveNote = `YouTube gave only ${fresh.read} of ${fresh.expected || 'all'} playlist songs after 3 tries, so the previous read is still used. It tries again in ${PLAYLIST_MINUTES} minutes, or use Refresh playlist.`;
        return;
      }
      if (!Reader.consistent(fresh.items, prev)) {
        if (prev) { D.archiveNote = `The playlist read back with repeated songs this time, so the previous read is still used. It tries again in ${PLAYLIST_MINUTES} minutes, or use Refresh playlist.`; return; }
        fresh.complete = false;   // nothing to fall back on: shown, but no songs are marked gone from it
      }
      useItems(fresh.items); D.hidden = fresh.hidden || 0; D.playlistAt = fresh.at || Date.now();
      if (!fresh.complete) { D.archiveNote = `Only ${fresh.read} of ${fresh.expected || 'all'} playlist songs could be read this time; none were marked as gone.`; return; }
      await stateLoaded;
      if (!D.loaded.state) return;   // songs gone from the playlist are worked out against the kept list only
      const u = Archive.update(D.doc.archive, D.items, D.playlistAt);
      if (u.refused) { D.archiveNote = `This playlist read looked incomplete (${u.refused} songs missing at once), so none were marked as gone.`; return; }
      D.archiveNote = '';
      if (!Sync.same(Backup.mergeArchive(D.doc.archive, u.archive), D.doc.archive)) change({ archive: u.archive });
    } catch (e) {
      // Refuse and report: songs aren't labeled from a playlist that couldn't be read
      D.items = []; D.playlistError = e.message; statusCache.clear(); statsCache = null;
    } finally { D.playlistLoading = false; }
  }

  // Live updates: every minute while the page is in sight (the recorder keeps recording either way)
  let liveOn = LS.get('live', true) !== false, liveTimer = null, ticking = 0;
  async function tick(force) {
    // A read that's been going for over 20 s was cut off while the tab slept (a phone freezes background tabs mid-request):
    // it no longer holds the next one back. Reading twice is harmless: plays and documents merge.
    // Out of sight it doesn't read, unless the station is playing here (the lock screen shows what's on)
    if ((ticking && Date.now() - ticking < 20000) || (!force && document.hidden && player.state === 'off')) return false;
    const mine = ticking = Date.now();
    try {
      await loadFeed();
      await loadPlays();
      if (force || Date.now() - D.stateAt > STATE_MINUTES * 60000) await loadState();
      if (Date.now() - D.playlistAt > PLAYLIST_MINUTES * 60000) await loadPlaylist(false);
    } finally { if (ticking === mine) ticking = 0; }
    quietRender();
    mediaMeta();
    return !D.err.plays;
  }
  function schedule() { clearInterval(liveTimer); if (liveOn) liveTimer = setInterval(() => tick(false), LIVE_SECONDS * 1000); }
  // Back to a tab that was out of sight (or restored from the back/forward cache, or back online): read now, and once more
  // a few seconds later if that failed (the network is often still waking up then) (Dan, Nov 4)
  let hiddenAt = document.hidden ? Date.now() : 0;
  function resume() {
    if (document.hidden || !liveOn) return;
    tick(true).then(ok => { if (!ok) setTimeout(() => tick(true), 4000); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 15000) resume(); else if (liveOn) tick(false);
  });
  addEventListener('pageshow', e => { if (e.persisted) resume(); });
  addEventListener('online', resume);

  // A problem worth a line at the top; '' when all is well
  function warning() {
    if (D.err.save) return `A change couldn't be saved yet (${D.err.save}). It's kept on this page and tried again; don't close the page until this goes away.`;
    if (D.err.state) return `Your marks, favorites and notes couldn't be read (${D.err.state}).`;
    if (D.err.plays) return `The plays couldn't be read (${D.err.plays}).`;
    const r = D.lastRun;
    if (r && !r.ok) return `The recorder couldn't read SomaFM's song list last time (${r.note}).`;
    if (r && r.lastOk && Date.now() / 1000 - r.lastOk > 45 * 60) return `The recorder hasn't recorded anything since ${when(r.lastOk)}.`;
    if (!D.recording) return "The recorder isn't set to record this station.";
    return '';
  }

  /* ---------- Page state (per device: filters, per page, sort, theme) ---------- */
  const S = {
    status: new Set(), cats: new Set(), favOnly: false, latest: false, q: '', page: 0,
    per: PAGE_SIZES.indexOf(LS.get('per', 50)) >= 0 ? LS.get('per', 50) : 50,
    allFilters: false, open: null, noteFor: null, noteDraft: '', pick: null, flash: null, goneOpen: false,
    topSort: LS.get('topSort', 'plays') === 'recent' ? 'recent' : 'plays',
    // What the song lists show without opening a row (More → Song lists; Dan, Nov 4): the album on narrow screens too,
    // and a song's note: its first line (the default), all of it, or none
    listAlbum: LS.get('listAlbum', false) === true,
    listNotes: ['one', 'all', 'off'].indexOf(LS.get('listNotes', 'one')) >= 0 ? LS.get('listNotes', 'one') : 'one',
    restore: null, restoreMsg: null, backupMsg: null,
  };
  document.documentElement.classList.toggle('show-alb', S.listAlbum);
  const VIEWS = ['now', 'history', 'stats', 'shuffle', 'more'];
  let view = 'now';
  // History's filters live in the address (so Back and a saved link work), and the last ones are remembered here
  function readAddress() {
    const p = location.pathname.replace(/^\/+|\/+$/g, '');
    view = VIEWS.indexOf(p) >= 0 ? p : 'now';
    if (view !== 'history') return;
    const q = new URLSearchParams(location.search), list = k => (q.get(k) || '').split(',').filter(Boolean);
    S.status = new Set(list('status').filter(k => STATUS.some(s => s[0] === k)));
    if (S.status.size === STATUS.length) S.status.clear();
    S.cats = new Set(list('cat').filter(k => CATS2.some(c => c[0] === k)));
    S.favOnly = q.get('fav') === '1'; S.latest = q.get('latest') === '1';
    S.q = q.get('q') || ''; S.page = Math.max(0, (Number(q.get('page')) || 1) - 1);
  }
  function historyQuery() {
    const q = new URLSearchParams();
    if (S.status.size) q.set('status', [...S.status].join(','));
    if (S.cats.size) q.set('cat', [...S.cats].join(','));
    if (S.favOnly) q.set('fav', '1');
    if (S.latest) q.set('latest', '1');
    if (S.q) q.set('q', S.q);
    if (S.page) q.set('page', String(S.page + 1));
    const s = q.toString();
    return s ? '?' + s.replace(/%2C/g, ',') : '';
  }
  function writeAddress() {
    const q = historyQuery();
    history.replaceState(null, '', '/history' + q);
    LS.set('histq', q.replace(/([?&])page=\d+&?/, '$1').replace(/[?&]$/, ''));
  }
  function go(path) {
    history.pushState(null, '', path);
    readAddress(); S.open = null; S.pick = null; S.noteFor = null; S.allFilters = false;
    render(); scrollTo(0, 0);
    if (view === 'shuffle') shufOpen();
  }
  addEventListener('popstate', () => { readAddress(); S.open = null; S.pick = null; S.noteFor = null; render(); if (view === 'shuffle') shufOpen(); });

  /* ---------- Rendering ---------- */
  const ICONS = {
    now: '<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    stats: '<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  };
  const TABS = [['now', 'Now'], ['history', 'History'], ['stats', 'Stats'], ['shuffle', 'Shuffle'], ['more', 'More']];
  const tabHref = k => k === 'now' ? '/' : k === 'history' ? '/history' + LS.get('histq', '') : '/' + k;
  function head(sub) {
    const w = warning(), bad = !!w && !D.err.save;
    return `<header class="top"><div><div class="ttl"><b>Christmas Lounge</b><button class="icon hre" data-act="reload" aria-label="Read the latest now" title="Read the latest now">${ico('refresh')}</button></div><span class="sub">${esc(sub)}</span></div>` +
      `<a class="live ${w ? 'bad' : ''}" href="/more" data-nav title="${esc(w || 'The recorder reads SomaFM\'s song list every 10 minutes')}"><i></i>${w ? (bad ? 'Check recording' : 'Not saved yet') : 'Recording'}</a></header>` +
      (w ? `<div class="warn ${D.err.save || D.err.state || D.err.plays ? 'err' : ''}" role="status">⚠ ${esc(w)}</div>` : '');
  }
  // The status: a colored dot and its name; on a phone the rows show just the dot (the name stays for screen readers)
  const st = (r) => `<span class="st ${r.status}" title="${esc(statusText(r))}"><span class="stl">${esc(statusText(r))}</span></span>`;

  // Rows are named by number in data-i, so song titles stay out of attributes the code reads
  let ROWS = [];
  const rid = p => { ROWS.push(p); return ROWS.length - 1; };
  const rowId = (p, ctx) => (ctx || '') + p.key + '@' + p.at;
  function playRow(p, ctx, isNow) {
    const id = rowId(p, ctx), open = S.open === id, r = statusOf(p.key, p.artist, p.title), i = rid(Object.assign({ id }, p));
    const fav = inList(r) && isFav(r.item.id), note = noteOf(p.key), n = counts.get(p.key) || 0;
    const star = inList(r) ? `<button class="star" data-act="fav" data-i="${i}" aria-pressed="${fav}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}: ${esc(p.title)}" title="${fav ? 'Favorite. Tap to remove.' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>` : '';
    // The note itself shows under the song when More → Song lists says so; otherwise a ✎ beside the name says there is one
    const lnote = note && S.listNotes !== 'off' ? `<div class="lnote ${S.listNotes}">${esc(S.listNotes === 'one' ? note.split('\n')[0] : note)}</div>` : '';
    const icons = note && !lnote ? '<span class="ic" title="Has a note">✎</span>' : '';
    const len = songLength(p.key, r);
    // The star (and ✎) right after the title's last word, on its line, when the title wraps (Dan, Nov 6)
    const tw = esc(p.title).split(' '), last = tw.pop(), title = (tw.length ? tw.join(' ') + ' ' : '') + `<span class="nw">${last}${star}${icons}</span>`;
    return `<div class="pr ${open ? 'open' : ''} ${S.flash === p.key ? 'flash' : ''}" data-act="row" data-i="${i}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="c-time"><span class="t12">${time(p.at)}</span><span class="t24">${time24(p.at)}</span><small>${short(p.at)}</small>${isNow ? '<span class="now-tag">NOW</span>' : ''}</div>
      <div class="c-song"><div class="t"><b>${title}</b></div><div class="by">${esc(p.artist)}${len ? ` · ${len.measured ? '~' : ''}${History.formatClock(len.secs)}` : ''}</div>${p.album ? `<div class="alb">${esc(p.album)}</div>` : ''}${lnote}</div>
      <div class="c-status">${st(r)}</div>
      <div class="c-cat">${!inList(r) ? '—' : catOf(r.item.id) ? `<span class="cf">${esc(CAT[catOf(r.item.id)])}</span><span class="cs">${esc(CATSH[catOf(r.item.id)])}</span>` : ''}</div>
      <div class="c-plays">${fmt(n)}×</div>
      <div class="c-go">${quickLinks(p, r)}</div>
      <div class="c-act">${chev()}</div>
      <div class="m-side m-st">${st(r)}</div><div class="m-side m-cnt"><span class="cnt">${fmt(n)}× ${chev()}</span></div>
      ${open ? detail(ROWS[i], r, i) : ''}</div>`;
  }
  // Open (the video you have) and Search YouTube as icons on the row itself, so the row needn't be opened for them.
  // An "other version" song has both: Open compares with the version you have; Search finds the one SomaFM played.
  const SVG = { cast: '<path d="M3 7.5V6a1.5 1.5 0 0 1 1.5-1.5h15A1.5 1.5 0 0 1 21 6v12a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M3 11a8.5 8.5 0 0 1 8.5 8.5M3 14.5a5 5 0 0 1 5 5"/><circle cx="3.6" cy="18.9" r=".9" fill="currentColor"/>', yt: '<rect class="ytbg" x="1" y="4.5" width="22" height="15" rx="4.6" fill="#f00" stroke="none"/><path d="M9.2 8.1v7.8l6.8-3.9z" fill="#fff" stroke="none"/>', vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>', open: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>', search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', chev: '<path d="M6 9l6 6 6-6"/>', refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>' };
  const ico = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[k]}</svg>`;
  // Open or closed: the chevron turns over (and fills) while the row is open; the CSS does it from .open
  const chev = on => `<span class="chev ${on ? 'on' : ''}" aria-hidden="true">${ico('chev')}</span>`;
  function quickLinks(p, r) {
    const out = [];
    if (canOpen(r)) out.push(`<a class="icon open" href="${ytWatch(r.item.id)}" target="_blank" rel="noopener" data-stop aria-label="Open on YouTube: ${esc(p.title)}" title="Open on YouTube">${ico('yt')}</a>`);
    if (!canOpen(r) || r.status === 'other') out.push(`<a class="icon" href="${ytSearch(M.searchQuery(p.artist, p.title))}" target="_blank" rel="noopener" data-stop aria-label="Search YouTube: ${esc(p.title)}" title="Search YouTube">${ico('search')}</a>`);
    return out.join('');
  }
  // What a song offers, by its state: the same choices as today's cards (Open and Search are on the row)
  function actions(p, r, i) {
    const b = (text, act, cls) => `<button class="pill ${cls || ''}" data-act="${act}" data-i="${i}">${text}</button>`;
    const tag = (cls, text) => `<span class="tag ${cls}">${text}</span>`;
    if (r.disliked) return tag('disliked', '👎 Disliked') + b('Undo', 'undislike');
    if (r.marked === 'have' && r.linkMissing) return tag('have', '✓ In playlist · marked') + b('Link song', 'pick') + b('Undo', 'unmark');
    if (r.marked === 'have' && r.linked) return tag('have', '✓ In playlist · linked') + b('Unlink', 'unlink');
    if (r.marked === 'have') return tag('have', '✓ In playlist · marked') + b('Link song', 'pick') + b('Undo', 'unmark');
    if (r.marked === 'not') return tag('none', '✗ Not in playlist · marked') + b('Undo', 'unmark') + b('👎 Dislike', 'dislike', 'dis');
    if (r.status === 'have') return tag('have', '✓ In playlist') + b('Wrong video?', 'pick');
    if (r.status === 'gone') return tag('gone', '⚠ Gone from playlist') + b('✓ I have it', 'pick', 'good');
    if (r.status === 'other') return tag('other', '≈ ' + statusText(r)) + b('✓ I have it', 'pick', 'good') + b('✗ Not this one', 'markNot', 'bad');
    if (r.status === 'none') return tag('none', '✗ Not in playlist') + b('✓ I have it', 'pick', 'good') + b('👎 Dislike', 'dislike', 'dis');
    return '';
  }
  function detail(p, r, i) {
    let meta = '';
    if (r.linkMissing) {
      const was = D.doc.archive[r.linkId];
      meta = `<div class="meta warnt">${was ? `The song you linked, <b>${esc(was.title)}</b>, is gone from your playlist.` : 'The song you linked is no longer in your playlist.'} Undo, or Link song again.</div>`;
    } else if (r.item && r.marked !== 'not' && !r.disliked) {
      const what = r.status === 'gone' ? 'You had' : r.linked ? 'Linked to' : r.marked ? 'Closest match' : r.status === 'other' ? 'The version you have' : 'You have';
      meta = `<div class="meta">${what}: <b>${esc(r.item.title)}</b>${r.item.ch ? ' — ' + esc(noTopic(r.item.ch)) : ''}</div>`;
    } else if (r.status === 'unknown') meta = `<div class="meta">${D.playlistError ? "The playlist couldn't be read, so songs aren't labeled." : 'Reading the playlist…'}</div>`;
    if (p.album) meta += `<div class="meta">Album: <b>${esc(p.album)}</b></div>`;
    const extra = [];
    if (inList(r) && (!r.marked || r.linked)) { const c = catOf(r.item.id); extra.push(`<button class="menubtn ${c ? 'set' : ''}" data-act="catmenu" data-i="${i}" aria-haspopup="listbox">${esc(c ? CAT[c] : 'Category…')} <span class="caret">▾</span></button>`); }
    const note = noteOf(p.key), editing = S.noteFor === p.id;
    if (!editing && !note) extra.push(`<button class="pill" data-act="note" data-i="${i}">✎ Add a note</button>`);
    const noteBox = editing
      ? `<textarea id="note-text" maxlength="2000" placeholder="A note about this song" aria-label="Note: ${esc(p.title)}">${esc(S.noteDraft)}</textarea>
         <div class="row" style="margin-top:8px"><button class="pill primary" data-act="noteSave" data-i="${i}">Save note</button>${note ? `<button class="pill" data-act="noteDelete" data-i="${i}">Delete</button>` : ''}<button class="pill" data-act="noteCancel">Cancel</button></div>`
      : note ? `<div class="notewrap"><button class="icon" data-act="note" data-i="${i}" aria-label="Edit note" title="Edit note">✎</button><div class="note">${esc(note)}</div></div>` : '';
    const picker = S.pick === p.id ? pickerBox(p, r, i) : '';
    return `<div class="detail" data-stop>${meta}<div class="row">${actions(p, r, i)}${extra.join('')}</div>${picker}${noteBox}${playLog(p)}</div>`;
  }
  // Every play of the song, each with the time since the one before; * marks a recording gap in between
  function playLog(p) {
    const n = counts.get(p.key) || 0;
    if (n < 2) return '';
    const { times, gapTimes } = Stats.songTimes(D.plays, p.key);
    let gaps = false, out = false;
    const li = Stats.playLog(times, gapTimes).map(e => {
      if (e.spansGap) gaps = true;
      let since = e.first ? 'first recorded' : esc(Stats.formatSpan(e.since)) + (e.spansGap ? '*' : '');
      if (e.spansGap && !e.counted) { out = true; since = `<s>${since}</s>`; }
      return `<li class="${e.spansGap ? 'gapped' : ''} ${e.at === p.at ? 'cur' : ''}"><b>${short(e.at)} ${time(e.at)}</b> <span>${since}</span></li>`;
    }).join('');
    return `<div class="meta" style="margin:12px 0 0">All ${fmt(n)} plays, newest first, with the time since the one before</div><ul class="log">${li}</ul>` +
      (gaps ? `<p class="legend">* A recording gap falls in between, so plays may have been missed.${out ? ' Struck through: left out of the averages, since it isn\'t in line with this song\'s gap-free replays.' : ''}</p>` : '');
  }
  // "Which playlist song is it?", opened by I have it, Link song or Wrong video?
  function pickerBox(p, r, i) {
    const fixing = r.status === 'have' && !r.marked;
    const btns = fixing ? `<button class="pill bad" data-act="pickNot" data-i="${i}">✗ Not in playlist</button>`
      : `<button class="pill" data-act="pickPlain" data-i="${i}">${r.marked === 'have' ? 'Keep without linking' : 'Mark without linking'}</button>`;
    return `<div class="picker"><div class="ph">Which playlist song is it?</div>
      <input type="search" id="pick-q" placeholder="Search your playlist" autocomplete="off" value="${esc(S.pickQ || '')}" data-i="${i}" aria-label="Search your playlist">
      <div class="choices-wrap">${choicesHtml(p, r, i)}</div>
      <div class="row" style="margin:0">${btns}<button class="pill" data-act="pickCancel">Cancel</button></div></div>`;
  }
  function choicesHtml(p, r, i) {
    const q = (S.pickQ || '').trim();
    let list = q ? M.searchItems(q, D.items, 40) : M.suggest(p.artist, p.title, D.items, 6);
    const fixing = r.status === 'have' && !r.marked;
    // The closest match goes first, so confirming it is one tap; when fixing a wrong match, it's left out
    if (!q && r.item && fixing) list = list.filter(it => it.id !== r.item.id);
    else if (!q && r.item && !r.linked) list = [r.item].concat(list.filter(it => it.id !== r.item.id)).slice(0, 6);
    S.choices = list;
    return `<div class="sub2">${q ? `Matching “${esc(q)}”` : 'Closest matches'}</div><div class="choices">` +
      (list.length ? list.map((it, k) => `<button class="choice" data-act="choose" data-i="${i}" data-k="${k}">${esc(it.title)}${it.ch ? `<small>${esc(noTopic(it.ch))}</small>` : ''}</button>`).join('')
        : `<div class="pempty">${q ? 'No playlist songs match that search.' : 'No close matches. Search your playlist above.'}</div>`) + '</div>';
  }

  const R = {};
  R.now = () => {
    const all = rows();
    if (!all.length) return head('SomaFM Christmas Lounge') + `<div class="box">${D.loaded.plays ? 'No plays recorded yet.' : 'Loading the plays…'}</div>`;
    const n = (D.nowAt && all.find(p => p.at === D.nowAt)) || all[0], playing = n.at === D.nowAt;
    const r = statusOf(n.key, n.artist, n.title), i = rid(Object.assign({ id: rowId(n, 'hero:') }, n)), id = ROWS[i].id;
    const open = S.open === id, plays = counts.get(n.key) || 0;
    const t = stats();
    // Dan, Nov 4: each count with its words beside it (under it when there's no room); shorter words on a phone
    // Until a song repeats / comes back: the measured average between replays, not the rotation estimate (Dan, Nov 6)
    const tiles = `<div class="g2" style="margin-top:12px"><div class="box mid"><div class="tl"><b class="big">${t.repeatIntervals ? esc(backText(t.avgRepeatSecs)) : '—'}</b><span class="k">until a song repeats</span></div></div>` +
      `<div class="box"><div class="tl"><b class="big">${fmt(D.plays.length)}</b><span class="k"><span class="lw">plays recorded</span><span class="ln">plays</span></span></div><div class="tl tl2"><b>${fmt(t.unique)}</b><span class="k"><span class="lw">distinct songs</span><span class="ln">songs</span></span></div></div></div>`;
    // Favorite: a star beside the song's name (Dan, Nov 4), so the buttons fit on one line on a phone
    const f = inList(r) && isFav(r.item.id);
    const fav = inList(r) ? `<button class="star" data-act="fav" data-i="${i}" aria-pressed="${f}" aria-label="${f ? 'Remove from favorites' : 'Add to favorites'}: ${esc(n.title)}" title="${f ? 'Favorite. Tap to remove.' : 'Add to favorites'}">${f ? '★' : '☆'}</button>` : '';
    // The star stays on the line with the name's last word (Dan, Nov 5)
    const starred = (name, star) => { if (!star) return `<span>${esc(name)}</span>`; const m = /^([\s\S]*\s)?(\S+)\s*$/.exec(name) || [, '', name]; return `<span>${esc(m[1] || '')}<span class="nw">${esc(m[2])}${star}</span></span>`; };
    const label = r.status === 'unknown' ? '' : st(r);   // the same colored status as the lists
    const note = noteOf(n.key);
    // Dan, Nov 5: the album always on a line of its own under the artist; on a phone the picture sits beside the two
    // (he tried it starting at the album's line and preferred this)
    // Dan, Nov 5: a small picture from the song's video when it's in the playlist (taps through to YouTube): in the top
    // right corner, or on a phone beside the artist, above the play count. Both are written; the CSS shows one.
    const thumb = w => inList(r) ? `<a class="hthumb ${w}" href="${ytWatch(r.item.id)}" target="_blank" rel="noopener" data-stop tabindex="-1" aria-hidden="true"><img src="https://i.ytimg.com/vi/${encodeURIComponent(r.item.id)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>` : '';
    const others = all.slice(0, 8).filter(p => p !== n).slice(0, 7);
    return head('SomaFM Christmas Lounge') + listenFailBox() + `<div class="split"><div>
      <div class="hero ${open ? 'open' : ''}" data-act="row" data-i="${i}" role="button" tabindex="0" aria-expanded="${open}">${thumb('ta')}<div class="hero-top"><small>${playing ? 'Now playing' : 'Last played ' + time(n.at)}</small>${label}${castBtn()}</div><h2>${starred(n.title, fav)}</h2><div class="hmain${n.album ? ' two' : ''}"><div class="hwho"><p class="hartist">${esc(n.artist)}</p>${n.album ? `<p class="halbum">${esc(n.album)}</p>` : ''}</div>${thumb('tb')}</div>${note ? `<div class="hnote">${esc(note)}</div>` : ''}
      <div class="acts">${heroListenBtn()}${canOpen(r) ? `<a class="pill yt" href="${ytWatch(r.item.id)}" target="_blank" rel="noopener" data-stop title="Open on YouTube" aria-label="Open on YouTube">${ico('yt')}YouTube</a>` : `<a class="pill solid" href="${ytSearch(M.searchQuery(n.artist, n.title))}" target="_blank" rel="noopener" data-stop aria-label="Search YouTube">${ico('search')}Search</a>`}<span class="hcount"><span class="hct">${inList(r) && catOf(r.item.id) ? `<span class="hcat">${esc(CAT[catOf(r.item.id)])}</span>` : ''}<span><span class="lw">${plural(plays, 'play')}</span><span class="ln">${fmt(plays)}×</span></span></span> ${chev()}</span></div>
      ${heroListen()}</div>
      ${open ? `<div class="hero-detail">${detail(ROWS[i], r, i)}</div>` : ''}
      ${tiles}</div>
      <div><h3>Just played <a href="${esc(tabHref('history'))}" data-nav>See all</a></h3><div class="plays">${PHEAD}${others.map(p => playRow(p, 'now:', false)).join('')}</div></div></div>`;
  };

  // History's rows after the filters, and the counts on the chips (counted before the status, category and favorite filters)
  function historyRows() {
    let list = rows().map(s => ({ s, r: statusOf(s.key, s.artist, s.title) }));
    if (S.latest) { const seen = new Set(); list = list.filter(x => { if (seen.has(x.s.key)) return false; seen.add(x.s.key); return true; }); }
    const all = list, known = !D.playlistError && D.items.length;
    if (known && S.status.size) list = list.filter(x => S.status.has(x.r.status) || (x.r.status === 'gone' && S.status.has('none')));
    if (known && S.cats.size) list = list.filter(x => inList(x.r) && S.cats.has(catOf(x.r.item.id) || 'uncat'));
    if (known && S.favOnly) list = list.filter(x => inList(x.r) && isFav(x.r.item.id));
    if (S.q) { const q = fold(S.q).trim(); if (q) list = list.filter(x => fold(x.s.title + ' ' + x.s.artist + ' ' + x.s.album).indexOf(q) >= 0); }
    return { all, list };
  }
  R.history = () => {
    const { all, list } = historyRows();
    const pages = Math.max(1, Math.ceil(list.length / S.per));
    if (S.page > pages - 1) S.page = pages - 1;
    const page = list.slice(S.page * S.per, (S.page + 1) * S.per);
    const count = k => all.filter(x => x.r.status === k || (k === 'none' && x.r.status === 'gone')).length;
    const listed = all.filter(x => inList(x.r));
    const catN = k => listed.filter(x => (catOf(x.r.item.id) || 'uncat') === k).length;
    const favN = listed.filter(x => isFav(x.r.item.id)).length;
    // A chip with nothing in it (and not on) is drawn dim, with its 0 in red (Dan, Nov 4)
    const z = (n, on) => n || on ? 'chip' : 'chip zero';
    const C = {
      all: () => `<button class="chip" aria-pressed="${!S.status.size}" data-act="fstatus" data-v="all">All <span class="n">${fmt(all.length)}</span></button>`,
      // sh: a shorter name below 900 px, on the first row (the names today's site uses on the tablet)
      st: (k, l, sh) => `<button class="${z(count(k), S.status.has(k))}" aria-pressed="${S.status.has(k)}" data-act="fstatus" data-v="${k}" aria-label="${l} ${fmt(count(k))}">${sh ? `<span class="wide">${l}</span><span class="narrow">${sh}</span>` : l} <span class="n">${fmt(count(k))}</span></button>`,
      fav: sh => `<button class="${z(favN, S.favOnly)}" aria-pressed="${S.favOnly}" data-act="ffav" aria-label="Favorites ${fmt(favN)}">★${sh ? '<span class="wide"> Favorites</span>' : ' Favorites'} <span class="n">${fmt(favN)}</span></button>`,
      // sh: the short name on phones (Swing, Jazz, Funk; Dan, Nov 6)
      cat: (k, l, sh) => `<button class="${z(catN(k), S.cats.has(k))}" aria-pressed="${S.cats.has(k)}" data-act="fcat" data-v="${k}" aria-label="${l} ${fmt(catN(k))}">${sh && sh !== l ? `<span class="lw">${l}</span><span class="ln">${sh}</span>` : l} <span class="n">${fmt(catN(k))}</span></button>`,
      latest: () => `<button class="chip" aria-pressed="${S.latest}" data-act="flatest" title="One row per song, at its most recent play" aria-label="Latest play only"><span class="wide">Latest play only</span><span class="narrow">Latest</span></button>`,
    };
    // In All filters, the ones with nothing in them go to the end of their group (the order is kept otherwise)
    const zeroLast = list => list.filter(x => x.n || x.on).concat(list.filter(x => !x.n && !x.on)).map(x => x.html).join('');
    const active = S.status.size + S.cats.size + (S.favOnly ? 1 : 0) + (S.latest ? 1 : 0);
    // The search box; with the few filters showing, it goes in their row, so on a phone it shares the line with All ▾ (Dan, Nov 5)
    // The hint becomes "Search…" when the box is too narrow for it (fitHint)
    const find = `<div class="find"><input type="search" id="find" placeholder="${HINT}" value="${esc(S.q)}" aria-label="Search plays: song, artist, or album"></div>`;
    let filters = '', findIn = false;
    if (D.items.length && !D.playlistError) {
      if (S.allFilters) {
        // Latest is always the second chip (Dan, Nov 4)
        const sts = STATUS.map(([k, l]) => ({ n: count(k), on: S.status.has(k), html: C.st(k, l) }));
        const fc = [{ n: favN, on: S.favOnly, html: C.fav() }].concat(CATS2.map(([k, l, sh]) => ({ n: catN(k), on: S.cats.has(k), html: C.cat(k, l, k === 'uncat' ? '' : sh) })));
        filters = `<div class="fpanel" role="group" aria-label="All filters"><h5>Status</h5><div class="grp">${C.all()}${C.latest()}${zeroLast(sts)}</div>
          <h5>Favorites and categories</h5><div class="grp">${zeroLast(fc)}</div>
          <div class="end"><button class="pill" ${active ? '' : 'disabled'} data-act="fclear">Clear all</button><button class="pill primary" data-act="fdone">Done</button></div></div>`;
      } else {
        // A few to start with (All, Latest, In playlist, Not in playlist, Favorites), plus any other filter that's on.
        // Not in playlist is left out while there are none (unless it's on).
        const q = [C.all(), C.latest(), C.st('have', 'In playlist', 'In list')];
        if (count('none') || S.status.has('none')) q.push(C.st('none', 'Not in playlist', 'Not in list'));
        q.push(C.fav(true));
        for (const [k, l] of STATUS) if (k !== 'have' && k !== 'none' && S.status.has(k)) q.push(C.st(k, l));
        for (const [k, , sh] of CATS2) if (S.cats.has(k)) q.push(C.cat(k, sh));
        filters = `<div class="quick" role="group" aria-label="Filters">${q.join('')}<button class="more-f" data-act="fopen" aria-expanded="false" aria-label="All filters"><span class="wide">All filters</span><span class="narrow">All</span>${active ? ` <span class="badge">${active} on</span>` : ''} ▾</button>${find}</div>`;
        findIn = true;
      }
    }
    const gone = goneItems();
    const goneBox = gone.length ? `<details class="warn" id="gonebox" ${S.goneOpen ? 'open' : ''}><summary>⚠ ${gone.length} song${gone.length === 1 ? ' is' : 's are'} gone from your playlist</summary>
      <p class="hint">Removed or made unavailable on YouTube. Search to find a new copy, or Dismiss if you removed it on purpose.</p>
      ${gone.map(g => { const topic = /\s*-\s*Topic\s*$/i.test(g.ch) ? noTopic(g.ch) : '';
        const q = (topic + ' ' + g.title).replace(/\.mp3\b|\b(official (music )?video|lyrics?|lyric video|audio only|4k|uhd|flac)\b/gi, ' ');
        return `<div class="kv"><span><b>${esc(g.title)}</b><small>${g.ch ? esc(noTopic(g.ch)) + ' · ' : ''}last seen ${esc(History.formatDate(g.last / 1000))}</small></span><span><a class="pill" href="${ytSearch(M.searchQuery('', q))}" target="_blank" rel="noopener">Search YouTube</a> <button class="pill" data-act="dismiss" data-v="${esc(g.id)}">Dismiss</button></span></div>`; }).join('')}</details>` : '';
    const pl = D.playlistError ? `<span class="grow err">Couldn't read “${PLAYLIST_NAME}”: ${esc(D.playlistError)}. Songs aren't labeled until it can be read.</span>`
      : D.playlistLoading && !D.items.length ? `<span class="grow">Reading “${PLAYLIST_NAME}”…</span>`
      : `<span class="grow"><b>${PLAYLIST_NAME}</b> playlist <span class="nw">· ${fmt(D.items.length)} songs</span>${D.hidden ? ` <span class="nw">(${D.hidden} unavailable left out)</span>` : ''} <span class="nw">· checked ${ago(D.playlistAt)}</span></span>`;
    const gaps = D.plays.filter(p => p[4]).length;
    return head('SomaFM station play history') + `
      <div class="bar-line">${pl}<button class="pill" data-act="refresh">↻ Refresh playlist</button><button class="toggle" aria-pressed="${liveOn}" data-act="live"><i></i>Live updates</button></div>
      ${D.archiveNote ? `<div class="warn">⚠ ${esc(D.archiveNote)}</div>` : ''}${goneBox}${filters}
      ${findIn ? '' : find}
      <div id="plist">${playsList(page, list)}</div>
      <div class="pager"><button class="pill" ${S.page ? '' : 'disabled'} data-act="newer">‹ Newer</button>
        <span id="ppos">${list.length ? `${fmt(S.page * S.per + 1)}–${fmt(S.page * S.per + page.length)} of ${fmt(list.length)}` : ''}</span>
        <span class="per">Per page <button class="menubtn set" data-act="permenu" aria-haspopup="listbox">${S.per} <span class="caret">▾</span></button></span>
        <button class="pill" ${S.page < pages - 1 ? '' : 'disabled'} data-act="older">Older ›</button></div>
      <div class="foot">${D.plays.length ? `Recording since ${esc(when(D.plays[D.plays.length - 1][0]))} · ${fmt(D.plays.length)} plays · ${plural(gaps, 'gap')}` : D.loaded.plays ? 'No plays recorded yet.' : 'Loading the plays…'}</div>`;
  };
  // Column names over the lists, shown wherever a list is laid out as a table (Dan, Nov 6: tablet and wider)
  const PHEAD = '<div class="pr ph" aria-hidden="true"><div>Time</div><div>Song</div><div>Status</div><div>Category</div><div>Plays</div><div style="text-align:right">Actions</div></div>';
  function playsList(page, list) {
    if (!page.length) return `<div class="plays"><div class="empty">${rows().length ? 'No plays match.' : D.loaded.plays ? 'No plays recorded yet.' : 'Loading the plays…'}</div></div>`;
    return `<div class="plays">${PHEAD}` +
      page.map(x => playRow(x.s, '', x.s.at === D.nowAt) + (x.s.gap && !S.latest ? '<div class="gaprow">Not recording here — plays in this stretch were missed</div>' : '')).join('') + '</div>';
  }

  R.stats = () => {
    const t = stats(), P = t.playlist, ok = !D.playlistError && D.items.length;
    const since = D.plays.length ? D.plays[D.plays.length - 1][0] : 0;
    const top = (S.topSort === 'recent' ? t.recentRepeats : t.top).map(s => latestRow.get(s.key)).filter(Boolean);
    const missing = t.topMissing.map(s => latestRow.get(s.key)).filter(Boolean);
    const favN = D.items.filter(it => isFav(it.id)).length;
    // Categories: how many of each, and the songs without one (to set them here)
    const catCount = {}, none = [], seen = new Set();
    for (const it of D.items) { if (seen.has(it.id)) continue; seen.add(it.id); const c = catOf(it.id); if (c) catCount[c] = (catCount[c] || 0) + 1; else none.push(it); }
    let left;
    if (!ok) left = `<h3>Your playlist</h3><div class="box">${D.playlistError ? `Couldn't read the playlist: ${esc(D.playlistError)}` : 'Reading the playlist…'}</div>`;
    else {
      const heard = P.heard, notHeard = P.notHeard;
      left = `<h3>Your playlist</h3><div class="g3 wide-mid"><div class="box"><b class="big">${fmt(P.songs)}</b><span class="k">songs</span></div><div class="box"><b class="big">${hmin(P.total)}</b><span class="k">total length</span></div><div class="box"><b class="big">${History.formatClock(P.avg)}</b><span class="k"><span class="lw">average song</span><span class="ln">avg song</span></span></div></div>
      <h3>Songs by status</h3>${inOut(t)}${statusBox(t)}
      <h3>Heard so far</h3><div class="box"><div class="kv"><span>Heard on SomaFM so far</span><b>${fmt(heard)} · ${pct(heard, P.songs)}</b></div><div class="meter" role="progressbar" aria-label="Playlist songs heard" aria-valuemin="0" aria-valuemax="${P.songs}" aria-valuenow="${heard}"><i style="width:${P.songs ? heard / P.songs * 100 : 0}%"></i></div>
        ${notHeard.length ? `<details class="sub"><summary>Not heard yet: ${fmt(notHeard.length)}</summary><ul>${notHeard.map(it => `<li><span class="nh">${esc(it.title)}</span><span class="acts">${starBtn(it.id, it.title)}<a class="pill" href="${ytWatch(it.id)}" target="_blank" rel="noopener">Open</a></span></li>`).join('')}</ul></details>` : '<div class="kv"><span>Not heard yet</span><b>0</b></div>'}
        <div class="kv"><span>Favorites</span><b>${fmt(favN)}</b></div>
        ${P.longest ? `<div class="kv"><span>Longest</span><span class="r">${chunks(`<b>${History.formatClock(P.longest.secs)}</b> · `, P.longest.title)}</span></div><div class="kv"><span>Shortest</span><span class="r">${chunks(`<b>${History.formatClock(P.shortest.secs)}</b> · `, P.shortest.title)}</span></div>` : ''}
        ${P.unknown ? `<div class="snote">Length unknown for ${plural(P.unknown, 'song')}.</div>` : ''}
        <div class="snote">Heard counts automatic matches and linked songs. Unlinked “I have it” marks don't say which video, so they aren't counted.</div></div>
      <h3>Categories</h3><div class="box">${CATS.map(([k, n]) => `<div class="kv"><span>${n}</span><b>${fmt(catCount[k] || 0)}</b></div>`).join('')}
        ${none.length ? `<details class="sub"><summary>No category yet: ${fmt(none.length)}</summary><ul>${none.map(it => `<li><span class="nh">${esc(it.title)}</span><span class="acts"><button class="menubtn" data-act="catmenuId" data-v="${esc(it.id)}" data-name="${esc(it.title)}" aria-haspopup="listbox">Category… <span class="caret">▾</span></button></span></li>`).join('')}</ul></details>` : '<div class="kv"><span>No category yet</span><b>0</b></div>'}</div>
`;
    }
    const firsts = t.recent ? Math.round(t.recentFirsts / t.recent * 100) : 0;
    const right = !t.plays ? '<h3>SomaFM rotation</h3><div class="box">No plays recorded yet.</div>' : `<h3>SomaFM rotation</h3><div class="g2"><div class="box"><b class="big">${t.repeatIntervals ? esc(backText(t.avgRepeatSecs)) : '—'}</b><span class="k">until a song comes back, on average</span></div><div class="box"><b class="big">${fmt(t.unique)}</b><span class="k">different songs played</span></div></div>
      <div class="box" style="margin-top:12px"><div class="kv"><span>Songs played more than once</span><b>${fmt(t.repeated)}</b></div><div class="kv"><span>Plays per song</span><b>${t.avgPlays.toFixed(1)}</b></div>
        ${t.repeatIntervals ? `<div class="kv"><span><span class="lw">Between a song's replays</span><span class="ln">Between replays</span></span><span class="r lines"><span>${numsBold(Stats.formatSpan(t.avgRepeatSecs))} average</span><span>${numsBold(Stats.formatSpan(t.medianRepeatSecs))} median</span></span></div>` : ''}
        ${t.recentFirsts ? `<div class="kv"><span><span class="nw">Of the last ${fmt(t.recent)} plays,</span> <span class="nw">heard for the first time</span></span><b class="nw">${fmt(t.recentFirsts)} · ${firsts}%</b></div>` : ''}
        <div class="snote">${t.repeatIntervals ? `Comes back is the measured average time between a song's replays (${fmt(t.repeatIntervals)} replays). ` : ''}As the first-time share drops toward zero, you've seen nearly all of the rotation.</div></div>
      <h3><span>${S.topSort === 'recent' ? '<span class="lw">Most recently replayed</span><span class="ln">Latest replays</span>' : 'Most played'}</span> <span class="seg" role="group" aria-label="Sort"><button class="${S.topSort !== 'recent' ? 'on' : ''}" data-act="topSort" data-v="plays" aria-pressed="${S.topSort !== 'recent'}">Most plays</button><button class="${S.topSort === 'recent' ? 'on' : ''}" data-act="topSort" data-v="recent" aria-pressed="${S.topSort === 'recent'}">Latest</button></span></h3>
      <div class="plays">${top.length ? PHEAD + top.map(p => playRow(p, 'top:', false)).join('') : '<div class="empty left">No songs have repeated yet.</div>'}</div>
      ${ok && missing.length ? `<h3>Most played that you don't have (${plural(t.missingSongs, 'song')})</h3><div class="plays">${PHEAD}${missing.map(p => playRow(p, 'miss:', false)).join('')}</div>` : ''}
      <h3>Recording</h3><div class="box"><div class="kv"><span>Since</span><b>${esc(day(since))} ${esc(time(since))}</b></div><div class="kv"><span>Plays saved</span><b>${fmt(t.plays)}</b></div>
        <div class="kv"><span>Time recorded</span><b class="ph2"><span>${esc(Stats.formatSpan(t.coveredSecs))}</span>${t.perHour ? `<span><span class="lw"> · </span>${t.perHour.toFixed(1)} songs an hour</span>` : ''}</b></div><div class="kv"><span>Gaps (station or recorder down)</span><b>${fmt(t.gaps)}</b></div></div>`;
    return head(since ? 'Since ' + day(since) : 'Your playlist and SomaFM\'s rotation') + `<div class="split"><div>${left}</div><div>${right}</div></div>`;
  };
  // In your playlist and disliked, as two cards: of the different songs played, and of all plays (Dan, Nov 4).
  // Other versions and songs simply not in the playlist aren't shown here (Songs by status has them).
  function inOut(t) {
    if (!t.labeledSongs) return '';
    const h = t.breakdown.have || { songs: 0, plays: 0 }, d = t.breakdown.disliked || { songs: 0, plays: 0 };
    // Each share as a %, its words beside it (under it on a phone) and the count below them; disliked laid out the same
    const share = (cls, n, of, wide, narrow) => `<div class="io-in ${cls}"><b class="big">${pct(n, of)}</b><span class="io-t"><span class="io-l"><span class="lw">${wide}</span><span class="ln">${narrow}</span></span><span class="io-n"><b>${fmt(n)}</b> of <b>${fmt(of)}</b></span></span></div>`;
    const card = (n, dn, of, what) => `<div class="box io">${share('good', n, of, `of ${what} in your playlist`, `of ${what} in playlist`)}${share('dis', dn, of, `of ${what} disliked`, `of ${what} disliked`)}</div>`;
    return `<div class="g2" style="margin-bottom:12px">${card(h.songs, d.songs, t.labeledSongs, 'songs')}${card(h.plays, d.plays, t.labeledPlays, 'plays')}</div>`;
  }
  // The other statuses, each as a share of the different songs and of all plays (Dan's tweak 2). In playlist and Disliked
  // are in the cards above, so this box lists only other versions, not in playlist and gone, and only when there are any
  // (Dan, Nov 4).
  function statusBox(t) {
    if (!t.labeledSongs) return '<div class="box"><div class="snote">No plays recorded yet.</div></div>';
    const ks = ['other', 'none', 'gone'].filter(k => t.breakdown[k] && t.breakdown[k].songs);
    if (!ks.length) return '';
    return `<div class="box">${ks.map(k => {
      const b = t.breakdown[k];
      return `<div class="kv stat">${st({ status: k })}<span class="r"><span><b>${plural(b.songs, 'song')}</b> · ${pct(b.songs, t.labeledSongs)}</span><span><b>${plural(b.plays, 'play')}</b> · ${pct(b.plays, t.labeledPlays)}</span></span></div>`;
    }).join('')}<div class="snote">Of ${plural(t.labeledSongs, 'different song')} and ${plural(t.labeledPlays, 'play')}. Plays count every time a song came on, so often-played songs weigh more.</div></div>`;
  }
  // A song title in pieces that wrap whole where they can: after " - " and before "(" ("Burl Ives - Have A Holly Jolly
  // Christmas" breaks at the dash, "The Nutcracker Suite (Remastered 1996)" before the bracket); lead goes on the first piece
  function chunks(lead, title) {
    const parts = String(title || '').split(/(?<= - )|(?= \()/).map(x => x.trim()).filter(Boolean);
    return parts.map((x, k) => `<span class="chunk">${k ? '' : lead}${esc(x)}</span>`).join(' ');
  }
  const starBtn = (id, title) => `<button class="star" data-act="star" data-v="${esc(id)}" aria-pressed="${isFav(id)}" aria-label="${isFav(id) ? 'Remove from favorites' : 'Add to favorites'}: ${esc(title)}">${isFav(id) ? '★' : '☆'}</button>`;

  R.more = () => {
    const th = THEMES.indexOf(document.documentElement.dataset.theme) >= 0 ? document.documentElement.dataset.theme : '';
    const T = [['', 'Midnight', 'linear-gradient(135deg,#283a8f,#6a3fb5)'], ['candy', 'Xmas Red', 'linear-gradient(135deg,#b3192f 0 44%,#16764a 56% 100%)'], ['evergreen', 'Xmas Green', 'linear-gradient(135deg,#16764a 0 44%,#b3192f 56% 100%)']];
    const r = D.lastRun;
    const rec = r ? (r.ok ? `The recorder last read SomaFM's song list at ${esc(when(r.at))}.` : `The recorder couldn't read SomaFM's song list at ${esc(when(r.at))} (${esc(r.note)})${r.lastOk ? '; last good read ' + esc(when(r.lastOk)) : ''}.`) : '';
    const w = warning();
    const rs = S.restore;
    let restore = '';
    if (rs) {
      const pv = rs.preview;
      restore = `<div class="restore"><b>This backup has:</b><ul>
        <li>${pv.plays ? `${fmt(pv.plays)} plays, ${esc(when(pv.first))} to ${esc(when(pv.last))}; ${fmt(pv.newPlays)} of them aren't here yet` : 'No plays'}</li>
        <li>${fmt(pv.marks)} marks, ${fmt(pv.dislikes)} dislikes, ${fmt(pv.favorites)} favorites, ${fmt(pv.categories)} categories, ${fmt(pv.notes)} notes, ${fmt(pv.songs)} remembered playlist songs</li>
        ${pv.original ? `<li>The playlist's original order, saved ${esc(when(pv.original / 1000))}</li>` : ''}${rs.exportedAt ? `<li>Backed up ${esc(when(rs.exportedAt / 1000))}</li>` : ''}${rs.skipped ? `<li>${plural(rs.skipped, 'damaged entry', 'damaged entries')} will be skipped</li>` : ''}</ul>
        <div class="hint">Merge adds it to your data: plays not kept yet are added, and for marks, favorites, categories and notes the newer change wins. Nothing is taken away.</div>
        <div class="item" style="padding:0;border:0"><div class="acts"><button class="pill primary" data-act="restoreMerge">Merge</button><button class="pill" data-act="restoreCancel">Cancel</button></div></div></div>`;
    }
    const msg = m => m ? `<div class="msg ${m.cls || ''}" style="padding:0 14px 12px">${esc(m.text)}</div>` : '';
    return head('Settings and your data') + `<div class="split"><div><h3>Theme</h3><div class="themes">${T.map(([k, l, g]) => `<button class="theme ${th === k ? 'on' : ''}" data-act="theme" data-v="${k}" aria-pressed="${th === k}"><i style="background:${g}"></i>${l}</button>`).join('')}</div>
      <p class="hint">Remembered on this device.</p>
      <h3>Song lists</h3><div class="box"><div class="snote" style="margin-top:0">What each song shows without opening it.</div>
        <div class="kv"><span>Album</span><span class="seg" role="group" aria-label="Album"><button class="${S.listAlbum ? 'on' : ''}" data-act="listAlbum" data-v="1" aria-pressed="${S.listAlbum}">Always</button><button class="${S.listAlbum ? '' : 'on'}" data-act="listAlbum" data-v="" aria-pressed="${!S.listAlbum}">Wide screens</button></span></div>
        <div class="kv"><span>Notes</span><span class="seg" role="group" aria-label="Notes">${[['one', 'First line'], ['all', 'All'], ['off', 'Off']].map(([k, l]) => `<button class="${S.listNotes === k ? 'on' : ''}" data-act="listNotes" data-v="${k}" aria-pressed="${S.listNotes === k}">${l}</button>`).join('')}</span></div>
        <div class="snote">Remembered on this device. Open a song for everything about it.</div></div>
      <h3>Listen</h3><div class="box"><div class="kv"><span>Plays</span><span class="seg" role="group" aria-label="Listen plays">${[['', 'Here'], ['somafm', "In SomaFM's player"]].map(([k, l]) => `<button class="${(viaSoma() ? 'somafm' : '') === k ? 'on' : ''}" data-act="listenVia" data-v="${k}" aria-pressed="${(viaSoma() ? 'somafm' : '') === k}">${l}</button>`).join('')}</span></div>
        <div class="snote">Here plays the stream inside the site. If a browser can't, Listen opens SomaFM's own player instead. Remembered on this device.</div></div>
      <h3>Your data</h3><div class="box"><div class="snote" style="margin-top:0">Kept in one place on your Cloudflare account: every device shows the same, and each change is saved as you make it.</div>
        <div class="kv"><span>Read ${D.stateAt ? ago(D.stateAt) : '—'}${D.err.save ? '' : queued || inflight ? ' · saving…' : ''}</span><button class="pill" data-act="reload">Read again now</button></div>
        ${w ? `<div class="msg err">⚠ ${esc(w)}</div>` : ''}${rec ? `<div class="snote">${rec}</div>` : ''}
        <div class="snote">The recorder reads SomaFM's list every 10 minutes around the clock, so no device needs to stay open.</div></div></div>
      <div><h3>Backup and restore</h3><div class="list"><div class="item"><div class="tx"><b>Download a backup</b><small>Plays, marks, favorites, categories, notes, remembered songs and the original order</small></div><div class="acts"><button class="pill" data-act="backupDown">Download</button><button class="pill" data-act="backupCopy">Copy</button></div></div>
      ${msg(S.backupMsg)}
      <div class="item"><div class="tx"><b>Restore from a backup</b><small>From today's site or an earlier backup; you see what it has before anything changes</small></div><div class="acts"><button class="pill" data-act="restorePick">Choose file…</button><button class="pill" data-act="restorePaste">Paste…</button></div></div>
      <input type="file" id="restore-file" accept=".json,application/json,text/plain" hidden>
      ${S.restorePaste ? `<div class="restore"><textarea id="restore-text" spellcheck="false" placeholder="Paste the copied backup here" aria-label="Copied backup"></textarea><div><button class="pill" data-act="restoreRead">Read pasted backup</button></div></div>` : ''}
      ${restore}${msg(S.restoreMsg)}</div>
      <h3>Export</h3><div class="list"><div class="item"><div class="tx"><b>Plays as CSV</b><small>For a spreadsheet: date, time, artist, title, album, status</small></div><div class="acts"><button class="pill" data-act="csvDown">Download</button><button class="pill" data-act="csvCopy">Copy</button></div></div></div>
      <p class="hint" style="margin-top:16px"><a href="/privacy/">Privacy policy</a></p></div></div>`;
  };

  // Redraws wait while you're choosing a song, writing a note, or a menu is open
  let renderHeld = false;
  function quietRender() { if (S.pick || S.noteFor || menu || volDrag) { renderHeld = true; return; } render(); }
  /* ---------- Listen: SomaFM's stream of the station, played here (Dan, Nov 5) ---------- */
  // SomaFM's own servers for it (from its .pls lists): the 128k AAC first (half the data of the 256k MP3), then the MP3
  const STREAMS = (() => {
    const hosts = ['ice6', 'ice2', 'ice5'], aac = !!document.createElement('audio').canPlayType('audio/aac');
    return (aac ? hosts.map(h => `https://${h}.somafm.com/${CHANNEL}-128-aac`) : []).concat(hosts.map(h => `https://${h}.somafm.com/${CHANNEL}-256-mp3`));
  })();
  const LOGO = 'https://api.somafm.com/logos/256/christmas256.png';
  const MS = 'mediaSession' in navigator ? navigator.mediaSession : null;
  // SomaFM turns away its stream when the page asking is on pages.dev (browsers say which page asked; Dan's devices only
  // play because AdGuard's tracking protection hides that). Where it's refused, Listen opens SomaFM's own player instead, remembered per device.
  // SomaFM's pages can't be shown inside another site, so it's a window of its own (Dan, Nov 5).
  const SOMA_PLAYER = `https://somafm.com/player24/station/${CHANNEL}`;
  const viaSoma = () => LS.get('listenVia2', '') === 'somafm';
  // The player page on workers.dev, in an invisible frame (player/ in the repo): SomaFM plays its stream to it, where it
  // turns this pages.dev site away (Dan, Nov 5). Until it says it's there, or where it can't load, the site plays itself.
  // On Dan's own domain (xmaslounge.zamulagh.fyi and next., Nov 5) SomaFM plays to the site, so there's no frame there.
  const OWN_DOMAIN = /(^|\.)zamulagh\.fyi$/.test(location.hostname);
  const PLAYER_PAGE = 'https://lounge-player.soma-recorder.workers.dev/';
  const PLAYER_ORIGIN = new URL(PLAYER_PAGE).origin;
  const frame = { el: null, ready: false, used: false };
  function frameSetup() {
    const f = frame.el = document.createElement('iframe');
    f.src = PLAYER_PAGE; f.allow = 'autoplay'; f.title = 'Player'; f.tabIndex = -1;
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    document.body.appendChild(f);
  }
  const frameSend = m => { if (frame.el && frame.el.contentWindow) frame.el.contentWindow.postMessage(m, PLAYER_ORIGIN); };
  addEventListener('message', e => {
    if (!frame.el || e.source !== frame.el.contentWindow || e.origin !== PLAYER_ORIGIN) return;
    const m = e.data || {};
    if (m.ev === 'ready') { frame.ready = true; frameSend({ cmd: 'hello' }); }
    else if (m.ev === 'state' && frame.used) {
      if (m.state === 'off' && player.state === 'off') return;
      player.state = m.state; paintListen(); mediaState();
      if (m.state === 'on') mediaMeta(true);
    }
    else if (m.ev === 'blocked') { player.state = 'off'; paintListen(); toast('The browser held the sound back. Tap Listen again.'); }
    else if (m.ev === 'failed') { player.log = m.log || []; listenFailed({ can: m.can, ua: m.ua }); }
  });
  function openSoma() {
    // A tab on every device (Dan, Nov 5), the same one each time it's still open
    const w = window.open(SOMA_PLAYER, 'somafm-player');
    if (!w) toast("The browser blocked SomaFM's player. Allow pop-ups for this site, or try again.");
    else toast("SomaFM's player is open. Press ▶ there to start.");
  }
  // In the bar of pages, so it's there on every page
  function listenBtn() {
    if (viaSoma()) return `<button class="listen off" data-act="listen" title="Opens SomaFM's player (this browser can't play the stream inside the site)"><span class="lic">${ico('open')}</span>Listen ↗</button>`;
    const s = player.state;
    const icon = s === 'off' ? ico('open') : s === 'loading' ? '<span class="spin"></span>' : '<span class="eq"><i></i><i></i><i></i></span>';
    return `<button class="listen ${s}" data-act="listen" aria-pressed="${s !== 'off'}" title="${s === 'off' ? 'Listen to the station' : 'Stop listening'}"><span class="lic">${icon}</span>${s === 'off' ? 'Listen' : 'Stop'}</button>`;
  }
  function paintListen() {
    const b = document.querySelector('.tabs .listen'); if (b) b.outerHTML = listenBtn();
    const hb = document.getElementById('hlbtn'); if (hb) hb.outerHTML = heroListenBtn();
    const h = document.getElementById('hlisten'); if (h && !volDrag) h.outerHTML = heroListen();
  }
  // Listen on the Now Playing card too, and while it plays, the volume (Dan, Nov 5). The card grows a row for it; taps
  // there don't open the card. The volume is the player's own (quieter than the device, never louder), kept per device.
  let volDrag = false;
  const volume = () => { const v = Number(LS.get('volume', 100)); return v >= 0 && v <= 100 ? Math.round(v) : 100; };
  function applyVolume() {
    const v = volume() / 100;
    if (player.audio) player.audio.volume = v;
    if (frame.used) frameSend({ cmd: 'volume', v });
  }
  /* ---------- Cast: the station on a Chromecast (Dan, Nov 5) ---------- */
  // Google's sender library (Chrome only) finds Chromecasts on the network; the button shows only when there is one. The
  // Chromecast fetches SomaFM's stream itself (no page address goes with it, so SomaFM's pages.dev block doesn't apply),
  // with the song playing when casting starts. Starting a cast stops Listen here.
  const castS = { ready: false, avail: false, on: false, name: '' };
  function castBtn() {
    if (!castS.avail && !castS.on) return '<span id="castbtn" hidden></span>';
    return `<button class="icon cast ${castS.on ? 'on' : ''}" id="castbtn" data-act="cast" aria-pressed="${castS.on}" title="${castS.on ? 'Casting to ' + esc(castS.name) + '. Tap to stop.' : 'Cast to a TV or speaker'}" aria-label="${castS.on ? 'Casting. Tap to stop' : 'Cast'}">${ico('cast')}</button>`;
  }
  function paintCast() { const b = document.getElementById('castbtn'); if (b) b.outerHTML = castBtn(); }
  function castSetup() {
    if (!window.chrome || castS.ready) return;
    window.__onGCastApiAvailable = ok => {
      if (!ok || !window.cast || !cast.framework) return;
      const ctx = cast.framework.CastContext.getInstance();
      ctx.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      castS.ready = true;
      const sync = () => {
        const st = ctx.getCastState(), sess = ctx.getCurrentSession();
        castS.avail = st !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
        castS.on = st === cast.framework.CastState.CONNECTED;
        castS.name = sess && sess.getCastDevice ? sess.getCastDevice().friendlyName || '' : '';
        paintCast();
      };
      ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, sync);
      ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, e => {
        sync();
        if (e.sessionState === cast.framework.SessionState.SESSION_STARTED) castLoad(e.session);
      });
      sync();
    };
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.async = true;
    document.head.appendChild(s);
  }
  // What the Chromecast plays: the stream, as a live music track with the song and its picture
  function castLoad(session) {
    if (player.state !== 'off') listenStop();
    const all = rows(), n = (D.nowAt && all.find(p => p.at === D.nowAt)) || all[0];
    const r = n && statusOf(n.key, n.artist, n.title), vid = r && inList(r) ? r.item.id : '';
    const info = new chrome.cast.media.MediaInfo(`https://ice6.somafm.com/${CHANNEL}-256-mp3`, 'audio/mpeg');
    info.streamType = chrome.cast.media.StreamType.LIVE;
    const md = new chrome.cast.media.MusicTrackMediaMetadata();
    md.title = n ? n.title : 'Christmas Lounge'; md.artist = n ? n.artist : 'SomaFM'; md.albumName = 'SomaFM Christmas Lounge';
    md.images = [new chrome.cast.Image(vid ? `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg` : LOGO)];
    info.metadata = md;
    const req = new chrome.cast.media.LoadRequest(info);
    req.autoplay = true;
    session.loadMedia(req).then(() => toast(`Playing on ${castS.name || 'the TV'}.`), e => toast("The Chromecast couldn't play the stream" + (e && e.code ? ` (${e.code})` : '') + '.'));
  }
  // Listen first in the card's row of buttons (Dan, Nov 5); shorter words on a phone
  function heroListenBtn() {
    if (viaSoma()) return `<button class="pill solid" id="hlbtn" data-act="listen" title="Opens SomaFM's player">${ico('open')}<span class="lw">Listen on SomaFM ↗</span><span class="ln">Listen ↗</span></button>`;
    const s = player.state;
    if (s === 'off') return `<button class="pill solid" id="hlbtn" data-act="listen" aria-pressed="false">${ico('open')}<span class="lw">Listen live</span><span class="ln">Listen</span></button>`;
    return `<button class="pill solid on" id="hlbtn" data-act="listen" aria-pressed="true">${s === 'loading' ? '<span class="spin"></span><span class="lw">Connecting</span><span class="ln">Stop</span>' : '<span class="eq"><i></i><i></i><i></i></span>Stop'}</button>`;
  }
  // While it plays, a row under the buttons with the volume
  function heroListen() {
    const s = player.state, v = volume();
    if (viaSoma() || s === 'off') return '<div id="hlisten" hidden></div>';
    return `<div class="hlisten" id="hlisten" data-stop><label class="vol">${ico('vol')}<input type="range" id="vol" min="0" max="100" step="1" value="${v}" aria-label="Volume"><span id="volv">${v}%</span></label></div>`;
  }
  addEventListener('input', e => {
    if (e.target.id !== 'vol') return;
    LS.set('volume', Number(e.target.value));
    const l = document.getElementById('volv'); if (l) l.textContent = e.target.value + '%';
    applyVolume();
  });
  addEventListener('pointerdown', e => { if (e.target.id === 'vol') volDrag = true; });
  addEventListener('pointerup', () => { if (volDrag) { volDrag = false; if (renderHeld) quietRender(); } });
  addEventListener('pointercancel', () => { volDrag = false; });
  function listenStart() {
    if (frame.ready) {
      frame.used = true;
      player.state = 'loading'; player.log = [];
      if (player.fail) { player.fail = null; if (view === 'now') render(); }
      paintListen();
      frameSend({ cmd: 'volume', v: volume() / 100 }); frameSend({ cmd: 'play' });
      mediaMeta(true); mediaState();
      return;
    }
    frame.used = false;
    if (!player.audio) {
      const a = player.audio = new Audio();
      a.preload = 'none';
      a.addEventListener('playing', () => { if (player.state === 'off') return; player.state = 'on'; player.tries = 0; paintListen(); mediaState(); });
      a.addEventListener('waiting', () => { if (player.state === 'on') { player.state = 'loading'; paintListen(); } });
      // A server that won't answer: the next one; when none will, stop and say so
      a.addEventListener('error', () => {
        if (player.state === 'off' || !a.getAttribute('src')) return;
        const e = a.error;
        listenLog(e ? `error ${e.code}${e.message ? ': ' + e.message : ''}` : 'error (no details)');
        if (++player.tries < STREAMS.length) { player.at = (player.at + 1) % STREAMS.length; a.src = STREAMS[player.at]; a.play().catch(x => listenLog(x)); return; }
        listenFailed();
      });
      // The stream ended (a server restart): start it again, so it keeps playing
      a.addEventListener('ended', () => { if (player.state !== 'off') { a.src = STREAMS[player.at]; a.play().catch(() => {}); } });
      if (MS) { MS.setActionHandler('play', listenStart); MS.setActionHandler('pause', listenStop); MS.setActionHandler('stop', listenStop); }
    }
    player.state = 'loading'; player.tries = 0; player.log = [];
    if (player.fail) { player.fail = null; if (view === 'now') render(); }
    paintListen();
    player.audio.volume = volume() / 100;
    player.audio.src = STREAMS[player.at];
    player.audio.play().catch(e => { listenLog(e); if (e && e.name === 'NotAllowedError') { listenStop(); toast('The browser held the sound back. Tap Listen again.'); } });
    mediaMeta(true); mediaState();
  }
  // What each try came to, kept for the details shown when none plays (Dan's TV, Nov 5)
  function listenLog(what) {
    const src = (player.audio && player.audio.getAttribute('src')) || '';
    const m = /\/\/([^.]+)\.somafm\.com\/[^-]+-(\d+-\w+)/.exec(src);
    player.log.push((m ? m[1] + ' ' + m[2] : src || 'no address') + ' — ' + (what && what.name ? what.name + (what.message ? ': ' + what.message : '') : what));
  }
  function listenFailed(from) {
    const a = player.audio || document.createElement('audio');
    LS.set('listenVia2', 'somafm');
    player.fail = { at: Date.now(), log: player.log.slice(), can: from && from.can || ['audio/aac', 'audio/mpeg'].map(t => `${t}: ${a.canPlayType(t) || 'no'}`).join(', '), ua: from && from.ua || navigator.userAgent };
    listenStop();
    toast("This browser can't play SomaFM's stream here. Open SomaFM's player from the Now page.");
    if (view === 'now') render();
  }
  function listenFailBox() {
    const f = player.fail;
    if (!f) return '';
    return `<div class="warn listen-fail" role="status">⚠ This browser can't play SomaFM's stream inside the site (${esc(time(Math.floor(f.at / 1000)))}). SomaFM turns it away here, so from now on Listen opens SomaFM's own player.
      <div class="acts"><button class="pill primary" data-act="listenSoma">Open SomaFM's player</button></div>
      <details><summary>Details</summary><pre>${esc(f.log.concat(f.can, f.ua).join('\n'))}</pre></details></div>`;
  }
  // A live stream isn't paused but let go, so starting again plays what's on now
  function listenStop() {
    player.state = 'off';
    if (frame.used) frameSend({ cmd: 'stop' });
    const a = player.audio;
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
    paintListen(); mediaState();
  }
  // What's playing, for the phone's notification and lock screen: the song, and its video's picture when it's in the playlist
  function mediaMeta(force) {
    if (!MS || player.state === 'off' || typeof MediaMetadata === 'undefined') return;
    const all = rows(), n = (D.nowAt && all.find(p => p.at === D.nowAt)) || all[0];
    const key = n ? n.at + ':' + D.items.length : '';
    if (!force && key === player.key) return;
    player.key = key;
    const r = n && statusOf(n.key, n.artist, n.title), vid = r && inList(r) ? r.item.id : '';
    const art = vid ? { src: `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' } : { src: LOGO, sizes: '256x256', type: 'image/png' };
    const meta = { title: n ? n.title : 'Christmas Lounge', artist: n ? n.artist : 'SomaFM', album: n && n.album ? n.album : 'SomaFM Christmas Lounge', artwork: [art] };
    MS.metadata = new MediaMetadata(meta);
    if (frame.used) frameSend({ cmd: 'meta', meta });
  }
  function mediaState() { if (MS) MS.playbackState = player.state === 'off' ? 'none' : 'playing'; }

  // "Pop" when the page changes (Dan, Nov 5, as in his EPGSA convention app): the new page's pill grows out from the
  // middle while its icon gives a small bounce and its color fades in. A "ghost" copy behind the bar does the growing, so
  // the icon itself isn't stretched. Only on a real change of page (the bar is redrawn often), not on the first one.
  let navShown = null;
  function animateNav() {
    if (navShown === view) return;
    const first = navShown === null; navShown = view;
    if (first || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const nav = document.querySelector('.tabs'), item = nav && nav.querySelector('a.on'), pill = item && item.querySelector('svg');
    const to = pill && pill.getBoundingClientRect();
    if (!to || !to.width || !pill.animate) return;
    const ease = 'cubic-bezier(.2,0,0,1)', dur = 280, cs = getComputedStyle(pill), box = nav.getBoundingClientRect();
    const other = nav.querySelector('a:not(.on)');
    const ghost = document.createElement('span');
    ghost.className = 'nav-ghost';
    Object.assign(ghost.style, { left: (to.left - box.left) + 'px', top: (to.top - box.top) + 'px', width: to.width + 'px', height: to.height + 'px', background: cs.backgroundColor, borderRadius: cs.borderRadius });
    nav.prepend(ghost);
    item.classList.add('nav-ghosted');
    const anim = ghost.animate([{ transform: 'scaleX(.3)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: dur, easing: ease });
    if (other) item.animate([{ color: getComputedStyle(other).color }, { color: getComputedStyle(item).color }], { duration: dur, easing: ease });
    pill.animate([{ transform: 'scale(.75)' }, { transform: 'scale(1.15)', offset: 0.6 }, { transform: 'none' }], { duration: 380, easing: 'ease-out' });
    const done = () => { item.classList.remove('nav-ghosted'); ghost.remove(); };
    anim.finished.then(done, done);
  }
  // History's search box: on a phone it shares the line with All ▾ (Dan, Nov 5), so where that leaves it too narrow
  // for the whole hint, the hint is just "Search…"
  const HINT = 'Search: song, artist, or album';
  let hintCanvas = null;
  function fitHint() {
    const e = document.getElementById('find');
    if (!e) return;
    const cs = getComputedStyle(e), c = (hintCanvas = hintCanvas || document.createElement('canvas')).getContext('2d');
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const room = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    e.placeholder = c.measureText(HINT).width + 10 <= room ? HINT : 'Search…';   // a little to spare: the font may still be loading when this measures
  }
  addEventListener('resize', fitHint);
  function render() {
    renderHeld = false;
    if (menu) closeMenu();
    const a = document.activeElement, fid = a && a.id, sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    ROWS = [];
    document.getElementById('tabs').innerHTML = TABS.map(([k, l]) => `<a class="${view === k ? 'on' : ''}" href="${esc(tabHref(k))}" data-nav ${view === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>${l}</a>`).join('') + listenBtn();
    document.getElementById('app').innerHTML = (view === 'shuffle' ? shufView : R[view])();
    document.title = 'Christmas Lounge · ' + TABS.find(t => t[0] === view)[1];
    fitHint();
    animateNav();
    if (fid) { const e = document.getElementById(fid); if (e) { e.focus({ preventScroll: true }); if (sel && e.setSelectionRange) try { e.setSelectionRange(sel[0], sel[1]); } catch (x) { /* not a text field */ } } }
  }
  // Only the plays and the paging, for typing in the search box
  function renderList() {
    ROWS = [];
    const { list } = historyRows(), pages = Math.max(1, Math.ceil(list.length / S.per));
    if (S.page > pages - 1) S.page = pages - 1;
    const page = list.slice(S.page * S.per, (S.page + 1) * S.per);
    $('#plist').innerHTML = playsList(page, list);
    $('#ppos').textContent = list.length ? `${fmt(S.page * S.per + 1)}–${fmt(S.page * S.per + page.length)} of ${fmt(list.length)}` : '';
    $('[data-act="newer"]').disabled = !S.page; $('[data-act="older"]').disabled = S.page >= pages - 1;
  }

  /* ---------- Menus in the page's colors (a system drop-down can't be themed, and opens full-screen on the tablet) ---------- */
  let menu = null;
  function openMenu(btn, label, opts, cur, choose) {
    closeMenu();
    const box = document.createElement('div');
    box.className = 'menu'; box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', label);
    for (const [k, name, cls] of opts) {
      const o = document.createElement('button');
      o.type = 'button'; o.className = cls || ''; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(k === cur));
      o.innerHTML = `<span class="tick">${k === cur ? '✓' : ''}</span>${esc(name)}`;
      o.onclick = () => { closeMenu(true); if (k !== cur) choose(k); };
      box.append(o);
    }
    box.addEventListener('keydown', e => {
      const list = [...box.querySelectorAll('button')], i = list.indexOf(document.activeElement);
      const to = j => { e.preventDefault(); list[(j + list.length) % list.length].focus(); };
      if (e.key === 'ArrowDown') to(i + 1); else if (e.key === 'ArrowUp') to(i - 1);
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); } else if (e.key === 'Tab') closeMenu();
    });
    document.body.append(box);
    const place = () => {
      const r = btn.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
      if (r.bottom < 0 || r.top > innerHeight) return closeMenu();
      let top = r.bottom + 4;
      if (top + h > innerHeight - 8 && r.top - h - 4 >= 8) top = r.top - h - 4;
      box.style.top = Math.round(top) + 'px';
      box.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8))) + 'px';
    };
    place();
    const away = e => { if (!box.contains(e.target) && !btn.contains(e.target)) closeMenu(); };
    document.addEventListener('pointerdown', away, true);
    addEventListener('scroll', place, true); addEventListener('resize', place);
    menu = { btn, box, away, place };
    btn.setAttribute('aria-expanded', 'true');
    (box.querySelector('[aria-selected="true"]') || box.querySelector('button')).focus({ preventScroll: true });
  }
  function closeMenu(refocus) {
    if (!menu) return;
    const m = menu; menu = null;
    m.box.remove();
    document.removeEventListener('pointerdown', m.away, true);
    removeEventListener('scroll', m.place, true); removeEventListener('resize', m.place);
    m.btn.setAttribute('aria-expanded', 'false');
    if (refocus && m.btn.isConnected) m.btn.focus({ preventScroll: true });
    if (renderHeld) setTimeout(quietRender, 50);
  }
  function catMenu(btn, id, title) {
    const cur = catOf(id), opts = CATS.map(c => [c[0], c[1]]);
    if (cur) opts.push(['', 'No category', 'clear']);
    openMenu(btn, 'Category: ' + title, opts, cur, k => { setCat(id, k); render(); });
  }

  /* ---------- Taps ---------- */
  const rowOf = el => ROWS[Number(el.dataset.i)];
  const resultOf = p => statusOf(p.key, p.artist, p.title);
  function closePanels() { S.pick = null; S.noteFor = null; S.pickQ = ''; }
  const ACT = {
    cast() {
      if (!castS.ready) return;
      const ctx = cast.framework.CastContext.getInstance();
      if (castS.on) { ctx.endCurrentSession(true); toast('Stopped casting.'); }
      else ctx.requestSession().catch(() => {});
    },
    listen() { if (viaSoma()) openSoma(); else if (player.state === 'off') listenStart(); else listenStop(); },
    listenSoma() { player.fail = null; openSoma(); render(); },
    listenVia(b) { LS.set('listenVia2', b.dataset.v === 'somafm' ? 'somafm' : null); player.fail = null; render(); },
    row(el) {
      const p = rowOf(el);
      S.open = S.open === p.id ? null : p.id; closePanels();
      render();
    },
    pick(el) { const p = rowOf(el); S.open = p.id; S.pick = p.id; S.noteFor = null; S.pickQ = ''; render(); const q = $('#pick-q'); if (q) q.focus({ preventScroll: true }); },
    pickCancel() { closePanels(); render(); },
    pickPlain(el) { const p = rowOf(el), r = resultOf(p); if (r.marked !== 'have') setMark(p.key, 'have'); closePanels(); render(); },
    pickNot(el) { setMark(rowOf(el).key, 'not'); closePanels(); render(); },
    choose(el) {
      const p = rowOf(el), it = S.choices && S.choices[Number(el.dataset.k)];
      if (!it || S.chosen) return;
      // Shown as linked for a moment before the panel closes, so it's clear it worked
      S.chosen = true;
      el.classList.add('chosen'); el.insertAdjacentHTML('afterbegin', '✓ Linked · ');
      for (const o of document.querySelectorAll('.choice')) if (o !== el) o.disabled = true;
      const q = $('#pick-q'); if (q) q.disabled = true;
      setTimeout(() => {
        S.chosen = false;
        setMark(p.key, 'have', it.id);
        closePanels(); S.flash = p.key;
        render();
        setTimeout(() => { S.flash = null; for (const f of document.querySelectorAll('.pr.flash')) f.classList.remove('flash'); }, 1600);
      }, 850);
    },
    markNot(el) { setMark(rowOf(el).key, 'not'); render(); },
    unmark(el) { setMark(rowOf(el).key, null); render(); },
    unlink(el) { setMark(rowOf(el).key, 'have'); render(); },   // two-level undo: Unlink keeps "I have it"; Undo then clears it
    dislike(el) { setDislike(rowOf(el).key, true); render(); },
    undislike(el) { setDislike(rowOf(el).key, false); render(); },
    fav(el) { const r = resultOf(rowOf(el)); if (inList(r)) { setFav(r.item.id, !isFav(r.item.id)); render(); } },
    star(el) { setFav(el.dataset.v, !isFav(el.dataset.v)); render(); },
    catmenu(el) { const p = rowOf(el), r = resultOf(p); if (inList(r)) catMenu(el, r.item.id, p.title); },
    catmenuId(el) { catMenu(el, el.dataset.v, el.dataset.name || ''); },
    note(el) { const p = rowOf(el); S.open = p.id; S.noteFor = p.id; S.pick = null; S.noteDraft = noteOf(p.key); render(); focusNote(); },
    
    noteSave(el) { const p = rowOf(el), t = ($('#note-text') || {}).value; const v = String(t == null ? S.noteDraft : t).trim(); if (v !== noteOf(p.key)) setNote(p.key, v); closePanels(); render(); },
    noteDelete(el) { setNote(rowOf(el).key, ''); closePanels(); render(); },
    noteCancel() { closePanels(); render(); },
    dismiss(el) { dismissGone(el.dataset.v); render(); },
    fstatus(el) {
      const k = el.dataset.v;
      if (k === 'all') S.status.clear(); else if (S.status.has(k)) S.status.delete(k); else S.status.add(k);
      if (S.status.size === STATUS.length) S.status.clear();   // every one on is the same as All
      S.page = 0; writeAddress(); render();
    },
    fcat(el) { const k = el.dataset.v; if (S.cats.has(k)) S.cats.delete(k); else S.cats.add(k); S.page = 0; writeAddress(); render(); },
    ffav() { S.favOnly = !S.favOnly; S.page = 0; writeAddress(); render(); },
    flatest() { S.latest = !S.latest; S.page = 0; writeAddress(); render(); },
    fclear() { S.status.clear(); S.cats.clear(); S.favOnly = false; S.latest = false; S.page = 0; writeAddress(); render(); },
    fopen() { S.allFilters = true; render(); },
    fdone() { S.allFilters = false; render(); },
    newer() { if (S.page) { S.page--; writeAddress(); render(); scrollTo(0, 0); } },
    older() { S.page++; writeAddress(); render(); scrollTo(0, 0); },
    permenu(el) { openMenu(el, 'Plays per page', PAGE_SIZES.map(n => [n, String(n)]), S.per, n => { S.per = n; LS.set('per', n); S.page = 0; writeAddress(); render(); }); },
    refresh() { return busy(async () => { D.playlistLoading = true; render(); await loadPlaylist(true); render(); }); },
    live() { liveOn = !liveOn; LS.set('live', liveOn); schedule(); if (liveOn) tick(true); render(); },
    listAlbum(el) { S.listAlbum = !!el.dataset.v; LS.set('listAlbum', S.listAlbum); document.documentElement.classList.toggle('show-alb', S.listAlbum); render(); },
    listNotes(el) { S.listNotes = el.dataset.v; LS.set('listNotes', S.listNotes); render(); },
    topSort(el) { S.topSort = el.dataset.v === 'recent' ? 'recent' : 'plays'; LS.set('topSort', S.topSort); render(); },
    theme(el) { const t = el.dataset.v; if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; LS.set('theme', t); render(); },
    reload() { return busy(async () => { await tick(true); await loadPlaylist(false); render(); toast('Read again just now.'); }); },
    backupDown() { try { download(`soma-xmas-checker-backup-${stamp()}.json`, backupText(), 'application/json'); S.backupMsg = { text: 'Backup downloaded. If nothing downloaded, use Copy.', cls: 'ok' }; } catch (e) { S.backupMsg = { text: `Couldn't save the file (${e.message}). Use Copy instead.`, cls: 'err' }; } render(); },
    backupCopy() { copy(backupText()).then(() => { S.backupMsg = { text: 'Backup copied.', cls: 'ok' }; render(); }, e => { S.backupMsg = { text: `Couldn't copy (${e.message}).`, cls: 'err' }; render(); }); },
    restorePick() { $('#restore-file').click(); },
    restorePaste() { S.restorePaste = !S.restorePaste; render(); const t = $('#restore-text'); if (t) t.focus(); },
    restoreRead() { readBackup(($('#restore-text') || {}).value); },
    restoreCancel() { S.restore = null; S.restoreMsg = null; render(); },
    restoreMerge() { return busy(mergeBackup); },
    csvDown() { download(`somafm-${CHANNEL}-history-${stamp().slice(0, 10)}.csv`, csvText(), 'text/csv;charset=utf-8'); toast('CSV downloaded. If nothing downloaded, use Copy.'); },
    csvCopy() { copy(csvText()).then(() => toast(`Copied ${fmt(D.plays.length)} plays as CSV.`), e => toast(`Couldn't copy (${e.message}).`)); },
  };
  function focusNote() { const ta = $('#note-text'); if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); keepInView(ta); } }
  // The on-screen keyboard can cover the note box as it opens; the box is fitted to what's still visible
  function keepInView(box) {
    const fit = () => {
      if (!box.isConnected) return;
      const vv = window.visualViewport, top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : innerHeight), r = box.getBoundingClientRect();
      let dy = r.bottom > bottom - 8 ? r.bottom - bottom + 12 : 0;
      if (r.top - dy < top + 8) dy = r.top - top - 8;
      if (Math.abs(dy) > 1) scrollBy(0, dy);
    };
    fit();
    const vv = window.visualViewport;
    if (vv) { vv.addEventListener('resize', fit); setTimeout(() => vv.removeEventListener('resize', fit), 1500); }
    setTimeout(fit, 400);
  }
  document.addEventListener('click', e => {
    const nav = e.target.closest('a[data-nav]');
    if (nav && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(nav.getAttribute('href')); return; }
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled) {
      // a tap inside an open row's panel doesn't fold the row up (except on its own buttons)
      if (el.dataset.act === 'row' && e.target.closest('[data-stop]') && e.target.closest('[data-stop]') !== el) return;
      const fn = ACT[el.dataset.act] || SHACT[el.dataset.act];
      if (fn) { e.preventDefault(); fn(el, e); }
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.pr[data-act="row"], .hero[data-act="row"]')) { e.preventDefault(); ACT.row(e.target); }
    if (e.key === 'Escape' && (S.pick || S.noteFor)) { closePanels(); render(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'note-text') { const b = $('[data-act="noteSave"]'); if (b) ACT.noteSave(b); }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'find') { S.q = t.value; S.page = 0; writeAddress(); renderList(); }
    else if (t.id === 'pick-q') { S.pickQ = t.value; const p = ROWS[Number(t.dataset.i)]; t.parentNode.querySelector('.choices-wrap').innerHTML = choicesHtml(p, resultOf(p), Number(t.dataset.i)); }
    else if (t.id === 'note-text') S.noteDraft = t.value;
  });
  document.addEventListener('change', e => { if (e.target.id === 'restore-file') { const f = e.target.files && e.target.files[0]; if (f) readFile(f); } });
  document.addEventListener('toggle', e => { if (e.target.id === 'gonebox') S.goneOpen = e.target.open; }, true);

  /* ---------- Backup, restore and CSV ---------- */
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const copy = text => navigator.clipboard.writeText(text);
  // The same file today's site makes, so either can read the other's
  function snapshot() {
    const d = D.doc;
    return { history: { [CHANNEL]: D.plays }, marks: d.marks, dislikes: d.dislikes, favorites: d.favorites, categories: d.categories, notes: d.notes, archive: d.archive, original: d.original };
  }
  const backupText = () => JSON.stringify(Backup.build(snapshot(), { playlistId: PLAYLIST_ID, scriptVersion: 'site/app' }));
  function csvText() {
    return History.toCSV(D.plays, (artist, title) => {
      const r = statusOf(M.markKey(artist, title), artist, title);
      return (r.status === 'unknown' ? '' : LABEL[r.status]) + (r.linked ? ' (linked)' : r.marked && !r.disliked ? ' (marked)' : '');
    });
  }
  async function readFile(f) {
    if (f.size > 20 * 1024 * 1024) { S.restoreMsg = { text: 'That file is too large to be a backup. Nothing was changed.', cls: 'err' }; render(); return; }
    readBackup(await f.text());
  }
  function readBackup(text) {
    S.restore = null;
    let v;
    try { v = Backup.validate(JSON.parse(String(text || '').trim())); }
    catch (e) { S.restoreMsg = { text: e instanceof SyntaxError ? "That isn't a backup: it couldn't be read as backup data. Nothing was changed." : `Can't use that backup: ${e.message}. Nothing was changed.`, cls: 'err' }; render(); return; }
    S.restore = { data: v.data, skipped: v.skipped, exportedAt: v.exportedAt, preview: Backup.preview(snapshot(), v.data) };
    S.restoreMsg = null; S.restorePaste = false;
    render();
  }
  // Plays go to the database 500 at a time; the rest is one change, merged by the same rules as every other
  async function mergeBackup() {
    const rs = S.restore;
    if (!rs) return;
    try {
      for (const ch of Object.keys(rs.data.history)) {
        const list = Cloud.cleanPlays(rs.data.history[ch]);
        for (let i = 0; i < list.length; i += 500) await api(`/plays?channel=${encodeURIComponent(ch)}`, { method: 'POST', body: { plays: list.slice(i, i + 500) } });
      }
      const d = rs.data;
      change({ marks: d.marks, dislikes: d.dislikes, favorites: d.favorites, categories: d.categories, notes: d.notes, archive: d.archive, original: d.original });
      await loadPlays();
      S.restore = null;
      S.restoreMsg = { text: `Merged. ${fmt(D.plays.length)} plays kept now.`, cls: 'ok' };
    } catch (e) { S.restoreMsg = { text: `The merge stopped: ${e.message}. What was sent is kept; merging the same backup again is safe.`, cls: 'err' }; }
    render();
  }

  /* ---------- Shuffle the real playlist (YouTube Data API; you sign in with Google) ---------- */
  // The plan and the moves are the checker's Shuffle module. The unfinished job is kept on this device before the first
  // move, so a run cut short is finished next time. The quota count, the order before the last change, what the last
  // run used, and the original order are in the synced document, so every device shows the same.
  const KINDS = {
    shuffle: { head: 'A new order', go: 'Shuffle the playlist', run: 'Shuffling your playlist…', name: 'A shuffle', done: 'Done. Your playlist is in the new order, and reading it back confirmed it.' },
    undo: { head: 'The order before the last shuffle', go: 'Put back this order', run: 'Putting back the earlier order…', name: 'Putting back the earlier order', done: 'Done. The earlier order is back, and reading the playlist confirmed it.' },
    original: { head: 'The original order', go: 'Put back the original order', run: 'Putting back the original order…', name: 'Putting back the original order', done: 'Done. The original order is back, and reading the playlist confirmed it.' },
  };
  const API_WAITS = [2000, 5000, 15000, 30000], READBACK_WAITS = [5000, 15000];
  const rand = n => { const lim = Math.floor(0x100000000 / n) * n, b = new Uint32Array(1); do { crypto.getRandomValues(b); } while (b[0] >= lim); return b[0] % n; };
  let sh = {}, shToken = null, shRunning = false, shStop = false, shWait = null, runUnits = 0, armed = null;
  const SH = { view: 'idle', msg: '' };
  const validToken = () => { const t = LS.get('signin:token', null); return t && t.token && t.exp > Date.now() ? t.token : null; };
  // A key for YouTube: the one this device has, else (sign-in kept on the server) a fresh one from it; null = sign in
  async function freshToken() {
    const v = validToken();
    if (v) return v;
    if (!D.clientId) await loadConfig();
    if (!D.keepsSignIn) return null;
    try {
      const d = (await api('/youtube/token', { method: 'POST', body: {} })).data;
      LS.set('signin:token', { token: d.access_token, at: Date.now(), exp: Date.now() + ((Number(d.expires_in) || 3600) - 120) * 1000, kept: true });
      return d.access_token;
    } catch (e) { if (e.status === 409) { LS.set('signin:token', null); return null; } throw e; }
  }
  function deviceId() {
    let d = LS.get('device', '');
    if (!d) { const b = new Uint8Array(8); crypto.getRandomValues(b); d = Array.prototype.map.call(b, x => x.toString(16).padStart(2, '0')).join(''); LS.set('device', d); }
    return d;
  }
  const usedToday = () => Sync.unitsOn(D.doc.shuffle.units, Shuffle.quotaDay(Date.now()));
  function addUsed(n) {
    runUnits += n;
    const me = deviceId(), dayKey = Shuffle.quotaDay(Date.now()), u = D.doc.shuffle.units[me];
    change({ shuffle: { units: { [me]: { day: dayKey, units: (u && u.day === dayKey ? u.units : 0) + n, at: Date.now() } } } }, 3000);
  }
  const lastOrder = () => D.doc.shuffle.last[PLAYLIST_ID] || null;
  const ytTry = Shuffle.retrying((...a) => ytCall(...a), API_WAITS, ms => sleep(ms), (e, wait) => {
    const t = $('#shprog'); if (t) t.textContent = `YouTube didn't answer (${e.message}). Trying again in ${Math.round(wait / 1000)} s…`;
  });
  async function ytCall(method, resource, params, body, again) {
    const q = new URLSearchParams();
    for (const k in params) if (params[k] !== '' && params[k] != null) q.set(k, String(params[k]));
    const headers = { Authorization: 'Bearer ' + shToken };
    if (body) headers['Content-Type'] = 'application/json';
    let r;
    // no-store: reading the playlist again right after the moves must not get a stored answer with the old order
    try { r = await fetch(`https://www.googleapis.com/youtube/v3/${resource}?${q}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
    catch (e) { throw Object.assign(new Error('network error'), { status: 0, reason: 'network' }); }
    addUsed(method === 'GET' ? 1 : Shuffle.UNITS_PER_MOVE);
    if (r.ok) return r.json();
    // The hour ran out mid-run: with the sign-in kept, a fresh key, and the same request once more
    if (r.status === 401 && !again && D.keepsSignIn) {
      LS.set('signin:token', null);
      const t = await freshToken().catch(() => null);
      if (t) { shToken = t; return ytCall(method, resource, params, body, true); }
    }
    let msg = '', reason = '';
    try { const j = await r.json(); msg = j.error.message || ''; reason = (j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || ''; } catch (e) { /* no details */ }
    throw Object.assign(new Error(msg || 'YouTube returned ' + r.status), { status: r.status, reason });
  }
  function resetMins() {
    let h = 0, m = 0;
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date())) {
      if (p.type === 'hour') h = Number(p.value);
      if (p.type === 'minute') m = Number(p.value);
    }
    return 1440 - h * 60 - m;
  }
  const quotaReset = () => new Date(Date.now() + resetMins() * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function trouble(e) {
    if (e.status === 401) { LS.set('signin:token', null); return D.keepsSignIn ? 'Google no longer accepts the sign-in. Sign in again.' : 'Your Google sign-in has run out (it lasts an hour).'; }
    if (/quota/i.test(e.reason || '')) return `Today's YouTube quota is used up. It resets at midnight Pacific time (${quotaReset()} your time).`;
    if (e.status === 403) return `YouTube refused: ${e.message}`;
    return `Couldn't talk to YouTube: ${e.message}`;
  }
  function shufSet(v, msg) { SH.view = v; SH.msg = msg || ''; if (view === 'shuffle') render(); }
  async function signIn() {
    if (!D.clientId) await loadConfig();
    if (!D.clientId) return shufSet('error', "The site has no Google Client ID set up (GOOGLE_CLIENT_ID), so it can't sign in.");
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    const state = Array.prototype.map.call(b, x => x.toString(16).padStart(2, '0')).join('');
    // Kept on the server: a one-time code, and offline access with the consent screen so Google gives a lasting permission
    const how = D.keepsSignIn ? { response_type: 'code', access_type: 'offline', prompt: 'consent' } : { response_type: 'token' };
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(Object.assign({ client_id: D.clientId, redirect_uri: location.origin + '/', scope: YT_SCOPE, state }, how));
    const startedAt = Date.now();
    LS.set('signin:pending', { state, popup: true, at: startedAt });
    const w = window.open(url, 'xlsignin', 'popup,width=520,height=700');
    if (!w) { LS.set('signin:pending', { state, popup: false, at: startedAt }); location.href = url; return; }   // popups blocked: sign in in this tab
    shufSet('waiting');
    clearInterval(shWait);
    shWait = setInterval(() => {
      const t = LS.get('signin:token', null);
      if (t && t.at >= startedAt) { clearInterval(shWait); shWait = null; if (t.token) shufStart(); else shufSet('signin', `Google sign-in didn't complete (${t.error}).`); }
      else if (Date.now() - startedAt > 10 * 60000) { clearInterval(shWait); shWait = null; shufSet('signin', 'Sign-in timed out.'); }
    }, 700);
  }
  // The playlist's original order, with video ids and titles so it can be read outside the site too; the one saved first wins
  function saveOriginal(ids, at) {
    const byId = new Map(); for (const it of sh.items) byId.set(it.id, it);
    change({ original: { at, playlistId: PLAYLIST_ID, songs: ids.map(id => { const it = byId.get(id) || {}; return { id, videoId: it.videoId || '', title: it.title || '' }; }) } });
  }
  function downloadOriginal() {
    const o = D.doc.original;
    if (!o) return;
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    let csv = 'Position,Title,Video\r\n';
    o.songs.forEach((s, i) => { csv += `${i + 1},${q(s.title)},${s.videoId ? 'https://www.youtube.com/watch?v=' + s.videoId : ''}\r\n`; });
    download(`${PLAYLIST_NAME.replace(/\W+/g, '-').toLowerCase()}-original-order.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
  }
  let shOpening = false;
  async function shufOpen() {
    if (shRunning || shWait || shOpening) return;
    shOpening = true;
    try {
      if (connecting) { shufSet('loading', 'Signing in…'); const t = await connecting; connecting = null; if (!t.token) return shufSet('signin', `Google sign-in didn't complete (${t.error}).`); }
      const fresh = SH.view === 'idle' || SH.view === 'signin' || SH.view === 'loading';
      if (fresh && !validToken()) shufSet('loading', 'Signing in…');
      const t = fresh ? await freshToken().catch(() => null) : validToken();
      if (t) { if (fresh) shufStart(); }
      else if (SH.view !== 'error') shufSet('signin');
    } finally { shOpening = false; }
  }
  async function shufStart() {
    try { shToken = await freshToken(); } catch (e) { return shufSet('error', `Couldn't get a Google key from the site (${e.message}).`); }
    if (!shToken) return shufSet('signin');
    shufSet('loading', 'Reading your playlist…');
    try {
      await stateLoaded;
      const who = await Shuffle.checkOwner(ytTry, PLAYLIST_ID);
      const list = await Shuffle.readItems(ytTry, PLAYLIST_ID);
      sh = { channel: who.channel, items: list, current: Shuffle.idsOf(list), titles: new Map(), note: '' };
      for (const it of list) sh.titles.set(it.id, it.title);
      // No original order kept yet: keep it now, before anything can change
      const last = lastOrder(), job = LS.get('shuffle:job', null);
      if (!D.doc.original) {
        if (last && last.before) saveOriginal(last.before, last.at);
        else if (job && job.before) saveOriginal(job.before, job.at);
        else { saveOriginal(sh.current, Date.now()); sh.savedNow = true; }
      }
      if (job && job.target) {
        if (!Shuffle.sameSongs(sh.current, job.target)) { LS.set('shuffle:job', null); sh.note = "An earlier shuffle didn't finish, but songs have been added or removed since, so it was set aside."; }
        else if (Shuffle.matches(sh.current, job.target)) finished(job);
        else return prepare(job.target, job.kind, job.before, job.at);
      }
      newShuffle();
    } catch (e) { shufSet('error', e.status !== undefined ? trouble(e) : `Can't shuffle: ${e.message}.`); }
  }
  function prepare(target, kind, before, resumeOf) {
    Object.assign(sh, { target, kind, before, resumeOf, moves: Shuffle.plan(sh.current, target) });
    clearTimeout(armed); armed = null;
    shufSet('ready');
  }
  // What SomaFM calls each playlist video it has played (the most-played song linked to it): its artist, title and album
  function somaInfo() {
    const out = new Map(), most = new Map();
    if (D.playlistError || !D.items.length) return out;
    const seen = new Set();
    for (const s of rows()) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      const r = statusOf(s.key, s.artist, s.title);
      if (r.status !== 'have' || !r.item) continue;
      const n = counts.get(s.key) || 0;
      if (!most.has(r.item.id) || n > most.get(r.item.id)) { most.set(r.item.id, n); out.set(r.item.id, { artist: s.artist, title: s.title, album: s.album || '' }); }
    }
    return out;
  }
  // Spreads out favorites and versions of a song, and keeps an artist's, album's or channel's songs apart
  function newShuffle() {
    const info = somaInfo();
    const a = Shuffle.arrange(sh.items, v => info.get(v) || null, v => isFav(v), rand, v => catOf(v));
    sh.spreadCounts = { favorites: 0, versions: 0, runs: [] };
    for (const g of a.groups) {
      if (g.kind === 'favorites') sh.spreadCounts.favorites = g.members.length;
      else if (g.kind === 'category') sh.spreadCounts.runs.push(`${CAT[g.category]} ${g.maxRun}`);
      else if (g.kind === 'versions') sh.spreadCounts.versions++;
    }
    sh.favIds = new Set(); sh.catNames = new Map();
    for (const it of sh.items) { if (isFav(it.videoId)) sh.favIds.add(it.id); const c = catOf(it.videoId); if (c) sh.catNames.set(it.id, CAT[c]); }
    prepare(a.ids, 'shuffle', sh.current, 0);
  }
  function finished(job) {
    LS.set('shuffle:job', null);
    change({ shuffle: { last: { [PLAYLIST_ID]: { before: job.kind === 'undo' ? null : job.before, at: Date.now() } } } });   // null after putting it back
  }
  async function runShuffle() {
    const job = { target: sh.target, before: sh.before, kind: sh.kind, at: sh.resumeOf || Date.now() };
    if (!D.doc.original) saveOriginal(sh.before, Date.now());
    LS.set('shuffle:job', job);
    shRunning = true; shStop = false; runUnits = 0; sh.done = 0;
    shufSet('running');
    let res = null, err = null;
    try { res = await Shuffle.run(ytTry, PLAYLIST_ID, sh.items, sh.moves, progress, () => shStop); } catch (e) { err = e; }
    shRunning = false;
    const n = sh.moves.length;
    const saveRun = complete => change({ shuffle: { run: { kind: job.kind, at: Date.now(), units: runUnits, moves: err ? err.done || 0 : res.done, complete } } });
    const after = ' Nothing was lost: every song is still there, partly in the new order. Open Shuffle again to finish.';
    if (err || res.stopped) saveRun(false);
    if (err) return shufSet('error', `${trouble(err)} ${fmt(err.done || 0)} of ${fmt(n)} moves were made.` + after);
    if (res.stopped) return shufSet('error', `Stopped after ${fmt(res.done)} of ${fmt(n)} moves.` + after);
    shufSet('loading', 'Checking the new order…');
    try {
      // Right after the last move, a read can still show an older order for a moment, so it looks twice more before saying so
      let list = await Shuffle.readItems(ytTry, PLAYLIST_ID);
      for (let i = 0; i < READBACK_WAITS.length && !Shuffle.matches(Shuffle.idsOf(list), sh.target); i++) { await sleep(READBACK_WAITS[i]); list = await Shuffle.readItems(ytTry, PLAYLIST_ID); }
      saveRun(true);
      if (!Shuffle.matches(Shuffle.idsOf(list), sh.target)) return shufSet('error', 'All the moves were made, but the playlist read back in a different order than planned. Nothing was lost. Open Shuffle again and it will plan the remaining moves.');
      finished(job);
      shufSet('done');
    } catch (e) { saveRun(true); shufSet('error', `${trouble(e)} The moves were all made, but the new order couldn't be checked. Open Shuffle again to check it.`); }
  }
  function progress(k, n) {
    sh.done = k;
    const bar = $('#shbar'), t = $('#shprog');
    if (bar) { bar.firstElementChild.style.width = (k / n * 100) + '%'; bar.setAttribute('aria-valuenow', String(k)); }
    if (t) t.textContent = `Moved ${fmt(k)} of ${fmt(n)}` + (shStop ? ' — stopping…' : '');
  }
  const SHACT = {
    shSignIn() { signIn(); },
    // Kept on the server: signing out asks Google to revoke the permission, for every device
    shSignOut() {
      if (!D.keepsSignIn) { LS.set('signin:token', null); return shufSet('signin'); }
      return busy(async () => {
        try { await api('/youtube/disconnect', { method: 'POST', body: {} }); LS.set('signin:token', null); sh.channel = ''; shufSet('signin'); toast('Signed out of Google on all your devices.'); }
        catch (e) { toast(`Couldn't sign out (${e.message}).`); }
      });
    },
    shCancelWait() { clearInterval(shWait); shWait = null; shufSet('signin'); },
    shStart() { shufStart(); },
    shNew() { newShuffle(); },
    shNewInstead() { LS.set('shuffle:job', null); newShuffle(); },
    shEarlier() { const l = lastOrder(); if (l && l.before) prepare(l.before, 'undo', sh.current, 0); },
    shOriginal() {
      const o = D.doc.original; if (!o) return;
      const ids = o.songs.map(s => s.id), now = new Set(sh.current);
      let removed = 0; for (const id of ids) if (!now.has(id)) removed++;
      sh.removed = removed; sh.added = sh.current.length - (ids.length - removed);
      prepare(Shuffle.restoreOrder(ids, sh.current), 'original', sh.current, 0);
    },
    shDownload() { downloadOriginal(); },
    shGo(el) {
      if (!sh.moves || !sh.moves.length) return;
      if (!armed) { el.textContent = 'Tap again to start'; armed = setTimeout(() => { armed = null; if (el.isConnected) el.textContent = sh.resumeOf ? 'Finish it' : KINDS[sh.kind].go; }, 5000); return; }
      clearTimeout(armed); armed = null; runShuffle();
    },
    shStop() { shStop = true; const t = $('#shprog'); if (t) t.textContent += ' — stopping…'; },
  };
  function quotaBox() {
    const used = usedToday(), left = Math.max(0, Shuffle.DAILY_UNITS - used), r = resetMins(), run = D.doc.shuffle.run, last = lastOrder();
    const until = r >= 60 ? `${Math.floor(r / 60)} h ${r % 60} min` : `${r} min`;
    const what = run ? (run.kind === 'shuffle' ? 'Last shuffle' : KINDS[run.kind] ? KINDS[run.kind].name : 'Last run') : '';
    return `<div class="box"><h4>Quota today</h4><div class="meter" role="progressbar" aria-label="Quota used today" aria-valuemin="0" aria-valuemax="${Shuffle.DAILY_UNITS}" aria-valuenow="${Math.min(used, Shuffle.DAILY_UNITS)}"><i style="width:${Math.min(100, used / Shuffle.DAILY_UNITS * 100)}%"></i></div>
      <div class="kv"><span>Left today (all your devices)</span><b>about ${fmt(left)} of ${fmt(Shuffle.DAILY_UNITS)}</b></div><div class="kv"><span>Resets</span><b>midnight Pacific · in ${until} <span class="nw">(${esc(quotaReset())})</span></b></div>
      ${run ? `<div class="kv"><span>${esc(what)}</span><b>${esc(when(run.at / 1000))}</b></div><div class="kv"><span>It used</span><b>about ${fmt(run.units)} units · ${plural(run.moves, 'move')}${run.complete ? '' : ' · stopped partway'}</b></div>` : ''}
      ${last ? `<div class="kv"><span>Order last changed</span><b>${esc(when(last.at / 1000))}</b></div>` : ''}
      <div class="kv"><span>Google's own count</span><a class="pill" href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" rel="noopener">Cloud Console</a></div>
      <div class="snote">Counted by this site on all your devices, so it doesn't include other apps using the same Google project. Google's own count is a few minutes behind.</div></div>`;
  }
  function shufView() {
    const v = SH.view, m = SH.msg, n = D.items.length;
    const say = (t, cls) => t ? `<div class="msg ${cls || ''}">${esc(t)}</div>` : '';
    let main = '';
    if (v === 'signin' || v === 'idle') {
      main = `<div class="box"><h4>Shuffle ${PLAYLIST_NAME}${n ? ` (${fmt(n)} songs)` : ''}</h4>${say(m, 'err')}<span class="k">Sign in with the Google account that owns ${PLAYLIST_NAME}.${D.keepsSignIn ? ' It stays signed in on all your devices until you sign out.' : ''}</span>
        <div class="btns"><button class="big-btn" data-act="shSignIn">Sign in with Google</button></div></div>`;
    } else if (v === 'waiting') {
      main = `<div class="box"><h4>Signing in</h4><div class="sline">Finish signing in in the Google window…</div><div class="btns"><button class="big-btn alt" data-act="shCancelWait">Cancel</button></div></div>`;
    } else if (v === 'loading') {
      main = `<div class="box"><div class="sline">${esc(m || 'Working…')}</div></div>`;
    } else if (v === 'ready') {
      const total = sh.current.length, mv = sh.moves.length, u = Shuffle.units(mv), K = KINDS[sh.kind], sc = sh.kind === 'shuffle' && !sh.resumeOf && sh.spreadCounts;
      const lines = [];
      for (let i = 0; i < Math.min(12, total); i++) {
        const cn = sh.catNames && sh.catNames.get(sh.target[i]);
        lines.push(`<li>${sh.favIds && sh.favIds.has(sh.target[i]) ? '★ ' : ''}${esc(sh.titles.get(sh.target[i]) || '?')}${cn ? `<span class="k"> · ${esc(cn)}</span>` : ''}</li>`);
      }
      let spread = '';
      if (sc) {
        const parts = [];
        if (sc.favorites) parts.push(`your ${fmt(sc.favorites)} favorites`);
        if (sc.versions) parts.push(`the versions of ${plural(sc.versions, 'song')} you have more than once`);
        spread = (parts.length ? 'Spread out evenly: ' + parts.join(' and ') + '. ' : '') + (sh.favIds.size ? 'A favorite is one of the first three songs. ' : '') +
          'Songs by the same artist, from the same album or posted by the same channel are kept apart. ' + (sc.runs.length ? `Most in a row from one category: ${sc.runs.join(', ')}. ` : '') + 'The rest is random.' +
          (sh.favIds.size ? '' : ' Tap ☆ on a song to make it a favorite.');
      }
      const label = sh.resumeOf ? 'Finish it' : K.go;
      main = `<div class="box">${say(sh.note)}<h4>${sh.resumeOf ? 'Unfinished' : esc(K.head)}</h4>
        <span class="k">${sh.resumeOf ? `${esc(K.name)} started ${esc(when(sh.resumeOf / 1000))} didn't finish. Finishing takes ${plural(mv, 'more move')}, about ${fmt(u)} quota units.`
          : `${fmt(total)} songs. Putting them in this order takes ${plural(mv, 'move')}, about ${fmt(u)} quota units.`}</span>
        ${sh.kind === 'original' && (sh.added || sh.removed) ? `<div class="snote">${[sh.added ? `${plural(sh.added, 'song')} added since go at the end.` : '', sh.removed ? `${fmt(sh.removed)} removed since ${sh.removed === 1 ? 'is' : 'are'} skipped.` : ''].filter(Boolean).join(' ')}</div>` : ''}
        ${usedToday() + u > Shuffle.DAILY_UNITS ? say(`That's more than today's quota has left, so it will stop partway. Open Shuffle again after midnight Pacific (${quotaReset()} your time) to finish.`, 'err') : ''}
        <ol class="shlist">${lines.join('')}</ol>${total > 12 ? `<div class="snote">…and ${fmt(total - 12)} more.</div>` : ''}
        ${spread ? `<div class="snote">${esc(spread)}</div>` : ''}${mv ? '' : '<div class="snote">The playlist is already in this order.</div>'}
        <div class="btns"><button class="big-btn" data-act="shGo" ${mv ? '' : 'disabled'}>${esc(label)}</button>
        ${sh.resumeOf ? '<button class="big-btn alt" data-act="shNewInstead">Start a new shuffle instead</button>' : `<button class="big-btn alt" data-act="shNew">${sh.kind === 'shuffle' ? 'Plan a new order' : 'Back to a new shuffle'}</button>`}
        ${!sh.resumeOf && sh.kind === 'shuffle' && lastOrder() && lastOrder().before && Shuffle.sameSongs(sh.current, lastOrder().before) && !Shuffle.matches(sh.current, lastOrder().before) ? '<button class="big-btn alt" data-act="shEarlier">Show the earlier order</button>' : ''}
        ${!sh.resumeOf && sh.kind !== 'original' && D.doc.original ? '<button class="big-btn alt" data-act="shOriginal">Put back the original order</button>' : ''}</div>
        <div class="snote">Signed in as ${esc(sh.channel)}.</div></div>`;
    } else if (v === 'running') {
      const total = sh.moves.length, k = sh.done || 0;
      main = `<div class="box"><h4>${esc(KINDS[sh.kind].run)}</h4><div class="meter" id="shbar" role="progressbar" aria-label="Songs moved" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${k}"><i style="width:${total ? k / total * 100 : 0}%"></i></div>
        <div class="snote" id="shprog">Moved ${fmt(k)} of ${fmt(total)}${shStop ? ' — stopping…' : ''}</div><div class="snote">Keep this page open until it finishes. If it's interrupted, Shuffle picks up where it stopped.</div>
        <div class="btns"><button class="big-btn alt" data-act="shStop">Stop</button></div></div>`;
    } else if (v === 'done') {
      main = `<div class="box">${say(KINDS[sh.kind].done, 'ok')}<div class="snote">The YouTube app may take a few minutes to show the new order.</div><div class="btns"><button class="big-btn alt" data-act="shStart">Shuffle again</button></div></div>`;
    } else {
      main = `<div class="box">${say(m, 'err')}<div class="btns"><button class="big-btn" data-act="${validToken() || D.keepsSignIn ? 'shStart' : 'shSignIn'}">${validToken() || D.keepsSignIn ? 'Try again' : 'Sign in again'}</button></div></div>`;
    }
    const o = D.doc.original;
    const extra = `<div class="box" style="margin-top:12px">${o ? `<div class="kv btnrow"><span>Original order, saved ${esc(when(o.at / 1000))} (${fmt(o.songs.length)} songs)</span><span><button class="pill" data-act="shDownload">Download (CSV)</button></span></div>` : '<div class="kv"><span>Original order</span><span class="r">not saved yet: it is kept when you first open a shuffle</span></div>'}
      ${sh.savedNow ? '<div class="snote">Saved just now from the playlist as it is.</div>' : ''}
      ${(validToken() || (D.keepsSignIn && sh.channel)) && v !== 'running' && v !== 'signin' ? `<div class="kv btnrow"><span>Signed in with Google${D.keepsSignIn ? ' on all your devices' : ''}</span><span><button class="pill" data-act="shSignOut">Sign out</button></span></div>` : ''}</div>`;
    return head('Reorder your YouTube playlist') + `<div class="split"><div>${main}${extra}</div><div>${quotaBox()}<p class="foot" style="text-align:left">Play the playlist with YouTube's shuffle off. Its sort setting in YouTube must stay on Manual, or YouTube shows it in another order.</p></div></div>`;
  }

  /* ---------- Start ---------- */
  readAddress();
  render();
  if (!OWN_DOMAIN) frameSetup();
  castSetup();
  loadConfig();
  (async () => {
    // The plays and the document first (so the page can show something), then the playlist and what's playing.
    // SomaFM's list is asked for at once: reading it records the latest plays on the server, so the plays are read again
    // right after it. The stored plays are only as new as the recorder's last 10-minute look, and without this the page
    // started up to 10 minutes behind until the first live update a minute later (Dan, Nov 6).
    const feedReq = api(`/feed?channel=${CHANNEL}`);
    feedReq.catch(() => {});
    await Promise.all([loadState(), loadPlays()]);
    if (!D.loaded.state) stateReady(false);
    render();
    await Promise.all([loadPlaylist(false), loadFeed(feedReq).then(loadPlays).then(() => render())]);
    render();
    if (view === 'shuffle') shufOpen();
    schedule();
  })();
})();
