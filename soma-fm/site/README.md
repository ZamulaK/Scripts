# Christmas Lounge site (xmaslounge.pages.dev)

The Xmas Mixed checker as a web page on Cloudflare Pages, for when SomaFM's history page isn't there and so changes
don't need a Tampermonkey update on each device. It runs the same `soma-xmas-checker.user.js` in "site mode" (see
HANDOFF.md §8c). Only Dan can open it: Cloudflare Access asks for his Google sign-in first.

| File | What it is |
|---|---|
| `public/index.html` | The page. |
| `public/site.js` | Stands in for Tampermonkey (saved values in IndexedDB, shared live with the site's other tabs), gets the built-in settings, runs the script. |
| `functions/api/[[path]].js` | Every `/api` request, handled by `../worker/src/site.js` (checks the Access sign-in on each one). |
| `wrangler.toml` | Project name, the recorder's D1 database, the names of the secrets. |
| `deploy.js` | `node site/deploy.js`: copies the userscript into `public/` and deploys. |

The recorder (`../worker`) still does the 10-minute look; Pages can't run on a schedule.

## Setting it up (done once)

The project was created with `wrangler pages project create xmaslounge --production-branch main --force` (`--force`
keeps it a Pages project; without it, wrangler now makes a Worker instead).

### 1. Cloudflare Zero Trust
- dash.cloudflare.com → **Zero Trust**. Pick a **team name**; it becomes `<team>.cloudflareaccess.com`. Choose the **Free** plan.

### 2. Google Cloud (the project that has the Shuffle Client ID)
- **APIs & Services → Credentials → Create credentials → API key.** Edit it: under API restrictions choose **Restrict key** →
  **YouTube Data API v3**. Leave application restrictions at None (Cloudflare's servers use it). Keep the key for step 4.
- **Edit the existing OAuth client** (the one Shuffle uses). Add `https://xmaslounge.pages.dev` under Authorized JavaScript
  origins and `https://xmaslounge.pages.dev/` under Authorized redirect URIs. Save.
- **Create credentials → OAuth client ID → Web application**, named "Cloudflare Access". Authorized JavaScript origin:
  `https://<team>.cloudflareaccess.com`. Authorized redirect URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
  Keep its Client ID and secret for step 3.

### 3. Cloudflare Access
- Zero Trust → **Settings → Authentication → Login methods → Add new → Google**. Paste the Client ID and secret from the
  "Cloudflare Access" client. Save, then **Test**.
- Zero Trust → **Access → Applications → Add an application → Self-hosted**. Name: Christmas Lounge. Public hostname:
  `xmaslounge.pages.dev`. Add a second one, `*.xmaslounge.pages.dev`, which covers the preview address each deployment gets.
  Login methods: **Google** only. Session duration: as long as you like (a month is fine).
  Policy: Action **Allow**, Include → **Emails** → your Google address. Save.
- Open the application and copy its **Application Audience (AUD) Tag**.

### 4. The site's secrets
In a terminal in `soma-fm/worker` (where wrangler is installed). Each command asks for the value, so it isn't typed into the command line:

```sh
npx wrangler pages secret put YT_KEY --project-name xmaslounge            # the API key from step 2
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name xmaslounge  # the Shuffle Client ID (…apps.googleusercontent.com)
npx wrangler pages secret put ACCESS_TEAM --project-name xmaslounge       # the team name from step 1
npx wrangler pages secret put ACCESS_AUD --project-name xmaslounge        # the AUD tag from step 3
```

Secrets reach the site on its next deployment: `node site/deploy.js`.

## How it stays private
- Access stands in front of the whole site, so no one gets the page without your Google sign-in.
- Every `/api` request also checks the token Access adds (signature, audience, issuer, expiry), and refuses without one.
  So even an address Access didn't cover gets nothing.
- The page and `site.js` hold no keys. The userscript itself is public on GitHub anyway.
