// What the recorder keeps from one look at SomaFM's song list. It uses the userscript's own History code,
// so plays are read, dated and gap-flagged exactly as on a device.
import Script from '../../soma-xmas-checker.user.js';
const { History } = Script;

// songs: the feed's rows; nowS: SomaFM's clock (unix seconds); newest: the newest play recorded so far,
// [at, artist, title, album], or null. Returns the plays newer than it (the first one flagged as after a gap
// when the list no longer reaches back to it, so plays were missed) and the break times in the list.
export function fromFeed(songs, nowS, newest) {
  const fetched = History.fromFeed(songs, nowS);
  const m = History.merge(newest ? [newest] : [], fetched, Infinity);
  return { plays: m.plays.slice(0, m.added), breaks: History.breaksFromFeed(songs, nowS) };
}

export const validChannel = c => /^[a-z0-9]{1,40}$/.test(c || '');
