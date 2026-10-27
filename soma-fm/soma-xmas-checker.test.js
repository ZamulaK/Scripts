// Regression gate for the matcher. Run: node soma-xmas-checker.test.js
const M = require('./soma-xmas-checker.user.js');
const items = require('./playlist.fixture.json');
const cases = [
  // [artist, title as SomaFM shows it, expected status]
  ['Cortex Cure', 'I Believe In Father Christmas', 'have'],
  ['June Christy', 'The Merriest [Thunderball Mix]', 'have'],
  ['King Kooba', 'O Christmas Tree', 'have'],
  ['Billy Paul Williams', 'Ye Merry Gents', 'have'],
  ['Lenny B (Featuring David Verbist)', 'Feliz Navidad', 'have'],
  ['Jack Jones', 'Sleigh Ride', 'have'],
  ['Ella Fitzgerald', 'Sleigh Ride', 'have'],
  ['Al Martino', 'Rudolph The Red-Nosed Reindeer', 'have'],          // typo in playlist title
  ['Vic Damone', 'Marshmallow World', 'have'],                         // typo in playlist title
  ['Dean Martin & Frank Sinatra', 'A Marshmallow World', 'have'],
  ['Mel Torme', 'The Christmas Song (Sonny J Remix)', 'have'],         // accent difference
  ['Patti Page', 'Frosty The Snowman [Rondo Brothers Remix]', 'have'],
  ['Kay Starr', "I've Got My Love To Keep Me Warm [Stuhr Remix]", 'have'],
  ['Charlie Parker', 'White Christmas (King Kooba Remix)', 'have'],
  ['Mel Torme', 'The Christmas Song (Michael Kessler Open Fire Mix)', 'other'], // different mix
  ['Patti Page', 'Frosty The Snowman', 'other'],                       // playlist has the remix only
  ['Herb Alpert', 'Jingle Bells', 'other'],
  ['Joe Williams (Bombay Dub Orchestra Remix)', 'Jingle Bells', 'other'],
  ['Connie Francis', 'Winter Wonderland', 'other'],
  ['Jack Johnson', 'Rudolph The Red Nosed Reindeer', 'other'],
  ['JT Donaldson', 'Snowflakes Falling (JT Donaldson Mix)', 'other'],
  ['Vic Damone', "It's A Marshmallow World", 'have'],                // extra "It's" + playlist typo
  ['Peas', 'Oh Holy Night', 'have'],                                   // "Oh" vs "O"
  ['Kabanjak', 'Holy Night', 'other'],                                 // different artist stays amber
  ['Rockapella', "It's Beginning To Look A Lot Like Christmas", 'have'], // medley title still matches
  // SomaFM cuts titles at 63 characters
  ['Eddie Dunstedter', 'Let It Snow, Let It Snow, Let it snow [Rudolph the Red-Nosed Re', 'have'],   // unclosed bracket
  ['Ray Anthony', 'Christmas Trumpets / We Wish You A Very Merry Christmas (1996 R', 'have'],      // unclosed paren
  ['Eddie Dunstedter', 'Let It Snow! Let It Snow! Let It Snow! / Rudolph, The Red-Nosed', 'have'],   // cut mid-word: "Re" ~ "Reindeer"
  ['Eddie Dunstedter', 'Let It Snow! Let It Snow! Let It Snow!/Rudolph, The Red-Nosed R', 'have'],   // cut mid-word: fragment matches the start of "Reindeer"
  ['Jack Jones', 'Sleigh Ride Through The Snowy Pines Of The Old Vermont Hills Ji', 'none'],   // cut word can't rescue a title that doesn't match
  ['Al Caiola', 'Holiday on Skis Featuring A Very Long Orchestral Arrangement Of', 'none'],     // cut-off prefix must not create a match
  // One missing or extra word inside a longer title
  ['Ray Anthony', 'Christmas Trumpets / We Wish You A Merry Christmas', 'have'],   // SomaFM drops "Very"
  ['Charles Afton', 'Dance Of The Little Sugar Plum Fairy', 'have'],                // SomaFM adds a word
  ['Release', 'Christmas Morning Eve', 'none'],                                     // 3-word title can't drop a word to fit a 2-word one
  ['Ray Anthony', 'Christmas Trumpets / We Wish You A Merry Xmas', 'none'],         // a different last word isn't a missing word
  ['Ray Anthony', 'Christmas Trumpets / We Wish A Merry Christmas', 'none'],        // two words missing ("You", "Very") is too many
  ['Vince Guaraldi Trio', 'Christmas Time Is Here', 'none'],   // must not match Kaskade's "Christmas Is Here"
  ['Someone Else', 'Christmas Trumpets / We Wish You A Merry Christmas', 'none'],   // near-miss title needs the same artist
  ['Count Basie & His Orchestra', 'Jingle Bells', 'other'],     // "His Orchestra" isn't an artist name
  ['Al Velilla', 'Jingle Beats', 'have'],      // plural vs "Jingle Beat"
  ['Someone Else', 'Jingle Beats', 'none'],    // plural tolerance needs the same artist
  ['Kubris Blumen', 'We Three Kings', 'none'],
  ['Dean Martin', 'Silent Night', 'none'],
  ['Al Di Meola', 'The First Noel', 'none'],
  ['Count Basie & His Orchestra', 'Good Morning Blues [The Real Tuesday Weld Clerkenwell Remix]', 'none'],
  ['Phantom Planet', 'Carol Of The Bells', 'none'],
  ['Pleasant Grove Minstrels', 'What Child Is This', 'none'],
];
function runAll(label) {
  let fail = 0;
  console.log(`--- ${label} ---`);
  for (const [a, t, want] of cases) {
    let r;
    try { r = M.check(a, t, items); } catch (e) { r = { status: 'ERROR: ' + e.message }; }
    const ok = r.status === want;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${want.padEnd(5)} got ${r.status.padEnd(5)}  ${a} — ${t}${r.item ? '  →  ' + r.item.title : ''}`);
  }
  console.log(`${cases.length - fail}/${cases.length} passed\n`);
  return fail;
}


// Hand-marked songs are stored under markKey; the same song must map to the same key
// however SomaFM varies case, accents or punctuation, and different songs must not collide.
function keyChecks() {
  let fail = 0;
  const same = [
    [['Mel Torme', 'The Christmas Song (Michael Kessler Open Fire Mix)'], ['MEL TORMÉ', 'The Christmas Song [Michael Kessler Open-Fire Mix]']],
    [["Tetsumi Nagaka", "Faithful Ye Come"], ["tetsumi nagaka", "Faithful, Ye Come!"]],
  ];
  const differ = [
    [['Mel Torme', 'The Christmas Song (Michael Kessler Open Fire Mix)'], ['Mel Torme', 'The Christmas Song (Sonny J Remix)']],
    [['Patti Page', 'Frosty The Snowman'], ['The Ventures', 'Frosty The Snowman']],
  ];
  console.log('--- hand-mark keys ---');
  for (const [a, b] of same) { const ok = M.markKey(...a) === M.markKey(...b); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  same key:      ${a.join(' — ')}  /  ${b.join(' — ')}`); }
  for (const [a, b] of differ) { const ok = M.markKey(...a) !== M.markKey(...b); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  different key: ${a.join(' — ')}  /  ${b.join(' — ')}`); }
  console.log('');
  return fail;
}


// Hand-marks override the automatic result. Version 1.x stored a bare timestamp meaning "have".
function markChecks() {
  let fail = 0;
  const other = { status: 'other', reason: 'otherArtist', item: { id: 'x', title: 'O Holy Night' } };
  const none = { status: 'none' };
  const have = { status: 'have', item: { id: 'y', title: 'Sleigh Ride' } };
  const cases = [
    ['legacy timestamp → have', M.applyMark(other, 1792880000000), r => r.status === 'have' && r.marked === 'have' && r.item.id === 'x'],
    ['mark have on red', M.applyMark(none, { v: 'have' }), r => r.status === 'have' && r.marked === 'have'],
    ['mark not on amber', M.applyMark(other, { v: 'not' }), r => r.status === 'none' && r.marked === 'not' && r.item.id === 'x'],
    ['no mark leaves amber', M.applyMark(other, undefined), r => r.status === 'other' && !r.marked],
    ['have mark on green is a no-op', M.applyMark(have, { v: 'have' }), r => r.status === 'have' && !r.marked],
    ['garbage mark ignored', M.applyMark(other, { v: 'maybe' }), r => r.status === 'other' && !r.marked],
    ['dislike on red', M.applyMark(none, undefined, true), r => r.status === 'disliked' && r.disliked],
    ['dislike after "not this one"', M.applyMark(other, { v: 'not' }, true), r => r.status === 'disliked' && r.marked === 'not'],
    ['dislike ignored once in playlist', M.applyMark(have, undefined, true), r => r.status === 'have' && !r.disliked],
    ['dislike ignored on amber', M.applyMark(other, undefined, true), r => r.status === 'other' && !r.disliked],
    ['"I have it" beats a dislike', M.applyMark(none, { v: 'have' }, true), r => r.status === 'have' && !r.disliked],
  ];
  console.log('--- hand-mark overrides ---');
  for (const [label, r, ok] of cases) { const pass = ok(r); if (!pass) fail++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`); }
  console.log('');
  return fail;
}


