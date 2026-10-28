// ==UserScript==
// @name         SomaFM → Xmas Mixed checker
// @namespace    https://somafm.com/
// @version      3.17.3
// @description  Checks SomaFM's song history against your YouTube playlist, records every play with stats, and can shuffle the playlist itself.
// @homepageURL  https://github.com/ZamulaK/Scripts/tree/main/soma-fm
// @updateURL    https://raw.githubusercontent.com/ZamulaK/Scripts/main/soma-fm/soma-xmas-checker.user.js
// @downloadURL  https://raw.githubusercontent.com/ZamulaK/Scripts/main/soma-fm/soma-xmas-checker.user.js
// @match        https://somafm.com/*/songhistory.html
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_listValues
// @grant        unsafeWindow
// @connect      www.youtube.com
// @connect      m.youtube.com
// @connect      youtube.com
// @run-at       document-idle
// ==/UserScript==

/* ---------- Settings ---------- */
const PLAYLIST_ID = 'PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt';
const PLAYLIST_NAME = 'Xmas Mixed';
const CACHE_MINUTES = 15;          // re-read the playlist at most this often (Refresh button forces it)
const CACHE_SCHEMA = 3;            // bump when the saved playlist's meaning changes, so old copies are re-read
const LIVE_SECONDS = 60;           // when live updates are on, re-check the song history this often
const HISTORY_MAX = 10000;         // plays kept on this device (about 3½ weeks of round-the-clock listening, ~1 MB)
const PAGE_SIZES = [25, 50, 100, 200];
// Shuffling the real playlist: Google sends sign-ins back here. It must match the OAuth client's redirect URI exactly.
const SIGNIN_RETURN = 'https://somafm.com/christmas/songhistory.html';
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';   // manage your YouTube playlists

/* ---------- Matching (pure; tested by soma-xmas-checker.test.js) ---------- */
const Matcher = (() => {
  const STOP = new Set(['the', 'a', 'an', 'and', 'of']);
  // Words that describe a mix generically and don't identify which mix it is
  const GENERIC_MIX = new Set(['mix', 'remix', 'edit', 'version', 'rework', 'reworked', 'original',
    'extended', 'radio', 'club', 'the', 'a', 'and', 'of', 'feat', 'ft', 'featuring', 'vs']);
  const ENSEMBLE = new Set(['trio', 'quartet', 'quintet', 'sextet', 'septet', 'octet', 'orchestra', 'band', 'group',
    'ensemble', 'combo', 'singers', 'chorus', 'choir', 'his', 'her', 'their']);
  const MIX_RE = /\b(re)?mix\b|\bedit\b|\bdub\b|\brework/i;

  // Plain loops instead of Array.from / some / every / map / find: SomaFM's page loads
  // prototype.js, which replaces those built-ins (Array.from with a broken version).
  function anyOf(arr, fn) { for (let i = 0; i < arr.length; i++) if (fn(arr[i], i)) return true; return false; }
  function allOf(arr, fn) { for (let i = 0; i < arr.length; i++) if (!fn(arr[i], i)) return false; return true; }
  function mapOf(arr, fn) { const out = []; for (let i = 0; i < arr.length; i++) out.push(fn(arr[i], i)); return out; }
  function keep(arr, fn) { const out = []; for (let i = 0; i < arr.length; i++) if (fn(arr[i], i)) out.push(arr[i]); return out; }

  function norm(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  const toks = s => keep(norm(s).split(' '), Boolean);
  const content = arr => keep(arr, t => !STOP.has(t));

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Exact, or a one-letter typo for words of 5+ letters (catches "Ruldolph", "Marshmellow")
  const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
  const has = (tok, list) => anyOf(list, t => same(tok, t));
  // Singular vs plural ("beat" ~ "beats"); only used for near-miss titles, which need the same artist
  const plural = (a, b) => a.length >= 3 && b.length >= 3 && (a + 's' === b || b + 's' === a);

  // Leading words a title often gains or loses ("It's A Marshmallow World" vs "Marshmallow World",
  // "Oh Holy Night" vs "O Holy Night"); tried only when the full title doesn't match
  const OPTIONAL_LEAD = new Set(['its', 'oh', 'o']);
  function titlePhrases(core) {
    const out = [core];
    let i = 0;
    while (i < core.length - 1 && OPTIONAL_LEAD.has(core[i])) i++;
    if (i > 0) out.push(core.slice(i));
    return out;
  }

  // SomaFM cuts titles and artists off at 63 characters, so the last word may be a fragment ("Re")
  const SOMA_MAX = 63;
  const cutOff = s => String(s || '').length >= SOMA_MAX;
  // Words must appear in order. With allowSkip (used only when the artist also matches), longer titles get
  // two allowances: a word may differ only by a plural "s" ("Jingle Beats" ~ "Jingle Beat"), and a single word inside the title
  // may be missing on either side ("We Wish You A Merry Christmas" ~ "We Wish You A Very Merry Christmas").
  //  - a word missing from SomaFM's title: only when SomaFM's title has 3+ words, so every word still matches
  //  - an extra word in SomaFM's title: only when it has 4+ words, so at least 3 still match
  // The first and last words always have to match.
  // With prefixLast, the final word may match the start of a longer word ("re" ~ "reindeer");
  // a one-letter fragment counts only after at least two other words.
  function alignAt(phrase, list, start, prefixLast, allowSkip) {
    const last = phrase.length - 1;
    const canSkipList = allowSkip && phrase.length >= 3, canSkipPhrase = allowSkip && phrase.length >= 4;
    const eq = (k, j) => j < list.length && (same(phrase[k], list[j]) || (allowSkip && plural(phrase[k], list[j])) ||
      (prefixLast && k === last && (phrase[k].length >= 2 || phrase.length >= 3) && list[j].indexOf(phrase[k]) === 0));
    function go(k, j, skip) {
      if (k > last) return true;
      if (eq(k, j) && go(k + 1, j + 1, skip)) return true;
      if (skip && k > 0) {
        if (canSkipList && eq(k, j + 1) && go(k + 1, j + 2, false)) return true;    // extra word in your title
        if (canSkipPhrase && k < last && go(k + 1, j, false)) return true;          // extra word in SomaFM's title
      }
      return false;
    }
    return go(0, start, true);
  }
  function containsPhrase(phrase, list, prefixLast, allowSkip) {
    if (!phrase.length) return false;
    for (let i = 0; i < list.length; i++) if (alignAt(phrase, list, i, prefixLast, allowSkip)) return true;
    return false;
  }

  // Pull "(...)" / "[...]" chunks that describe a mix
  function mixParts(s) {
    const out = [];
    // A bracket left open by SomaFM's cutoff ("[Rudolph the Red-Nosed Re") counts as a bracket too
    String(s || '').replace(/[([]([^)\]]*)(?:[)\]]|$)/g, (_, inner) => { if (MIX_RE.test(inner)) out.push(inner); return ''; });
    return out;
  }
  const stripBrackets = s => String(s || '').replace(/[([][^)\]]*(?:[)\]]|$)/g, ' ');

  function parseSoma(artist, title) {
    const core = content(toks(stripBrackets(title)));
    const mixText = mixParts(title).concat(mixParts(artist)).join(' ');
    const mixTokens = keep(toks(mixText), t => !GENERIC_MIX.has(t));
    // "Trio", "Orchestra", "His Band" etc. are optional: "Vince Guaraldi Trio" ~ "Vince Guaraldi".
    // A name made only of such words ("His Orchestra") is dropped.
    const artistNames = keep(mapOf(stripBrackets(artist)
      .split(/\s*(?:&|,|\/|\bfeat\.?|\bfeaturing\b|\bft\.?|\band\b|\bwith\b|\bvs\.?)\s*/i),
      p => keep(content(toks(p)), t => !ENSEMBLE.has(t))), p => p.length);
    // An open bracket at the cutoff was stripped whole, so only an unbracketed cut-off word is a fragment
    const titleCut = cutOff(title) && !/[([][^)\]]*$/.test(title);
    return { core, hasMix: mixText.length > 0, mixTokens, artistNames, primary: artistNames[0] || [],
      titleCut, artistCut: cutOff(artist) };
  }

  function parseItem(item) {
    const channel = String(item.ch || '').replace(/\s*-\s*Topic\s*$/i, '');
    const titleToks = content(toks(item.title));
    const all = content(toks(item.title + ' ' + channel));
    const mixText = mixParts(item.title).join(' ') || (/\bremix\b|\bmix\b/i.test(item.title) ? 'mix' : '');
    return { titleToks, all, hasMix: mixText.length > 0, mixTokens: keep(toks(mixText), t => !GENERIC_MIX.has(t)) };
  }

  // status: 'have' | 'other' | 'none'
  function check(artist, title, items) {
    const s = parseSoma(artist, title);
    let best = null;
    const rank = { have: 3, sameArtistOtherMix: 2, otherArtist: 1 };
    const phrases = titlePhrases(s.core);
    const lastName = s.artistNames.length - 1;
    for (let n = 0; n < items.length; n++) {
      const item = items[n];
      const p = parseItem(item);
      const exact = anyOf(phrases, ph => containsPhrase(ph, p.titleToks, s.titleCut, false));
      if (!exact && !anyOf(phrases, ph => containsPhrase(ph, p.titleToks, s.titleCut, true))) continue;
      const artistOk = anyOf(s.artistNames, (a, n) => allOf(a, (t, k) => has(t, p.all) ||
        (s.artistCut && n === lastName && k === a.length - 1 && t.length >= 2 && anyOf(p.all, x => x.indexOf(t) === 0))));
      if (!exact && !artistOk) continue;   // a near-miss title only counts for the same artist
      let kind;
      if (!artistOk) kind = 'otherArtist';
      else if (s.hasMix) {
        const hit = keep(s.mixTokens, t => has(t, p.all)).length;
        kind = (s.mixTokens.length ? hit * 2 >= s.mixTokens.length : p.hasMix) ? 'have' : 'sameArtistOtherMix';
      } else kind = p.hasMix ? 'sameArtistOtherMix' : 'have';
      const score = rank[kind] * 2 + (exact ? 1 : 0);   // at the same rank, an exact title beats a near-miss
      if (!best || score > best.score) best = { kind, item, score };
      if (kind === 'have' && exact) break;
    }
    if (!best) return { status: 'none' };
    return { status: best.kind === 'have' ? 'have' : 'other', reason: best.kind, item: best.item };
  }

  // YouTube search text: main artist, the title (bracket text kept as plain words), and any mix or
  // remix credited in the artist field ("Joe Williams (Bombay Dub Orchestra Remix)")
  function searchQuery(artist, title) {
    const primary = stripBrackets(artist).split(/\s*(?:&|,|\/|\bfeat\.?|\bfeaturing\b)\s*/i)[0].trim();
    const parts = [primary, String(title || '').replace(/[()[\]]/g, ' ')].concat(mixParts(artist));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Key for songs you mark by hand: ignores case, accents and punctuation
  const markKey = (artist, title) => norm(artist) + '|' + norm(title);

  // What a stored hand-mark says: 'have', 'not', or null. Version 1.x stored a bare timestamp,
  // which meant "in playlist".
  function markValue(stored) {
    if (typeof stored === 'number') return 'have';
    if (stored && (stored.v === 'have' || stored.v === 'not')) return stored.v;
    return null;
  }
  // Your mark overrides the automatic result; the closest playlist match is kept for "Open".
  // A dislike (kept separately) applies only to songs that end up "not in playlist"; if the song
  // later shows up in your playlist, that wins.
  // A "have" mark can be linked to a specific playlist video (stored.id). The link wins over the
  // automatic match; if that video has left the playlist, the card says so (linkMissing) instead of
  // pointing at something else.
  function applyMark(result, stored, disliked, items) {
    const v = markValue(stored);
    let r = result;
    const linkId = v === 'have' && stored && typeof stored === 'object' && stored.id ? String(stored.id) : '';
    if (linkId) {
      let found = null;
      for (let i = 0; items && i < items.length; i++) if (items[i].id === linkId) { found = items[i]; break; }
      r = found ? { status: 'have', marked: 'have', linked: true, item: found }
                : { status: 'have', marked: 'have', linkMissing: true, linkId, item: null };
    } else if (v === 'have' && r.status !== 'have') r = Object.assign({}, r, { status: 'have', marked: 'have' });
    else if (v === 'not' && r.status !== 'none') r = Object.assign({}, r, { status: 'none', marked: 'not' });
    if (disliked && r.status === 'none') r = Object.assign({}, r, { status: 'disliked', disliked: true });
    return r;
  }

  // Deleted, private or blocked videos: YouTube hides them from viewers but may list them for the owner
  function isUnavailable(v, title) {
    return v.isPlayable === false || !!v.unplayableText || !v.lengthSeconds ||
      /^\[(deleted|private|unavailable)( video)?\]$/i.test(String(title).trim());
  }

  // Playlist songs most like a SomaFM play, for linking a hand-mark: shared title words count double,
  // shared artist words once; ties keep playlist order. Only songs sharing at least one word are returned.
  // Filler words that would make unrelated songs look alike ("'Zat You Santa Claus" vs "What Are You Doing…")
  const FILLER = new Set(['you', 'your', 'i', 'me', 'my', 'we', 'our', 'is', 'it', 'its', 'in', 'on', 'to', 'for',
    'be', 'all', 'this', 'that', 'with', 'are', 'what', 'do', 'im', 'ill', 'when', 'from', 'at']);
  function suggest(artist, title, items, n) {
    const tWords = keep(content(toks(stripBrackets(title))), t => !FILLER.has(t));
    const aWords = keep(content(toks(stripBrackets(artist))), t => !FILLER.has(t));
    const scored = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const all = content(toks(it.title + ' ' + String(it.ch || '').replace(/\s*-\s*Topic\s*$/i, '')));
      let score = 0;
      for (let k = 0; k < tWords.length; k++) if (has(tWords[k], all)) score += 2;
      for (let k = 0; k < aWords.length; k++) if (has(aWords[k], all)) score += 1;
      if (score > 0) scored.push({ score, i, it });
    }
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return mapOf(scored.slice(0, n), x => x.it);
  }
  // Every typed word must start a word in the playlist title or channel ("jack jo" finds Jack Jones)
  function searchItems(query, items, limit) {
    const q = toks(query);
    if (!q.length) return [];
    const out = [];
    for (let i = 0; i < items.length && out.length < limit; i++) {
      const words = toks(items[i].title + ' ' + (items[i].ch || ''));
      if (allOf(q, w => anyOf(words, x => x.indexOf(w) === 0))) out.push(items[i]);
    }
    return out;
  }

  // A song title's words for comparing versions: bracket text, years, video words and a leading "It's"/"Oh"/"O" left out
  const VIDEO_WORDS = new Set(['official', 'video', 'audio', 'lyrics', 'lyric', 'hd', 'hq', '4k', 'uhd', 'flac', 'mp3', 'remastered', 'remaster']);
  function titleWords(t) {
    const w = keep(content(toks(stripBrackets(t))), x => !VIDEO_WORDS.has(x) && !/^(19|20)\d\d$/.test(x));
    const p = titlePhrases(w);
    return p[p.length - 1];
  }
  // Two titles name the same song: the same words apart from one-letter typos, a plural "s", or one
  // extra word on either side ("We Wish You A Merry Christmas" ~ "We Wish You A Very Merry Christmas")
  function sameTitle(a, b) {
    if (!a.length || !b.length || Math.abs(a.length - b.length) > 1) return false;
    if (a.length === 1 || b.length === 1) return a.length === b.length && same(a[0], b[0]);
    return alignAt(a, b, 0, false, true) && alignAt(b, a, 0, false, true);
  }

  return { check, searchQuery, norm, parseSoma, anyOf, mapOf, keep, markKey, markValue, applyMark, isUnavailable, suggest, searchItems,
    stripBrackets, titleWords, sameTitle };
})();

