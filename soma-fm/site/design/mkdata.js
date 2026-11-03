const M = require('../../soma-xmas-checker.user.js');
const D = require('path').join(__dirname, '/');
const b = JSON.parse(require(D + 'state.json')[0].results[0].body);
const hist = require(D + 'plays.json')[0].results.map(r => [r.at, r.artist, r.title, r.album, r.gap]);
const items = Object.values(b.archive).filter(a => !a.gone);
const cache = new Map();
const st = (a, t) => { const k = M.markKey(a, t); if (!cache.has(k)) cache.set(k, M.applyMark(M.check(a, t, items), b.marks[k], !!b.dislikes[k], items)); return { k, r: cache.get(k) }; };
const counts = new Map(), times = new Map();
for (const p of hist) { const k = M.markKey(p[1], p[2]); counts.set(k, (counts.get(k) || 0) + 1); if (!times.has(k)) times.set(k, []); times.get(k).push(p[0]); }
const row = p => { const { k, r } = st(p[1], p[2]); const vid = r.item && r.item.id;
  return { at: p[0], artist: p[1], title: p[2], album: p[3], gap: !!p[4], key: k, status: r.status, reason: r.reason || '', marked: r.marked || '', linked: !!r.linked,
    item: r.item ? { id: r.item.id, title: r.item.title, ch: String(r.item.ch || '').replace(/\s*-\s*Topic$/, '') } : null,
    plays: counts.get(k), times: times.get(k).slice(0, 40), fav: !!(vid && b.favorites[vid] && b.favorites[vid].on), cat: (vid && b.categories[vid] && b.categories[vid].c) || '', note: (b.notes[k] || {}).t || '' }; };
const plays = hist.slice(0, 160).map(row);
const songs = new Map(); for (const p of hist) { const k = M.markKey(p[1], p[2]); if (!songs.has(k)) songs.set(k, p); }
const by = { have: 0, other: 0, none: 0, gone: 0, disliked: 0 }; const heard = new Set();
for (const p of songs.values()) { const r = st(p[1], p[2]).r; by[r.status]++; if (r.status === 'have' && r.item) heard.add(r.item.id); }
const cats = { band: 0, classics: 0, dance: 0, jazz: 0, mellow: 0, soul: 0, uncat: 0 };
for (const it of items) { const c = b.categories[it.id] && b.categories[it.id].c; cats[c || 'uncat']++; }
const top = [...songs.values()].map(row).sort((x, y) => y.plays - x.plays).slice(0, 15);
const notHeard = items.filter(i => !heard.has(i.id)).map(i => ({ id: i.id, title: i.title }));
const gone = Object.values(b.archive).filter(a => a.gone && !a.dismissed).map(a => ({ title: a.title, ch: a.ch, last: a.last }));
const gaps = hist.filter(p => p[4]).length;
const out = { now: plays[0], plays, top, notHeard, gone, totals: { plays: hist.length, gaps, songs: songs.size, playlist: items.length, heard: heard.size, favorites: Object.values(b.favorites).filter(f => f.on).length, by, cats, backHours: 14.7, since: hist[hist.length - 1][0] } };
require('fs').writeFileSync(D + 'data.js', 'window.XL = ' + JSON.stringify(out) + ';\n');
console.log(JSON.stringify(out.totals), 'notHeard', notHeard.length, 'gone', gone.length, 'gapsInSample', plays.filter(p => p.gap).length);