// Unavailable playlist entries (deleted, private, blocked) are left out of counts and matching
function availabilityChecks() {
  let fail = 0;
  const ok = { isPlayable: true, lengthSeconds: '182' };
  const cases = [
    ['normal video kept', ok, 'Sleigh Ride', false],
    ['deleted video', { isPlayable: false }, '[Deleted video]', true],
    ['private video', { lengthSeconds: '0' }, '[Private video]', true],
    ['blocked but titled', { isPlayable: false, lengthSeconds: '200' }, 'Frosty The Snowman', true],
    ['unplayable notice', { isPlayable: true, lengthSeconds: '200', unplayableText: { simpleText: 'Video unavailable' } }, 'Jingle Bells', true],
    ['private title even if flags look fine', ok, '[Private video]', true],
  ];
  console.log('--- unavailable videos ---');
  for (const [label, v, title, want] of cases) { const got = M.isUnavailable(v, title); const pass = got === want; if (!pass) fail++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`); }
  console.log('');
  return fail;
}


// Real-world shapes for the Vince Guaraldi report: the right entry must win over a near-miss
function guaraldiChecks() {
  let fail = 0;
  const kaskade = { id: 'k', title: 'Kaskade - Christmas Is Here (ft. Late Night Alumni) Lyrics', ch: 'Vibe Jaron' };
  const cases = [
    ['artist without "Trio" in title', [kaskade, { id: 'g', title: 'Vince Guaraldi - Christmas Time Is Here (Vocal)', ch: 'Peanuts' }], 'have', 'g'],
    ['artist only in channel name', [kaskade, { id: 'g', title: 'Christmas Time Is Here', ch: 'Vince Guaraldi Trio - Topic' }], 'have', 'g'],
    ['no artist anywhere: exact title beats near-miss', [kaskade, { id: 'g', title: 'Christmas Time Is Here', ch: 'A Charlie Brown Christmas' }], 'other', 'g'],
    ['only the near-miss in playlist', [kaskade], 'none', null],
  ];
  console.log('--- Vince Guaraldi report ---');
  for (const [label, list, want, id] of cases) {
    const r = M.check('Vince Guaraldi Trio', 'Christmas Time Is Here', list);
    const pass = r.status === want && (id === null || (r.item && r.item.id === id));
    if (!pass) fail++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: got ${r.status}${r.item ? ' → ' + r.item.title : ''}`);
  }
  console.log('');
  return fail;
}