/* ---------- Play history (pure; tested by soma-xmas-checker.test.js) ---------- */
// A play is [at, artist, title, album, afterGap]: at = unix seconds; afterGap = 1 on the first play
// recorded after a stretch the page wasn't open for. Lists are newest first.
const History = (() => {
  const isBreak = (artist, title) => /station id/i.test(title) || /station id/i.test(artist) || /^\s*break\s*$/i.test(artist);

  // A play dated more than this past "now" can't be real. On Oct 27, 2026 SomaFM's feed briefly dated an
  // hour of plays a day ahead; saved, they hid every real play after them (merge only adds newer plays).
  const FUTURE_SLACK = 15 * 60;
  // The feed lists about the last hour, so every play in it should fall within this window before "now"
  const FEED_BACK = 6 * 3600;
  const DAY = 86400;

  // A feed date outside [now - FEED_BACK, now + FUTURE_SLACK] moved by whole days into it (the Oct 27 glitch
  // had the right time of day on the wrong day); null when no whole-day move fits, since then the time is wrong too
  function fixDate(at, now) {
    const lo = now - FEED_BACK, hi = now + FUTURE_SLACK;
    if (at >= lo && at <= hi) return at;
    const moved = at + Math.ceil((lo - at) / DAY) * DAY;   // the earliest whole-day move that reaches lo
    return moved <= hi ? moved : null;
  }

  // SomaFM feed rows -> plays, newest first; station IDs and rows without a time are dropped. Given now,
  // a misdated play gets its date fixed (fixDate), or is dropped when it can't be.
  function fromFeed(songs, now) {
    const out = [];
    const list = songs || [];
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      if (!x || !x.artist || !x.title) continue;
      let at = Number(x.date);
      if (!isFinite(at) || at <= 0 || isBreak(String(x.artist), String(x.title))) continue;
      if (now) { at = fixDate(at, now); if (at === null) continue; }
      out.push([at, String(x.artist), String(x.title), String(x.album || '')]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out;
  }

  // Start times of station IDs and breaks in the feed, newest first. Never shown; they only end the song before them.
  function breaksFromFeed(songs, now) {
    const out = [];
    const list = songs || [];
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      if (!x || !isBreak(String(x.artist || ''), String(x.title || ''))) continue;
      let at = Number(x.date);
      if (!isFinite(at) || at <= 0) continue;
      if (now) { at = fixDate(at, now); if (at === null) continue; }
      out.push(at);
    }
    return out.sort((a, b) => b - a);
  }
  // Saved break times plus new ones, newest first, no repeats, at most max; the same list back when nothing is new
  function mergeBreaks(stored, fetched, max) {
    const seen = new Set(stored);
    const fresh = Matcher.keep(fetched, t => !seen.has(t));
    if (!fresh.length) return stored;
    const all = stored.concat(fresh).sort((a, b) => b - a);
    return all.length > max ? all.slice(0, max) : all;
  }

  // How long each song ran on SomaFM: from its start to the next song or break. Plays whose end wasn't
  // recorded (the newest, or before a recording gap) and implausible spans are skipped. Per song key, the
  // median of its measured plays, so one odd span (a missed break) doesn't skew it. plays newest first.
  const LEN_MIN = 20, LEN_MAX = 20 * 60;
  function measuredLengths(plays, breaks, keyOf) {
    const spans = new Map();
    const br = (breaks || []).slice().sort((a, b) => a - b);   // oldest first, to walk alongside the plays
    let b = 0;
    for (let i = plays.length - 1; i >= 1; i--) {               // oldest play first; plays[i - 1] is the next one
      const at = plays[i][0], next = plays[i - 1];
      if (next[4]) continue;                                    // a recording gap before the next play
      while (b < br.length && br[b] <= at) b++;
      const end = b < br.length && br[b] < next[0] ? br[b] : next[0];
      const len = end - at;
      if (len < LEN_MIN || len > LEN_MAX) continue;
      const k = keyOf(plays[i][1], plays[i][2]);
      const l = spans.get(k);
      if (l) l.push(len); else spans.set(k, [len]);
    }
    const out = new Map();
    spans.forEach((l, k) => {
      l.sort((x, y) => x - y);
      const m = l.length >> 1;
      out.set(k, l.length % 2 ? l[m] : Math.round((l[m - 1] + l[m]) / 2));
    });
    return out;
  }

  // Saved plays dated in the future removed (see FUTURE_SLACK); the same list back when there are none
  function dropFuture(plays, now) {
    const out = Matcher.keep(plays, p => !(p[0] > now + FUTURE_SLACK));
    return out.length === plays.length ? plays : out;
  }

  // Add newly fetched plays to the stored list. If the fetch no longer reaches back to the newest stored
  // play, plays in between were missed: the oldest new play is flagged afterGap.
  function merge(stored, fetched, max) {
    const newest = stored.length ? stored[0][0] : null;
    const fresh = [];
    for (let i = 0; i < fetched.length; i++) {
      const p = fetched[i];
      if (newest === null || p[0] > newest) fresh.push(p.slice(0, 4));
      else if (p[0] === newest && !(p[1] === stored[0][1] && p[2] === stored[0][2])) fresh.push(p.slice(0, 4));
    }
    if (!fresh.length) return { plays: stored, added: 0, gap: false };
    const oldestFetched = fetched[fetched.length - 1][0];
    const gap = newest !== null && oldestFetched > newest;
    if (gap) fresh[fresh.length - 1].push(1);
    let plays = fresh.concat(stored);
    if (plays.length > max) plays = plays.slice(0, max);
    return { plays, added: fresh.length, gap };
  }

  const pad = n => (n < 10 ? '0' : '') + n;
  // m/d/yy, local time
  function formatDate(sec) {
    const d = new Date(sec * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(-2);
  }
  function formatTime(sec) {
    const d = new Date(sec * 1000);
    const h = d.getHours();
    return ((h % 12) || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  const csvCell = v => { const t = String(v == null ? '' : v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  // Oldest first, for spreadsheets. statusLabel(artist, title) gives the playlist status text.
  function toCSV(plays, statusLabel) {
    const lines = ['Date,Time,Artist,Title,Album,Playlist status,After gap'];
    for (let i = plays.length - 1; i >= 0; i--) {
      const p = plays[i];
      const cells = [formatDate(p[0]), formatTime(p[0]), p[1], p[2], p[3], statusLabel(p[1], p[2]), p[4] ? 'yes' : ''];
      let line = '';
      for (let k = 0; k < cells.length; k++) line += (k ? ',' : '') + csvCell(cells[k]);
      lines.push(line);
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  // How many playlist songs have been heard. Automatic matches and linked marks count; an unlinked
  // hand-mark doesn't say which playlist video it is. results = match results for the recorded plays; items = current playlist.
  function coverage(results, items) {
    const inPlaylist = new Set();
    for (let i = 0; i < items.length; i++) inPlaylist.add(items[i].id);
    const heard = new Set();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'have' && (!r.marked || r.linked) && r.item && inPlaylist.has(r.item.id)) heard.add(r.item.id);
    }
    return { heard: heard.size, total: inPlaylist.size };
  }

  // Total and average length of the playlist; songs YouTube gave no length for are counted separately
  function lengthStats(items) {
    let total = 0, known = 0;
    for (let i = 0; i < items.length; i++) { const t = Number(items[i].secs) || 0; if (t > 0) { total += t; known++; } }
    return { total, known, unknown: items.length - known, avg: known ? Math.round(total / known) : 0 };
  }
  // 20520 -> "5 h 42 min"; under an hour -> "42 min"
  function formatTotal(secs) {
    const mins = Math.round(secs / 60), h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h} h ${m} min` : `${m} min`;
  }
  // 203 -> "3:23"; 3725 -> "1:02:05"
  function formatClock(secs) {
    const s = Math.round(secs), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(r);
  }

  return { fromFeed, fixDate, breaksFromFeed, mergeBreaks, measuredLengths, dropFuture, merge, formatDate, formatTime, toCSV, coverage, lengthStats, formatTotal, formatClock };
})();

/* ---------- Playlist memory (pure; tested by soma-xmas-checker.test.js) ---------- */
// YouTube stops showing a video's title once it's removed or made unavailable, so every song seen in
// the playlist is remembered: { [id]: { id, title, ch, first, last, gone?, dismissed? } } (times in ms).
const Archive = (() => {
  const { keep } = Matcher;

  // Record a fresh, complete playlist read. Songs no longer present are marked gone, unless so many
  // vanish at once that the read itself looks incomplete; then nothing is marked (refuse and report).
  function update(archive, items, now) {
    const next = {};
    for (const id of Object.keys(archive || {})) next[id] = Object.assign({}, archive[id]);
    const present = new Set();
    let back = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      present.add(it.id);
      const prev = next[it.id];
      if (prev && prev.gone) back++;
      next[it.id] = { id: it.id, title: it.title, ch: it.ch || '', first: prev ? prev.first : now, last: now };
    }
    const vanished = [];
    let wasPresent = 0;
    for (const id of Object.keys(next)) {
      if (present.has(id)) { wasPresent++; continue; }
      if (!next[id].gone) { vanished.push(id); wasPresent++; }
    }
    const limit = Math.max(5, Math.floor(wasPresent * 0.25));
    if (vanished.length > limit) {
      return { archive: archive || {}, gone: 0, back: 0, refused: vanished.length };
    }
    for (let i = 0; i < vanished.length; i++) next[vanished[i]].gone = now;
    return { archive: next, gone: vanished.length, back, refused: 0 };
  }

  // Gone and not dismissed, most recently gone first
  function goneList(archive) {
    const out = keep(Object.keys(archive || {}), id => archive[id].gone && !archive[id].dismissed);
    const list = [];
    for (let i = 0; i < out.length; i++) list.push(archive[out[i]]);
    list.sort((a, b) => b.gone - a.gone);
    return list;
  }

  function dismiss(archive, id, now) {
    const next = Object.assign({}, archive);
    if (next[id]) next[id] = Object.assign({}, next[id], { dismissed: now });
    return next;
  }

  // A play that's otherwise "not in playlist" but matches (same artist, same song) a video that used to
  // be in your playlist is flagged "gone", so you know it's one you liked
  function applyGone(result, artist, title, gone) {
    if (result.status !== 'none' || result.marked || result.disliked || !gone.length) return result;
    const m = Matcher.check(artist, title, gone);
    return m.status === 'have' ? Object.assign({}, result, { status: 'gone', item: m.item }) : result;
  }

  return { update, goneList, dismiss, applyGone };
})();

/* ---------- Backup and restore (pure; tested by soma-xmas-checker.test.js) ---------- */
// One file holds everything worth keeping: play history (per channel), marks and links, dislikes, favorites, categories,
// and the remembered playlist titles. Settings stay with each device.
const Backup = (() => {
  const APP = 'soma-xmas-checker', FORMAT = 1;
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const keyOf = p => p[0] + '|' + p[1] + '|' + p[2];

  function build(data, meta) {
    return Object.assign({ app: APP, format: FORMAT, exportedAt: Date.now() }, meta || {}, { data });
  }

  // Checks a parsed backup. Throws with a plain explanation if it isn't one of ours; otherwise returns
  // the cleaned data and how many malformed entries were skipped.
  function validate(obj) {
    if (!isObj(obj) || obj.app !== APP) throw new Error("this isn't a backup from this script");
    if (obj.format !== FORMAT) throw new Error(`backup format ${obj.format} isn't supported by this version (expects ${FORMAT})`);
    const d = isObj(obj.data) ? obj.data : null;
    if (!d) throw new Error('the backup has no data section');
    let skipped = 0;
    const history = {};
    for (const ch of Object.keys(isObj(d.history) ? d.history : {})) {
      const list = Array.isArray(d.history[ch]) ? d.history[ch] : [];
      const ok = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (Array.isArray(p) && typeof p[0] === 'number' && isFinite(p[0]) && typeof p[1] === 'string' && typeof p[2] === 'string') {
          const q = [p[0], p[1], p[2], typeof p[3] === 'string' ? p[3] : ''];
          if (p[4]) q.push(1);
          ok.push(q);
        } else skipped++;
      }
      ok.sort((a, b) => b[0] - a[0]);
      if (/^[a-z0-9]+$/i.test(ch)) history[ch] = ok;
    }
    const marks = {};
    for (const k of Object.keys(isObj(d.marks) ? d.marks : {})) {
      const m = d.marks[k];
      if (typeof m === 'number' || (isObj(m) && (m.v === 'have' || m.v === 'not'))) marks[k] = m; else skipped++;
    }
    const dislikes = {};
    for (const k of Object.keys(isObj(d.dislikes) ? d.dislikes : {})) {
      if (typeof d.dislikes[k] === 'number') dislikes[k] = d.dislikes[k]; else skipped++;
    }
    // Favorites: playlist video id -> { on, at }; a removed favorite is kept (on: false) so a merge doesn't bring it back
    const favorites = {};
    for (const id of Object.keys(isObj(d.favorites) ? d.favorites : {})) {
      const f = d.favorites[id];
      if (isObj(f) && typeof f.on === 'boolean' && typeof f.at === 'number') favorites[id] = { on: f.on, at: f.at }; else skipped++;
    }
    // Categories: playlist video id -> { c, at }; c is '' once a category is cleared, for the same reason
    const categories = {};
    for (const id of Object.keys(isObj(d.categories) ? d.categories : {})) {
      const f = d.categories[id];
      if (isObj(f) && typeof f.c === 'string' && typeof f.at === 'number') categories[id] = { c: f.c, at: f.at }; else skipped++;
    }
    const archive = {};
    for (const id of Object.keys(isObj(d.archive) ? d.archive : {})) {
      const e = d.archive[id];
      if (isObj(e) && typeof e.title === 'string') archive[id] = Object.assign({}, e, { id }); else skipped++;
    }
    let original = null;
    const o = d.original;
    if (isObj(o) && typeof o.at === 'number' && Array.isArray(o.songs)) {
      const songs = [];
      for (let i = 0; i < o.songs.length; i++) {
        const x = o.songs[i];
        if (isObj(x) && typeof x.id === 'string' && x.id) songs.push({ id: x.id, videoId: typeof x.videoId === 'string' ? x.videoId : '', title: typeof x.title === 'string' ? x.title : '' });
        else skipped++;
      }
      if (songs.length) original = { at: o.at, playlistId: typeof o.playlistId === 'string' ? o.playlistId : '', songs };
    } else if (o) skipped++;
    return { data: { history, marks, dislikes, favorites, categories, archive, original }, skipped, exportedAt: obj.exportedAt };
  }

  // Union of two newest-first play lists; the same play recorded on both devices is kept once.
  // A gap marker is dropped when the other device's recording filled that gap (a play within 15 minutes
  // before it), since nothing was missed there anymore.
  function mergeHistory(a, b, max) {
    const seen = new Map();
    for (const list of [a || [], b || []]) for (let i = 0; i < list.length; i++) {
      const p = list[i], k = keyOf(p);
      if (!seen.has(k)) seen.set(k, p.slice(0, 4).concat(p[4] ? [1] : []));
      else if (!p[4] && seen.get(k)[4]) seen.set(k, p.slice(0, 4));    // recorded without a gap on either device: no gap
    }
    const out = [];
    seen.forEach(p => out.push(p));
    out.sort((x, y) => y[0] - x[0]);
    for (let i = 0; i < out.length; i++) {
      if (out[i][4] && i + 1 < out.length && out[i][0] - out[i + 1][0] <= 900) out[i] = out[i].slice(0, 4);
    }
    return max && out.length > max ? out.slice(0, max) : out;
  }

  // Marks: the more recently set one wins (old timestamp-only marks count as set at that time)
  const markTime = m => typeof m === 'number' ? m : (m && m.at) || 0;
  function mergeMarks(a, b) {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b || {})) if (!(k in out) || markTime(b[k]) > markTime(out[k])) out[k] = b[k];
    return out;
  }
  function mergeDislikes(a, b) {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b || {})) out[k] = Math.max(out[k] || 0, b[k]);
    return out;
  }
  // Favorites and categories: the more recent change wins, whether it added, changed or removed one
  function mergeFavorites(a, b) {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b || {})) if (!(k in out) || b[k].at > out[k].at) out[k] = b[k];
    return out;
  }
  const mergeCategories = mergeFavorites;
  const catCount = f => { let n = 0; for (const k of Object.keys(f || {})) if (f[k] && f[k].c) n++; return n; };
  const favCount = f => { let n = 0; for (const k of Object.keys(f || {})) if (f[k] && f[k].on) n++; return n; };
  // Remembered playlist songs: newest sighting wins; "gone" only if marked gone after its last sighting anywhere
  function mergeArchive(a, b) {
    const out = {};
    const ids = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
    ids.forEach(id => {
      const x = (a || {})[id], y = (b || {})[id];
      if (!x || !y) { out[id] = Object.assign({}, x || y); return; }
      const newer = (y.last || 0) > (x.last || 0) ? y : x;
      const e = { id, title: newer.title, ch: newer.ch || '', first: Math.min(x.first || newer.last, y.first || newer.last), last: Math.max(x.last || 0, y.last || 0) };
      const gone = Math.max(x.gone || 0, y.gone || 0);
      if (gone > e.last) {
        e.gone = gone;
        const dis = Math.max(x.dismissed || 0, y.dismissed || 0);
        if (dis) e.dismissed = dis;
      }
      out[id] = e;
    });
    return out;
  }

  // The playlist's original order: the one saved earliest is the true original, so it wins
  function mergeOriginal(a, b) {
    if (!a || !b) return a || b || null;
    return b.at < a.at ? b : a;
  }

  // What importing would do, for the summary shown before anything changes
  function preview(current, incoming) {
    const plays = [], newPlays = {};
    let total = 0, added = 0, first = 0, last = 0;
    for (const ch of Object.keys(incoming.history)) {
      const list = incoming.history[ch];
      total += list.length;
      if (list.length) { last = Math.max(last, list[0][0]); first = first ? Math.min(first, list[list.length - 1][0]) : list[list.length - 1][0]; }
      const have = new Set(); for (const p of (current.history[ch] || [])) have.add(keyOf(p));
      let n = 0; for (const p of list) if (!have.has(keyOf(p))) n++;
      newPlays[ch] = n; added += n;
    }
    return { plays: total, newPlays: added, perChannel: newPlays, first, last,
      marks: Object.keys(incoming.marks).length, dislikes: Object.keys(incoming.dislikes).length, favorites: favCount(incoming.favorites), categories: catCount(incoming.categories), songs: Object.keys(incoming.archive).length,
      original: incoming.original ? incoming.original.at : 0 };
  }

  return { build, validate, mergeHistory, mergeMarks, mergeDislikes, mergeFavorites, favCount, mergeCategories, catCount, mergeArchive, mergeOriginal, preview };
})();

/* ---------- Stats panel numbers (pure; tested by soma-xmas-checker.test.js) ---------- */
const Stats = (() => {
  const { markKey, keep } = Matcher;
  const median = arr => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  // plays: newest first [at, artist, title, album, afterGap]; items: current playlist;
  // statusOf(artist, title, key) -> match result. Song identity is the same key hand-marks use.
  function compute(plays, items, statusOf) {
    const n = plays.length;
    const songs = new Map();
    for (let i = n - 1; i >= 0; i--) {           // oldest first, so "first" is the first recorded play
      const p = plays[i], key = markKey(p[1], p[2]);
      let s = songs.get(key);
      if (!s) { s = { key, artist: p[1], title: p[2], count: 0, first: p[0], last: p[0], times: [] }; songs.set(key, s); }
      s.count++; s.last = p[0]; s.times.push(p[0]);
    }
    // Time actually recorded: spans between consecutive plays, skipping gaps and anything over an hour
    let covered = 0, gaps = 0;
    for (let i = 0; i < n; i++) {
      if (plays[i][4]) gaps++;
      if (i + 1 < n && !plays[i][4]) { const d = plays[i][0] - plays[i + 1][0]; if (d > 0 && d <= 3600) covered += d; }
    }
    const list = [];
    songs.forEach(s => { s.r = statusOf(s.artist, s.title, s.key); list.push(s); });
    const byCount = (a, b) => b.count - a.count || b.last - a.last;
    // Time between replays of the same song. An interval is left out if the recording has a gap inside it:
    // a play flagged afterGap at time q means plays just before q were missed, so any interval
    // (older, newer] that contains such a q isn't a true replay interval.
    const gapTimes = [];
    for (let i = 0; i < n; i++) if (plays[i][4]) gapTimes.push(plays[i][0]);
    const spansGap = (older, newer) => { for (let g = 0; g < gapTimes.length; g++) if (gapTimes[g] > older && gapTimes[g] <= newer) return true; return false; };
    const repeatGaps = [];
    let repeatsSpanningGap = 0, gapRepeatSum = 0;
    for (let i = 0; i < list.length; i++) for (let k = 1; k < list[i].times.length; k++) {
      const older = list[i].times[k - 1], newer = list[i].times[k];
      if (spansGap(older, newer)) { repeatsSpanningGap++; gapRepeatSum += newer - older; }
      else repeatGaps.push(newer - older);
    }
    let repeatSum = 0;
    for (let i = 0; i < repeatGaps.length; i++) repeatSum += repeatGaps[i];
    // Headline estimate, counting only what was recorded: hours actually recorded x different songs / plays.
    // Gaps can't skew it, since neither the time nor any plays inside a gap are counted. (Leaving out
    // replays that span a gap would bias low, because long intervals are the ones gaps tend to fall in;
    // keeping them as measured biases high, because plays inside the gap were missed.)
    const rateRepeatSecs = n > list.length && covered ? covered * list.length / n : 0;
    // Of the most recent plays, how many were the first time that song was recorded
    const recent = Math.min(100, n);
    let firsts = 0;
    for (let i = 0; i < recent; i++) if (songs.get(markKey(plays[i][1], plays[i][2])).first === plays[i][0]) firsts++;
    const breakdown = {};
    for (let i = 0; i < list.length; i++) {
      const st = list[i].r.status;
      const b = breakdown[st] || (breakdown[st] = { songs: 0, plays: 0 });
      b.songs++; b.plays += list[i].count;
    }
    // Share of plays and of different songs in each group; the four groups add up to 100%
    const GROUPS = { have: ['have'], other: ['other'], missing: ['none', 'gone'], disliked: ['disliked'] };
    const shares = {};
    let labeledPlays = 0, labeledSongs = 0;
    for (const g in GROUPS) {
      let pl = 0, so = 0;
      for (const k of GROUPS[g]) if (breakdown[k]) { pl += breakdown[k].plays; so += breakdown[k].songs; }
      shares[g] = { plays: pl, songs: so };
      labeledPlays += pl; labeledSongs += so;
    }
    for (const g in shares) {
      shares[g].playPct = labeledPlays ? shares[g].plays / labeledPlays * 100 : 0;
      shares[g].songPct = labeledSongs ? shares[g].songs / labeledSongs * 100 : 0;
    }
    const repeated = keep(list, s => s.count > 1).length;
    const missing = keep(list, s => s.r.status === 'none' || s.r.status === 'gone');
    // Playlist side
    const L = History.lengthStats(items);
    const timed = keep(items, it => Number(it.secs) > 0).sort((a, b) => b.secs - a.secs);
    const results = []; for (let i = 0; i < list.length; i++) results.push(list[i].r);
    const cov = History.coverage(results, items);
    const heardIds = new Set();
    for (let i = 0; i < results.length; i++) { const r = results[i]; if (r.status === 'have' && (!r.marked || r.linked) && r.item) heardIds.add(r.item.id); }
    const notHeard = keep(items, it => !heardIds.has(it.id));
    return {
      plays: n, first: n ? plays[n - 1][0] : 0, last: n ? plays[0][0] : 0, gaps, coveredSecs: covered,
      perHour: covered ? n / (covered / 3600) : 0,
      unique: list.length, repeated, repeatPlays: n - list.length, avgPlays: list.length ? n / list.length : 0,
      medianRepeatSecs: median(repeatGaps), avgRepeatSecs: repeatGaps.length ? repeatSum / repeatGaps.length : 0,
      rateRepeatSecs, avgGapRepeatSecs: repeatsSpanningGap ? gapRepeatSum / repeatsSpanningGap : 0,
      repeatIntervals: repeatGaps.length, repeatsSpanningGap, recent, recentFirsts: firsts, gapTimes,
      top: list.slice().sort(byCount).slice(0, 10),
      topMissing: missing.sort(byCount).slice(0, 10), missingSongs: missing.length,
      recentRepeats: keep(list, s => s.count > 1).sort((a, b) => b.last - a.last || b.count - a.count).slice(0, 10),
      breakdown, shares, labeledPlays, labeledSongs,
      playlist: { songs: items.length, total: L.total, avg: L.avg, unknown: L.unknown,
        longest: timed[0] || null, shortest: timed[timed.length - 1] || null,
        heard: cov.heard, notHeard },
    };
  }
  // 9000 -> "2 h 30 min"; 2700 -> "45 min"; 86400*2.5 -> "2 days 12 h"
  function formatSpan(secs) {
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h < 48) return `${h} h${m ? ' ' + m + ' min' : ''}`;
    const d = Math.floor(h / 24), rh = h % 24;
    return `${d} days${rh ? ' ' + rh + ' h' : ''}`;
  }
  // One song's plays, newest first, each with the time since its previous play and whether a
  // recording gap falls in between (plays may have been missed there). times: oldest first.
  function playLog(times, gapTimes) {
    const out = [];
    for (let k = times.length - 1; k >= 0; k--) {
      const at = times[k], prev = k > 0 ? times[k - 1] : null;
      let spansGap = false;
      if (prev !== null) for (let g = 0; g < gapTimes.length; g++) if (gapTimes[g] > prev && gapTimes[g] <= at) { spansGap = true; break; }
      out.push({ at, first: prev === null, spansGap, since: prev === null ? 0 : at - prev });
    }
    return out;
  }

  // One song's play times (oldest first) and the recording-gap markers, straight from the history
  function songTimes(plays, key) {
    const times = [], gapTimes = [];
    for (let i = plays.length - 1; i >= 0; i--) {
      const p = plays[i];
      if (p[4]) gapTimes.push(p[0]);
      if (markKey(p[1], p[2]) === key) times.push(p[0]);
    }
    return { times, gapTimes };
  }

  return { compute, formatSpan, playLog, songTimes };
})();

