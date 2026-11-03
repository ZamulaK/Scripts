// What the recorder keeps from one look at SomaFM's song list. It uses the userscript's own History code,
// so plays are read, dated and gap-flagged exactly as on a device.
import Script from '../../soma-xmas-checker.user.js';
const { History, Cloud, Sync } = Script;

// songs: the feed's rows; nowS: SomaFM's clock (unix seconds); recent: the newest plays recorded so far,
// [at, artist, title, album], newest first (an hour or more of them, so a feed dated an hour off is caught).
// Returns the plays newer than the newest of them (the first one flagged as after a gap when the list no
// longer reaches back to it, so plays were missed) and the break times in the list.
export function fromFeed(songs, nowS, recent) {
  const list = recent || [];
  const fetched = History.fromFeed(songs, nowS, list);
  const m = History.merge(list.length ? [list[0]] : [], fetched, Infinity);
  return { plays: m.plays.slice(0, m.added), breaks: History.breaksFromFeed(songs, nowS, list) };
}

// Plays a device sends, checked the same way devices check the recorder's
export const cleanPlays = Cloud.cleanPlays;

// The synced document's rules, for the changes the new site (site/app) sends one at a time
export { Sync };

export const validChannel = c => /^[a-z0-9]{1,40}$/.test(c || '');