// Plural tolerance must not let "Jingle Bells" match "Jingle Bell Rock" for a different artist
function pluralChecks() {
  let fail = 0;
  const list = [{ id: 'r', title: 'Jingle Bell Rock', ch: 'Bobby Helms - Topic' }];
  const cases = [
    ['Jingle Bells (other artist) vs Jingle Bell Rock', M.check('Brenda Lee', 'Jingle Bells', list), 'none'],
    ['Jingle Bell Rock (same artist) still exact', M.check('Bobby Helms', 'Jingle Bell Rock', list), 'have'],
  ];
  console.log('--- plural tolerance ---');
  for (const [label, r, want] of cases) { const pass = r.status === want; if (!pass) fail++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: got ${r.status}`); }
  console.log('');
  return fail;
}


// Play history: what gets saved, de-duplicated, flagged as a gap, capped, and exported
function historyChecks() {
  let fail = 0;
  const H = M.History;
  const feed = (rows) => { const out = []; for (const [date, artist, title] of rows) out.push({ date: String(date), artist, title, album: 'Alb' }); return out; };
  const results = [];
  const check = (label, ok) => { results.push([label, ok]); if (!ok) fail++; };

  const f1 = H.fromFeed(feed([[1000, 'A', 'One'], [1300, 'Break', 'Station ID'], [1200, 'B', 'Two'], [0, 'C', 'No time']]));
  check('feed: station IDs and untimed rows dropped, newest first', f1.length === 2 && f1[0][2] === 'Two' && f1[1][2] === 'One');

  let m = H.merge([], f1, 100);
  check('first save: all plays, no gap', m.added === 2 && !m.gap && m.plays.length === 2);

  const overlap = H.fromFeed(feed([[1400, 'C', 'Three'], [1200, 'B', 'Two'], [1000, 'A', 'One']]));
  m = H.merge(m.plays, overlap, 100);
  check('overlapping fetch: only the new play added, no gap', m.added === 1 && !m.gap && m.plays[0][2] === 'Three' && m.plays.length === 3);

  const same = H.merge(m.plays, overlap, 100);
  check('same fetch again: nothing added', same.added === 0 && same.plays === m.plays);

  const later = H.fromFeed(feed([[9000, 'E', 'Five'], [8800, 'D', 'Four']]));
  const g = H.merge(m.plays, later, 100);
  check('fetch that no longer reaches back: oldest new play flagged as after a gap',
    g.gap && g.plays[1][2] === 'Four' && g.plays[1][4] === 1 && !g.plays[0][4]);

  const capped = H.merge(g.plays, H.fromFeed(feed([[9500, 'F', 'Six']])), 4);
  check('cap keeps the newest plays', capped.plays.length === 4 && capped.plays[0][2] === 'Six' && capped.plays[3][2] === 'Three');   // Six, Five, Four, Three

  // Oct 27, 2026: SomaFM's feed briefly dated an hour of plays a day ahead
  const nowS = 1793100000;   // Oct 2026
  const ahead = H.fromFeed(feed([[nowS + 86400 - 300, 'X', 'Tomorrow'], [nowS + 600, 'Y', 'Clock skew'], [nowS - 200, 'Z', 'Real']]), nowS);
  check('feed: a play dated a day ahead gets today\'s date; a few minutes ahead is kept as is',
    ahead.length === 3 && ahead[0][2] === 'Clock skew' && ahead[0][0] === nowS + 600 && ahead[1][2] === 'Real' && ahead[2][2] === 'Tomorrow' && ahead[2][0] === nowS - 300);
  const behind = H.fromFeed(feed([[nowS - 86400 - 120, 'B', 'Yesterday'], [nowS - 2 * 86400 - 900, 'C', 'Two days back'], [nowS + 3 * 86400 - 60, 'D', 'Three days ahead']]), nowS);
  check('feed: plays dated whole days behind or ahead are moved to today',
    behind.length === 3 && behind[0][0] === nowS - 60 && behind[1][0] === nowS - 120 && behind[2][0] === nowS - 900);
  const offTime = H.fromFeed(feed([[nowS + 10 * 3600, 'E', 'Ten hours ahead'], [nowS - 12 * 3600, 'F', 'Twelve hours back'], [nowS - 100, 'G', 'Fine']]), nowS);
  check('feed: a play no whole-day move can fix (wrong time of day) is dropped', offTime.length === 1 && offTime[0][2] === 'Fine');
  check('fixDate: the window edges', H.fixDate(nowS - 6 * 3600, nowS) === nowS - 6 * 3600 && H.fixDate(nowS + 900, nowS) === nowS + 900 && H.fixDate(nowS + 901, nowS) === null);
  check('feed: without "now", dates are used as given', H.fromFeed(feed([[nowS + 86400, 'X', 'Tomorrow']]))[0][0] === nowS + 86400);
  // The Oct 27 glitch: the last hour repeated a day ahead. Fixed, the repeats land on the saved plays and add nothing.
  const hour = []; for (let k = 0; k < 15; k++) hour.push([nowS - 4000 + k * 240, 'Art' + k, 'Song' + k]);
  const savedHour = H.merge([], H.fromFeed(feed(hour), nowS), 100).plays;
  const repeatDayAhead = []; for (const [t, a, ti] of hour) repeatDayAhead.push([t + 86400, a, ti]);
  check('feed: the Oct 27 repeats, fixed, add nothing', H.merge(savedHour, H.fromFeed(feed(repeatDayAhead), nowS), 100).added === 0);
  const newDayAhead = H.merge(savedHour, H.fromFeed(feed([[nowS - 30 + 86400, 'New', 'Misdated']].concat(repeatDayAhead)), nowS), 100);
  check('feed: a new play dated a day ahead is recorded at the right time, with no gap',
    newDayAhead.added === 1 && newDayAhead.plays[0][0] === nowS - 30 && newDayAhead.plays[0][2] === 'Misdated' && !newDayAhead.gap);
  const stuck = [[nowS + 86400, 'X', 'Tomorrow', '', 1], [nowS - 3600, 'Z', 'Real', '']];
  const unstuck = H.dropFuture(stuck, nowS);
  check('saved future plays are removed', unstuck.length === 1 && unstuck[0][2] === 'Real');
  check('nothing to remove: same list back', H.dropFuture(unstuck, nowS) === unstuck);
  const resumed = H.merge(unstuck, H.fromFeed(feed([[nowS - 60, 'N', 'New']]), nowS), 100);
  check('after removing them, new plays are recorded again (flagged after a gap)', resumed.added === 1 && resumed.plays[0][2] === 'New' && resumed.gap);

  const at = new Date(2026, 9, 5, 15, 7).getTime() / 1000;   // Oct 5 2026, 3:07 PM local
  check('date is m/d/yy', H.formatDate(at) === '10/5/26');
  check('time is h:mm AM/PM', H.formatTime(at) === '3:07 PM' && H.formatTime(new Date(2026, 0, 1, 0, 5).getTime() / 1000) === '12:05 AM');

  const csv = H.toCSV([[at + 60, 'Mel Tormé', 'The Christmas Song, "Live"', 'X', 1], [at, 'A', 'One', '']], () => 'In playlist');
  const lines = csv.split('\r\n');
  check('csv: byte-order mark for Excel, header, oldest first',
    csv.charCodeAt(0) === 0xfeff && lines[0].slice(1) === 'Date,Time,Artist,Title,Album,Playlist status,After gap' && lines[1].indexOf(',A,One,') > 0);
  check('csv: commas and quotes escaped, gap flag written',
    lines[2] === '10/5/26,3:08 PM,Mel Tormé,"The Christmas Song, ""Live""",X,In playlist,yes');

  const items3 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const cov = H.coverage([
    { status: 'have', item: { id: 'a' } }, { status: 'have', item: { id: 'a' } },   // same song twice counts once
    { status: 'have', marked: 'have', item: { id: 'b' } },                          // hand-mark doesn't count
    { status: 'other', item: { id: 'c' } }, { status: 'none' }, { status: 'unknown' },
    { status: 'have', item: { id: 'gone' } },                                         // no longer in the playlist
  ], items3);
  check('coverage: unique automatic matches only, against the current playlist', cov.heard === 1 && cov.total === 3);

  console.log('--- play history ---');
  for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// Linking a hand-mark to a specific playlist video
function linkChecks() {
  let fail = 0;
  const res = [];
  const check = (label, ok) => { res.push([label, ok]); if (!ok) fail++; };
  const none = { status: 'none' };
  const other = { status: 'other', reason: 'otherArtist', item: items[41] };
  const linked = M.applyMark(none, { v: 'have', id: 'p3GVsuhY2Fo' }, false, items);
  check('linked mark: in playlist, linked, Open goes to the chosen video', linked.status === 'have' && linked.linked && linked.item.id === 'p3GVsuhY2Fo');
  const wins = M.applyMark(other, { v: 'have', id: 'p3GVsuhY2Fo' }, false, items);
  check('link wins over the automatic closest match', wins.item.id === 'p3GVsuhY2Fo' && wins.linked);
  const gone = M.applyMark(none, { v: 'have', id: 'not-in-playlist' }, false, items);
  check('linked video left the playlist: still marked, no item, flagged', gone.status === 'have' && gone.linkMissing && gone.item === null && !gone.linked);
  const plain = M.applyMark(other, { v: 'have' }, false, items);
  check('unlinked mark keeps the closest match, not linked', plain.status === 'have' && !plain.linked && plain.item === items[41]);
  const cov = M.History.coverage([linked, plain, gone], items);
  check('coverage counts linked marks only', cov.heard === 1);

  const sg = M.suggest('Peas', 'Holy Night Reprise', items, 3);
  check('suggest: shared title and artist words rank first', sg.length > 0 && sg[0].id === 'vjJxuUKGvE8');
  const sg2 = M.suggest('Eddie Dunstedter', 'Let It Snow Medley', items, 3);
  check('suggest: artist breaks ties between same-title songs', sg2[0].id === 'rXxOTMA5Jxs');
  check('suggest: nothing in common returns nothing', M.suggest('Zzyzx', 'Qwerty', items, 5).length === 0);
  check('suggest: filler words alone don\'t count ("you")', !M.anyOf(M.suggest('Louis Armstrong', "'Zat You Santa Claus", items, 6), it => /New Year|Trumpets/.test(it.title)));

  const sr = M.searchItems('sleigh', items, 40);
  check('search: finds every Sleigh Ride', sr.length === 5);
  check('search: word starts ("jack jo")', M.searchItems('jack jo', items, 40).length === 1 && M.searchItems('jack jo', items, 40)[0].id === 'kTLvI1h-lA4');
  check('search: channel name counts ("ventures")', M.searchItems('ventures', items, 40)[0].id === 'azOu4nKq0_k');
  check('search: empty query returns nothing', M.searchItems('  ', items, 40).length === 0);
  check('search: limit respected', M.searchItems('christmas', items, 3).length === 3);

  console.log('--- linking to a playlist song ---');
  for (const [label, ok] of res) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// YouTube search text includes mixes; playlist memory notices songs that leave the playlist
function goneChecks() {
  let fail = 0;
  const res = [];
  const check = (label, ok) => { res.push([label, ok]); if (!ok) fail++; };
  const q = M.searchQuery;
  check('search: mix in the artist field is added', q('Joe Williams (Bombay Dub Orchestra Remix)', 'Jingle Bells') === 'Joe Williams Jingle Bells Bombay Dub Orchestra Remix');
  check('search: mix in the title kept, brackets dropped', q('Eartha Kitt', 'Santa Baby [Alexkid & Dj Sleep Remix]') === 'Eartha Kitt Santa Baby Alexkid & Dj Sleep Remix');
  check('search: "featuring" credit isn\'t a mix', q('Lenny B (Featuring David Verbist)', 'Feliz Navidad') === 'Lenny B Feliz Navidad');
  check('search: plain song unchanged', q('Jack Jones', 'Sleigh Ride') === 'Jack Jones Sleigh Ride');

  const A = M.Archive;
  const twenty = []; for (let i = 0; i < 20; i++) twenty.push({ id: 'v' + i, title: 'Song ' + i, ch: 'Artist ' + i + ' - Topic' });
  let u = A.update({}, twenty, 1000);
  check('first read: every song remembered, none gone', Object.keys(u.archive).length === 20 && u.gone === 0);
  const minus2 = twenty.slice(2);
  u = A.update(u.archive, minus2, 2000);
  check('two songs vanish: marked gone with the time', u.gone === 2 && u.archive.v0.gone === 2000 && u.archive.v1.title === 'Song 1');
  check('gone list: newest first, titles kept', A.goneList(u.archive).length === 2 && A.goneList(u.archive)[0].title !== undefined);
  const again = A.update(u.archive, minus2, 3000);
  check('still gone on the next read: not re-marked', again.gone === 0 && again.archive.v0.gone === 2000);
  const dis = A.dismiss(again.archive, 'v0', 3500);
  check('dismiss hides it from the gone list', A.goneList(dis).length === 1 && A.goneList(dis)[0].id === 'v1');
  const back = A.update(dis, twenty, 4000);
  check('video comes back: no longer gone or dismissed', back.back === 2 && !back.archive.v0.gone && !back.archive.v0.dismissed && A.goneList(back.archive).length === 0);
  const big = A.update(back.archive, twenty.slice(10), 5000);
  check('half the playlist vanishing at once is refused, nothing marked', big.refused === 10 && big.gone === 0 && A.goneList(big.archive).length === 0);
  const few = A.update(back.archive, twenty.slice(5), 5000);
  check('five vanishing at once is allowed (small playlists)', few.refused === 0 && few.gone === 5);
  const renamed = A.update(back.archive, [{ id: 'v3', title: 'Song 3 (Remastered)', ch: 'X' }].concat(twenty.slice(0, 3), twenty.slice(4)), 6000);
  check('a retitled video keeps its newest title and first-seen time', renamed.archive.v3.title === 'Song 3 (Remastered)' && renamed.archive.v3.first === 1000);

  const gone = [{ id: 'g', title: 'Kaskade - Christmas Is Here (ft. Late Night Alumni) Lyrics', ch: 'Vibe Jaron' }];
  const g1 = A.applyGone({ status: 'none' }, 'Kaskade', 'Christmas Is Here', gone);
  check('play of a gone song is flagged gone with the old video', g1.status === 'gone' && g1.item.id === 'g');
  check('same title, different artist stays not in playlist', A.applyGone({ status: 'none' }, 'Someone Else', 'Christmas Is Here', gone).status === 'none');
  check('"Not this one" mark is respected', A.applyGone({ status: 'none', marked: 'not' }, 'Kaskade', 'Christmas Is Here', gone).status === 'none');
  check('disliked is respected', A.applyGone({ status: 'disliked', disliked: true }, 'Kaskade', 'Christmas Is Here', gone).status === 'disliked');
  check('songs in the playlist are untouched', A.applyGone({ status: 'have', item: { id: 'x' } }, 'Kaskade', 'Christmas Is Here', gone).status === 'have');
  const lm = M.applyMark({ status: 'none' }, { v: 'have', id: 'g' }, false, []);
  check('linked video gone: the card can name it (linkId kept)', lm.linkMissing && lm.linkId === 'g');

  console.log('--- search text and songs gone from the playlist ---');
  for (const [label, ok] of res) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// Reading playlists past 100 songs, with fake YouTube pages
async function readerChecks() {
  let fail = 0;
  const res = [];
  const check = (label, ok) => { res.push([label, ok]); if (!ok) fail++; };
  const R = M.Reader;
  const song = i => ({ id: 'v' + i, title: 'Song ' + i, ch: 'Ch ' + i });
  const pvr = (x, i) => ({ playlistVideoRenderer: { videoId: x.id, index: { simpleText: String(i) }, title: { runs: [{ text: x.title }] },
    shortBylineText: { runs: [{ text: x.ch }] }, isPlayable: true, lengthSeconds: '180' } });
  const panel = (x, i) => ({ playlistPanelVideoRenderer: { videoId: x.id, indexText: { simpleText: String(i) }, title: { simpleText: x.title },
    shortBylineText: { runs: [{ text: x.ch }] }, lengthText: { simpleText: '3:00' } } });
  const page = data => '<script>var ytInitialData = ' + JSON.stringify(data) + ';</script>"INNERTUBE_CLIENT_VERSION":"2.1"';
  // A fake YouTube: playlist page shows the first 100 plus a next-page token; next-page answers empty;
  // a watch page's side panel shows `win` songs starting near the requested position
  function fakeYouTube(list, opts) {
    const o = Object.assign({ win: 200, hiddenNote: 0, stall: false }, opts);
    const calls = { watch: 0, next: 0 };
    const get = async url => {
      if (url.indexOf('/playlist?') >= 0) {
        const first = []; for (let i = 0; i < Math.min(100, list.length); i++) first.push(pvr(list[i], i + 1));
        if (list.length > 100) first.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'T' } } } });
        const data = { header: { stats: [{ runs: [{ text: String(list.length + o.hiddenNote) }, { text: ' videos' }] }] }, contents: first };
        if (o.hiddenNote) data.alerts = [{ text: o.hiddenNote + ' unavailable videos are hidden' }];
        return page(data);
      }
      calls.watch++;
      if (o.stall) return page({ panel: [] });
      const at = Number(url.match(/index=(\d+)/)[1]);
      const from = Math.max(0, at - 10), to = Math.min(list.length, from + o.win);
      const items = []; for (let i = from; i < to; i++) items.push(panel(list[i], i + 1));
      return page({ playlist: { contents: items } });
    };
    const post = async () => { calls.next++; return { responseContext: {} }; };
    return { get, post, calls };
  }
  const big = []; for (let i = 1; i <= 250; i++) big.push(song(i));

  let f = fakeYouTube(big.slice(0, 101));
  let r = await R.read(f.get, f.post, 'PLX');
  check('101 songs: all read, complete, one side-panel step', r.complete && r.items.length === 101 && r.items[100].id === 'v101' && f.calls.watch === 1);

  f = fakeYouTube(big, { win: 60 });
  r = await R.read(f.get, f.post, 'PLX');
  let inOrder = true; for (let i = 0; i < r.items.length; i++) if (r.items[i].id !== 'v' + (i + 1)) inOrder = false;
  check('250 songs with a 60-song panel: several steps, all in order', r.complete && r.items.length === 250 && inOrder && f.calls.watch >= 3);

  f = fakeYouTube(big.slice(0, 80));
  r = await R.read(f.get, f.post, 'PLX');
  check('under 100 songs: no extra requests', r.complete && r.items.length === 80 && f.calls.watch === 0 && f.calls.next === 0);

  f = fakeYouTube(big.slice(0, 150), { stall: true });
  r = await R.read(f.get, f.post, 'PLX');
  check('side panel gives nothing: read is marked incomplete (100 of 150)', !r.complete && r.read === 100 && r.expected === 150 && r.items.length === 100);

  f = fakeYouTube(big.slice(0, 120), { hiddenNote: 3 });
  r = await R.read(f.get, f.post, 'PLX');
  check('"3 unavailable videos are hidden": expected count leaves them out', r.complete && r.expected === 120 && r.hidden === 3);

  const dup = big.slice(0, 101); dup[100] = dup[4];   // same video at positions 5 and 101
  f = fakeYouTube(dup);
  r = await R.read(f.get, f.post, 'PLX');
  check('a song in the playlist twice is counted at both positions', r.complete && r.items.length === 101 && r.items[100].id === 'v5');

  const list = [{ idx: 1 }, { idx: 2 }];
  const added = R.mergeByIndex(list, [{ idx: 2 }, { idx: 4 }, { idx: 3 }, { idx: 3 }]);
  check('merge adds only later positions, once each, in order', added === 2 && list.length === 4 && list[2].idx === 3 && list[3].idx === 4);
  check('counts reads "1,234 videos"', R.counts({ stats: [{ runs: [{ text: '1,234' }] }] }).total === 1234);

  // Oct 26: right after a shuffle, the first 100 came back in the new order and the side panel in the old one.
  // The count added up (129), but 7 songs were repeats and 7 others were missing, and they were marked gone.
  const good = [], mixed = [];
  for (let i = 0; i < 129; i++) good.push({ id: 'v' + i });
  for (let i = 0; i < 122; i++) mixed.push({ id: 'v' + i });
  for (let i = 0; i < 7; i++) mixed.push({ id: 'v' + (i * 3) });
  check('repeats: counts songs listed a second time', R.repeats(mixed) === 7 && R.repeats(good) === 0);
  check('a read with songs repeated that weren\'t before is not trusted', !R.consistent(mixed, good));
  check('a clean read is trusted, and a song really in the playlist twice stays fine', R.consistent(good, good) && R.consistent(good.concat([{ id: 'v5' }]), good.concat([{ id: 'v5' }])) && R.consistent(good, null));
  check('with nothing to compare to, a read with repeats is not trusted', !R.consistent(mixed, null));

  const P = R.parseLength;
  check('lengths: "3:05", "1:02:03", junk', P('3:05') === 185 && P('1:02:03') === 3723 && P('') === 0 && P('live') === 0 && P('3:') === 0);
  check('lengths kept from both page types', r.items[0].secs === 180 && R.entryFrom({ videoId: 'x', title: { simpleText: 't' }, lengthText: { simpleText: '4:10' } }).secs === 250);
  const H = M.History;
  const L = H.lengthStats([{ secs: 180 }, { secs: 240 }, { secs: 0 }, {}]);
  check('length stats: total, average of known songs, unknown counted', L.total === 420 && L.avg === 210 && L.known === 2 && L.unknown === 2);
  check('formats: "5 h 42 min", "42 min", "3:23", "1:02:05"',
    H.formatTotal(20520) === '5 h 42 min' && H.formatTotal(2520) === '42 min' && H.formatClock(203) === '3:23' && H.formatClock(3725) === '1:02:05');

  console.log('--- reading playlists past 100 songs ---');
  for (const [label, ok] of res) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// Stats panel numbers
function statsChecks() {
  let fail = 0;
  const res = [];
  const check = (label, ok) => { res.push([label, ok]); if (!ok) fail++; };
  const S = M.Stats;
  // 6 plays, newest first; 200 s apart; a gap before the oldest of the newest three
  const T = 100000;
  const plays = [
    [T + 1000, 'Kaskade', 'Christmas Is Here', ''],
    [T + 800, 'Peas', 'O Holy Night', ''],
    [T + 600, 'Unknown Artist', 'Mystery Song', '', 1],   // first play after a gap
    [T, 'Kaskade', 'Christmas Is Here', ''],
    [T - 200, 'Unknown Artist', 'Mystery Song', ''],
    [T - 400, 'Disliked Artist', 'Bad Song', ''],
  ];
  const items = [
    { id: 'k', title: 'Kaskade - Christmas Is Here', ch: 'Vibe Jaron', secs: 240 },
    { id: 'p', title: 'O Holy Night', ch: 'Peas - Topic', secs: 180 },
    { id: 'z', title: 'Never Played', ch: 'Nobody', secs: 300 },
  ];
  const status = (artist, title) => /Kaskade/.test(artist) ? { status: 'have', item: items[0] }
    : /Peas/.test(artist) ? { status: 'have', marked: 'have', item: items[1] }       // unlinked mark: not "heard"
    : /Disliked/.test(artist) ? { status: 'disliked', disliked: true } : { status: 'none' };
  const st = S.compute(plays, items, status);
  check('plays, distinct songs, repeats', st.plays === 6 && st.unique === 4 && st.repeated === 2 && st.repeatPlays === 2);
  check('recorded time skips the gap (800 s of the 1400 s span)', st.coveredSecs === 800 && st.gaps === 1);
  check('top song is the most played, ties broken by most recent', st.top[0].title === 'Christmas Is Here' && st.top[0].count === 2 && st.top[1].title === 'Mystery Song');
  check('most-played missing songs leave out dislikes and songs you have', st.topMissing.length === 1 && st.topMissing[0].title === 'Mystery Song' && st.missingSongs === 1);
  check('new-song rate: 4 of the 6 recent plays were first plays', st.recent === 6 && st.recentFirsts === 4);
  check('replays across a recording gap are left out (both here)', st.repeatIntervals === 0 && st.repeatsSpanningGap === 2 && st.avgRepeatSecs === 0);
  // No gaps: A at 0, 600, 1500 (intervals 600, 900); B at 100, 1300 (1200) -> mean 900, median 900
  const clean = S.compute([[1500, 'A', 'a', ''], [1300, 'B', 'b', ''], [600, 'A', 'a', ''], [100, 'B', 'b', ''], [0, 'A', 'a', '']], items, () => ({ status: 'none' }));
  check('average and median time between replays', clean.repeatIntervals === 3 && clean.avgRepeatSecs === 900 && clean.medianRepeatSecs === 900 && clean.repeatsSpanningGap === 0);
  // Gap flagged on the play at 1300: A's 600->1500 interval spans it, A's 0->600 doesn't; B's 100->1300 includes it
  const withGap = S.compute([[1500, 'A', 'a', ''], [1300, 'B', 'b', '', 1], [600, 'A', 'a', ''], [100, 'B', 'b', ''], [0, 'A', 'a', '']], items, () => ({ status: 'none' }));
  check('only the replays spanning the gap are dropped', withGap.repeatIntervals === 1 && withGap.avgRepeatSecs === 600 && withGap.repeatsSpanningGap === 2);
  check('breakdown by status', st.breakdown.have.songs === 2 && st.breakdown.have.plays === 3 && st.breakdown.none.plays === 2 && st.breakdown.disliked.songs === 1);
  check('playlist: total, longest, shortest', st.playlist.total === 720 && st.playlist.longest.id === 'z' && st.playlist.shortest.id === 'p');
  check('heard / not heard: unlinked mark doesn\'t count', st.playlist.heard === 1 && st.playlist.notHeard.length === 2);
  const sh = st.shares;
  check('shares of plays: have 3/6, missing 2/6, disliked 1/6, other 0', sh.have.plays === 3 && Math.round(sh.have.playPct) === 50 &&
    Math.round(sh.missing.playPct) === 33 && Math.round(sh.disliked.playPct) === 17 && sh.other.playPct === 0);
  check('shares of songs: 2/4 have, 1/4 missing, 1/4 disliked', sh.have.songPct === 50 && sh.missing.songPct === 25 && sh.disliked.songPct === 25);
  const gone = S.compute([[T, 'Gone Artist', 'Gone Song', ''], [T - 200, 'Other Artist', 'Other Song', '']], items,
    a => /Gone/.test(a) ? { status: 'gone' } : { status: 'other' });
  check('"gone" counts as not in playlist; groups add to 100%', gone.shares.missing.plays === 1 &&
    Math.round(gone.shares.have.playPct + gone.shares.other.playPct + gone.shares.missing.playPct + gone.shares.disliked.playPct) === 100);
  // Rotation of 3 songs every 600, 1800 and 5400 s over 48 h, with an 8 h stretch not recorded.
  // True replay-weighted mean interval = 3 / (1/600 + 1/1800 + 1/5400) = 1246 s.
  const sim = [];
  const periods = [[600, 0], [1800, 250], [5400, 470]];
  for (let p = 0; p < 3; p++) for (let t = periods[p][1]; t < 48 * 3600; t += periods[p][0]) sim.push([t, 'S' + p, 'Song ' + p, '']);
  const gapFrom = 20 * 3600, gapTo = 28 * 3600;
  let kept = [];
  for (const x of sim) if (x[0] < gapFrom || x[0] >= gapTo) kept.push(x);
  kept.sort((a, b) => b[0] - a[0]);
  let firstAfter = null; for (const x of kept) if (x[0] >= gapTo) firstAfter = x;   // oldest play after the gap
  firstAfter.push(1);
  const est = S.compute(kept, items, () => ({ status: 'none' }));
  check('recorded-time estimate lands on the true average despite an 8 h gap (1246 s, within 5%)', Math.abs(est.rateRepeatSecs - 1246) / 1246 < 0.05);
  check('leaving out gap-spanning replays runs short; including them as measured runs long',
    est.avgRepeatSecs < est.rateRepeatSecs && est.avgGapRepeatSecs > est.rateRepeatSecs);
  check('no replays yet: no estimate', S.compute([[100, 'A', 'a', ''], [0, 'B', 'b', '']], items, () => ({ status: 'none' })).rateRepeatSecs === 0);
  check('most recently replayed: repeats only, newest replay first', st.recentRepeats.length === 2 && st.recentRepeats[0].title === 'Christmas Is Here' && st.recentRepeats[1].title === 'Mystery Song');
  const stt = S.songTimes(plays, M.markKey('Kaskade', 'Christmas Is Here'));
  check('one song\'s times come back oldest first, with gap markers', stt.times.length === 2 && stt.times[0] === T && stt.times[1] === T + 1000 && stt.gapTimes.length === 1 && stt.gapTimes[0] === T + 600);
  const log = S.playLog([0, 600, 1500, 2000], [1500]);   // a gap was flagged on the play at 1500
  check('play log: newest first, time since previous (kept across a gap, which is flagged), first play labeled',
    log.length === 4 && log[0].at === 2000 && log[0].since === 500 && log[1].spansGap && log[1].since === 900 &&
    log[2].since === 600 && !log[2].spansGap && log[3].first);
  const unk = S.compute(plays, [], () => ({ status: 'unknown' }));
  check('playlist unreadable: no shares instead of a divide-by-zero', unk.labeledPlays === 0 && unk.shares.have.playPct === 0);
  const empty = S.compute([], items, status);
  check('no plays yet: zeros, every playlist song not heard', empty.plays === 0 && empty.unique === 0 && empty.perHour === 0 && empty.playlist.notHeard.length === 3);
  check('spans: "45 min", "2 h 30 min", "2 days 12 h"', S.formatSpan(2700) === '45 min' && S.formatSpan(9000) === '2 h 30 min' && S.formatSpan(216000) === '2 days 12 h');
  console.log('--- stats panel ---');
  for (const [label, ok] of res) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// Backup and restore
function backupChecks() {
  let fail = 0;
  const res = [];
  const check = (label, ok) => { res.push([label, ok]); if (!ok) fail++; };
  const B = M.Backup;
  // Tablet recorded the evening; laptop recorded overnight and the morning
  const tablet = [[5000, 'A', 'a', ''], [4800, 'B', 'b', ''], [4600, 'C', 'c', '']];
  const laptop = [[9000, 'E', 'e', ''], [5300, 'D', 'd', ''], [5000, 'A', 'a', ''], [4800, 'B', 'b', '', 1]];
  const m = B.mergeHistory(tablet, laptop, 100);
  let aCount = 0, bPlay = null; for (const p of m) { if (p[2] === 'a') aCount++; if (p[2] === 'b') bPlay = p; }
  check('merge: union of both devices, newest first, shared plays once (E D A B C)', m.length === 5 && m[0][2] === 'e' && m[4][2] === 'c' && aCount === 1);
  check('merge: a play recorded without a gap on one device loses its gap marker', !bPlay[4]);
  const hole = B.mergeHistory([[9000, 'E', 'e', '', 1], [2000, 'X', 'x', '']], [[8700, 'F', 'f', ''], [8400, 'G', 'g', '']], 100);
  check('merge: a gap the other device filled is no longer marked', !hole[0][4]);
  const stillGap = B.mergeHistory([[9000, 'E', 'e', '', 1], [2000, 'X', 'x', '']], [], 100);
  check('merge: a gap nobody filled stays marked', stillGap[0][4] === 1);
  check('merge: cap keeps the newest', B.mergeHistory(tablet, laptop, 2).length === 2 && B.mergeHistory(tablet, laptop, 2)[0][0] === 9000);

  const mk = B.mergeMarks({ k1: { v: 'have', at: 100 }, k2: 50 }, { k1: { v: 'not', at: 200 }, k2: { v: 'not', at: 40 }, k3: { v: 'have', at: 1, id: 'x' } });
  check('marks: the more recent one wins, new ones added', mk.k1.v === 'not' && mk.k2 === 50 && mk.k3.id === 'x');
  check('dislikes: union', Object.keys(B.mergeDislikes({ a: 1 }, { b: 2, a: 3 })).length === 2 && B.mergeDislikes({ a: 1 }, { a: 3 }).a === 3);
  const ar = B.mergeArchive({ v1: { id: 'v1', title: 'Old', first: 10, last: 100, gone: 150 }, v2: { id: 'v2', title: 'T2', first: 5, last: 50 } },
    { v1: { id: 'v1', title: 'New', first: 20, last: 200 }, v3: { id: 'v3', title: 'T3', first: 1, last: 1, gone: 2, dismissed: 3 } });
  check('playlist memory: newer sighting wins; seen again after "gone" means not gone', ar.v1.title === 'New' && !ar.v1.gone && ar.v1.first === 10 && ar.v1.last === 200);
  check('playlist memory: entries from either side kept, dismissals kept', ar.v2.title === 'T2' && ar.v3.gone === 2 && ar.v3.dismissed === 3);

  const good = B.build({ history: { christmas: laptop }, marks: { k: { v: 'have', at: 1 } }, dislikes: { d: 5 }, archive: { v1: { title: 'T', first: 1, last: 2 } } });
  const v = B.validate(JSON.parse(JSON.stringify(good)));
  check('round trip: a backup reads back the same', v.data.history.christmas.length === 4 && v.data.marks.k.v === 'have' && v.data.dislikes.d === 5 && v.data.archive.v1.id === 'v1' && v.skipped === 0);
  const messy = JSON.parse(JSON.stringify(good));
  messy.data.history.christmas.push(['bad'], [1, 2, 3]); messy.data.marks.junk = 'x'; messy.data.dislikes.junk = 'y';
  check('malformed entries are skipped and counted', B.validate(messy).skipped === 4 && B.validate(messy).data.history.christmas.length === 4);
  const refuse = o => { try { B.validate(o); return false; } catch (e) { return true; } };
  check('not ours / wrong format / no data: refused', refuse({ app: 'other' }) && refuse(Object.assign({}, good, { format: 99 })) && refuse({ app: 'soma-xmas-checker', format: 1 }) && refuse(null));
  const orig = { at: 500, playlistId: 'PL1', songs: [{ id: 'p1', videoId: 'v1', title: 'One' }, { id: 'p2', videoId: 'v2', title: 'Two' }] };
  const withOrig = B.validate(JSON.parse(JSON.stringify(B.build({ history: {}, marks: {}, dislikes: {}, archive: {}, original: orig }))));
  check('original order: a backup carries it', withOrig.data.original && withOrig.data.original.songs.length === 2 && withOrig.data.original.songs[1].title === 'Two' && withOrig.data.original.at === 500);
  check('original order: an older backup without it reads as none', v.data.original === null);
  const later = { at: 900, songs: [{ id: 'p2', videoId: 'v2', title: 'Two' }] };
  check('original order: merging keeps the one saved first; either side alone is kept',
    B.mergeOriginal(later, orig) === orig && B.mergeOriginal(orig, later) === orig && B.mergeOriginal(null, orig) === orig && B.mergeOriginal(orig, null) === orig && B.mergeOriginal(null, null) === null);
  const pv = B.preview({ history: { christmas: tablet } }, v.data);
  check('preview: says when the backup has the original order', B.preview({ history: {} }, withOrig.data).original === 500 && pv.original === 0);
  check('preview: plays in the backup, how many are new here, date range', pv.plays === 4 && pv.newPlays === 2 && pv.first === 4800 && pv.last === 9000 && pv.marks === 1);

  console.log('--- backup and restore ---');
  for (const [label, ok] of res) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// Shuffling the real playlist, against a fake YouTube Data API that applies moves the way YouTube does
async function shuffleChecks() {
  let fail = 0;
  const res = [];
  const check = (label, ok) => { res.push([label, ok]); if (!ok) fail++; };
  const S = M.Shuffle;
  let seed = 11;
  const rand = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
  const range = n => { const a = []; for (let i = 0; i < n; i++) a.push('item' + i); return a; };
  const equal = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

  const ids = range(116);
  const o = S.order(ids, rand);
  check('shuffle is a reordering of the same songs', S.sameSongs(ids, o) && !equal(ids, o));

  // Every plan, applied move by move, gives exactly the target, using only the moves it has to
  let planOk = true, fewest = true, total = 0, trials = 0;
  for (const n of [1, 2, 3, 5, 10, 50, 116, 240]) {
    for (let t = 0; t < 20; t++) {
      const cur = S.order(range(n), rand), target = S.order(cur, rand);
      const moves = S.plan(cur, target);
      let list = cur;
      for (let k = 0; k < moves.length; k++) list = S.applyMove(list, moves[k].id, moves[k].position);
      if (!equal(list, target)) planOk = false;
      const at = new Map(); for (let i = 0; i < cur.length; i++) at.set(cur[i], i);
      const ranks = []; for (let i = 0; i < target.length; i++) ranks.push(at.get(target[i]));
      if (moves.length !== n - S.longestRun(ranks).size) fewest = false;
      if (n === 116) { total += moves.length; trials++; }
    }
  }
  check('every plan, applied move by move, ends in exactly the new order (1 to 240 songs)', planOk);
  check('only songs outside the largest already-in-order group are moved', fewest);
  check('116 songs: about 95 moves on average, not 116', total / trials < 105 && total / trials > 85);
  check('already in order: no moves', S.plan(ids, ids).length === 0);
  check('one song moved to the front: one move', S.plan(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']).length === 1);
  check('longest run: 3,1,2,5,4 keeps three', S.longestRun([3, 1, 2, 5, 4]).size === 3);
  let threw = '';
  try { S.plan(['a', 'b'], ['a', 'c']); } catch (e) { threw = e.message; }
  check('a plan refuses when songs were added or removed', /changed/.test(threw));
  check('quota: 95 moves is 4,750 units', S.units(95) === 4750);
  const ro = S.restoreOrder(['a', 'b', 'c', 'd'], ['x', 'd', 'b', 'a', 'y']);
  check('original order: kept songs in their original order, removed ones skipped, added ones at the end', ro.join() === 'a,b,d,x,y');
  check('quota day is the Pacific date', S.quotaDay(Date.UTC(2026, 9, 27, 5, 0)) === '10/26/2026' && S.quotaDay(Date.UTC(2026, 9, 27, 8, 0)) === '10/27/2026');

  // Fake YouTube: 116 songs, pages of 50, owner check, moves, and a quota that can run out
  function fakeYT(n, opts) {
    opts = opts || {};
    const yt = { order: range(n), calls: 0, puts: 0, quotaAfter: opts.quotaAfter == null ? Infinity : opts.quotaAfter, owner: opts.owner || 'UCme' };
    yt.call = async (method, resource, params, body) => {
      yt.calls++;
      if (method === 'GET' && resource === 'channels') return { items: [{ id: 'UCme', snippet: { title: 'Dan' } }] };
      if (method === 'GET' && resource === 'playlists') return { items: params.id === 'PL1' ? [{ snippet: { channelId: yt.owner, title: 'Xmas Mixed' } }] : [] };
      if (method === 'GET' && resource === 'playlistItems') {
        const start = Number(params.pageToken || 0), out = [];
        for (let i = start; i < Math.min(start + params.maxResults, yt.order.length); i++) {
          const id = yt.order[i];
          out.push({ id, snippet: { position: i, title: 'Song ' + id, resourceId: { kind: 'youtube#video', videoId: 'v' + id } } });
        }
        return start + params.maxResults < yt.order.length ? { items: out, nextPageToken: String(start + params.maxResults) } : { items: out };
      }
      if (method === 'PUT' && resource === 'playlistItems') {
        if (yt.puts >= yt.quotaAfter) throw Object.assign(new Error('The request cannot be completed because you have exceeded your quota.'), { status: 403, reason: 'quotaExceeded' });
        if (body.snippet.playlistId !== 'PL1' || body.snippet.resourceId.videoId !== 'v' + body.id) throw Object.assign(new Error('bad request'), { status: 400, reason: 'badRequest' });
        yt.puts++;
        yt.order = S.applyMove(yt.order, body.id, body.snippet.position);
        return {};
      }
      throw new Error('unexpected call ' + method + ' ' + resource);
    };
    return yt;
  }

  const yt = fakeYT(116);
  const who = await S.checkOwner(yt.call, 'PL1');
  check('owner check passes for the channel that owns the playlist', who.channel === 'Dan' && who.title === 'Xmas Mixed');
  const list = await S.readItems(yt.call, 'PL1');
  check('reads all 116 songs over three pages, in order, with video ids', list.length === 116 && list[0].id === 'item0' && list[115].id === 'item115' && list[7].videoId === 'vitem7' && yt.calls === 5);
  const target = S.order(S.idsOf(list), rand), moves = S.plan(S.idsOf(list), target);
  let steps = 0;
  const r = await S.run(yt.call, 'PL1', list, moves, () => steps++, null);
  const back = S.idsOf(await S.readItems(yt.call, 'PL1'));
  check('run makes every move, and the playlist reads back in the new order', r.done === moves.length && steps === moves.length && S.matches(back, target));

  // The quota runs out partway: nothing is lost, and a fresh plan from the playlist as it now stands finishes the job
  const yt2 = fakeYT(116, { quotaAfter: 40 });
  const list2 = await S.readItems(yt2.call, 'PL1');
  const target2 = S.order(S.idsOf(list2), rand);
  let err = null;
  try { await S.run(yt2.call, 'PL1', list2, S.plan(S.idsOf(list2), target2), null, null); } catch (e) { err = e; }
  check('quota running out stops the run and says how many moves were made', err && err.reason === 'quotaExceeded' && err.done === 40);
  const mid = S.idsOf(await S.readItems(yt2.call, 'PL1'));
  check('a stopped run loses no songs', S.sameSongs(mid, target2));
  yt2.quotaAfter = Infinity;
  const rest = S.plan(mid, target2);
  const list2b = await S.readItems(yt2.call, 'PL1');
  await S.run(yt2.call, 'PL1', list2b, rest, null, null);
  check('finishing next time completes the same new order', S.matches(S.idsOf(await S.readItems(yt2.call, 'PL1')), target2));

  // Stop between moves
  const yt3 = fakeYT(20);
  const list3 = await S.readItems(yt3.call, 'PL1');
  const target3 = S.order(S.idsOf(list3), rand), moves3 = S.plan(S.idsOf(list3), target3);
  let k3 = 0;
  const r3 = await S.run(yt3.call, 'PL1', list3, moves3, () => k3++, () => k3 >= 3);
  check('Stop takes effect between moves', r3.stopped && r3.done === 3 && yt3.puts === 3);

  // Putting back the earlier order is just another plan
  const yt4 = fakeYT(30);
  const before = S.idsOf(await S.readItems(yt4.call, 'PL1'));
  const l4 = await S.readItems(yt4.call, 'PL1');
  await S.run(yt4.call, 'PL1', l4, S.plan(before, S.order(before, rand)), null, null);
  const l4b = await S.readItems(yt4.call, 'PL1');
  await S.run(yt4.call, 'PL1', l4b, S.plan(S.idsOf(l4b), before), null, null);
  const l4c = await S.readItems(yt4.call, 'PL1');
  await S.run(yt4.call, 'PL1', l4c, S.plan(S.idsOf(l4c), S.order(S.idsOf(l4c), rand)), null, null);
  const l4d = await S.readItems(yt4.call, 'PL1');
  await S.run(yt4.call, 'PL1', l4d, S.plan(S.idsOf(l4d), S.restoreOrder(before, S.idsOf(l4d))), null, null);
  check('putting back the earlier order restores it exactly', S.matches(S.idsOf(await S.readItems(yt4.call, 'PL1')), before));

  // Refuse when the signed-in channel isn't the owner
  let refused = '';
  try { await S.checkOwner(fakeYT(5, { owner: 'UCsomeoneElse' }).call, 'PL1'); } catch (e) { refused = e.message; }
  check("refuses when signed in as a channel that doesn't own the playlist", /doesn't own the playlist/.test(refused));
  refused = '';
  try { await S.checkOwner(fakeYT(5).call, 'PLnope'); } catch (e) { refused = e.message; }
  check('refuses when the playlist is not found', /couldn't be found/.test(refused));

  console.log('--- shuffling the playlist ---');
  for (const [label, ok] of res) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('');
  return fail;
}


// Source check: actions wrapped in runBusy run after a frame, when an event's target inside the
// shadow root has been cleared. Reading e.target in one broke Per page and file import (fixed in 3.11).
function sourceChecks() {
  let fail = 0;
  const src = require('fs').readFileSync(require('path').join(__dirname, 'soma-xmas-checker.user.js'), 'utf8');
  const bad = [];
  // every inline action handed to runBusy: "runBusy(() => { ... }" or "runBusy(async () => { ... }"
  const re = /runBusy\((?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    const body = src.slice(m.index, j);
    if (/\be\.target\b|\bev\.target\b/.test(body)) bad.push(src.slice(0, m.index).split('\n').length);
  }
  const ok = bad.length === 0;
  if (!ok) fail++;
  console.log('--- source checks ---');
  console.log(`${ok ? 'PASS' : 'FAIL'}  no event target read inside a delayed action${ok ? '' : ' (lines ' + bad.join(', ') + ')'}`);

  // Tampermonkey auto-updates from the repo copy: both URLs must point at this file there,
  // and package.json must carry the same version so a bump isn't half done.
  const header = key => (src.match(new RegExp('^// @' + key + '\\s+(\\S+)', 'm')) || [])[1];
  const raw = 'https://raw.githubusercontent.com/ZamulaK/Scripts/main/soma-fm/soma-xmas-checker.user.js';
  const urlsOk = header('updateURL') === raw && header('downloadURL') === raw;
  if (!urlsOk) fail++;
  console.log(`${urlsOk ? 'PASS' : 'FAIL'}  update and download URLs point at the repo copy of this file`);
  const pkgVersion = require('./package.json').version;
  const versionOk = header('version') === pkgVersion;
  if (!versionOk) fail++;
  console.log(`${versionOk ? 'PASS' : 'FAIL'}  @version ${header('version')} matches package.json ${pkgVersion}`);
  console.log('');
  return fail;
}

let failures = runAll('normal environment');
failures += keyChecks();
failures += markChecks();
failures += availabilityChecks();
failures += guaraldiChecks();
failures += pluralChecks();
failures += historyChecks();
failures += linkChecks();
failures += goneChecks();
failures += statsChecks();
failures += backupChecks();
failures += sourceChecks();

// SomaFM's page loads prototype.js 1.7.2, which replaces these built-ins (Array.from returns
// an array of nulls for {length:n}). The matcher must not depend on any of them.
const saved = { from: Array.from };
const methods = ['some', 'every', 'map', 'find', 'filter'];
for (const m of methods) saved[m] = Array.prototype[m];
Array.from = () => [null, null, null];
for (const m of methods) Array.prototype[m] = function () { throw new Error('Array.prototype.' + m + ' was called'); };
try { failures += runAll('with built-ins sabotaged like prototype.js'); failures += keyChecks(); failures += markChecks(); failures += availabilityChecks(); failures += guaraldiChecks(); failures += pluralChecks(); failures += historyChecks(); failures += linkChecks(); failures += goneChecks(); failures += statsChecks(); failures += backupChecks(); }
finally {
  Array.from = saved.from;
  for (const m of methods) Array.prototype[m] = saved[m];
}

(async () => {
  failures += await readerChecks();
  failures += await shuffleChecks();
  // and again with the built-ins sabotaged like prototype.js
  Array.from = () => [null, null, null];
  for (const m of methods) Array.prototype[m] = function () { throw new Error('Array.prototype.' + m + ' was called'); };
  try { console.log('(sabotaged)'); failures += await readerChecks(); failures += await shuffleChecks(); }
  finally { Array.from = saved.from; for (const m of methods) Array.prototype[m] = saved[m]; }
  process.exit(failures ? 1 : 0);
})();