/* ---------- Reading the YouTube playlist (tested by soma-xmas-checker.test.js) ---------- */
// The playlist page gives the first 100 songs. YouTube's "next page" request currently comes back empty
// when made from a script, so the rest is read from the playlist side panel of a watch page, which
// lists the songs around a given position. A read only counts as complete when it reaches the
// playlist's stated total; an incomplete read is still shown, but never used to mark songs as gone.
const Reader = (() => {
  const { mapOf } = Matcher;

  // Desktop pages embed the data as an object; the mobile site embeds it as an escaped string
  function readInitialData(html) {
    let m = html.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
    if (m) return JSON.parse(m[1]);
    m = html.match(/var ytInitialData\s*=\s*'(.*?)';\s*<\/script>/s);
    if (m) {
      const js = m[1].replace(/\\'/g, "'").replace(/(?<!\\)((?:\\\\)*)\\x([0-9a-fA-F]{2})/g, '$1\\u00$2');
      return JSON.parse(JSON.parse('"' + js + '"'));
    }
    return null;
  }

  const textOf = t => (t && (t.simpleText || mapOf(t.runs || [], r => r.text).join(''))) || '';
  // One playlist entry from either the playlist page or the watch-page side panel
  // "3:05" or "1:02:03" -> seconds
  function parseLength(t) {
    const parts = String(t || '').trim().split(':');
    if (parts.length < 2 || parts.length > 3) return 0;
    let secs = 0;
    for (let i = 0; i < parts.length; i++) { const n = Number(parts[i]); if (!isFinite(n) || parts[i] === '') return 0; secs = secs * 60 + n; }
    return secs;
  }
  function entryFrom(v) {
    const title = textOf(v.title);
    const secs = Number(v.lengthSeconds) || parseLength(textOf(v.lengthText));
    const lengthSeconds = v.lengthSeconds || (v.lengthText ? '1' : '');
    return {
      secs,
      idx: Number(textOf(v.index) || textOf(v.indexText)) || 0,
      id: v.videoId, title, ch: (v.shortBylineText?.runs?.[0]?.text) || textOf(v.shortBylineText) || '',
      unavailable: Matcher.isUnavailable({ isPlayable: v.isPlayable, unplayableText: v.unplayableText, lengthSeconds }, title),
    };
  }
  function collect(obj, out, cont) {
    if (!obj || typeof obj !== 'object') return;
    const v = obj.playlistVideoRenderer || obj.playlistPanelVideoRenderer;
    if (v) { if (v.videoId) out.push(entryFrom(v)); return; }
    if (obj.continuationItemRenderer) {
      const t = obj.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
      if (t && cont) cont.push(t);
      return;
    }
    for (const k in obj) collect(obj[k], out, cont);
  }

  // Add entries past the highest position already read, in order; returns how many were added.
  // Positions (not video ids) are compared, so a song in the playlist twice is kept twice.
  function mergeByIndex(list, more) {
    let max = 0;
    for (let i = 0; i < list.length; i++) if (list[i].idx > max) max = list[i].idx;
    const add = [];
    const seen = new Set();
    for (let i = 0; i < more.length; i++) {
      const e = more[i];
      if (e.idx > max && !seen.has(e.idx)) { seen.add(e.idx); add.push(e); }
    }
    add.sort((a, b) => a.idx - b.idx);
    for (let i = 0; i < add.length; i++) list.push(add[i]);
    return add.length;
  }

  // "101 videos" on the playlist page, and "N unavailable videos are hidden" when YouTube hides some
  function counts(data) {
    const s = JSON.stringify(data);
    const total = Number((s.match(/"stats":\[\{"runs":\[\{"text":"([\d,]+)"/) || [])[1]?.replace(/,/g, '')) || 0;
    const hidden = Number((s.match(/(\d+) unavailable videos? (?:is|are) hidden/) || [])[1]) || 0;
    return { total, hidden };
  }

  // get(url) -> page text; post(url, body) -> parsed JSON
  async function read(get, post, playlistId) {
    const id = playlistId || PLAYLIST_ID;
    const html = await get(`https://www.youtube.com/playlist?list=${id}&hl=en`);
    const data = readInitialData(html);
    if (!data) throw new Error('YouTube page format not recognized');
    const entries = [], cont = [];
    collect(data, entries, cont);
    const hadMore = cont.length > 0;
    const { total, hidden } = counts(data);
    const expected = total ? Math.max(0, total - hidden) : 0;
    const ver = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
    // The official next-page request first, in case YouTube answers it again
    for (let guard = 0; cont.length && ver && post && guard < 30; guard++) {
      try {
        const d = await post('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false',
          { context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'en' } }, continuation: cont.shift() });
        const more = [], next = [];
        collect(d, more, next);
        if (!mergeByIndex(entries, more)) break;
        for (let i = 0; i < next.length; i++) cont.push(next[i]);
      } catch (e) { break; }
    }
    // Then the watch-page side panel, stepping forward from the last song read
    for (let guard = 0; guard < 40 && entries.length && (expected ? entries.length < expected : hadMore); guard++) {
      const last = entries[entries.length - 1];
      const page = readInitialData(await get(`https://www.youtube.com/watch?v=${last.id}&list=${id}&index=${last.idx}&hl=en`));
      if (!page) break;
      const more = [];
      collect(page, more, null);
      if (!mergeByIndex(entries, more)) break;
    }
    let unavailable = 0;
    const items = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.unavailable) unavailable++;
      else items.push({ id: e.id, title: e.title, ch: e.ch, secs: e.secs || 0 });
    }
    if (!items.length) throw new Error('no playable songs found (is the playlist public or unlisted?)');
    const complete = expected ? entries.length >= expected : !hadMore;
    return { items, hidden: hidden + unavailable, complete, read: entries.length, expected };
  }

  // How many songs in a read are repeats of one already listed
  function repeats(list) {
    const seen = new Set();
    let n = 0;
    for (let i = 0; i < list.length; i++) { if (seen.has(list[i].id)) n++; else seen.add(list[i].id); }
    return n;
  }
  // For a while after the playlist is reordered, the playlist page (first 100) and the watch-page side
  // panel (the rest) can show different orders, so some songs come back twice and others not at all,
  // while the count still adds up. A read with more repeats than the last good one is that, not real.
  const consistent = (fresh, prevItems) => repeats(fresh) <= repeats(prevItems || []);

  // A short or failed read is usually YouTube having a moment, so try again after each wait.
  // Returns the first good read, else the last read; throws only if every try failed.
  async function readRetry(readOnce, good, waits, sleep) {
    let last = null, err = null;
    for (let i = 0; i <= waits.length; i++) {
      if (i) await sleep(waits[i - 1]);
      try { last = await readOnce(); } catch (e) { err = e; continue; }
      if (good(last)) return last;
    }
    if (!last) throw err;
    return last;
  }

  return { read, readInitialData, entryFrom, collect, mergeByIndex, counts, parseLength, repeats, consistent, readRetry };
})();

/* ---------- Shuffling the real playlist (tested by soma-xmas-checker.test.js) ---------- */
// YouTube has no "reorder the playlist" request: each song is moved on its own (playlistItems.update
// with a new position, 50 of the 10,000 daily quota units). So the plan keeps the largest group of
// songs that are already in the right order relative to each other and moves only the rest, each one
// straight after the song that should come before it. The playlist is read back afterwards to confirm.
// call(method, resource, params, body) -> parsed JSON; it throws an Error with .status and .reason.
const Shuffle = (() => {
  const { mapOf } = Matcher;
  const UNITS_PER_MOVE = 50, UNITS_PER_READ = 1, DAILY_UNITS = 10000, PAGE = 50;

  // Fisher-Yates; rand(n) -> a whole number from 0 to n-1
  function order(ids, rand) {
    const a = ids.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* A shuffle that keeps like songs apart. Favorites, and the versions of a song, are spread about evenly
     (counting around the end, for a playlist that repeats); songs by the same artist, from the same album or
     posted by the same channel just aren't put close together. A category may repeat, but not too many in a row. Starting from a plain shuffle, songs are
     swapped while that makes the spacing better, so the rest of the order stays random. */

  // What a playlist video is, for spreading: soma is SomaFM's { artist, title, album } when it has played
  // this video, otherwise it's worked out from the video's title and channel ("Artist - Topic").
  // names: words of artist and channel names known anywhere in the playlist (see nameWords).
  function describe(item, soma, names) {
    const titles = [];
    const addTitles = t => { for (const part of String(t || '').split('/')) { const w = Matcher.titleWords(part); if (w.length) titles.push(w); } };
    const ch = String(item.ch || '').trim();
    const topic = /\s-\s*Topic$/i.test(ch) ? ch.replace(/\s*-\s*Topic$/i, '') : '';
    if (soma) addTitles(soma.title);
    // The video's title, whole and each side of "Artist - Title". A side that names an artist or a channel
    // isn't a title (and names the artist when nothing else does); otherwise either side may be the title.
    addTitles(item.title);
    let artistName = soma ? soma.artist : topic;
    const sides = Matcher.stripBrackets(item.title).split(/\s+[-–—]\s+|:\s+/);
    if (sides.length > 1) for (const s of sides) {
      const w = Matcher.titleWords(s);
      const isName = n => n && Matcher.sameTitle(w, Matcher.titleWords(n));
      let named = isName(artistName) || isName(ch);
      for (let i = 0; names && i < names.length && !named; i++) named = Matcher.sameTitle(w, names[i]);
      if (named) { if (!artistName) artistName = s; continue; }
      addTitles(s);
    }
    const artist = artistName ? Matcher.parseSoma(artistName, '').primary.join(' ') : '';
    return { titles, artist, album: soma && soma.album ? Matcher.norm(soma.album) : '', uploader: !topic && ch ? Matcher.norm(ch) : '' };
  }

  // Artist and channel names in the playlist, so "Kaskade - This Christmas Night" posted by someone else
  // is known to be by Kaskade when Kaskade's own channel posted another song
  function nameWords(items, somaOf) {
    const out = [];
    const add = n => { const w = Matcher.titleWords(n); if (w.length && !Matcher.anyOf(out, x => Matcher.sameTitle(x, w))) out.push(w); };
    for (let i = 0; i < items.length; i++) {
      const soma = somaOf(items[i]);
      if (soma) add(soma.artist);
      add(String(items[i].ch || '').replace(/s*-s*Topics*$/i, ''));
    }
    return out;
  }

  // Groups to spread: { members (indexes), even: true to space them evenly, kind }. favs[i] says if song i is a favorite.
  // cats[i] is song i's category ('' for none): no more than maxRun of one category in a row, more allowed for bigger ones
  const maxRun = (k, n) => Math.min(5, Math.max(3, Math.ceil(k / n * 12)));
  function spreadGroups(descs, favs, cats) {
    const groups = [], n = descs.length;
    const favList = [];
    for (let i = 0; i < n; i++) if (favs[i]) favList.push(i);
    if (favList.length > 1) groups.push({ members: favList, even: true, kind: 'favorites' });
    // Versions of a song: any title of one is the same as any title of the other (joined through chains)
    const up = []; for (let i = 0; i < n; i++) up.push(i);
    const top = i => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (top(i) === top(j)) continue;
      let hit = false;
      for (let a = 0; a < descs[i].titles.length && !hit; a++)
        for (let b = 0; b < descs[j].titles.length && !hit; b++) hit = Matcher.sameTitle(descs[i].titles[a], descs[j].titles[b]);
      if (hit) up[top(i)] = top(j);
    }
    const byKey = (kind, keyOf, even) => {
      const m = new Map();
      for (let i = 0; i < n; i++) { const k = keyOf(i); if (k === '') continue; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
      m.forEach(members => { if (members.length > 1) groups.push({ members, even, kind }); });
    };
    byKey('versions', i => String(top(i)), true);
    byKey('artist', i => descs[i].artist, false);
    byKey('album', i => descs[i].album, false);
    byKey('uploader', i => descs[i].uploader, false);
    const cm = new Map();
    for (let i = 0; cats && i < n; i++) if (cats[i]) { if (!cm.has(cats[i])) cm.set(cats[i], []); cm.get(cats[i]).push(i); }
    cm.forEach((members, c) => { if (members.length > 3) groups.push({ members, even: false, kind: 'category', category: c, maxRun: maxRun(members.length, n) }); });
    return groups;
  }

  // How far a group's spacing is from what's wanted (0 is perfect). pos[i] is song i's place.
  function groupCost(g, pos, n) {
    const p = [];
    for (let i = 0; i < g.members.length; i++) p.push(pos[g.members[i]]);
    p.sort((x, y) => x - y);
    const k = p.length, ideal = n / k;
    if (g.maxRun) {
      // Runs of this category's songs one after another (around the end too); only the songs past maxRun cost
      const gapAfter = i => i + 1 < k ? p[i + 1] - p[i] : n - p[k - 1] + p[0];
      let s = 0;
      while (s < k && gapAfter((s - 1 + k) % k) === 1) s++;   // the first song of a run
      if (s === k) { const over = k - g.maxRun; return over > 0 ? 2 * over * over : 0; }
      let c = 0, run = 0;
      for (let t = 0; t < k; t++) {
        run++;
        if (gapAfter((s + t) % k) !== 1) { if (run > g.maxRun) c += 2 * (run - g.maxRun) * (run - g.maxRun); run = 0; }
      }
      return c;
    }
    const near = Math.min(12, Math.max(2, Math.round(ideal / 2)));   // closer than this counts as bunched
    let c = 0;
    for (let i = 0; i < k; i++) {
      const gap = i + 1 < k ? p[i + 1] - p[i] : n - p[k - 1] + p[0];
      if (g.even) { const e = (gap - ideal) / ideal; c += 4 * e * e; }
      else if (gap < near) { const e = (near - gap) / near; c += e * e; }
    }
    return c;
  }

  // Indexes 0..n-1 in a spread-out order. rand(n) -> a whole number from 0 to n-1.
  function spread(n, groups, rand) {
    const start = [], of = [], placed = [];
    for (let i = 0; i < n; i++) { start.push(i); of.push([]); }
    const at = order(start, rand), pos = [];
    for (let p = 0; p < n; p++) pos[at[p]] = p;
    for (let g = 0; g < groups.length; g++) for (let i = 0; i < groups[g].members.length; i++) of[groups[g].members[i]].push(g);
    for (let i = 0; i < n; i++) if (of[i].length) placed.push(i);
    if (!placed.length || n < 3) return at;
    const cost = mapOf(groups, g => groupCost(g, pos, n));
    const rounds = 300 * n;
    for (let r = 0; r < rounds; r++) {
      const x = placed[rand(placed.length)], px = pos[x], py = rand(n), y = at[py];
      if (x === y) continue;
      const touched = of[x].slice();
      for (let t = 0; t < of[y].length; t++) if (touched.indexOf(of[y][t]) < 0) touched.push(of[y][t]);
      let before = 0, after = 0;
      for (let t = 0; t < touched.length; t++) before += cost[touched[t]];
      at[px] = y; at[py] = x; pos[x] = py; pos[y] = px;
      const fresh = [];
      for (let t = 0; t < touched.length; t++) { const c = groupCost(groups[touched[t]], pos, n); fresh.push(c); after += c; }
      // Early on, a slightly worse swap is sometimes kept, so the order isn't stuck at the first good-enough spacing
      const heat = r < rounds * 0.7 ? 0.3 * (1 - r / (rounds * 0.7)) : 0;
      const worse = after - before;
      if (worse > 1e-9 && !(heat > 0 && rand(1000000) / 1000000 < Math.exp(-worse / heat))) {
        at[px] = x; at[py] = y; pos[x] = px; pos[y] = py;
        continue;
      }
      for (let t = 0; t < touched.length; t++) cost[touched[t]] = fresh[t];
    }
    return at;
  }

  // A new order for the playlist: items are { id, videoId, title, ch }; somaOf(videoId), isFav(videoId) and
  // catOf(videoId) describe them. Returns the ids in order and the groups that were spread.
  function arrange(items, somaOf, isFav, rand, catOf) {
    const names = nameWords(items, it => somaOf(it.videoId));
    const descs = mapOf(items, it => describe(it, somaOf(it.videoId), names));
    const groups = spreadGroups(descs, mapOf(items, it => !!isFav(it.videoId)), catOf ? mapOf(items, it => catOf(it.videoId) || '') : null);
    const at = spread(items.length, groups, rand);
    return { ids: mapOf(at, i => items[i].id), groups };
  }

  // Indexes of one longest increasing run (not necessarily adjacent) in a list of numbers
  function longestRun(nums) {
    const tails = [], prev = [];
    for (let i = 0; i < nums.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (nums[tails[mid]] < nums[i]) lo = mid + 1; else hi = mid; }
      prev[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    const keepIdx = new Set();
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) keepIdx.add(k);
    return keepIdx;
  }

  const sameSongs = (a, b) => {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    if (s.size !== a.length) return false;
    for (let i = 0; i < b.length; i++) if (!s.has(b[i])) return false;
    return true;
  };

  // Moves that turn current (playlist item ids in order) into target: [{ id, position }], where position
  // is 0-based in the list as it stands after the move, which is how YouTube applies it
  function plan(current, target) {
    if (!sameSongs(current, target)) throw new Error('the playlist changed (songs added or removed)');
    const at = new Map();
    for (let i = 0; i < current.length; i++) at.set(current[i], i);
    const ranks = [];
    for (let i = 0; i < target.length; i++) ranks.push(at.get(target[i]));
    const stay = longestRun(ranks);
    const list = current.slice(), moves = [];
    for (let i = 0; i < target.length; i++) {
      if (stay.has(i)) continue;
      const id = target[i];
      list.splice(list.indexOf(id), 1);
      const position = i === 0 ? 0 : list.indexOf(target[i - 1]) + 1;
      list.splice(position, 0, id);
      moves.push({ id, position });
    }
    return moves;
  }
  // The same move applied to a local copy (used by the tests' fake YouTube)
  function applyMove(list, id, position) {
    const out = list.slice();
    out.splice(out.indexOf(id), 1);
    out.splice(position, 0, id);
    return out;
  }
  const units = moves => moves * UNITS_PER_MOVE;
  // The saved original order for the songs still in the playlist, then songs added since, in their current order
  function restoreOrder(original, current) {
    const now = new Set(current), was = new Set(original), out = [];
    for (let i = 0; i < original.length; i++) if (now.has(original[i])) out.push(original[i]);
    for (let i = 0; i < current.length; i++) if (!was.has(current[i])) out.push(current[i]);
    return out;
  }

  // Every song in the playlist, in playlist order: { id (playlist item), videoId, title }
  async function readItems(call, playlistId) {
    const out = [];
    let pageToken = '';
    for (let guard = 0; guard < 200; guard++) {
      const d = await call('GET', 'playlistItems', { part: 'snippet', playlistId, maxResults: PAGE, pageToken });
      const list = (d && d.items) || [];
      for (let i = 0; i < list.length; i++) {
        const s = list[i].snippet || {};
        out.push({ id: list[i].id, videoId: (s.resourceId && s.resourceId.videoId) || '', title: s.title || '',
          ch: s.videoOwnerChannelTitle || '', position: Number(s.position) || 0 });
      }
      pageToken = (d && d.nextPageToken) || '';
      if (!pageToken) break;
    }
    out.sort((a, b) => a.position - b.position);
    return out;
  }
  const idsOf = list => { const out = []; for (let i = 0; i < list.length; i++) out.push(list[i].id); return out; };
  const readUnits = n => Math.max(1, Math.ceil(n / PAGE)) * UNITS_PER_READ;

  // Refuse unless the signed-in channel owns the playlist. Returns { channel, title }.
  async function checkOwner(call, playlistId) {
    const me = await call('GET', 'channels', { part: 'snippet', mine: 'true' });
    const pl = await call('GET', 'playlists', { part: 'snippet', id: playlistId });
    const mine = me && me.items && me.items[0];
    const p = pl && pl.items && pl.items[0];
    if (!mine) throw new Error('this Google account has no YouTube channel');
    if (!p) throw new Error("the playlist couldn't be found");
    const channel = (mine.snippet && mine.snippet.title) || 'that channel';
    if (p.snippet.channelId !== mine.id) throw new Error(`you're signed in as ${channel}, which doesn't own the playlist. Sign in again and choose the channel that owns it`);
    return { channel, title: p.snippet.title };
  }

  // Makes the moves one at a time. onStep(done, total) after each; stop() is checked before each.
  // An error is passed on with .done (moves made so far) added.
  async function run(call, playlistId, items, moves, onStep, stop) {
    const videoOf = new Map();
    for (let i = 0; i < items.length; i++) videoOf.set(items[i].id, items[i].videoId);
    for (let k = 0; k < moves.length; k++) {
      if (stop && stop()) return { done: k, stopped: true };
      const m = moves[k];
      try {
        await call('PUT', 'playlistItems', { part: 'snippet' },
          { id: m.id, snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: videoOf.get(m.id) }, position: m.position } });
      } catch (e) { e.done = k; throw e; }
      if (onStep) onStep(k + 1, moves.length);
    }
    return { done: moves.length, stopped: false };
  }

  // Same order? (after reading the playlist back)
  function matches(list, target) {
    if (list.length !== target.length) return false;
    for (let i = 0; i < list.length; i++) if (list[i] !== target[i]) return false;
    return true;
  }

  // The quota day runs midnight to midnight Pacific time
  const quotaDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });

  return { order, describe, nameWords, maxRun, spreadGroups, groupCost, spread, arrange, longestRun, plan, applyMove, units, restoreOrder, readItems, idsOf, readUnits, checkOwner, run, matches, sameSongs, quotaDay,
    UNITS_PER_MOVE, DAILY_UNITS };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Object.assign({ History, Archive, Reader, Stats, Backup, Shuffle }, Matcher);
} else if (!catchSignIn()) {
  main();
}

