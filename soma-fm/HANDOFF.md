# SomaFM → Xmas Mixed checker: handoff

Handoff from a claude.ai conversation (Oct 24–26, 2026) to Claude Code. Current version: **3.12.7**.

The project lives in the `soma-fm/` folder of Dan's public GitHub repo `ZamulaK/Scripts` (local clone:
`C:\Utility\Scripts\UserScripts`), next to his other userscripts. Claude may commit and push changes to it.
Read this file before changing anything. `CLAUDE.md` holds the short list of rules; this file explains them.

---

## 1. What this is

A Tampermonkey userscript for Dan's tablet (and soon his laptop). It takes over SomaFM's
[Christmas Lounge song history page](https://somafm.com/christmas/songhistory.html) and shows each song
SomaFM plays against Dan's public YouTube playlist **"Xmas Mixed"** (`PLRpb0eQM5sYC0-Fhol0BnOwYygZy_UTyt`):

- **In playlist** (green pill), **Other version** (amber: same song, different artist or mix), **Not in playlist** (red), **Gone from playlist**, **Disliked**.
- Buttons: **Open** (the matching playlist video), **Search YouTube**, **✓ I have it** (links to a chosen playlist video), **✗ Not this one**, **👎 Dislike**, Undo / Unlink.
- It **records every play** while open (SomaFM's feed covers about the last hour), with dates, gap markers, paging, CSV export, and **Backup / Restore** between devices.
- A **📊 Stats** panel: playlist length, songs heard so far, share of plays you have / don't / dislike, rotation estimates, top-10 lists with per-song play logs.

The point: Dan listens to SomaFM, adds songs he likes to his playlist, and wants to (1) know instantly whether a
song is already there, (2) find the ones he doesn't have, and (3) understand SomaFM's rotation.

## 2. Where Dan runs it

- **Tablet:** Quetta browser (Chromium-based) with Tampermonkey. Portrait width is about **600 CSS px**, and that's the main layout target.
- **Laptop (next):** a desktop browser with Tampermonkey, kept running with PowerToys Awake for continuous recording.
  The site needs to be excluded from tab sleeping (Edge "Never put these sites to sleep" / Chrome "Always keep these sites active").
- Tampermonkey storage is **per browser**. Moving data between devices uses Backup / Restore (merge).
- **Updates arrive automatically** (since 3.11.1): `@updateURL` / `@downloadURL` point at the raw file on GitHub's `main`
  branch, and Tampermonkey installs any higher `@version` it finds there. So **every push to `main` ships to Dan's devices**;
  push only after the regression gates pass. Every change bumps `@version` (and `package.json`, which a source check enforces).
  Import from file (Dashboard → Utilities) still works for testing a build before pushing it.

## 3. Files

| File | What it is |
|---|---|
| `soma-xmas-checker.user.js` | The whole userscript. One file, by design, so it can be imported into Tampermonkey as-is. |
| `soma-xmas-checker.test.js` | Unit tests for the pure modules (`npm test`). Runs everything twice: normally, and with built-ins sabotaged the way SomaFM's prototype.js breaks them. Also a source check (see §7.4). |
| `xmas-mixed-original-order.csv` | The playlist's original order (129 songs: position, title, channel, video link), read Oct 26, 2026 from Dan's machine before the first shuffle. A permanent copy outside Tampermonkey; Dan was fine with it being public. |
| `playlist.fixture.json` | Snapshot of 61 songs from the playlist (Oct 24) that the matching tests run against. |
| `page-check.js` | Real-page regression check (`npm run test:page`): loads SomaFM's live page in headless Chromium with stand-ins for Tampermonkey, checks layout at 1024/768/600/400/360 px, light and dark, plus Stats, Backup, Per page, card play history, and response time. Needs internet to somafm.com, and never contacts YouTube. |
| `package.json` | `npm test`, `npm run test:page`. Playwright is a dev dependency. |

First-time setup on a new machine: `npm install`, then `npx playwright install chromium`.

## 4. How it works

```
SomaFM page loads ──► main() hides SomaFM's layout, adds a viewport tag, mounts the UI in a shadow root
   │
   ├─ every 60 s (Live updates on): fetch /songs/christmas.json ──► History.fromFeed ──► History.merge into saved history
   │                                                                (gap marker if the feed no longer reaches back)
   ├─ every 15 min (or Refresh): Reader.read(YouTube) ──► playlist items ──► Archive.update (remember titles, notice gone songs)
   │
   └─ render(): for each play shown, statusOf(row) =
          Matcher.check(artist, title, items)        automatic match
          → Matcher.applyMark(…, mark, disliked, items)  hand marks / links / dislikes
          → Archive.applyGone(…)                      was it in the playlist before?
        cached per song key (statusCache); cleared only for what changed
```

### Modules (all in the one file)

| Module | Pure? | Responsibility |
|---|---|---|
| `Matcher` | yes | Song matching, search text, mark keys, hand-mark logic, suggestions and search for linking, unavailable-video test, array helpers that are safe under prototype.js (`anyOf`, `allOf`, `mapOf`, `keep`). |
| `History` | yes | Play history: feed → plays, merging with gap detection, date/time formats, CSV, coverage (playlist songs heard), playlist length stats. |
| `Archive` | yes | Remembering playlist titles, detecting songs gone from the playlist (with a safety stop), dismissing, flagging plays of gone songs. |
| `Backup` | yes | Backup file format, validation, merge rules (history, marks, dislikes, archive), import preview. |
| `Stats` | yes | Everything in the Stats panel: counts, shares, rotation estimates, top lists, per-song play logs. |
| `Shuffle` | yes (I/O injected) | Shuffling the real playlist: Fisher-Yates order, the move plan, reading the playlist and making the moves through the YouTube Data API, owner check. `call(method, resource, params, body)` is injected so it can be tested with a fake API. See §8a. |
| `Reader` | yes (I/O injected) | Reading the YouTube playlist: page parsing, the >100-song side-panel fallback, complete/incomplete reads. `read(get, post)` takes fetch functions so it can be tested with a fake YouTube. |
| `main()` | no | Everything on the page: UI, storage, timers, dialogs, event handlers. Runs only under Tampermonkey (the file exports the modules instead when loaded by Node). |

### Saved data (Tampermonkey `GM_getValue` / `GM_setValue`)

| Key | Contents |
|---|---|
| `history:<channel>` | Plays, newest first: `[unixSeconds, artist, title, album, afterGap?]`. `afterGap = 1` on the first play recorded after a stretch that was missed. Capped at `HISTORY_MAX` (10,000). |
| `playlist` | Cached playlist read: `{ schema, at, items: [{id, title, ch, secs}], hidden }`. Re-read when older than 15 min or when `schema !== CACHE_SCHEMA` (currently 3). |
| `archive:<playlistId>` | Every playlist song ever seen: `{ [videoId]: { id, title, ch, first, last, gone?, dismissed? } }` (ms). |
| `marks` | Hand marks by song key: `{ v: 'have' \| 'not', at, id? }`. `id` = linked playlist video. Old 1.x marks are a bare timestamp meaning "have". |
| `dislikes` | Song key → timestamp. Kept separate from marks so Undo restores exactly. |
| `backup:beforeImport` | `{ at, data }` saved before every import, for "Undo last import". |
| `signin:clientId` | Dan's Google OAuth Client ID (pasted into the Shuffle panel once per device; kept out of the public repo). |
| `signin:pending`, `signin:token`, `signin:reopen` | Sign-in in progress (random `state`, popup or same tab); the one-hour access key `{ token, at, exp }`; "reopen Shuffle after a same-tab sign-in". |
| `shuffle:job:<playlistId>` | A shuffle or put-back in progress: `{ target, before, kind: 'shuffle' \| 'undo', at }`. Saved before the first move; cleared once the read-back confirms the order. |
| `shuffle:original:<playlistId>` | `{ at, playlistId, songs: [{ id, videoId, title }] }`: the playlist's order before it was first changed. Saved once, never overwritten; **included in backups** (merge keeps the earliest saved; Replace keeps this device's if the backup has none). |
| `shuffle:last:<playlistId>` | `{ before, at }`: the order before the last shuffle, for "Show the earlier order". |
| `shuffle:units` | `{ day, units }`: this script's own estimate of quota used today (Pacific date). |
| `filters`, `live`, `keepAwake`, `pageSize`, `topSort` | Per-device settings. Not included in backups (nor are the `signin:` keys or the other `shuffle:` keys). |

**Song key** = `Matcher.markKey(artist, title)` = normalized artist + `|` + normalized title (case, accents, punctuation ignored). Marks, dislikes, stats and caches all use it.

### Outside sources

| Source | Used for | Notes |
|---|---|---|
| `https://somafm.com/songs/christmas.json` | Live play feed (same origin, plain `fetch`) | About 20 songs, about an hour. `date` is unix seconds. Titles and artists are **cut at 63 characters**. Station IDs are filtered out. |
| SomaFM's own history table | Fallback list if the feed fails | Times only, no dates; never saved to history. |
| `https://www.youtube.com/playlist?list=…` | First 100 playlist songs | Fetched via `GM_xmlhttpRequest` with **`anonymous: true`** (signed-out view) and a **desktop User-Agent** (tablets otherwise get redirected to m.youtube.com). Parses `ytInitialData`; the mobile escaped-string format is handled too. |
| `youtubei/v1/browse` (continuation) | Songs past 100 | **Returns empty for scripted requests** (as of Oct 2026). Still tried first in case it comes back. |
| `https://www.youtube.com/watch?v=<last>&list=…&index=<n>` | Songs past 100 | The watch page's playlist side panel lists the songs around position n. The script steps forward until the playlist's stated total is reached. |
| `https://accounts.google.com/o/oauth2/v2/auth` | Google sign-in for Shuffle | Implicit flow (`response_type=token`), scope `youtube`, returns to `SIGNIN_RETURN` (must match the OAuth client's redirect URI exactly). |
| `https://www.googleapis.com/youtube/v3/…` | Shuffle: `channels`, `playlists`, `playlistItems` list and update | Plain `fetch` with `Authorization: Bearer`. List = 1 unit, update = 50 units; 10,000 units a day (checked Oct 26, 2026). |
| `https://www.youtube.com/watch_videos?video_ids=a,b,c` | Not used (an alternative to Shuffle that was considered) | Builds a temporary queue **in the exact order given**, **max 50 videos**. Verified Oct 26 from a US connection. |

## 5. Hard-won gotchas (each one broke something once)

1. **SomaFM loads prototype.js 1.7.2**, which replaces `Array.from` (broken: `Array.from({length:3})` gives nulls) and `Array.prototype.map/some/every/find`. **Never use those in the script**; use `Matcher.anyOf / allOf / mapOf / keep` or plain loops. `filter`, `sort`, `slice`, `concat`, `forEach`, spread and `for…of` are fine. The unit tests sabotage these built-ins and run everything again to enforce this. Test code that runs during the sabotaged pass must avoid them too.
2. **The UI lives in a shadow root** (`#xm-host`), so SomaFM's CSS can't reach it. Query with `root.querySelector`, not `document`. Styles go in the template's `<style>`.
3. **Delayed actions lose `event.target`.** `runBusy()` waits one frame so "Working…" can paint. After that, an event's `target` inside the shadow root is cleared. **Read elements directly** (`$('#per').value`), never `e.target`, inside `runBusy` actions. This broke Per page from 3.9.0 to 3.10.0. A source check in the unit tests now fails the build if it happens again.
4. **SomaFM's page has no viewport tag.** Without the one `main()` adds, phones and tablets lay the page out 980 px wide and shrink it.
5. **YouTube from non-US servers hides region-blocked songs** (from Anthropic's cloud, 41 of 78 were hidden). Anything checking real playlist contents must run from a US connection, such as Dan's machines.
6. **The 63-character cutoff** in SomaFM titles and artists can leave an unclosed bracket (`[Rudolph the Red-Nosed Re`) or a word fragment. The matcher treats an open bracket as closed and lets a final fragment match the start of a word (a one-letter fragment only after two or more matched words).
7. **Tampermonkey's sandbox:** the wake lock is looked up on `unsafeWindow.navigator` first. `@connect` must list `www.youtube.com`, `m.youtube.com` and `youtube.com`, or requests fail as "network error".
8. **Background redraws are paused while a dialog or the song picker is open** (`quietRender()` + `renderPending`), then caught up on close. Rendering under an open dialog made closing it lag.
9. **Performance:** matching every recorded song against the playlist takes about 0.3 s on a desktop and over 2 s on a tablet. `statusCache` is keyed by song key: marks and dislikes **delete only that key**. Clear the whole cache only when the playlist or the gone list changes.
10. **An incomplete playlist read must never mark songs as gone.** `Reader.read` reports `complete` only when it reaches the stated total (minus "N unavailable videos are hidden"). `Archive.update` also refuses if more than max(5, 25%) of songs vanish at once.
12. **Right after a reorder, YouTube's pages disagree.** On Oct 26, just after the first shuffle, the playlist page (first 100) showed the new order and the watch-page side panel (the rest) the old one. The count still came to 129, so the read looked complete, but 7 songs were repeats and 7 others were missing: they were marked gone, and 3 songs fell back to amber matches. Since 3.12.3, a read with more repeated songs than the last good read is not trusted (`Reader.consistent`): the previous read is kept, and it tries again in 15 minutes.
13. **SomaFM's feed can date plays in the future.** Around 2:58 AM on Oct 27, the christmas feed briefly listed the plays from 2:04–2:58 AM again, dated a day ahead (Oct 28). Both devices saved them, and since `History.merge` only adds plays newer than the newest saved one, nothing real was recorded after that. Since 3.12.6, `History.dropFuture` clears saved plays more than 15 minutes in the future when the page loads (also after a backup import). Since 3.12.7, `History.fromFeed` expects every feed play within [now − 6 h, now + 15 min] and moves one outside it by whole days into that window (`History.fixDate`); if no whole-day move fits, the time itself is wrong and the play is dropped. "Now" is SomaFM's server clock (the feed response's `Date` header), falling back to the device clock.
11. **YouTube page formats change.** Parsing walks `ytInitialData` for `playlistVideoRenderer` / `playlistPanelVideoRenderer` / `continuationItemRenderer` wherever they are, rather than fixed paths. If a read breaks, the header says so (refuse and report) and songs aren't labeled.

## 6. Matching rules, and why

`Matcher.check(artist, title, items)` returns `have`, `other` (reason `sameArtistOtherMix` or `otherArtist`), or `none`, plus the playlist `item`.

- Titles are compared as **word sequences** after normalizing (case, accents, `&` → and, punctuation). "the a an and of" are ignored. One-letter typos are tolerated in words of 5+ letters (Ruldolph, Marshmellow).
- Leading "It's / Oh / O" are optional ("It's A Marshmallow World" ~ "Marshmallow World").
- **Artist must match for green.** All words of one credited artist must appear in the video title or channel (`- Topic` stripped). Ensemble words (trio, orchestra, band, his, …) are optional ("Vince Guaraldi Trio" ~ "Vince Guaraldi"). A name made only of those words is dropped.
- **Mixes:** if SomaFM names a mix (`[… Remix]` / `(… Mix)`, in title or artist), at least half its distinctive words must appear for green. Otherwise the result is amber, "Different mix".
- **Near-miss titles count only for the same artist:** one missing or extra word inside a longer title (SomaFM dropped "Very"), or a plural "s" ("Jingle Beats" ~ "Jingle Beat"). Introduced in 2.4.4 without the artist rule, it falsely matched "Christmas Time Is Here" to Kaskade's "Christmas Is Here". Fixed in 2.4.5.
- At equal rank, an **exact title beats a near-miss**, and an exact green match ends the search.

**Why conservative:** Dan prefers refuse-and-report over guess-and-apply. A wrong green hides a song he wants. A wrong red only costs a tap on "✓ I have it". Every reported miss became a test case. Fix the matcher with a test, rather than loosening it broadly.

**Hand marks:** "I have it" opens a picker (closest match first, then suggestions ranked by shared words, ignoring filler words like "you"; plus a search box). Choosing a video **links** the mark, which then counts toward "heard". Undo is two-level: **Unlink** keeps the mark, then **Undo** clears it. "Not this one" hides Open and the match line. Dislike applies only to songs that end up not in the playlist, and a later real match wins.

## 7. Stats, and what the data has shown

- **Share of plays / of songs** in four groups that add to 100%: in playlist, other version, not in playlist (includes gone), disliked.
- **Heard so far:** playlist songs matched automatically or by linked mark (unlinked marks don't say which video, so they don't count).
- **Replay headline = recorded time × different songs ÷ plays.** Gaps can't skew it: neither the time nor the plays inside a gap are counted. Leaving out gap-spanning replays biases **low** (long intervals are where gaps fall). Keeping them as measured biases **high** (plays in the gap were missed). A simulation (3 songs at 10/30/90 min, 8 h unrecorded) gave a true 21 min, this estimate 21 min, gap-excluded 20 min, gap replays as measured 513 min. It's in the tests.
- Both direct measurements are still shown underneath, labeled with which way they lean. Per-song play logs (tap a count in Stats, or "▸ N plays" on a card) show the raw evidence with gaps marked.

**Dan's data (CSV, Oct 25–26):** 286 plays, 188 songs, 17.3 h recorded in two stretches (7.7 h evening, 9.6 h morning, 6.9 h gap).
94 songs heard once, 90 twice, 4 three times, so **no heavy rotation**. Headline 11.3 h. A per-song-median alternative
(12.9 h) was tested and **rejected**. In-stretch repeats (8.1, 8.1, 8.5, 9.0, 2.6 h) are capped by the 9.6 h stretch length, and the
count of in-stretch repeats fits a faster group of about 9–9.5 h with many slower songs. Counter-example: Eddie Dunstedter "I Saw
Mommy…" played 9:47 PM, then not until 2:48 PM. Dan's view: SomaFM probably plays a fixed list in random order, and it will even out.
**Decision: keep the headline as is; revisit with a long unbroken recording.**

## 8. UI notes

- **Header:** title left, 📊 Stats always top right. Refresh / Live / Awake sit under Stats when they fit beside the title. `fitHeader()` **measures** (full labels → short labels "Refresh / Live: On / Awake: On" → own row) and re-runs on resize and label changes. Dan explicitly asked for this arrangement at 600 px portrait.
- **Chips** toggle multi-select, All resets, and all-on = All. "Not in playlist" includes gone songs.
- **Cards:** shading = slate on not-in-playlist, lighter slate on other version, plain on matches, dashed on disliked. Every row of buttons must fit on **one line at tablet portrait width** (Dan's requirement).
- **"Working…"** pill shows after 150 ms for slow actions (`runBusy`). Dialogs are `<dialog>` with `showModal`, and tap outside closes.
- **Colors** are tokens in `:host` with a dark set under `prefers-color-scheme: dark`. Check contrast (white-on-button ≥ 4.5:1) when adding buttons.
- Before shipping UI changes, check 600 px (tablet portrait) and 360 px, light and dark, ideally with screenshots.

## 8a. Shuffle (3.12)

Dan wanted the playlist itself in a fair random order, because YouTube's own shuffle seems to favor some songs.
"🔀 Shuffle playlist" (footer) reorders the real playlist through the YouTube Data API.

- **Setup (done Oct 26):** an OAuth client of type Web application in Dan's Google Cloud project, JavaScript origin
  `https://somafm.com`, redirect URI `https://somafm.com/christmas/songhistory.html`, publishing status Testing with Dan as
  test user. The Client ID is pasted into the panel on each device. No client secret is used.
- **Sign-in:** a popup goes to Google; Google returns to the song history page with the key in the `#fragment`. `catchSignIn()`
  (runs before `main()`) checks `state` against `signin:pending`, saves the key, strips it from the address, and closes the
  popup. The waiting page polls `signin:token`. If popups are blocked, the sign-in happens in the same tab and Shuffle reopens.
- **Why so many units:** there's no bulk reorder, so each song is a `playlistItems.update` with a new position (50 units).
  `Shuffle.plan` keeps the longest group of songs already in the right relative order (longest increasing subsequence)
  and moves each other song straight after its new predecessor. That's about 95 moves for 116 songs, not 116 (about 4,750 units).
- **Safety:** checks that the signed-in channel owns the playlist; songs are only moved, never added or removed; two taps to
  start; the job is saved first, so a run cut short by quota, expiry, Stop or closing the page is finished next time; the playlist
  is read back and compared before it says Done; the order before the last change can be put back.
- **Original order (3.12.1, Dan asked for it):** saved when Shuffle first reads the playlist on a device (3.12.2; 3.12.1 waited for the first change), never overwritten, carried in backups,
  and downloadable as a CSV (position, title, video link). Putting it back keeps songs added since at the end and skips removed ones.
  A device with none saved says so, and suggests bringing in the other device's backup before shuffling there; otherwise that
  device would save its already-shuffled order as the "original".
- **Not yet seen on the real API:** a deleted or private video in the playlist may refuse to move. If that happens, the panel
  reports YouTube's message and the job can be finished or set aside.
- Playing it: shuffle off, playlist sort setting on **Manual** (otherwise YouTube shows another order).

## 9. Testing and regression gates

- `npm test`: about 375 checks across both runs (matching cases from every reported miss, marks, unavailable videos, history merge and gaps, linking, gone songs, reader with a fake YouTube, stats, backup/merge, shuffle plans and runs against a fake API, source check). **Every bug fix adds a test that fails before the fix.**
- `npm run test:page`: 64 real-page checks, including the Shuffle panel against a fake Google API (`page.route`), so Google is never contacted. It failed on the 3.10.0 build (Per page) and passes on 3.11.0.
- For a new UI feature, add a check to `page-check.js` in the same style.
- Dan's real exported CSV is a good fixture for stats work (he can export again; it isn't in the repo).

## 10. Open items / next steps

1. **Shuffle: first real run** (3.12.0). Dan chose to reorder the real playlist (§8a). Watch the first run for anything the fake API didn't show (deleted videos, sort setting).
2. **Laptop setup** (above). Then merge the tablet backup into it.
3. **Analyses once a few days are recorded** (from an exported CSV): (a) shuffled fixed list vs independent random picks, from the spread of replay intervals; (b) songs played more often than chance would explain.

## 11. Working with Dan

- Concise replies; he signals when he's done. He values understanding **why** a design decision was made.
- **Conservative:** refuse and report rather than guess and apply. Ask before anything hard to undo.
- **Regression gates with every shipped feature** (§9).
- **Ask questions as plain typed text.** Pick-list / selector answers from tool UIs don't reach him; he always types answers.
- He tests on the tablet right away and reports precisely (screenshots, exact titles). Take reports literally, and verify against his data when it's available.
- He corrected an earlier example I used: "Faithful Ye Come" (Tetsumi Nagaka) is a **different song** from "O Come All Ye Faithful". Don't assume songs are the same from similar titles.

## 12. Version history (short)

| Version | Change |
|---|---|
| 1.0 | Labels on SomaFM's table. 1.0.1 network fix (desktop UA, `@connect`). 1.0.2 prototype.js workaround. 1.1 bright buttons, "Mark as in playlist". |
| 2.0 | Full redesign: own UI in a shadow root, live feed, filter chips. 2.1 Open beside title. 2.2 shading, "Not this one". 2.3 multi-select chips. |
| 2.4.x | Unavailable videos excluded; signed-out reads; 63-char cutoff; near-miss words (artist-gated in 2.4.5); ensemble words; plurals. |
| 2.5–2.9 | Play history with dates, paging, gaps, CSV. Dislike. Progress bar. Linking marks to a playlist video, with confirmation and two-level undo. |
| 3.0 | Playlist memory and "gone from playlist"; mixes from the artist field added to YouTube searches. |
| 3.1 | Playlists past 100 songs via the watch-page side panel; incomplete reads never mark songs gone. |
| 3.2–3.5 | Playlist length; Keep screen on; Stats panel; measured header layout with short labels. |
| 3.6–3.8 | Replay statistics, per-song play logs, recorded-time replay estimate. |
| 3.9 | Only the changed song is re-matched (2.3 s → 0.2 s on a slowed CPU); "Working…" indicator; no redraws under dialogs; Open buttons in Stats. |
| 3.10 | "▸ N plays" history on cards; "Most recent" sort in Stats. |
| 3.11 | Backup / Restore (merge, replace, undo); Per page fix; source check for delayed actions; `page-check.js`. 3.11.1 moved into the Scripts repo; Tampermonkey auto-update from GitHub. 3.11.2 play logs show the elapsed time with * for a gap (legend below), wider Stats panel on desktop. |
| 3.12 | Shuffle the real playlist through the YouTube Data API (Google sign-in, fewest moves, resume, read-back check, put back). 3.12.1 keeps the original order (in backups, downloadable). 3.12.2 saves it as soon as Shuffle opens; original order also committed as a CSV. 3.12.3 distrusts playlist reads with new repeats (false "gone" songs right after a shuffle). 3.12.4: an automatic match can be corrected ("Wrong video?" links another video). 3.12.5: "Not in playlist" moved into that picker. 3.12.6: plays dated in the future are ignored and cleared (gotcha 13). 3.12.7: misdated feed plays are moved by whole days to the right date instead of dropped. |
