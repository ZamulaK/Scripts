# SomaFM recorder (Cloudflare Worker)

Records every play on SomaFM's Christmas Lounge around the clock, so the userscript can fill in the stretches
when no device had the song history page open. Since 3.22 it also holds the plays each device recorded and one
synced document with Dan's marks, dislikes, favorites, categories, notes, remembered playlist songs and original order.

- Every 10 minutes (Cron Trigger) it reads `https://somafm.com/songs/christmas.json` (about the last hour of
  plays) and adds the new ones to a D1 database. It reuses the userscript's own `History` code
  (`src/core.js` imports `../soma-xmas-checker.user.js`), so dates are fixed and missed stretches flagged
  exactly as on a device.
- Endpoints (all need `Authorization: Bearer <key>`; CORS allows https://somafm.com):
  - `GET /plays?channel=christmas&since=<unix seconds>`: plays **stored or changed** since then (by the `added` column, so old
    plays a device sends late still reach the others), newest first, plus breaks and how the last look went.
  - `POST /plays?channel=christmas` `{ plays }`: up to 500 plays a device recorded. A stored play loses its gap flag when the
    device's copy has none (someone was recording before it).
  - `GET /state` / `PUT /state` `{ base, state }`: the synced document. A save from an older version gets 409 with the current
    one; the device merges (`Sync.merge`) and tries again.
- The userscript syncs when the page opens, every 2 minutes while Live is on, when you come back to the tab, and a few
  seconds after a change.
- It doesn't touch YouTube: Cloudflare may run it outside the US, where YouTube hides region-blocked songs.
  Matching against the playlist stays on the devices.
- Free plan: about 144 runs a day against 100,000 requests a day; D1 free up to 5 GB.

## Files

| File | What it is |
|---|---|
| `src/index.js` | The Worker: the 10-minute job (`record`), the `/plays` and `/state` endpoints (`handle`), CORS for somafm.com. |
| `src/core.js` | What to keep from one look at the feed (`fromFeed`). |
| `schema.sql` | Tables: `plays`, `breaks`, `runs` (how the last look went, shown in the userscript), `docs` (the synced document). |
| `migrate-3.22.sql` | Brings a 3.21 database up to date (run once; done on the live one Oct 31, 2026). `test-schema-3.21.sql` is the old schema, for its test. |
| `test.js` | `npm test`: against a real SQLite database (`node:sqlite`) behind a stand-in for D1. |
| `wrangler.toml` | Name, cron, stations (`CHANNELS`), D1 binding. The database id isn't secret. |

## Setting it up (done once)

```sh
cd soma-fm/worker
npm install
npx wrangler login                                   # opens a browser: allow access to the Cloudflare account
npx wrangler d1 create soma                          # put the printed database_id in wrangler.toml
npx wrangler d1 execute soma --remote --file schema.sql
npx wrangler secret put KEY                          # a long random key (at least 16 letters/digits); not in the repo
npx wrangler deploy                                  # prints the address, e.g. https://soma-recorder.<name>.workers.dev
```

The setup code pasted into the userscript (Backup / Restore → Cloud recorder) is the address and key on one
line: `https://soma-recorder.<name>.workers.dev#<key>`.

## Trying it locally

```sh
echo KEY=localtestkey-0123456789abcdef > .dev.vars
npx wrangler d1 execute soma --local --file schema.sql
npm run dev                                          # then open http://localhost:8787/__scheduled to run the job once
curl -H "Authorization: Bearer localtestkey-0123456789abcdef" "http://localhost:8787/plays?channel=christmas"
```

After changing the userscript's `History` code, deploy again so the recorder uses the same rules.