/* ---------- Google sign-in return (Tampermonkey only) ---------- */
// Google sends the sign-in back to SIGNIN_RETURN with a one-hour access key in the address's #fragment.
// If this page is that return, and for the sign-in this script started, the key is saved for the page
// that asked for it and this window closes. Returns true when the page should go no further.
function catchSignIn() {
  if (!/[#&]state=/.test(location.hash)) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  const asked = GM_getValue('signin:pending', null);
  if (!asked || p.get('state') !== asked.state) return false;
  window.history.replaceState(null, '', location.pathname + location.search);   // keep the key out of the address bar
  GM_setValue('signin:pending', null);
  const token = p.get('access_token');
  GM_setValue('signin:token', token
    ? { token, at: Date.now(), exp: Date.now() + ((Number(p.get('expires_in')) || 3600) - 120) * 1000 }
    : { error: p.get('error') || 'no access key came back', at: Date.now() });
  if (!asked.popup) { GM_setValue('signin:reopen', Date.now()); return false; }   // signed in in this tab: carry on and reopen Shuffle
  window.close();
  const note = document.createElement('div');                                    // if the browser keeps the window open
  note.textContent = token ? 'Signed in. You can close this window and go back to the Shuffle panel.' : "Sign-in didn't complete. Close this window and try again.";
  note.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:2rem;font:600 20px system-ui,sans-serif;background:#0f1714;color:#e8efe9;text-align:center';
  document.body.appendChild(note);
  return true;
}

/* ---------- Page behavior (Tampermonkey only) ---------- */
function main() {
  const { anyOf, mapOf, keep } = Matcher;   // prototype.js-safe array helpers
  const channel = location.pathname.split('/')[1] || 'christmas';
  const stationName = ((document.title.match(/SomaFM:\s*(.*?)\s+Song History/i) || [])[1] || 'SomaFM').trim();

  /* ----- Read the page's own table first: it's the fallback if the live feed can't be reached ----- */
  function readTable() {
    const out = [];
    for (const t of document.querySelectorAll('table')) {
      if (!/Played At/i.test(t.rows[0]?.textContent || '')) continue;
      for (const row of t.rows) {
        if (row.cells.length < 3 || /Played At/i.test(row.cells[0].textContent)) continue;
        const artist = row.cells[1].textContent.trim(), title = row.cells[2].textContent.trim();
        if (!artist || !title) continue;
        out.push({ artist, title, album: (row.cells[3]?.textContent || '').trim(),
          time: row.cells[0].textContent.replace(/\(Now\)/i, '').replace(/ /g, ' ').trim(), art: '' });
      }
      break;
    }
    return out;
  }
  const tableSongs = readTable();

  /* ----- Take over the page ----- */
  // SomaFM's page has no viewport tag, so phones and tablets lay it out 980px wide and shrink it
  for (const m of document.querySelectorAll('meta[name="viewport"]')) m.remove();
  document.head.appendChild(Object.assign(document.createElement('meta'),
    { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }));
  const hide = document.createElement('style');
  hide.textContent = 'html,body{margin:0!important;padding:0!important;background:#f6f8f6!important}' +
    '@media (prefers-color-scheme: dark){html,body{background:#0f1714!important}}' +
    'body>*:not(#xm-host){display:none!important}';
  document.head.appendChild(hide);
  const host = document.createElement('div');
  host.id = 'xm-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });   // shadow DOM: SomaFM's CSS can't reach in

  root.innerHTML = `<style>
    /* Layout: one centered column; a header with status + controls, then one card per song */
    :host{--bg:#f6f8f6;--card:#ffffff;--fg:#17221d;--muted:#5d6b64;--line:#dfe6e1;--accent:#1f6feb;--accent-fg:#fff;
      --have-bg:#dcf2e3;--have-fg:#13603a;--other-bg:#fbedcf;--other-fg:#7a4a00;--none-bg:#f9dcd7;--none-fg:#8f2213;
      --mark:#25804f;--marknot:#b23a2a;--undo:#5a6472;--now:#b8860b;--chip:#eef2ef;--none-card:#e1e7ef;--none-line:#c4cfdc;--dislike:#5a4762;--dis-bg:#ebe6ee;--dis-fg:#5a4a60;--other-card:#f0f3f8;--other-line:#d6dee8;
      all:initial;display:block;background:var(--bg);color:var(--fg);min-height:100vh;
      font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:clamp(15px,0.55vw + 12.5px,19px);line-height:1.4}
    @media (prefers-color-scheme: dark){:host{--bg:#0f1714;--card:#17221d;--fg:#e8efe9;--muted:#9aaba2;--line:#273630;
      --accent:#4c8dff;--have-bg:#173d29;--have-fg:#8fe0ae;--other-bg:#43341a;--other-fg:#f5cf7f;--none-bg:#4a221d;--none-fg:#ffb1a5;
      --mark:#2f9a60;--marknot:#c2513f;--undo:#4b5561;--now:#e8b84a;--chip:#1e2b25;--none-card:#232e3c;--none-line:#36465b;--dislike:#634f6c;--dis-bg:#2e2733;--dis-fg:#cdbfd3;--other-card:#1d2833;--other-line:#2f3d4e}}
    *{box-sizing:border-box}
    .wrap{max-width:52rem;margin:0 auto;padding:1rem max(16px,env(safe-area-inset-right,0px)) 2.5rem max(16px,env(safe-area-inset-left,0px))}
    /* Header: title on the left, Stats always top right. The three buttons sit right below Stats when they
       fit beside the title (full labels, else short ones); otherwise they get their own row ("stacked").
       fitHeader() picks the arrangement from measured widths. */
    header{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.75rem;row-gap:.6rem;
      grid-template-areas:"titles stats" "titles btns" "status status" "filters filters" "catf catf" "anote anote" "gone gone";
      padding-bottom:.9rem;border-bottom:1px solid var(--line);margin-bottom:.9rem}
    header.stacked{grid-template-areas:"titles stats" "btns btns" "status status" "filters filters" "catf catf" "anote anote" "gone gone"}
    .titles{grid-area:titles;min-width:0}
    #stats{grid-area:stats;justify-self:end;align-self:start}
    header .btns{grid-area:btns;justify-self:end;align-self:start;flex-wrap:nowrap}
    header.stacked .btns{justify-self:start;flex-wrap:wrap}
    header .controls{grid-area:status}
    header .filters{grid-area:filters}
    header .catf{grid-area:catf}
    .catf:empty,.catf button[hidden]{display:none}
    @media (max-width:899px){.catf .wide{display:none}}
    #anote{grid-area:anote} #gonebox{grid-area:gone}
    .lbl-short{display:none}
    header.compact .lbl-full{display:none} header.compact .lbl-short{display:inline}
    header.measure .btns{flex-wrap:nowrap} header.measure h1,header.measure .sub{white-space:nowrap}
    h1{font-size:1.55em;line-height:1.15;margin:0;font-weight:750;letter-spacing:-.01em;text-wrap:balance}
    .sub{color:var(--muted);font-size:.85em;margin-top:.15rem}
    .controls{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .6rem}
    .status{flex:1 1 14rem;min-width:0;color:var(--muted);font-size:.9em}
    .status b{color:var(--fg)}
    .btns{display:flex;flex-wrap:wrap;gap:.5rem;flex:0 1 auto;min-width:0}
    .status.err{color:var(--none-fg)}
    button,a.btn{font:inherit;font-size:.82em;font-weight:650;border:0;border-radius:999px;padding:.42em .95em;cursor:pointer;
      text-decoration:none;display:inline-flex;align-items:center;gap:.35em;white-space:nowrap;line-height:1.2}
    button:focus-visible,a.btn:focus-visible{outline:2px solid var(--now);outline-offset:2px}
    .ctl{background:var(--chip);color:var(--fg);border:1px solid var(--line)}
    .ctl[aria-pressed="true"]{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
    .filters{display:flex;flex-wrap:wrap;gap:.4rem}
    .filters button{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:600}
    .filters button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
    .filters .one{margin-left:auto}
    .filters .n{font-variant-numeric:tabular-nums;opacity:.8}
    ol{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
    li{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.8rem .95rem;
      display:grid;grid-template-columns:5.2em minmax(0,1fr);gap:.2rem .8rem}
    /* Only cards on screen are laid out (about 9× faster redraws with 50 cards); the rest keep their last size */
    #cards > li{content-visibility:auto;contain-intrinsic-size:auto 140px}
    li.none{background:var(--none-card);border-color:var(--none-line)}
    li.other{background:var(--other-card);border-color:var(--other-line)}
    li.gone{background:var(--none-card);border-color:var(--none-line)}
    .gone .pill{background:var(--other-bg);color:var(--other-fg)}
    .warnline{color:var(--other-fg);font-size:.85em}
    .gonebox{border:1px solid var(--line);border-radius:12px;background:var(--card)}
    .gonebox summary{cursor:pointer;padding:.55rem .8rem;font-weight:650;font-size:.9em;color:var(--other-fg)}
    .gonebox summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:12px}
    .gonelist{display:grid;gap:.5rem;padding:0 .8rem .8rem}
    .gonerow{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;padding-top:.5rem;border-top:1px solid var(--line)}
    .gonerow .gt{flex:1 1 16rem;min-width:0}
    .gonerow .gt b{display:block;overflow-wrap:anywhere}
    .gonerow small{color:var(--muted)}
    li.disliked{background:transparent;border-style:dashed}
    li.disliked .title,li.disliked .artist{color:var(--muted)}
    .disliked .pill{background:var(--dis-bg);color:var(--dis-fg)}
    .dislike{background:var(--dislike);color:#fff}
    li.now{border-color:var(--now);box-shadow:0 0 0 1px var(--now) inset}
    .time{color:var(--muted);font-size:.82em;font-variant-numeric:tabular-nums;padding-top:.2em;line-height:1.3}
    .time .live{display:block;color:var(--now);font-weight:700;font-size:.92em;letter-spacing:.04em;text-transform:uppercase}
    .song{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.7rem;align-items:start}
    .names{min-width:0}
    .song .album{grid-column:1 / -1}
    a.open{margin-top:.1em}
    .title{font-weight:700;font-size:1.08em;line-height:1.25;overflow-wrap:anywhere}
    .artist{margin-top:.1rem;overflow-wrap:anywhere}
    button.fav{background:none;border:0;padding:.05em .3em;font-size:1.1em;line-height:1;color:var(--muted);vertical-align:baseline;font-weight:400}
    button.fav[aria-pressed="true"]{color:var(--now)}
    select.cat{font:inherit;font-size:.82em;font-weight:650;border-radius:999px;padding:.38em .7em;background:var(--chip);color:var(--muted);border:1px dashed var(--line);max-width:100%}
    select.cat.set{color:var(--fg);border-style:solid}
    .len{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
    .album{color:var(--muted);font-size:.82em;margin-top:.1rem;overflow-wrap:anywhere}
    .state{grid-column:2;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;margin-top:.45rem}
    .pill{font-size:.8em;font-weight:700;border-radius:999px;padding:.3em .75em;white-space:nowrap}
    .have .pill{background:var(--have-bg);color:var(--have-fg)}
    .other .pill{background:var(--other-bg);color:var(--other-fg)}
    .none .pill{background:var(--none-bg);color:var(--none-fg)}
    .go{background:var(--accent);color:var(--accent-fg)}
    .mark{background:var(--mark);color:#fff}
    .marknot{background:var(--marknot);color:#fff}
    .undo{background:var(--undo);color:#fff}
    .note{grid-column:2;color:var(--muted);font-size:.8em;overflow-wrap:anywhere}
    li.empty{display:block;background:transparent;border:1px dashed var(--line);color:var(--muted);padding:2rem 1rem;text-align:center}
    .time .date{display:block}
    li.gap{display:block;background:transparent;border:0;border-top:2px dashed var(--line);border-radius:0;
      padding:.35rem 0 0;color:var(--muted);font-size:.8em;text-align:center}
    footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem 1rem;
      margin-top:1rem;padding-top:.9rem;border-top:1px solid var(--line)}
    .pager,.tools{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
    .pager .pos{color:var(--muted);font-size:.85em;font-variant-numeric:tabular-nums}
    .ctl:disabled{opacity:.45;cursor:default}
    select{font:inherit;font-size:.82em;color:var(--fg);background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:.38em .7em}
    label.per{color:var(--muted);font-size:.85em;display:inline-flex;align-items:center;gap:.4em}
    .rec{flex-basis:100%;color:var(--muted);font-size:.8em}
    .working{position:fixed;z-index:20;left:50%;top:calc(env(safe-area-inset-top,0px) + .6rem);transform:translateX(-50%);
      display:flex;align-items:center;gap:.5rem;padding:.4rem .85rem;border-radius:999px;background:var(--fg);color:var(--bg);
      font-size:.85em;font-weight:650;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;visibility:hidden;pointer-events:none}
    :host(.working) .working{opacity:1;visibility:visible;transition:opacity .12s ease .15s,visibility 0s linear .15s}
    .spin{width:.9em;height:.9em;border-radius:50%;border:2px solid currentColor;border-right-color:transparent}
    @media (prefers-reduced-motion:no-preference){.spin{animation:xmspin .7s linear infinite}@keyframes xmspin{to{transform:rotate(360deg)}}}
    [aria-busy="true"]{cursor:progress}
    dialog#statsbox,dialog#backupbox,dialog#shufbox{width:min(46rem,calc(100% - 32px));margin:auto;max-height:min(88vh,60rem);padding:0;border:1px solid var(--line);border-radius:16px;
      background:var(--bg);color:var(--fg);font:inherit;box-shadow:0 18px 50px rgba(0,0,0,.25)}
    dialog#statsbox{width:min(72rem,calc(100% - 32px))}
    dialog#statsbox::backdrop,dialog#backupbox::backdrop,dialog#shufbox::backdrop{background:rgba(10,20,15,.45)}
    #backupbody,#shufbody{padding:1rem;display:grid;gap:1.1rem}
    .shinput{font:inherit;font-size:.85em;width:100%;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.5rem}
    .shlist{margin:0;padding-left:1.6rem;font-size:.88em;display:grid;gap:.1rem}
    .shlist li{display:list-item;background:none;border:0;border-radius:0;padding:0;grid-template-columns:none;overflow-wrap:anywhere}
    .brow{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
    #bkpaste{font:inherit;font-size:.82em;width:100%;min-height:6rem;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.5rem}
    .bmsg{font-size:.88em}
    .bmsg.err{color:var(--none-fg)}
    .bmsg.ok{color:var(--have-fg)}
    .bpreview{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.75rem .85rem;display:grid;gap:.55rem}
    .bpreview ul{margin:0;padding-left:1.1rem;font-size:.9em;display:grid;gap:.15rem}
    .bpreview li{display:list-item;background:none;border:0;padding:0;grid-template-columns:none}
    .ctl.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
    .ctl.danger{background:var(--marknot);color:#fff;border-color:var(--marknot)}
    .shead{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:1rem;
      padding:.8rem 1rem;background:var(--bg);border-bottom:1px solid var(--line)}
    .shead h2{margin:0;font-size:1.2em}
    #statsbody{padding:1rem;display:grid;gap:1.1rem}
    .ssec{display:grid;gap:.55rem}
    .ssec h3{margin:0;font-size:.78em;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.25rem,1fr));gap:.5rem}
    .tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.6rem .75rem}
    .tile .v{font-size:1.25em;font-weight:750;font-variant-numeric:tabular-nums}
    .tile .k{color:var(--muted);font-size:.78em}
    .tile .k2{font-size:.8em;margin-top:.15rem;font-variant-numeric:tabular-nums}
    .tile.share{border-left-width:4px}
    .tile.share.have{border-left-color:var(--have-fg)} .tile.share.other{border-left-color:var(--other-fg)}
    .tile.share.none{border-left-color:var(--none-fg)} .tile.share.disliked{border-left-color:var(--dislike)}
    .sline{font-size:.9em}
    .sline b{font-variant-numeric:tabular-nums}
    .slist{margin:0;padding:0;list-style:none;display:grid;gap:.35rem;counter-reset:n}
    .slist > li{display:grid;grid-template-columns:2em minmax(0,1fr) auto auto;align-items:center;gap:.5rem;background:var(--card);
      border:1px solid var(--line);border-radius:10px;padding:.45rem .65rem;font-size:.9em}
    .slist > li::before{counter-increment:n;content:counter(n);color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
    .slist .nm{min-width:0;overflow-wrap:anywhere}
    .slist .nm small{display:block;color:var(--muted)}
    .slist .ct{font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
    .slist .ct small{font-weight:400;color:var(--muted)}
    .ctbtn{font:inherit;font-weight:700;font-variant-numeric:tabular-nums;background:var(--chip);color:var(--fg);border:1px solid var(--line);
      border-radius:999px;padding:.15em .55em;cursor:pointer}
    .ctbtn .caret{display:inline-block;font-size:.8em;transition:transform .15s}
    .ctbtn[aria-expanded="true"]{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
    .ctbtn[aria-expanded="true"] .caret{transform:rotate(180deg)}
    .plog{grid-column:1 / -1;border-top:1px dashed var(--line);padding-top:.4rem;margin-top:.15rem}
    .plog ul{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.15rem 1rem;font-size:.82em}
    .plog li{display:block;background:none;border:0;border-radius:0;padding:0;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .plog li span{color:var(--muted)}
    .plog li.gapped span{color:var(--other-fg)}
    .plog li.this b{text-decoration:underline;text-underline-offset:2px}
    .plog .plegend{margin:.35rem 0 0;font-size:.78em;color:var(--muted)}
    .cardlog{grid-column:1 / -1;margin-top:.35rem}
    .histbtn{display:inline-flex;margin-top:.35rem;font-size:.92em;font-weight:650;background:var(--chip);color:var(--fg);
      border:1px solid var(--line);border-radius:999px;padding:.15em .55em;white-space:nowrap}
    .histbtn[aria-expanded="true"]{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
    .time .histbtn .caret{font-size:.8em;margin-right:.1em}
    .seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden}
    .seg button{border-radius:0;background:transparent;color:var(--muted);font-size:.78em;padding:.3em .8em}
    .seg button[aria-pressed="true"]{background:var(--fg);color:var(--bg)}
    .sechead{display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap}
    .chip{font-size:.75em;font-weight:700;border-radius:999px;padding:.15em .55em;margin-left:.35em;white-space:nowrap}
    .chip.have{background:var(--have-bg);color:var(--have-fg)} .chip.other,.chip.gone{background:var(--other-bg);color:var(--other-fg)}
    .chip.none{background:var(--none-bg);color:var(--none-fg)} .chip.disliked{background:var(--dis-bg);color:var(--dis-fg)}
    .sdet summary{cursor:pointer;font-size:.9em;font-weight:650}
    .sdet ul{margin:.4rem 0 0;padding-left:1.1rem;font-size:.85em;display:grid;gap:.2rem}
    .sdet ul{padding-left:0;list-style:none}
    .sdet li{display:flex;align-items:center;justify-content:space-between;gap:.75rem;background:none;border:0;border-radius:0;padding:.1rem 0;grid-template-columns:none}
    .sdet li .nh{min-width:0;overflow-wrap:anywhere}
    a.btn.small{font-size:.72em;padding:.28em .75em;flex:none}
    .snote{color:var(--muted);font-size:.8em}
    .snote a{color:var(--fg);text-decoration:underline}
    .qbody{margin-top:.55rem}
    .bar{height:.55rem;border-radius:999px;background:var(--chip);border:1px solid var(--line);overflow:hidden}
    .barwrap{display:grid;gap:.3rem}
    .barhead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.2rem .75rem}
    .barlab{margin-left:auto;font-size:.88em;font-variant-numeric:tabular-nums;white-space:nowrap}
    .fill{height:100%;width:0;background:var(--mark);border-radius:999px}
    @media (max-width:420px){.slist > li{grid-template-columns:1.6em minmax(0,1fr)}.slist .ct,.slist .go{grid-column:2}}
    .note.warn{color:var(--other-fg)}
    .picker{grid-column:2;margin-top:.55rem;padding:.75rem;border:1px solid var(--line);border-radius:12px;background:var(--card);display:grid;gap:.5rem}
    .picker .ph{font-weight:700;font-size:.92em}
    .picker .sub2{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.05em}
    .picker input{font:inherit;font-size:.9em;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.5em .7em;width:100%}
    .picker input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .choices{display:grid;gap:.3rem;max-height:18rem;overflow-y:auto}
    .choice{display:block;width:100%;text-align:left;white-space:normal;background:var(--chip);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:.5em .75em;font-weight:600}
    .choice small{display:block;font-weight:400;color:var(--muted);font-size:.85em;margin-top:.1em}
    .pbtns{display:flex;flex-wrap:wrap;gap:.5rem}
    .pempty{color:var(--muted);font-size:.85em}
    .choice.chosen{background:var(--have-bg);color:var(--have-fg);border-color:var(--have-fg)}
    .choice.chosen .tick{font-weight:800}
    .choice:disabled:not(.chosen){opacity:.45}
    li.flash{box-shadow:0 0 0 3px var(--mark)}
    @media (prefers-reduced-motion:no-preference){
      li.flash{animation:xmflash 1.6s ease-out}
      @keyframes xmflash{0%{box-shadow:0 0 0 4px var(--mark)}100%{box-shadow:0 0 0 0 transparent}}
    }
    @media (max-width:420px){.picker{grid-column:1}}
    @media (max-width:420px){li{grid-template-columns:minmax(0,1fr)}.state,.note{grid-column:1}.time{display:flex;gap:.6em;padding:0}.time .live,.time .date{display:inline}}
    @media (prefers-reduced-motion:no-preference){li{transition:border-color .2s}}
  </style>
  <div class="wrap">
    <header>
      <div class="titles"><h1></h1><div class="sub">SomaFM · play history</div></div>
      <button type="button" class="ctl" id="stats" aria-haspopup="dialog">📊 Stats</button>
      <span class="btns">
        <button type="button" class="ctl" id="refresh"></button>
        <button type="button" class="ctl" id="live"></button>
        <button type="button" class="ctl" id="awake"></button>
      </span>
      <div class="controls">
        <span class="status" role="status"></span>
      </div>
      <div class="filters" role="group" aria-label="Show"></div>
      <div class="filters catf" role="group" aria-label="Category"></div>
      <div class="warnline" id="anote" hidden></div>
      <details class="gonebox" id="gonebox" hidden><summary id="gonesum"></summary><div class="gonelist" id="gonelist"></div></details>
    </header>
    <ol id="cards"></ol>
    <footer>
      <div class="pager">
        <button type="button" class="ctl" id="prev">‹ Newer</button>
        <span class="pos" id="pos"></span>
        <button type="button" class="ctl" id="next">Older ›</button>
        <label class="per">Per page <select id="per"></select></label>
      </div>
      <div class="tools">
        <button type="button" class="ctl" id="csv">Export CSV</button>
        <button type="button" class="ctl" id="copy">Copy CSV</button>
        <button type="button" class="ctl" id="backup" aria-haspopup="dialog">Backup / Restore</button>
        <button type="button" class="ctl" id="shuffle" aria-haspopup="dialog">🔀 Shuffle playlist</button>
      </div>
      <div class="rec" id="rec" role="status"></div>
    </footer>
  </div>
  <div class="working" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span>Working…</div>
  <dialog id="backupbox" aria-labelledby="bktitle">
    <div class="shead"><h2 id="bktitle">Back up or move your data</h2><button type="button" class="ctl" id="bkclose">Close</button></div>
    <div id="backupbody">
      <div class="ssec">
        <h3>Save a backup</h3>
        <div class="snote">One file with your play history, "I have it" / "Not this one" marks and links, dislikes, favorites, categories, the remembered playlist songs, and the playlist's original order. Settings stay with each device.</div>
        <div class="brow"><button type="button" class="ctl primary" id="bkdown">Download backup</button><button type="button" class="ctl" id="bkcopy">Copy backup</button></div>
        <div class="bmsg" id="bkoutmsg" role="status"></div>
      </div>
      <div class="ssec">
        <h3>Bring in a backup</h3>
        <div class="snote">From another device or an earlier backup. Nothing changes until you choose Merge or Replace.</div>
        <div class="brow"><button type="button" class="ctl" id="bkpick">Choose backup file</button>
          <input type="file" id="bkfile" accept=".json,application/json,text/plain" hidden></div>
        <details class="sdet"><summary>Or paste a copied backup</summary>
          <textarea id="bkpaste" spellcheck="false" placeholder="Paste the copied backup here"></textarea>
          <div class="brow" style="margin-top:.4rem"><button type="button" class="ctl" id="bkread">Read pasted backup</button></div>
        </details>
        <div class="bmsg" id="bkinmsg" role="status"></div>
        <div id="bkpreview"></div>
      </div>
      <div class="ssec" id="bkundo" hidden>
        <h3>Undo</h3>
        <div class="brow"><span class="bmsg" id="bkundotext"></span><button type="button" class="ctl" id="bkundobtn">Undo last import</button></div>
      </div>
    </div>
  </dialog>
  <dialog id="shufbox" aria-labelledby="shtitle">
    <div class="shead"><h2 id="shtitle">Shuffle ${PLAYLIST_NAME}</h2><button type="button" class="ctl" id="shclose">Close</button></div>
    <div id="shufbody"></div>
  </dialog>
  <dialog id="statsbox" aria-labelledby="statstitle">
    <div class="shead"><h2 id="statstitle">Stats</h2><button type="button" class="ctl" id="statsclose">Close</button></div>
    <div id="statsbody"></div>
  </dialog>`;
  const $ = sel => root.querySelector(sel);
  $('h1').textContent = stationName;

  /* ----- State ----- */
  const FILTERS = [['all', 'All'], ['none', 'Not in playlist'], ['other', 'Other version'], ['have', 'In playlist'], ['disliked', 'Disliked']];
  let songsFrom = 'page', items = [], hiddenCount = 0, playlistAt = 0, playlistError = '', loading = true, nowAt = null;
  // Status chips toggle; an empty set means "All". Remembered on this device.
  const STATUS_KEYS = ['none', 'other', 'have', 'disliked'];
  let filters = new Set(keep(GM_getValue('filters', []) || [], k => STATUS_KEYS.indexOf(k) >= 0));
  function toggleFilter(key) {
    if (key === 'all') filters.clear();
    else if (filters.has(key)) filters.delete(key);
    else filters.add(key);
    if (filters.size === STATUS_KEYS.length) filters.clear();   // every chip on is the same as All
    GM_setValue('filters', [...filters]);
    page = 0;
    render();
  }
  let latestOnly = GM_getValue('latestOnly', false) === true;   // one card per song: its most recent play
  let live = GM_getValue('live', true);
  let pageSize = GM_getValue('pageSize', 50);
  if (PAGE_SIZES.indexOf(pageSize) < 0) pageSize = 50;
  let page = 0;

  function getMarks() { const m = GM_getValue('marks', {}); return m && typeof m === 'object' ? m : {}; }
  function setMark(key, v, id) {
    const m = getMarks(); if (v) m[key] = id ? { v, at: Date.now(), id } : { v, at: Date.now() }; else delete m[key]; GM_setValue('marks', m);
    statusCache.delete(key);   // only this song can change, so only it is matched again
  }

  // Songs you dislike, kept apart from the have/not marks so Undo restores the card exactly
  function getDislikes() { const d = GM_getValue('dislikes', {}); return d && typeof d === 'object' ? d : {}; }
  function setDislike(key, on) {
    const d = getDislikes(); if (on) d[key] = Date.now(); else delete d[key]; GM_setValue('dislikes', d);
    statusCache.delete(key);
  }

  // Favorites are playlist videos (by video id), so every SomaFM song linked to one shares its star.
  // Removing one keeps it as on: false, so a backup merge from another device doesn't bring it back.
  let favCache = null;   // read once; cleared when a backup import or undo changes it
  function getFavs() {
    if (!favCache) { const f = GM_getValue('favorites', {}); favCache = f && typeof f === 'object' && !Array.isArray(f) ? f : {}; }
    return favCache;
  }
  const isFav = (favs, id) => !!(id && favs[id] && favs[id].on);
  function setFav(id, on) { const f = Object.assign({}, getFavs()); f[id] = { on, at: Date.now() }; favCache = f; GM_setValue('favorites', f); }
  // The star button: ☆ to add, ⭐ to remove
  // Stars and categories change in place (every card or Stats row for that video), without redrawing the list,
  // so they respond at once. Nothing else on a card depends on them.
  const sameVideo = (sel, id) => keep([...root.querySelectorAll(sel)], x => x.dataset.vid === id);
  function showFav(b, on) {
    b.textContent = on ? '⭐' : '☆';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', (on ? 'Remove from favorites: ' : 'Add to favorites: ') + b.dataset.name);
    b.title = on ? 'Favorite. Tap to remove.' : 'Add to favorites';
  }
  function favBtn(id, title) {
    const b = el('button', 'fav'); b.type = 'button';
    b.dataset.vid = id; b.dataset.name = title;
    b.onclick = () => {
      const on = !isFav(getFavs(), id);
      setFav(id, on);
      for (const x of sameVideo('button.fav', id)) showFav(x, on);
    };
    showFav(b, isFav(getFavs(), id));
    return b;
  }

  // Categories, also by playlist video id: { c, at }, with c '' once cleared (so a merge doesn't bring it back).
  // Stored by these keys, so the names can change.
  // Key, name, and the shorter name on the filter chips (Soul/Funk's chip is "Funk" below desktop width)
  const CATEGORIES = [['band', 'Band/Swing', 'Swing'], ['classics', 'Classics', 'Classics'], ['dance', 'Dance', 'Dance'], ['jazz', 'Jazz/Piano', 'Jazz'], ['mellow', 'Mellow', 'Mellow'], ['soul', 'Soul/Funk', 'Funk']];
  const catName = c => { for (const [k, name] of CATEGORIES) if (k === c) return name; return ''; };
  let catCache = null;
  function getCats() {
    if (!catCache) { const f = GM_getValue('categories', {}); catCache = f && typeof f === 'object' && !Array.isArray(f) ? f : {}; }
    return catCache;
  }
  const catOf = (cats, id) => (id && cats[id] && catName(cats[id].c) ? cats[id].c : '');
  function setCat(id, c) { const f = Object.assign({}, getCats()); f[id] = { c, at: Date.now() }; catCache = f; GM_setValue('categories', f); }
  function catSelect(id, title) {
    const sel = el('select', 'cat');
    sel.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Category…' }));
    for (const [k, name] of CATEGORIES) sel.append(Object.assign(document.createElement('option'), { value: k, textContent: name }));
    sel.value = catOf(getCats(), id);
    sel.classList.toggle('set', !!sel.value);
    sel.setAttribute('aria-label', 'Category: ' + title);
    sel.dataset.vid = id;
    sel.onblur = () => { if (renderPending && !pickerKey && !$('#statsbox').open) { renderPending = false; setTimeout(render, 50); } };
    sel.onchange = () => {
      setCat(id, sel.value);
      for (const x of sameVideo('select.cat', id)) { x.value = sel.value; x.classList.toggle('set', !!sel.value); }
      refreshCatCounts();
    };
    return sel;
  }
  // Category chips (3.17): only songs in the playlist have a category. None on means no category filter;
  // 'uncat' is "No category". Remembered on this device.
  let catFilters = new Set(keep(GM_getValue('catFilters', []) || [], k => k === 'uncat' || !!catName(k)));
  function toggleCatFilter(key) {
    if (catFilters.has(key)) catFilters.delete(key); else catFilters.add(key);
    GM_setValue('catFilters', [...catFilters]);
    page = 0;
    render();
  }
  // The listed playlist videos, one per card, so the chip counts can follow a category change without a redraw
  let catRowVids = [], catCountEls = new Map();
  function catCounts() {
    const cats = getCats(), n = new Map();
    for (const v of catRowVids) { const k = catOf(cats, v) || 'uncat'; n.set(k, (n.get(k) || 0) + 1); }
    return n;
  }
  // "None" is hidden once every song has a category, unless it's on (else there'd be no way to turn it off)
  const hideNone = (b, n) => { b.hidden = !n && !catFilters.has('uncat'); };
  function refreshCatCounts() {
    const n = catCounts();
    for (const [k, e] of catCountEls) { e.textContent = fmt(n.get(k) || 0); if (k === 'uncat') hideNone(e.parentNode, n.get(k) || 0); }
  }

  /* ----- Playlist memory: titles of every song seen, so ones that disappear can still be named ----- */
  const AKEY = 'archive:' + PLAYLIST_ID;
  const OKEY = 'shuffle:original:' + PLAYLIST_ID;   // the playlist's order before it was first shuffled
  let archive = GM_getValue(AKEY, {});
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) archive = {};
  let archiveNote = '', goneCache = null, goneOpen = false;
  const goneItems = () => goneCache || (goneCache = Archive.goneList(archive));
  function dismissGone(id) {
    archive = Archive.dismiss(archive, id, Date.now()); GM_setValue(AKEY, archive);
    goneCache = null; statusCache.clear(); render();
  }

  /* ----- Play history, saved on this device per channel ----- */
  const HKEY = 'history:' + channel;
  let history = GM_getValue(HKEY, []);
  if (!Array.isArray(history)) history = [];
  // Plays saved with a future date (a SomaFM feed glitch, or merged in from a backup) would block new plays
  function clearFuture() {
    const clean = History.dropFuture(history, Date.now() / 1000);
    if (clean !== history) { history = clean; GM_setValue(HKEY, history); }
  }
  clearFuture();
  // Station ID / break start times: never shown, only used to end the song before them (song lengths)
  const BKEY = 'breaks:' + channel, BREAKS_MAX = 2000;
  let breaks = GM_getValue(BKEY, []);
  if (!Array.isArray(breaks)) breaks = [];
  let measured = null;   // song key -> seconds it ran on SomaFM; rebuilt when history or breaks change
  // A song's length: your playlist video's when it's that recording, otherwise measured from SomaFM's play times
  function songLength(key, r) {
    if (r && r.status === 'have' && r.item && Number(r.item.secs) > 0) return { secs: Number(r.item.secs), measured: false };
    if (!measured) measured = History.measuredLengths(history, breaks, Matcher.markKey);
    const m = measured.get(key);
    return m ? { secs: m, measured: true } : null;
  }
  function lengthTag(key, r) {
    const l = songLength(key, r);
    if (!l) return null;
    const t = el('span', 'len', ' · ' + (l.measured ? '~' : '') + History.formatClock(l.secs));
    t.title = l.measured ? 'Measured from when SomaFM started this song and the next one' : 'Length of your playlist video';
    return t;
  }
  let rowBase = null;   // display rows built from history; rebuilt only when history changes
  let playCounts = new Map();          // song key -> plays recorded
  const openLogs = new Set();          // cards whose play history is open (key@time), kept across refreshes
  function baseRows() {
    if (rowBase) return rowBase;
    if (!history.length) {
      rowBase = mapOf(tableSongs, t => ({ artist: t.artist, title: t.title, album: t.album, time: t.time, key: Matcher.markKey(t.artist, t.title) }));
    } else {
      rowBase = mapOf(history, p => ({ at: p[0], artist: p[1], title: p[2], album: p[3], gap: !!p[4], key: Matcher.markKey(p[1], p[2]) }));
    }
    playCounts = new Map();
    for (let i = 0; i < rowBase.length; i++) if (rowBase[i].at != null) playCounts.set(rowBase[i].key, (playCounts.get(rowBase[i].key) || 0) + 1);
    return rowBase;
  }

  /* ----- Data: song history (SomaFM's own feed, same site) ----- */
  async function loadSongs() {
    try {
      const r = await fetch(`/songs/${channel}.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      // "Now" from SomaFM's server clock when it sends one, so a device clock that's off doesn't move real plays
      const served = Date.parse(r.headers.get('Date') || '');
      const nowS = (isFinite(served) ? served : Date.now()) / 1000;
      const fetched = History.fromFeed(data.songs, nowS);
      if (fetched.length) nowAt = fetched[0][0];
      const m = History.merge(history, fetched, HISTORY_MAX);
      if (m.added) { history = m.plays; rowBase = null; measured = null; GM_setValue(HKEY, history); }
      const nb = History.mergeBreaks(breaks, History.breaksFromFeed(data.songs, nowS), BREAKS_MAX);
      if (nb !== breaks) { breaks = nb; measured = null; GM_setValue(BKEY, breaks); }
      songsFrom = 'live';
    } catch (e) {
      if (songsFrom !== 'live') songsFrom = 'page';
    }
  }

  /* ----- Data: your YouTube playlist ----- */
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const why = r => keep([r && r.error, r && r.status ? 'status ' + r.status : '', r && r.finalUrl ? 'at ' + r.finalUrl : ''], Boolean)
    .join(', ') || 'no details from Tampermonkey';
  function gmGet(url) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'GET', url, anonymous: true, headers: { 'Accept-Language': 'en-US,en', 'User-Agent': DESKTOP_UA },
      onload: r => r.status === 200 ? res(r.responseText) : rej(new Error('YouTube returned ' + r.status)),
      onerror: r => rej(new Error('network error (' + why(r) + ')')),
      ontimeout: () => rej(new Error('timed out')), timeout: 20000
    }));
  }
  function gmPost(url, body) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'POST', url, anonymous: true, data: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'User-Agent': DESKTOP_UA },
      onload: r => r.status === 200 ? res(JSON.parse(r.responseText)) : rej(new Error('YouTube returned ' + r.status)),
      onerror: r => rej(new Error('network error (' + why(r) + ')')), timeout: 20000
    }));
  }
  const fetchPlaylist = () => Reader.read(gmGet, gmPost);

  // Waits (ms) before each retry when a read comes back short or fails
  const RETRY_WAITS = [5000, 15000];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // One read at a time: a timer tick or Refresh during a read (and its retries) waits for it
  let playlistRead = null;
  function loadPlaylist(force) {
    if (!playlistRead) playlistRead = readPlaylistNow(force).finally(() => { playlistRead = null; });
    return playlistRead;
  }
  // Matching every song again takes seconds on a tablet, so the saved matches are kept unless the playlist
  // really changed. (Each read of the saved copy is a new object, so comparing objects always said "changed",
  // and every minute's check threw all the matches away.)
  function samePlaylist(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.id !== y.id || x.title !== y.title || x.ch !== y.ch || (x.secs || 0) !== (y.secs || 0)) return false;
    }
    return true;
  }
  function useItems(list) {
    if (samePlaylist(items, list)) return;
    items = list; statusCache.clear();
  }
  const goneSig = () => mapOf(goneItems(), g => g.id).join();
  async function readPlaylistNow(force) {
    const cached = GM_getValue('playlist', null);
    if (!force && cached && cached.schema === CACHE_SCHEMA && Array.isArray(cached.items) && Date.now() - cached.at < CACHE_MINUTES * 60000) {
      useItems(cached.items); hiddenCount = cached.hidden || 0; playlistAt = cached.at; playlistError = ''; return;
    }
    try {
      const prevItems = cached && cached.schema === CACHE_SCHEMA && Array.isArray(cached.items) ? cached.items : null;
      const fresh = await Reader.readRetry(fetchPlaylist, f => f.complete && Reader.consistent(f.items, prevItems), RETRY_WAITS, sleep);
      if (!fresh.complete && prevItems && prevItems.length > fresh.items.length) {
        // Still short after the retries: keep the fuller last read, and leave its time so the next check tries again
        useItems(prevItems); hiddenCount = cached.hidden || 0; playlistAt = cached.at; playlistError = '';
        archiveNote = `YouTube gave only ${fresh.read} of ${fresh.expected || 'all'} playlist songs after ${RETRY_WAITS.length + 1} tries, so the previous read is still used. It tries again on the next check, or use Refresh.`;
        return;
      }
      if (!Reader.consistent(fresh.items, prevItems)) {
        const n = Reader.repeats(fresh.items) - Reader.repeats(prevItems || []);
        if (prevItems && prevItems.length) {
          // Keep the last good read (only the order changes in a reorder, and order doesn't affect matching).
          // Its time is moved on so the next try is in CACHE_MINUTES, not every minute; Refresh tries now.
          useItems(prevItems); hiddenCount = cached.hidden || 0; playlistAt = Date.now(); playlistError = '';
          GM_setValue('playlist', Object.assign({}, cached, { at: playlistAt }));
          archiveNote = `YouTube's playlist pages disagreed this time (${n} song${n === 1 ? '' : 's'} came back twice and others not at all), which happens for a while after the playlist is reordered. The previous read is still used; it tries again in ${CACHE_MINUTES} minutes, or use Refresh.`;
          return;
        }
        fresh.complete = false;   // nothing to fall back on: show it, but never mark songs gone from it
      }
      useItems(fresh.items); hiddenCount = fresh.hidden; playlistAt = Date.now(); playlistError = '';
      GM_setValue('playlist', { schema: CACHE_SCHEMA, at: playlistAt, items, hidden: hiddenCount });
      // Remember every song, and notice any that have left the playlist since the last read,
      // but only from a complete read: songs a short read missed aren't gone
      if (!fresh.complete) {
        archiveNote = `Only ${fresh.read} of ${fresh.expected || 'all'} playlist songs could be read this time; songs past that aren't checked, and none were marked as gone.`;
      } else {
        const u = Archive.update(archive, items, playlistAt);
        if (u.refused) archiveNote = `This playlist read looked incomplete (${u.refused} songs missing at once), so none were marked as gone.`;
        else {
          const was = goneSig();
          archiveNote = ''; archive = u.archive; GM_setValue(AKEY, archive); goneCache = null;
          if (goneSig() !== was) statusCache.clear();   // songs gone (or back) are labeled differently
        }
      }
    } catch (e) {
      // Refuse and report: never label songs from a playlist we couldn't read
      items = []; playlistError = e.message; statusCache.clear();
    }
  }

  /* ----- Rendering ----- */
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // "Working…" shows (after a short delay, so quick actions don't flicker) while an action runs.
  // The action starts after the browser has had a chance to paint the indicator.
  let busyCount = 0;
  const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  async function runBusy(fn, ev) {
    const target = ev && ev.currentTarget;
    busyCount++; root.host.classList.add('working');
    if (target && target.setAttribute) target.setAttribute('aria-busy', 'true');
    try { await nextPaint(); await fn(ev); }
    finally {
      if (target && target.removeAttribute) target.removeAttribute('aria-busy');
      if (--busyCount <= 0) { busyCount = 0; root.host.classList.remove('working'); }
    }
  }
  const btn = (text, cls, onclick) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = e => runBusy(onclick, e); return b; };
  const link = (text, href, extra) => { const a = el('a', 'btn go' + (extra ? ' ' + extra : ''), text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };

  // Each distinct song is matched once; cleared when the playlist or your marks change
  const statusCache = new Map();
  function statusOf(row, marks, dislikes) {
    if (playlistError || !items.length) return { status: 'unknown' };
    let r = statusCache.get(row.key);
    if (!r) {
      r = Matcher.applyMark(Matcher.check(row.artist, row.title, items), marks[row.key], !!dislikes[row.key], items);
      r = Archive.applyGone(r, row.artist, row.title, goneItems());
      statusCache.set(row.key, r);
    }
    return r;
  }
  const STATUS_TEXT = { have: 'In playlist', other: 'Other version', none: 'Not in playlist', gone: 'Gone from playlist', disliked: 'Disliked', unknown: '' };
  // "Not in playlist" chip also shows songs gone from the playlist: both are songs to go find
  const inGroup = (status, key) => status === key || (key === 'none' && status === 'gone');
  const fmt = n => n.toLocaleString('en-US');

  /* ----- Header buttons: full or short labels, beside the title or on their own row ----- */
  // Both labels are always in the button; the header's "compact" class shows the short one.
  // aria-label keeps the full wording for screen readers either way.
  function setLabel(b, full, short) {
    if (b.dataset.full === full && b.dataset.short === short) return;
    b.dataset.full = full; b.dataset.short = short;
    b.textContent = '';
    b.append(el('span', 'lbl-full', full), el('span', 'lbl-short', short));
    b.setAttribute('aria-label', full);
    queueFit();
  }
  let fitQueued = false;
  function queueFit() { if (!fitQueued) { fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitHeader(); }); } }
  // Natural (one-line) width of an element's content
  function natural(elm) { const r = document.createRange(); r.selectNodeContents(elm); return r.getBoundingClientRect().width; }
  function fitHeader() {
    const head = root.querySelector('header'), btns = root.querySelector('header .btns');
    if (!head || !head.clientWidth) return;
    const cs = getComputedStyle(head), gap = parseFloat(cs.columnGap) || 0;
    const width = head.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    head.classList.add('measure');
    const titleW = Math.max(natural($('h1')), natural($('.sub')));
    head.classList.remove('compact');
    const fullW = btns.scrollWidth;
    head.classList.add('compact');
    const shortW = btns.scrollWidth;
    head.classList.remove('measure');
    const statsW = $('#stats').getBoundingClientRect().width;
    const roomFor = w => titleW + gap + Math.max(w, statsW) <= width;
    const besideFull = roomFor(fullW), besideShort = roomFor(shortW);
    head.classList.toggle('compact', !besideFull && (besideShort || fullW > width));
    head.classList.toggle('stacked', !besideFull && !besideShort);
  }
  if (typeof ResizeObserver === 'function') {
    let lastW = 0;
    new ResizeObserver(entries => { const w = Math.round(entries[0].contentRect.width); if (w !== lastW) { lastW = w; queueFit(); } }).observe(root.host);
  } else window.addEventListener('resize', queueFit);

  /* ----- "Which playlist song is it?" panel, opened by "I have it" or "Link song" ----- */
  let pickerKey = null, pickerShown = false, flashKey = null;
  function picker(s, r) {
    const box = el('div', 'picker');
    const choices = el('div', 'choices');
    const label = el('div', 'sub2');
    const input = document.createElement('input');
    input.type = 'search'; input.id = 'xm-pick'; input.placeholder = 'Search your playlist'; input.autocomplete = 'off';
    // Show the choice as linked for a moment before the panel closes, so it's clear it worked
    let chosen = false;
    const fixing = r.status === 'have' && !r.marked;   // correcting a wrong automatic match
    const choose = (it, b) => {
      if (chosen) return;
      chosen = true;
      b.classList.add('chosen');
      b.prepend(el('span', 'tick', '✓ Linked · '));
      for (const other of choices.querySelectorAll('.choice')) if (other !== b) other.disabled = true;
      input.disabled = true;
      setTimeout(() => {
        setMark(s.key, 'have', it.id);
        pickerKey = null;
        flashKey = s.key;
        render();
        setTimeout(() => { flashKey = null; for (const f of root.querySelectorAll('li.flash')) f.classList.remove('flash'); }, 1600);
      }, 850);
    };
    function fill() {
      const q = input.value.trim();
      let list = q ? Matcher.searchItems(q, items, 40) : Matcher.suggest(s.artist, s.title, items, 6);
      // The card's closest match goes first, so confirming it is one tap; when fixing a wrong match, it's left out
      if (!q && r.item && fixing) list = keep(list, it => it.id !== r.item.id);
      else if (!q && r.item && !r.linked) list = [r.item].concat(keep(list, it => it.id !== r.item.id)).slice(0, 6);
      label.textContent = q ? `Matching "${q}"` : 'Closest matches';
      choices.textContent = '';
      if (!list.length) choices.append(el('div', 'pempty', q ? 'No playlist songs match that search.' : 'No close matches. Search your playlist above.'));
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const b = btn('', 'choice', () => choose(it, b));
        b.append(it.title);
        if (it.ch) b.append(el('small', '', it.ch.replace(/\s*-\s*Topic$/, '')));
        choices.append(b);
      }
    }
    input.addEventListener('input', fill);   // updates only the list, so typing keeps focus
    const unlinked = btn(r.marked === 'have' ? 'Keep without linking' : 'Mark without linking', 'ctl', () => {
      if (r.marked !== 'have') setMark(s.key, 'have'); pickerKey = null; render();
    });
    const cancel = btn('Cancel', 'ctl', () => { pickerKey = null; render(); });
    const btns = el('div', 'pbtns');
    // "Without linking" would keep the wrong match; offer "not in playlist" instead
    if (fixing) btns.append(btn('✗ Not in playlist', 'marknot', () => { setMark(s.key, 'not'); pickerKey = null; render(); }), cancel);
    else btns.append(unlinked, cancel);
    box.append(el('div', 'ph', 'Which playlist song is it?'), input, label, choices, btns);
    fill();
    return box;
  }

  // Background refreshes wait while the song picker or the Stats panel is open
  let renderPending = false;
  function quietRender() {
    const statsOpen = $('#statsbox').open || $('#backupbox').open || $('#shufbox').open;
    // Not while a category drop-down is open or focused either: redrawing would close it
    const choosing = root.activeElement && root.activeElement.tagName === 'SELECT';
    if (pickerKey || statsOpen || choosing) { renderPending = true; return; }
    render();
  }

  // One song's play log: each play with the time since the previous one; * marks a recording gap in between
  function playLogBox(cls, times, gapTimes, thisAt) {
    const box = el('div', cls), ul = el('ul', '');
    let gaps = false;
    for (const e of Stats.playLog(times, gapTimes)) {
      if (e.spansGap) gaps = true;
      const it = el('li', (e.spansGap ? 'gapped' : '') + (e.at === thisAt ? ' this' : ''));
      it.append(el('b', '', History.formatDate(e.at) + ' ' + History.formatTime(e.at)), ' ',
        el('span', '', e.first ? 'first recorded' : Stats.formatSpan(e.since) + (e.spansGap ? '*' : '')));
      ul.append(it);
    }
    box.append(ul, el('p', 'plegend', 'Time since the previous play.' + (gaps ? ' * A recording gap falls in between, so plays may have been missed.' : '')));
    return box;
  }

  function render() {
    const marks = getMarks(), dislikes = getDislikes();
    const base = baseRows();
    let rows = mapOf(base, s => ({ s, r: statusOf(s, marks, dislikes) }));
    if (latestOnly) { const seen = new Set(); rows = keep(rows, x => { if (seen.has(x.s.key)) return false; seen.add(x.s.key); return true; }); }

    const st = $('.status');
    st.className = 'status' + (playlistError ? ' err' : '');
    if (playlistError) st.textContent = `Couldn't read "${PLAYLIST_NAME}": ${playlistError}. Songs aren't labeled until it can be read.`;
    else if (loading) st.textContent = `Reading "${PLAYLIST_NAME}"…`;
    else {
      const mins = Math.round((Date.now() - playlistAt) / 60000);
      st.textContent = '';
      st.append(el('b', '', PLAYLIST_NAME), ` · ${items.length} songs${hiddenCount ? ` (${hiddenCount} unavailable left out)` : ''} · checked ${mins < 1 ? 'just now' : mins + ' min ago'}` +
        (songsFrom === 'page' ? ' · live feed unavailable' : ''));
    }
    setLabel($('#refresh'), 'Refresh playlist', 'Refresh');
    const liveBtn = $('#live');
    setLabel(liveBtn, 'Live updates: ' + (live ? 'On' : 'Off'), 'Live: ' + (live ? 'On' : 'Off'));
    liveBtn.setAttribute('aria-pressed', String(live));
    const aw = $('#awake');
    const awState = !wakeApi() ? ['Not supported', 'N/A'] : !keepAwake ? ['Off', 'Off'] : wakeError ? ['Blocked', 'Blocked'] : wakeLock ? ['On', 'On'] : ['Waiting', 'Waiting'];
    setLabel(aw, 'Keep screen on: ' + awState[0], 'Awake: ' + awState[1]);
    aw.setAttribute('aria-pressed', String(keepAwake && !!wakeApi()));
    aw.disabled = !wakeApi();
    aw.title = !wakeApi() ? "This browser can't keep the screen on for a page."
      : wakeError ? `The browser refused: ${wakeError}. Tap to try again.`
      : keepAwake ? 'Holds while this page is the visible tab. Turns back on when you return to it.' : '';

    const f = $('.filters');
    f.textContent = '';
    if (!playlistError && items.length) {
      for (const [key, label] of FILTERS) {
        const n = key === 'all' ? rows.length : keep(rows, x => inGroup(x.r.status, key)).length;
        const b = btn('', '', () => toggleFilter(key));
        b.append(label + ' ', el('span', 'n', fmt(n)));
        b.setAttribute('aria-pressed', String(key === 'all' ? filters.size === 0 : filters.has(key)));
        f.append(b);
      }
      const one = btn('Latest', 'one', () => { latestOnly = !latestOnly; GM_setValue('latestOnly', latestOnly); page = 0; render(); });
      one.setAttribute('aria-pressed', String(latestOnly));
      one.title = 'One card per song, at its most recent play';
      f.append(one);
    }
    const cf = $('.catf'), inList = x => x.r.status === 'have' && x.r.item;
    cf.textContent = '';
    catRowVids = mapOf(keep(rows, inList), x => x.r.item.id);
    catCountEls = new Map();
    if (!playlistError && items.length) {
      const n = catCounts();
      for (const [key, , label] of CATEGORIES.concat([['uncat', '', 'None']])) {
        const b = btn('', '', () => toggleCatFilter(key)), c = el('span', 'n', fmt(n.get(key) || 0));
        const name = el('span', '');   // one flex item, so the button's gap doesn't split "Soul/" from "Funk"
        if (key === 'soul') name.append(el('span', 'wide', 'Soul/'));
        name.append(label);
        b.append(name, c);
        b.setAttribute('aria-pressed', String(catFilters.has(key)));
        catCountEls.set(key, c);
        if (key === 'uncat') hideNone(b, n.get(key) || 0);
        cf.append(b);
      }
    }

    let shownAll = filters.size === 0 || playlistError ? rows : keep(rows, x => filters.has(x.r.status) || (x.r.status === 'gone' && filters.has('none')));
    if (catFilters.size && !playlistError) { const cats = getCats(); shownAll = keep(shownAll, x => inList(x) && catFilters.has(catOf(cats, x.r.item.id) || 'uncat')); }
    const pages = Math.max(1, Math.ceil(shownAll.length / pageSize));
    if (page > pages - 1) page = pages - 1;
    const shown = shownAll.slice(page * pageSize, (page + 1) * pageSize);

    const ol = $('ol');
    ol.textContent = '';
    pickerShown = false;
    if (!shown.length) ol.append(el('li', 'empty', base.length ? 'No songs in this group.' : 'No recently played songs found.'));
    for (let i = 0; i < shown.length; i++) {
      const { s, r } = shown[i];
      const li = el('li', r.status);
      if (flashKey && s.key === flashKey) li.classList.add('flash');
      const isNow = s.at != null ? s.at === nowAt : s === base[0];
      if (isNow) li.classList.add('now');
      const time = el('div', 'time');
      if (isNow) time.append(el('span', 'live', 'Now'));
      if (s.at != null) time.append(el('span', 'date', History.formatDate(s.at) + ' '), History.formatTime(s.at));
      else time.append(s.time);
      // Songs heard more than once: a link under the time opens this song's whole play history
      const nPlays = s.at != null ? (playCounts.get(s.key) || 0) : 0;
      const logKey = s.key + '@' + s.at;
      if (nPlays > 1) {
        const open = openLogs.has(logKey);
        const hl = btn('', 'histbtn', () => { if (openLogs.has(logKey)) openLogs.delete(logKey); else openLogs.add(logKey); render(); });
        hl.append(el('span', 'caret', open ? '▾' : '▸'), ` ${nPlays} plays`);
        hl.setAttribute('aria-expanded', String(open));
        hl.setAttribute('aria-label', `${nPlays} plays of ${s.title}: ${open ? 'hide' : 'show'} play history`);
        time.append(hl);
      }
      const song = el('div', 'song');
      const names = el('div', 'names');
      const artist = el('div', 'artist', s.artist);
      const len = lengthTag(s.key, r);
      if (len) artist.append(len);
      const ttl = el('div', 'title', s.title);
      // A star for songs in your playlist: it marks the playlist video, which Shuffle spreads out
      if (r.status === 'have' && r.item) ttl.append(' ', favBtn(r.item.id, s.title));
      names.append(ttl, artist);
      song.append(names);
      // "Open" always sits beside the song name: your matching video, or the version you have, to compare
      // Hidden while you've marked the song "not this one"; Undo brings it back
      if (r.item && r.status !== 'unknown' && r.status !== 'gone' && r.marked !== 'not' && !r.disliked) {
        song.append(link('Open', `https://www.youtube.com/watch?v=${r.item.id}&list=${PLAYLIST_ID}`, 'open'));
      }
      if (s.album) song.append(el('div', 'album', s.album));
      li.append(time, song);

      if (r.status !== 'unknown') {
        const state = el('div', 'state');
        const key = s.key;
        const search = link('Search YouTube', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(Matcher.searchQuery(s.artist, s.title)));
        const markHave = btn('✓ I have it', 'mark', () => { pickerKey = key; render(); });
        const linkBtn = btn('Link song', 'ctl', () => { pickerKey = key; render(); });
        const markNot = btn('✗ Not this one', 'marknot', () => { setMark(key, 'not'); render(); });
        const undo = btn('Undo', 'undo', () => { setMark(key, null); render(); });
        const dislike = btn('👎 Dislike', 'dislike', () => { setDislike(key, true); render(); });
        if (r.disliked) {
          state.append(el('span', 'pill', '👎 Disliked'), search, btn('Undo', 'undo', () => { setDislike(key, false); render(); }));
        } else if (r.marked === 'have' && r.linkMissing) {
          state.append(el('span', 'pill', '✓ In playlist · marked'), linkBtn, undo);
        } else if (r.marked === 'have' && r.linked) {
          // Two-level undo: Unlink keeps "I have it"; the next Undo clears it
          state.append(el('span', 'pill', '✓ In playlist · linked'), btn('Unlink', 'undo', () => { setMark(key, 'have'); render(); }), catSelect(r.item.id, s.title));
        } else if (r.marked === 'have') {
          state.append(el('span', 'pill', '✓ In playlist · marked'), linkBtn, undo);
        } else if (r.marked === 'not') {
          state.append(el('span', 'pill', '✗ Not in playlist · marked'), search, undo, dislike);
        } else if (r.status === 'have') {
          // An automatic match can be wrong: link the right video, or say it isn't in the playlist
          state.append(el('span', 'pill', '✓ In playlist'), btn('Wrong video?', 'ctl', () => { pickerKey = key; render(); }), catSelect(r.item.id, s.title));
        } else if (r.status === 'gone') {
          state.append(el('span', 'pill', '⚠ Gone from playlist'), search, markHave);
        } else if (r.status === 'other') {
          state.append(el('span', 'pill', r.reason === 'sameArtistOtherMix' ? '≈ Different mix' : '≈ Other version'), search, markHave, markNot);
        } else {
          state.append(el('span', 'pill', '✗ Not in playlist'), search, markHave, dislike);
        }
        li.append(state);
        if (r.linkMissing) {
          const was = archive[r.linkId];
          li.append(el('div', 'note warn', (was ? `The song you linked, ${was.title}, is gone from your playlist.` : 'The song you linked is no longer in your playlist.') +
            ' Undo, or Link song again.'));
        } else if (r.item && r.marked !== 'not' && !r.disliked && (r.status !== 'have' || r.marked)) {
          li.append(el('div', 'note', (r.status === 'gone' ? 'You had: ' : r.linked ? 'Linked to: ' : r.marked ? 'Closest match: ' : 'You have: ') + r.item.title +
            (r.item.ch ? ' — ' + r.item.ch.replace(/\s*-\s*Topic$/, '') : '')));
        }
        if (pickerKey === key && !pickerShown) { pickerShown = true; li.append(picker(s, r)); }
      }
      if (nPlays > 1 && openLogs.has(logKey)) {
        const { times, gapTimes } = Stats.songTimes(history, s.key);
        li.append(playLogBox('plog cardlog', times, gapTimes, s.at));
      }
      ol.append(li);
      // The page wasn't open between this play and the one below it
      if (s.gap && !latestOnly) ol.append(el('li', 'gap', 'Not recording here — plays in this stretch were missed'));
    }

    // Songs gone from the playlist
    const an = $('#anote');
    an.hidden = !archiveNote; an.textContent = archiveNote ? '⚠ ' + archiveNote : '';
    const gl = goneItems(), gb = $('#gonebox');
    gb.hidden = !gl.length;
    if (gl.length) {
      gb.open = goneOpen;
      $('#gonesum').textContent = `⚠ ${gl.length} song${gl.length === 1 ? ' is' : 's are'} gone from your playlist`;
      const list = $('#gonelist');
      list.textContent = '';
      list.append(el('div', 'pempty', 'Removed or made unavailable on YouTube. Search to find a new copy, or Dismiss if you removed it on purpose.'));
      for (let i = 0; i < gl.length; i++) {
        const g = gl[i];
        const row = el('div', 'gonerow');
        const t = el('div', 'gt');
        const topic = /\s*-\s*Topic\s*$/i.test(g.ch) ? g.ch.replace(/\s*-\s*Topic\s*$/i, '') : '';
        t.append(el('b', '', g.title), el('small', '', (g.ch ? g.ch.replace(/\s*-\s*Topic\s*$/i, '') + ' · ' : '') + 'last seen ' + History.formatDate(g.last / 1000)));
        const q = (topic + ' ' + g.title).replace(/\.mp3\b|\b(official (music )?video|lyrics?|lyric video|audio only|4k|uhd|flac)\b/gi, ' ');
        row.append(t, link('Search YouTube', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(Matcher.searchQuery('', q))),
          btn('Dismiss', 'ctl', () => dismissGone(g.id)));
        list.append(row);
      }
    }

    // Footer: paging, export, recording summary
    $('#pos').textContent = shownAll.length ? `${fmt(page * pageSize + 1)}–${fmt(page * pageSize + shown.length)} of ${fmt(shownAll.length)}` : '';
    $('#prev').disabled = page === 0;
    $('#next').disabled = page >= pages - 1;
    const per = $('#per');
    if (!per.options.length) for (const n of PAGE_SIZES) per.append(Object.assign(document.createElement('option'), { value: String(n), textContent: String(n) }));
    per.value = String(pageSize);
    $('#csv').disabled = $('#copy').disabled = !history.length;
    const rec = $('#rec');
    if (!history.length) rec.textContent = songsFrom === 'live' ? 'Starting to record plays…' : 'Not recording: the live feed is unavailable.';
    else {
      const gaps = keep(history, p => p[4]).length;
      rec.textContent = `Recording since ${History.formatDate(history[history.length - 1][0])} ${History.formatTime(history[history.length - 1][0])}` +
        ` · ${fmt(history.length)} plays saved` + (gaps ? ` · ${fmt(gaps)} gap${gaps === 1 ? '' : 's'}` : '') +
        ` · keeps the newest ${fmt(HISTORY_MAX)}` + (exportNote ? ` · ${exportNote}` : '');
    }
  }

  /* ----- Stats panel: worked out when it's opened, not on every refresh ----- */
  let topSort = GM_getValue('topSort', 'plays') === 'recent' ? 'recent' : 'plays';
  const STATUS_CHIP = { have: 'In playlist', other: 'Other version', none: 'Not in playlist', gone: 'Gone', disliked: 'Disliked' };
  function openStats() {
    const marks = getMarks(), dislikes = getDislikes();
    const ok = !playlistError && items.length;
    const st = Stats.compute(history, ok ? items : [], (artist, title, key) => ok ? statusOf({ artist, title, key }, marks, dislikes) : { status: 'unknown' });
    const body = $('#statsbody');
    body.textContent = '';
    const sec = (title, ...kids) => { const d = el('div', 'ssec'); d.append(el('h3', '', title), ...kids); body.append(d); return d; };
    const tiles = list => { const g = el('div', 'tiles'); for (const [v, k] of list) { const t = el('div', 'tile'); t.append(el('div', 'v', v), el('div', 'k', k)); g.append(t); } return g; };
    const line = (...parts) => { const d = el('div', 'sline'); d.append(...parts); return d; };
    let logSeq = 0;
    const songRow = (s, extra) => {
      const li = document.createElement('li');
      const nm = el('div', 'nm'); nm.append(s.title);
      if (s.r.status === 'have' && s.r.item) nm.append(' ', favBtn(s.r.item.id, s.title));
      if (STATUS_CHIP[s.r.status]) nm.append(el('span', 'chip ' + s.r.status, STATUS_CHIP[s.r.status]));
      const by = el('small', '', s.artist);
      const len = lengthTag(s.key, s.r);
      if (len) by.append(len);
      nm.append(by);
      const ct = el('div', 'ct');
      const logId = 'plog-' + (++logSeq);
      const toggle = btn('', 'ctbtn', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        let box = root.getElementById ? root.getElementById(logId) : root.querySelector('#' + logId);
        if (open) { if (box) box.hidden = true; return; }
        if (!box) {                                    // built on first open only
          box = playLogBox('plog', s.times, st.gapTimes, null); box.id = logId;
          li.append(box);
        }
        box.hidden = false;
      });
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', logId);
      toggle.setAttribute('aria-label', `${s.count} plays of ${s.title}: show each play`);
      toggle.append(fmt(s.count) + '× ', el('span', 'caret', '▾'));
      ct.append(toggle, el('small', '', ' · last ' + History.formatDate(s.last) + ' ' + History.formatTime(s.last)));
      li.append(nm, ct);
      // Open the playlist video for songs that have one (not for songs marked "not this one", disliked, or gone)
      const r = s.r;
      if (r.item && (r.status === 'have' || r.status === 'other') && r.marked !== 'not' && !r.disliked) {
        li.append(link('Open', `https://www.youtube.com/watch?v=${r.item.id}&list=${PLAYLIST_ID}`, 'small'));
      }
      if (extra) { extra.classList.add('small'); li.append(extra); }
      return li;
    };

    // Your playlist
    const P = st.playlist;
    if (ok) {
      const pl = sec('Your playlist');
      pl.append(tiles([[fmt(P.songs), 'songs'], [History.formatTotal(P.total), 'total length'], [History.formatClock(P.avg), 'average song']]));

      const bar = el('div', 'bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(P.songs)); bar.setAttribute('aria-valuenow', String(P.heard)); bar.setAttribute('aria-label', 'Playlist songs heard');
      const fill = el('div', 'fill'); fill.style.width = (P.songs ? P.heard / P.songs * 100 : 0) + '%'; bar.append(fill);
      const pctHeard = P.songs ? Math.round(P.heard / P.songs * 100) : 0;
      // Caption on the left and the numbers on the right, above a full-width bar
      const head = el('div', 'barhead');
      const lab = el('div', 'barlab'); lab.append(el('b', '', fmt(P.heard)), ' heard · ', el('b', '', pctHeard + '%'), ' of ' + fmt(P.songs));
      head.append(el('div', 'sline', 'Heard on SomaFM so far'), lab);
      const barWrap = el('div', 'barwrap'); barWrap.append(head, bar);
      pl.append(barWrap);
      if (P.longest) pl.append(line('Longest: ', el('b', '', History.formatClock(P.longest.secs)), ' — ' + P.longest.title),
        line('Shortest: ', el('b', '', History.formatClock(P.shortest.secs)), ' — ' + P.shortest.title));
      if (P.unknown) pl.append(el('div', 'snote', `Length unknown for ${fmt(P.unknown)} song${P.unknown === 1 ? '' : 's'}.`));
      if (P.notHeard.length) {
        const det = el('details', 'sdet'); det.append(el('summary', '', `Not heard yet: ${fmt(P.notHeard.length)}`));
        const ul = document.createElement('ul');
        for (const it of P.notHeard) {
          const li = el('li', ''), nh = el('span', 'nh', it.title + ' ');
          nh.append(favBtn(it.id, it.title));
          li.append(nh, link('Open', `https://www.youtube.com/watch?v=${it.id}&list=${PLAYLIST_ID}`, 'small'));
          ul.append(li);
        }
        det.append(ul);
        pl.append(det);
      }
      // Categories: how many of each, and the songs without one (to set them here, heard or not)
      {
        const cats = getCats(), count = new Map(), none = [], seen = new Set();
        for (const it of items) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          const c = catOf(cats, it.id);
          if (c) count.set(c, (count.get(c) || 0) + 1); else none.push(it);
        }
        const parts = [];
        for (const [k, name] of CATEGORIES) if (count.get(k)) parts.push(`${name} ${fmt(count.get(k))}`);
        pl.append(line('Categories: ', parts.length ? parts.join(' · ') : 'none set yet'));
        if (none.length) {
          const det = el('details', 'sdet'); det.append(el('summary', '', `No category yet: ${fmt(none.length)}`));
          const ul = document.createElement('ul');
          for (const it of none) { const li = el('li', ''); li.append(el('span', 'nh', it.title), catSelect(it.id, it.title)); ul.append(li); }
          det.append(ul);
          pl.append(det);
        }
      }
      pl.append(el('div', 'snote', 'Heard counts automatic matches and linked songs. Unlinked "I have it" marks don\'t say which video, so they aren\'t counted.'));
    } else sec('Your playlist', el('div', 'snote', playlistError ? `Couldn't read the playlist: ${playlistError}` : 'Reading the playlist…'));

    if (!st.plays) { sec('SomaFM rotation', el('div', 'snote', 'No plays recorded yet.')); $('#statsbox').showModal ? $('#statsbox').showModal() : $('#statsbox').setAttribute('open', ''); return; }

    // What share of SomaFM's plays you have, don't have, or dislike
    if (ok && st.labeledPlays) {
      const sh = st.shares, pc = v => Math.round(v) + '%';
      const share = sec(`Of everything SomaFM played (${fmt(st.labeledPlays)} plays, ${fmt(st.labeledSongs)} different songs)`);
      const g = el('div', 'tiles');
      for (const [k, label, cls] of [['have', 'in your playlist', 'have'], ['other', 'another version in your playlist', 'other'],
        ['missing', 'not in your playlist', 'none'], ['disliked', 'disliked', 'disliked']]) {
        const t = el('div', 'tile share ' + cls);
        t.append(el('div', 'v', pc(sh[k].playPct)), el('div', 'k', `of plays ${label}`), el('div', 'k2', `${pc(sh[k].songPct)} of songs (${fmt(sh[k].songs)})`));
        g.append(t);
      }
      share.append(g, el('div', 'snote', '"Of plays" counts every play, so often-played songs weigh more; "of songs" counts each different song once. "Not in your playlist" includes songs gone from it.'));
    }

    // Rotation
    const rot = sec('SomaFM rotation');
    rot.append(tiles([[fmt(st.plays), 'plays recorded'], [fmt(st.unique), 'different songs'], [fmt(st.repeated), 'songs played more than once'],
      [st.avgPlays.toFixed(1), 'plays per song']]));
    if (st.rateRepeatSecs) {
      rot.append(line('A song comes back about every ', el('b', '', Stats.formatSpan(st.rateRepeatSecs)), ' of listening.'));
      rot.append(el('div', 'snote', `Worked out from ${Stats.formatSpan(st.coveredSecs)} of recorded time and ${fmt(st.plays)} plays of ${fmt(st.unique)} songs. ` +
        'Only recorded time and the plays in it are counted, so gaps in recording don\'t skew it.'));
      const parts = [];
      if (st.repeatIntervals) parts.push(`back-to-back recorded replays average ${Stats.formatSpan(st.avgRepeatSecs)} (median ${Stats.formatSpan(st.medianRepeatSecs)}, ${fmt(st.repeatIntervals)} replays), which runs short because gaps tend to fall in the longer intervals`);
      if (st.repeatsSpanningGap) parts.push(`replays across a gap average ${Stats.formatSpan(st.avgGapRepeatSecs)} (${fmt(st.repeatsSpanningGap)}), which runs long because plays inside the gap were missed`);
      if (parts.length) rot.append(el('div', 'snote', 'Measured directly: ' + parts.join('; ') + '.'));
    }
    const pct = st.recent ? Math.round(st.recentFirsts / st.recent * 100) : 0;
    rot.append(line(`Of the last ${fmt(st.recent)} plays, `, el('b', '', `${fmt(st.recentFirsts)} (${pct}%)`), ' were songs heard for the first time.'),
      el('div', 'snote', 'As this drops toward zero, you\'ve seen nearly all of the rotation.'));

    // Top 10, by plays or by most recent replay
    const t10 = el('div', 'ssec'); body.append(t10);
    const head = el('div', 'sechead');
    const h3 = el('h3', '');
    const seg = el('div', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Sort');
    const ol1 = el('ol', 'slist');
    function fillTop() {
      const recent = topSort === 'recent';
      h3.textContent = recent ? 'Most recently replayed' : 'Most played';
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === topSort));
      ol1.textContent = '';
      const list = recent ? st.recentRepeats : st.top;
      if (!list.length) ol1.append(el('div', 'snote', 'No songs have repeated yet.'));
      for (const s of list) ol1.append(songRow(s));
    }
    for (const [k, label] of [['plays', 'By plays'], ['recent', 'Most recent']]) {
      const b = btn(label, '', () => { topSort = k; GM_setValue('topSort', k); fillTop(); });
      b.dataset.k = k; seg.append(b);
    }
    head.append(h3, seg); t10.append(head, ol1);
    fillTop();

    // Most played that you don't have
    const tm = sec(`Most played that you don't have (${fmt(st.missingSongs)} songs)`);
    if (!st.topMissing.length) tm.append(el('div', 'snote', 'Nothing to find. Every song recorded is in your playlist, another version is, or you disliked it.'));
    else {
      const ol2 = el('ol', 'slist');
      for (const s of st.topMissing) ol2.append(songRow(s, link('Search', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(Matcher.searchQuery(s.artist, s.title)))));
      tm.append(ol2);
    }

    // Breakdown
    const bd = sec('Songs by status');
    for (const k of ['have', 'other', 'none', 'gone', 'disliked']) {
      const b = st.breakdown[k]; if (!b) continue;
      const sp = st.labeledSongs ? Math.round(b.songs / st.labeledSongs * 100) : 0, pp = st.labeledPlays ? Math.round(b.plays / st.labeledPlays * 100) : 0;
      bd.append(line(el('span', 'chip ' + k, STATUS_CHIP[k]), ` ${fmt(b.songs)} song${b.songs === 1 ? '' : 's'} (${sp}%), ${fmt(b.plays)} play${b.plays === 1 ? '' : 's'} (${pp}%)`));
    }

    // Coverage
    const cv = sec('Recording');
    cv.append(line('From ', el('b', '', History.formatDate(st.first) + ' ' + History.formatTime(st.first)), ' to ',
      el('b', '', History.formatDate(st.last) + ' ' + History.formatTime(st.last))),
      line('Time recorded: ', el('b', '', Stats.formatSpan(st.coveredSecs)), st.perHour ? ` · about ${st.perHour.toFixed(1)} songs an hour` : '',
        ` · ${fmt(st.gaps)} gap${st.gaps === 1 ? '' : 's'}`));

    const dlg = $('#statsbox');
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    body.scrollTop = 0;
  }
  $('#stats').onclick = e => runBusy(openStats, e);
  $('#statsclose').onclick = () => {
    const d = $('#statsbox'); d.close ? d.close() : d.removeAttribute('open');
    if (renderPending) { renderPending = false; setTimeout(render, 50); }   // catch up after the panel is gone
  };
  $('#statsbox').addEventListener('close', () => { if (renderPending) { renderPending = false; setTimeout(render, 50); } });
  $('#statsbox').addEventListener('click', e => { if (e.target === $('#statsbox')) $('#statsclose').click(); });   // tap outside to close

  /* ----- Backup / Restore ----- */
  const PREKEY = 'backup:beforeImport';
  function historyKeys() {
    try { if (typeof GM_listValues === 'function') return keep(GM_listValues(), k => /^history:[a-z0-9]+$/i.test(k)); } catch (e) {}
    return [HKEY];
  }
  function snapshot() {
    const h = {};
    for (const k of historyKeys()) h[k.slice(8)] = GM_getValue(k, []);
    return { history: h, marks: getMarks(), dislikes: getDislikes(), favorites: getFavs(), categories: getCats(), archive: GM_getValue(AKEY, {}), original: GM_getValue(OKEY, null) };
  }
  function backupText() { return JSON.stringify(Backup.build(snapshot(), { playlistId: PLAYLIST_ID, scriptVersion: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '' })); }
  function reloadState() {
    history = GM_getValue(HKEY, []); if (!Array.isArray(history)) history = [];
    clearFuture();
    archive = GM_getValue(AKEY, {}); if (!archive || typeof archive !== 'object' || Array.isArray(archive)) archive = {};
    rowBase = null; measured = null; goneCache = null; favCache = null; catCache = null; statusCache.clear(); openLogs.clear();
  }
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  const say = (id, text, cls) => { const m = $(id); m.className = 'bmsg' + (cls ? ' ' + cls : ''); m.textContent = text; };
  const when = sec => History.formatDate(sec) + ' ' + History.formatTime(sec);

  function showUndo() {
    const pre = GM_getValue(PREKEY, null);
    $('#bkundo').hidden = !(pre && pre.at);
    if (pre && pre.at) $('#bkundotext').textContent = `Last import: ${when(pre.at / 1000)}. Undo puts this device back how it was before.`;
  }
  function openBackup() {
    say('#bkoutmsg', ''); say('#bkinmsg', ''); $('#bkpreview').textContent = ''; $('#bkpaste').value = ''; $('#bkfile').value = '';
    showUndo();
    const d = $('#backupbox'); if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  }
  $('#backup').onclick = openBackup;
  $('#bkclose').onclick = () => { const d = $('#backupbox'); d.close ? d.close() : d.removeAttribute('open'); if (renderPending) { renderPending = false; setTimeout(render, 50); } };
  $('#backupbox').addEventListener('close', () => { if (renderPending) { renderPending = false; setTimeout(render, 50); } });
  $('#backupbox').addEventListener('click', e => { if (e.target === $('#backupbox')) $('#bkclose').click(); });

  $('#bkdown').onclick = e => runBusy(() => {
    try {
      const name = `soma-xmas-checker-backup-${stamp()}.json`;
      const url = URL.createObjectURL(new Blob([backupText()], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      say('#bkoutmsg', `Saved ${name}. If nothing downloaded, use Copy backup.`, 'ok');
    } catch (err) { say('#bkoutmsg', `Couldn't save the file (${err.message}). Use Copy backup instead.`, 'err'); }
  }, e);
  $('#bkcopy').onclick = e => runBusy(() => {
    try { GM_setClipboard(backupText(), 'text'); say('#bkoutmsg', 'Backup copied. Paste it into the other device\'s Backup / Restore panel, or into a note to keep.', 'ok'); }
    catch (err) { say('#bkoutmsg', `Couldn't copy (${err.message}).`, 'err'); }
  }, e);

  let pending = null;   // validated backup waiting for Merge / Replace
  function readBackup(text) {
    $('#bkpreview').textContent = ''; pending = null;
    let obj;
    try { obj = JSON.parse(String(text || '').trim()); }
    catch (err) { say('#bkinmsg', "That isn't a backup: it couldn't be read as backup data. Nothing was changed.", 'err'); return; }
    let v;
    try { v = Backup.validate(obj); }
    catch (err) { say('#bkinmsg', `Can't use that backup: ${err.message}. Nothing was changed.`, 'err'); return; }
    pending = v;
    const pv = Backup.preview(snapshot(), v.data);
    say('#bkinmsg', '');
    const box = el('div', 'bpreview');
    const ul = el('ul', '');
    ul.append(el('li', '', pv.plays ? `${fmt(pv.plays)} plays, ${when(pv.first)} to ${when(pv.last)}; ${fmt(pv.newPlays)} of them aren't on this device yet` : 'No plays'),
      el('li', '', `${fmt(pv.marks)} marks, ${fmt(pv.dislikes)} dislikes, ${fmt(pv.favorites)} favorites, ${fmt(pv.categories)} categories, ${fmt(pv.songs)} remembered playlist songs`));
    if (pv.original) ul.append(el('li', '', `The playlist's original order, saved ${when(pv.original / 1000)}`));
    if (v.exportedAt) ul.append(el('li', '', `Backed up ${when(v.exportedAt / 1000)}`));
    if (v.skipped) ul.append(el('li', '', `${fmt(v.skipped)} damaged entr${v.skipped === 1 ? 'y' : 'ies'} will be skipped`));
    const row = el('div', 'brow');
    const merge = btn('Merge (recommended)', 'ctl primary', () => applyImport('merge'));
    let armed = null;
    const replace = btn('Replace everything here', 'ctl danger', () => {
      if (!armed) { replace.textContent = 'Tap again to replace'; armed = setTimeout(() => { armed = null; replace.textContent = 'Replace everything here'; }, 5000); return; }
      clearTimeout(armed); applyImport('replace');
    });
    const cancel = btn('Cancel', 'ctl', () => { pending = null; $('#bkpreview').textContent = ''; });
    row.append(merge, replace, cancel);
    box.append(el('b', '', 'This backup has:'), ul,
      el('div', 'snote', 'Merge combines it with what\'s here (use this to keep two devices in step). Replace makes this device an exact copy of the backup.'), row);
    $('#bkpreview').append(box);
  }
  function applyImport(mode) {
    if (!pending) return;
    const inc = pending.data, before = snapshot();
    GM_setValue(PREKEY, { at: Date.now(), data: before });                   // so the import can be undone
    const chans = new Set(Object.keys(inc.history).concat(mode === 'replace' ? Object.keys(before.history) : []));
    chans.forEach(ch => {
      const mine = before.history[ch] || [], theirs = inc.history[ch] || [];
      GM_setValue('history:' + ch, mode === 'merge' ? Backup.mergeHistory(mine, theirs, HISTORY_MAX) : theirs.slice(0, HISTORY_MAX));
    });
    GM_setValue('marks', mode === 'merge' ? Backup.mergeMarks(before.marks, inc.marks) : inc.marks);
    GM_setValue('dislikes', mode === 'merge' ? Backup.mergeDislikes(before.dislikes, inc.dislikes) : inc.dislikes);
    GM_setValue('favorites', mode === 'merge' ? Backup.mergeFavorites(before.favorites, inc.favorites) : inc.favorites);
    GM_setValue('categories', mode === 'merge' ? Backup.mergeCategories(before.categories, inc.categories) : inc.categories);
    GM_setValue(AKEY, mode === 'merge' ? Backup.mergeArchive(before.archive, inc.archive) : inc.archive);
    // The original playlist order can't be recreated, so even Replace keeps this device's when the backup has none
    GM_setValue(OKEY, mode === 'merge' ? Backup.mergeOriginal(before.original, inc.original) : inc.original || before.original || null);
    reloadState();
    pending = null; $('#bkpreview').textContent = '';
    say('#bkinmsg', mode === 'merge' ? `Merged. ${fmt(history.length)} plays saved here now.` : `Replaced. ${fmt(history.length)} plays saved here now.`, 'ok');
    showUndo();
    renderPending = true;
  }
  $('#bkpick').onclick = () => $('#bkfile').click();
  $('#bkfile').onchange = e => runBusy(async () => {
    const input = $('#bkfile'), f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { say('#bkinmsg', 'That file is too large to be a backup from this script. Nothing was changed.', 'err'); return; }
    readBackup(await f.text());
  }, e);
  $('#bkread').onclick = e => runBusy(() => readBackup($('#bkpaste').value), e);
  $('#bkundobtn').onclick = e => runBusy(() => {
    const pre = GM_getValue(PREKEY, null);
    if (!pre || !pre.data) return;
    const d = pre.data;
    const chans = new Set(Object.keys(d.history).concat(mapOf(historyKeys(), k => k.slice(8))));   // also empties channels added by the import
    chans.forEach(ch => GM_setValue('history:' + ch, d.history[ch] || []));
    GM_setValue('marks', d.marks || {}); GM_setValue('dislikes', d.dislikes || {}); GM_setValue(AKEY, d.archive || {});
    if ('original' in d) GM_setValue(OKEY, d.original || null);   // undo snapshots from before 3.12.1 don't have it
    if ('favorites' in d) GM_setValue('favorites', d.favorites || {});   // nor favorites before 3.14
    if ('categories' in d) GM_setValue('categories', d.categories || {});   // nor categories before 3.15
    GM_setValue(PREKEY, null);
    reloadState();
    say('#bkinmsg', `Import undone. ${fmt(history.length)} plays saved here, as before.`, 'ok');
    showUndo();
    renderPending = true;
  }, e);

  /* ----- Shuffle the real playlist (YouTube Data API; you sign in with Google) ----- */
  // The plan and the moves are in Shuffle. The job is saved before the first move, so a shuffle cut short
  // (quota, sign-in running out, closing the page) is finished the next time Shuffle opens. Kept for
  // putting things back: the order before the last shuffle, and the playlist's original order (saved
  // before the first shuffle, never overwritten, and carried in backups).
  const JOBKEY = 'shuffle:job:' + PLAYLIST_ID, LASTKEY = 'shuffle:last:' + PLAYLIST_ID, USEDKEY = 'shuffle:units', RUNKEY = 'shuffle:lastRun';
  const KINDS = {
    shuffle: { head: 'New order', go: 'Shuffle the playlist', run: 'Shuffling your playlist…', name: 'A shuffle',
      done: 'Done. Your playlist is in the new order, and reading it back confirmed it.' },
    undo: { head: 'The order before the last shuffle', go: 'Put back this order', run: 'Putting back the earlier order…', name: 'Putting back the earlier order',
      done: 'Done. The earlier order is back, and reading the playlist confirmed it.' },
    original: { head: 'The original order', go: 'Put back the original order', run: 'Putting back the original order…', name: 'Putting back the original order',
      done: 'Done. The original order is back, and reading the playlist confirmed it.' },
  };
  const rand = n => { const lim = Math.floor(0x100000000 / n) * n, b = new Uint32Array(1); do { crypto.getRandomValues(b); } while (b[0] >= lim); return b[0] % n; };
  const plain = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; };   // no "Working…": these show their own progress
  let shufToken = null, shufRunning = false, shufStop = false, waitTimer = null, sh = {}, runUnits = 0;
  const validToken = () => { const t = GM_getValue('signin:token', null); return t && t.token && t.exp > Date.now() ? t.token : null; };
  const usedToday = () => { const u = GM_getValue(USEDKEY, null); return u && u.day === Shuffle.quotaDay(Date.now()) ? u.units : 0; };
  const addUsed = n => { runUnits += n; GM_setValue(USEDKEY, { day: Shuffle.quotaDay(Date.now()), units: usedToday() + n }); };
  async function ytCall(method, resource, params, body) {
    const q = new URLSearchParams();
    for (const k in params) if (params[k] !== '' && params[k] != null) q.set(k, String(params[k]));
    const headers = { Authorization: 'Bearer ' + shufToken };
    if (body) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(`https://www.googleapis.com/youtube/v3/${resource}?${q}`, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw Object.assign(new Error('network error'), { status: 0, reason: 'network' }); }
    addUsed(method === 'GET' ? 1 : Shuffle.UNITS_PER_MOVE);
    if (r.ok) return r.json();
    let msg = '', reason = '';
    try { const j = await r.json(); msg = j.error.message || ''; reason = (j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || ''; } catch (e) {}
    throw Object.assign(new Error(msg || 'YouTube returned ' + r.status), { status: r.status, reason });
  }
  // Minutes until midnight Pacific, when the quota resets
  function resetMins() {
    let h = 0, m = 0;
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date())) {
      if (p.type === 'hour') h = Number(p.value);
      if (p.type === 'minute') m = Number(p.value);
    }
    return 1440 - h * 60 - m;
  }
  // Local time of the next midnight Pacific
  const quotaReset = () => new Date(Date.now() + resetMins() * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // YouTube doesn't tell an app how much quota is left, so this is the script's own count on this device.
  // Google's count is in the Cloud Console, a few minutes behind. Folded under one line; stays open once opened.
  let quotaOpen = false;
  function quotaInfo(sec) {
    const used = usedToday(), left = Math.max(0, Shuffle.DAILY_UNITS - used), r = resetMins();
    const until = r >= 60 ? `${Math.floor(r / 60)} h ${r % 60} min` : `${r} min`;
    const det = el('details', 'sdet');
    det.open = quotaOpen;
    det.addEventListener('toggle', () => { quotaOpen = det.open; });
    det.append(el('summary', '', `ⓘ Quota: about ${fmt(left)} units left today`));
    sec.append(det);
    sec = el('div', 'ssec qbody'); det.append(sec);
    sec.append(el('div', 'sline',`About ${fmt(left)} of ${fmt(Shuffle.DAILY_UNITS)} units left today (${fmt(used)} used). It resets in ${until}, at midnight Pacific (${quotaReset()} your time).`));
    const last = GM_getValue(RUNKEY, null);
    if (last && last.units) {
      const what = last.kind === 'shuffle' ? 'The last shuffle' : KINDS[last.kind] ? KINDS[last.kind].name : 'The last run';
      sec.append(el('div', 'sline', `${what} (${when(last.at / 1000)}) used about ${fmt(last.units)} units: ${fmt(last.moves)} move${last.moves === 1 ? '' : 's'} at ${Shuffle.UNITS_PER_MOVE} each, plus reading the playlist.${last.complete ? '' : ' It stopped partway.'}`));
    }
    const note = el('div', 'snote', "Counted by this script on this device, so it doesn't include other devices or other apps using the same Google project. ");
    const a = el('a', '', "Google's own count");
    a.href = 'https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas'; a.target = '_blank'; a.rel = 'noopener';
    note.append(a, " is in the Cloud Console (it's a few minutes behind).");
    sec.append(note);
  }
  function trouble(e) {
    if (e.status === 401) { GM_setValue('signin:token', null); return 'Your Google sign-in has run out (it lasts an hour).'; }
    if (/quota/i.test(e.reason || '')) return `Today's YouTube quota is used up. It resets at midnight Pacific time (${quotaReset()} your time).`;
    if (e.status === 403) return `YouTube refused: ${e.message}`;
    return `Couldn't talk to YouTube: ${e.message}`;
  }

  function signIn() {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    let state = '';
    for (let i = 0; i < b.length; i++) state += b[i].toString(16).padStart(2, '0');
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: GM_getValue('signin:clientId', ''), redirect_uri: SIGNIN_RETURN, response_type: 'token', scope: YT_SCOPE, state });
    const startedAt = Date.now();
    GM_setValue('signin:pending', { state, popup: true, at: startedAt });
    const w = window.open(url, 'xmsignin', 'popup,width=520,height=700');
    if (!w) { GM_setValue('signin:pending', { state, popup: false, at: startedAt }); location.href = url; return; }   // popups blocked: sign in in this tab
    shufShow('waiting');
    clearInterval(waitTimer);
    waitTimer = setInterval(() => {
      const t = GM_getValue('signin:token', null);
      if (t && t.at >= startedAt) { clearInterval(waitTimer); waitTimer = null; if (t.token) shufStart(); else shufShow('signin', `Google sign-in didn't complete (${t.error}).`); }
      else if (Date.now() - startedAt > 10 * 60000) { clearInterval(waitTimer); waitTimer = null; shufShow('signin', 'Sign-in timed out.'); }
    }, 700);
  }

  // The playlist's original order: song ids with their video ids and titles, so it can also be read outside the script
  function saveOriginal(ids, at) {
    const byId = new Map();
    for (const it of sh.items) byId.set(it.id, it);
    const songs = [];
    for (const id of ids) { const it = byId.get(id) || {}; songs.push({ id, videoId: it.videoId || '', title: it.title || '' }); }
    GM_setValue(OKEY, { at, playlistId: PLAYLIST_ID, songs });
  }
  const originalIds = o => { const out = []; for (const s of o.songs) out.push(s.id); return out; };
  function downloadOriginal() {
    const o = GM_getValue(OKEY, null);
    if (!o) return;
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    let csv = 'Position,Title,Video\r\n';
    for (let i = 0; i < o.songs.length; i++) csv += `${i + 1},${q(o.songs[i].title)},${o.songs[i].videoId ? 'https://www.youtube.com/watch?v=' + o.songs[i].videoId : ''}\r\n`;
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${PLAYLIST_NAME.replace(/\W+/g, '-').toLowerCase()}-original-order.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function shufStart() {
    if (!GM_getValue('signin:clientId', '')) return shufShow('setup');
    shufToken = validToken();
    if (!shufToken) return shufShow('signin');
    shufShow('loading', 'Reading your playlist…');
    try {
      const who = await Shuffle.checkOwner(ytCall, PLAYLIST_ID);
      const list = await Shuffle.readItems(ytCall, PLAYLIST_ID);
      sh = { channel: who.channel, items: list, current: Shuffle.idsOf(list), titles: new Map(), note: '' };
      for (const it of list) sh.titles.set(it.id, it.title);
      // No original order saved on this device yet: save it now, before anything can change. If this device
      // already changed the playlist (3.12.0 didn't keep the original), the order from before that is the original.
      const last = GM_getValue(LASTKEY, null), job = GM_getValue(JOBKEY, null);
      if (!GM_getValue(OKEY, null)) {
        if (last && last.before) saveOriginal(last.before, last.at);
        else if (job && job.before) saveOriginal(job.before, job.at);
        else { saveOriginal(sh.current, Date.now()); sh.savedNow = true; }
      }
      if (job && job.target) {
        if (!Shuffle.sameSongs(sh.current, job.target)) { GM_setValue(JOBKEY, null); sh.note = "An earlier shuffle didn't finish, but songs have been added or removed since, so it was set aside."; }
        else if (Shuffle.matches(sh.current, job.target)) finished(job);
        else return prepare(job.target, job.kind, job.before, job.at);
      }
      newShuffle();
    } catch (e) { shufShow('error', e.status !== undefined ? trouble(e) : `Can't shuffle: ${e.message}.`); }
  }
  function prepare(target, kind, before, resumeOf) {
    Object.assign(sh, { target, kind, before, resumeOf, moves: Shuffle.plan(sh.current, target) });
    shufShow('ready');
  }
  // What SomaFM calls each playlist video it has played (the most-played song linked to it), so Shuffle
  // knows its artist, title and album
  function somaInfo() {
    const out = new Map(), most = new Map();
    if (playlistError || !items.length) return out;
    const marks = getMarks(), dislikes = getDislikes(), base = baseRows(), seen = new Set();
    for (let i = 0; i < base.length; i++) {
      const s = base[i];
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      const r = statusOf(s, marks, dislikes);
      if (r.status !== 'have' || !r.item) continue;
      const n = playCounts.get(s.key) || 0;
      if (!most.has(r.item.id) || n > most.get(r.item.id)) { most.set(r.item.id, n); out.set(r.item.id, { artist: s.artist, title: s.title, album: s.album || '' }); }
    }
    return out;
  }
  // A shuffle that spreads out favorites and versions of a song, and keeps an artist's, album's or channel's songs apart
  function newShuffle() {
    const info = somaInfo(), favs = getFavs(), cats = getCats();
    const a = Shuffle.arrange(sh.items, v => info.get(v) || null, v => isFav(favs, v), rand, v => catOf(cats, v));
    sh.spreadCounts = { favorites: 0, versions: 0, apart: 0, runs: [] };
    for (const g of a.groups) {
      if (g.kind === 'favorites') sh.spreadCounts.favorites = g.members.length;
      else if (g.kind === 'category') sh.spreadCounts.runs.push(`${catName(g.category)} ${g.maxRun}`);
      else if (g.kind === 'versions') sh.spreadCounts.versions++;
      else sh.spreadCounts.apart++;
    }
    sh.favIds = new Set(); sh.catNames = new Map();
    for (const it of sh.items) {
      if (isFav(favs, it.videoId)) sh.favIds.add(it.id);
      const c = catOf(cats, it.videoId);
      if (c) sh.catNames.set(it.id, catName(c));
    }
    prepare(a.ids, 'shuffle', sh.current, 0);
  }
  function finished(job) {
    GM_setValue(JOBKEY, null);
    GM_setValue(LASTKEY, job.kind === 'undo' ? null : { before: job.before, at: Date.now() });
  }
  async function go() {
    const job = { target: sh.target, before: sh.before, kind: sh.kind, at: sh.resumeOf || Date.now() };
    if (!GM_getValue(OKEY, null)) saveOriginal(sh.before, Date.now());   // first change on this device: keep the order as it was
    GM_setValue(JOBKEY, job);
    shufRunning = true; shufStop = false; runUnits = 0;
    shufShow('running');
    let res = null, err = null;
    try { res = await Shuffle.run(ytCall, PLAYLIST_ID, sh.items, sh.moves, progress, () => shufStop); }
    catch (e) { err = e; }
    shufRunning = false;
    const n = sh.moves.length;
    const saveRun = complete => GM_setValue(RUNKEY, { kind: job.kind, at: Date.now(), units: runUnits, moves: err ? err.done || 0 : res.done, complete });
    const after = ' Nothing was lost: every song is still there, partly in the new order. Open Shuffle again to finish.';
    if (err || res.stopped) saveRun(false);
    if (err) return shufShow('error', `${trouble(err)} ${fmt(err.done || 0)} of ${fmt(n)} moves were made.` + after);
    if (res.stopped) return shufShow('error', `Stopped after ${fmt(res.done)} of ${fmt(n)} moves.` + after);
    shufShow('loading', 'Checking the new order…');
    try {
      const list = await Shuffle.readItems(ytCall, PLAYLIST_ID);
      if (!Shuffle.matches(Shuffle.idsOf(list), sh.target)) return saveRun(true), shufShow('error', 'All the moves were made, but the playlist read back in a different order than planned. Nothing was lost. Open Shuffle again and it will plan the remaining moves.');
      saveRun(true);
      finished(job);
      shufShow('done');
    } catch (e) { saveRun(true); shufShow('error', `${trouble(e)} The moves were all made, but the new order couldn't be checked. Open Shuffle again to check it.`); }
  }
  function progress(k, n) {
    const bar = $('#shbar'), t = $('#shprog');
    if (bar) { bar.firstChild.style.width = (k / n * 100) + '%'; bar.setAttribute('aria-valuenow', String(k)); }
    if (t) t.textContent = `Moved ${fmt(k)} of ${fmt(n)}`;
  }

  function shufShow(view, msg) {
    const body = $('#shufbody');
    body.textContent = '';
    let sec = el('div', 'ssec');
    body.append(sec);
    const say1 = (text, cls) => sec.append(el('div', 'bmsg' + (cls ? ' ' + cls : ''), text));
    const row = (...b) => { const r = el('div', 'brow'); r.append(...b); sec.append(r); };
    if (view === 'setup') {
      sec.append(el('div', 'sline', 'Paste the Client ID of your Google OAuth client (it ends in .apps.googleusercontent.com). It stays on this device.'));
      const inp = el('input', 'shinput'); inp.id = 'shclient'; inp.type = 'text'; inp.spellcheck = false; inp.placeholder = '….apps.googleusercontent.com';
      inp.value = GM_getValue('signin:clientId', '');
      sec.append(inp);
      if (msg) say1(msg, 'err');
      row(plain('Save', 'ctl primary', () => {
        const v = $('#shclient').value.trim();
        if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(v)) return shufShow('setup', "That doesn't look like a Client ID.");
        GM_setValue('signin:clientId', v); GM_setValue('signin:token', null); shufStart();
      }));
    } else if (view === 'signin') {
      if (msg) say1(msg, 'err');
      sec.append(el('div', 'sline', `Sign in with the Google account that owns ${PLAYLIST_NAME}. If Google asks for a channel, choose the one that owns the playlist.`),
        el('div', 'snote', "Google will say the app hasn't been verified: it's your own app, so choose Continue. The sign-in lasts an hour."));
      row(plain('Sign in with Google', 'ctl primary', signIn), plain('Change Client ID', 'ctl', () => shufShow('setup')));
    } else if (view === 'waiting') {
      sec.append(el('div', 'sline', 'Finish signing in in the Google window…'));
      row(plain('Cancel', 'ctl', () => { clearInterval(waitTimer); waitTimer = null; shufShow('signin'); }));
    } else if (view === 'loading') {
      sec.append(el('div', 'sline', msg || 'Working…'));
    } else if (view === 'ready') {
      const n = sh.current.length, m = sh.moves.length, u = Shuffle.units(m), used = usedToday(), K = KINDS[sh.kind];
      if (sh.note) say1(sh.note);
      if (sh.resumeOf) {
        sec.append(el('h3', '', 'Unfinished'),
          el('div', 'sline', `${K.name} started ${when(sh.resumeOf / 1000)} didn't finish. Finishing takes ${fmt(m)} more move${m === 1 ? '' : 's'}, about ${fmt(u)} quota units.`));
      } else {
        sec.append(el('h3', '', K.head),
          el('div', 'sline', `${fmt(n)} songs. Putting them in this order takes ${fmt(m)} move${m === 1 ? '' : 's'}, about ${fmt(u)} quota units.`));
        if (sh.kind === 'original' && (sh.added || sh.removed)) sec.append(el('div', 'snote',
          keep([sh.added ? `${fmt(sh.added)} song${sh.added === 1 ? '' : 's'} added since go at the end.` : '', sh.removed ? `${fmt(sh.removed)} removed since ${sh.removed === 1 ? 'is' : 'are'} skipped.` : ''], Boolean).join(' ')));
      }
      sec.append(el('div', 'snote', `Signed in as ${sh.channel}.`));
      if (used + u > Shuffle.DAILY_UNITS) say1(`That's more than today's quota has left, so it will stop partway. Open Shuffle again after midnight Pacific (${quotaReset()} your time) to finish.`, 'err');
      const ol = el('ol', 'shlist');
      for (let i = 0; i < Math.min(12, n); i++) {
        const li = el('li', '', (sh.favIds && sh.favIds.has(sh.target[i]) ? '⭐ ' : '') + (sh.titles.get(sh.target[i]) || '?'));
        const cn = sh.catNames && sh.catNames.get(sh.target[i]);
        if (cn) li.append(el('span', 'len', ' · ' + cn));
        ol.append(li);
      }
      sec.append(ol);
      if (n > 12) sec.append(el('div', 'snote', `…and ${fmt(n - 12)} more.`));
      const sc = sh.kind === 'shuffle' && !sh.resumeOf && sh.spreadCounts;
      if (sc) {
        const parts = [];
        if (sc.favorites) parts.push(`your ${fmt(sc.favorites)} favorites`);
        if (sc.versions) parts.push(`the versions of ${fmt(sc.versions)} song${sc.versions === 1 ? '' : 's'} you have more than once`);
        sec.append(el('div', 'snote', (parts.length ? 'Spread out evenly: ' + parts.join(' and ') + '. ' : '') +
          'Songs by the same artist, from the same album or posted by the same channel are kept apart. ' +
          (sc.runs.length ? `Most in a row from one category: ${sc.runs.join(', ')}. ` : '') + 'The rest is random.' +
          (sc.favorites ? '' : ' Tap ☆ on a song to make it a favorite.')));
      }
      const label = sh.resumeOf ? 'Finish it' : K.go;
      let armed = null;
      const goBtn = plain(label, 'ctl primary', () => {
        if (!m) return;
        if (!armed) { goBtn.textContent = 'Tap again to start'; armed = setTimeout(() => { armed = null; goBtn.textContent = label; }, 5000); return; }
        clearTimeout(armed); go();
      });
      goBtn.disabled = !m;
      if (sh.resumeOf) row(goBtn, plain('Start a new shuffle instead', 'ctl', () => { GM_setValue(JOBKEY, null); newShuffle(); }));
      else row(goBtn, plain(sh.kind === 'shuffle' ? 'Reshuffle' : 'Back to a new shuffle', 'ctl', newShuffle));
      if (!m) sec.append(el('div', 'snote', 'The playlist is already in this order.'));

      // Putting things back
      if (!sh.resumeOf) {
        sec = el('div', 'ssec'); body.append(sec);
        sec.append(el('h3', '', 'Put back'));
        const orig = GM_getValue(OKEY, null);
        if (orig && orig.songs && orig.songs.length) {
          sec.append(el('div', 'sline', `Original order saved ${when(orig.at / 1000)} (${fmt(orig.songs.length)} songs). It's kept on this device and in backups, and never overwritten.`));
          const btns = [];
          if (sh.kind !== 'original') btns.push(plain('Show the original order', 'ctl', () => {
            const ids = originalIds(orig), target = Shuffle.restoreOrder(ids, sh.current);
            const now = new Set(sh.current);
            let removed = 0;
            for (const id of ids) if (!now.has(id)) removed++;
            sh.removed = removed; sh.added = sh.current.length - (ids.length - removed);
            prepare(target, 'original', sh.current, 0);
          }));
          btns.push(plain('Download it', 'ctl', downloadOriginal));
          row(...btns);
          if (sh.savedNow) sec.append(el('div', 'snote', "Saved just now from the playlist as it is. If you've already shuffled it on another device, " +
            "bring in that device's backup (Backup / Restore, Merge): the order saved first is kept, so the true original wins."));
        }
        const last = GM_getValue(LASTKEY, null);
        if (sh.kind === 'shuffle' && last && last.before && Shuffle.sameSongs(sh.current, last.before) && !Shuffle.matches(sh.current, last.before)) {
          sec.append(el('div', 'snote', `Last changed ${when(last.at / 1000)}. You can put back the order from before that.`));
          row(plain('Show the earlier order', 'ctl', () => prepare(last.before, 'undo', sh.current, 0)));
        }
        sec.append(el('div', 'snote', "Play the playlist with YouTube's shuffle off. Its sort setting in YouTube must stay on Manual, or YouTube shows it in another order."));
      }
    } else if (view === 'running') {
      const n = sh.moves.length;
      sec.append(el('div', 'sline', KINDS[sh.kind].run));
      const bar = el('div', 'bar'); bar.id = 'shbar'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(n)); bar.setAttribute('aria-valuenow', '0'); bar.setAttribute('aria-label', 'Songs moved');
      const fill = el('div', 'fill'); fill.style.width = '0%'; bar.append(fill);
      const t = el('div', 'snote', `Moved 0 of ${fmt(n)}`); t.id = 'shprog';
      sec.append(bar, t, el('div', 'snote', "Keep this page open until it finishes. If it's interrupted, Shuffle picks up where it stopped."));
      row(plain('Stop', 'ctl', () => { shufStop = true; $('#shprog').textContent += ' — stopping…'; }));
    } else if (view === 'done') {
      say1(KINDS[sh.kind].done, 'ok');
      sec.append(el('div', 'snote', "Play it with YouTube's shuffle off. The YouTube app may take a few minutes to show the new order."));
      row(plain('Shuffle again', 'ctl', shufStart));
    } else {   // 'error'
      say1(msg, 'err');
      row(plain(validToken() ? 'Try again' : 'Sign in again', 'ctl primary', shufStart));
    }
    if (!/^(running|waiting|loading)$/.test(view)) { sec = el('div', 'ssec'); body.append(sec); quotaInfo(sec); }
  }
  function openShuffle() {
    const d = $('#shufbox'); if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
    if (!shufRunning && !waitTimer) shufStart();
  }
  $('#shuffle').onclick = openShuffle;
  $('#shclose').onclick = () => { const d = $('#shufbox'); d.close ? d.close() : d.removeAttribute('open'); };
  $('#shufbox').addEventListener('close', () => { if (renderPending) { renderPending = false; setTimeout(render, 50); } });
  $('#shufbox').addEventListener('click', e => { if (e.target === $('#shufbox')) $('#shclose').click(); });

  /* ----- Export ----- */
  let exportNote = '';
  function csvText() {
    const marks = getMarks(), dislikes = getDislikes();
    return History.toCSV(history, (artist, title) => {
      const r = statusOf({ artist, title, key: Matcher.markKey(artist, title) }, marks, dislikes);
      return STATUS_TEXT[r.status] + (r.linked ? ' (linked)' : r.marked && !r.disliked ? ' (marked)' : '');
    });
  }
  function exportName() {
    const d = new Date();
    return `somafm-${channel}-history-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
  }
  $('#csv').onclick = () => {
    try {
      const url = URL.createObjectURL(new Blob([csvText()], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: exportName() });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      exportNote = `Exported ${exportName()} — if nothing downloaded, use Copy CSV`;
    } catch (e) { exportNote = `Export failed (${e.message}); try Copy CSV`; }
    render();
  };
  $('#copy').onclick = () => {
    try { GM_setClipboard(csvText(), 'text'); exportNote = `Copied ${fmt(history.length)} plays as CSV`; }
    catch (e) { exportNote = `Copy failed (${e.message})`; }
    render();
  };
  $('#gonebox').addEventListener('toggle', () => { goneOpen = $('#gonebox').open; });
  $('#prev').onclick = e => runBusy(() => { if (page > 0) { page--; render(); root.host.scrollIntoView(); } }, e);
  $('#next').onclick = e => runBusy(() => { page++; render(); root.host.scrollIntoView(); }, e);
  // Read the element itself: inside the shadow root, the event's target is cleared once the action is delayed for "Working…"
  $('#per').onchange = e => runBusy(() => { pageSize = Number($('#per').value); GM_setValue('pageSize', pageSize); page = 0; render(); }, e);

  /* ----- Controls and timers ----- */
  $('#refresh').onclick = e => runBusy(async () => { loading = true; playlistError = ''; render(); await loadPlaylist(true); loading = false; render(); }, e);
  let timer = null;
  function schedule() {
    clearInterval(timer);
    if (live) timer = setInterval(async () => {
      await loadSongs();                       // keeps recording in the background, as long as the browser lets it run
      if (document.hidden) return;             // skip the playlist check and redraw until you're looking
      await loadPlaylist(false);
      quietRender();                           // not while you're choosing a song or reading Stats
    }, LIVE_SECONDS * 1000);
  }
  $('#live').onclick = () => { live = !live; GM_setValue('live', live); schedule(); render(); };

  /* ----- Keep screen on (Screen Wake Lock) ----- */
  // The browser holds it only while this page is the visible tab and releases it whenever the tab is
  // hidden or the screen is turned off by hand, so it's asked for again each time the page comes back.
  let keepAwake = GM_getValue('keepAwake', false), wakeLock = null, wakeError = '';
  function wakeApi() {
    try {
      const nav = (typeof unsafeWindow !== 'undefined' && unsafeWindow.navigator && unsafeWindow.navigator.wakeLock) ? unsafeWindow.navigator : navigator;
      return nav.wakeLock && typeof nav.wakeLock.request === 'function' ? nav.wakeLock : null;
    } catch (e) { return null; }
  }
  async function holdScreen() {
    const api = wakeApi();
    if (!keepAwake || !api || wakeLock || document.hidden) { quietRender(); return; }
    try {
      const lock = await api.request('screen');
      wakeLock = lock; wakeError = '';
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; quietRender(); });
    } catch (e) { wakeError = (e && (e.message || e.name)) || 'not allowed'; }
    quietRender();
  }
  async function releaseScreen() {
    const lock = wakeLock; wakeLock = null; wakeError = '';
    if (lock) { try { await lock.release(); } catch (e) {} }
    render();
  }
  $('#awake').onclick = () => {
    if (keepAwake && !wakeError) { keepAwake = false; GM_setValue('keepAwake', false); releaseScreen(); }
    else { keepAwake = true; GM_setValue('keepAwake', true); wakeError = ''; holdScreen(); }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) holdScreen(); });
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && live) { await loadSongs(); await loadPlaylist(false); quietRender(); }
  });

  render();
  holdScreen();
  // Back from signing in to Google in this tab (when the browser blocked the sign-in window)
  const back = GM_getValue('signin:reopen', 0);
  if (back) { GM_setValue('signin:reopen', 0); if (Date.now() - back < 5 * 60000) openShuffle(); }
  (async () => {
    await Promise.all([loadSongs(), loadPlaylist(false)]);
    loading = false;
    render();
    schedule();
  })();
}
