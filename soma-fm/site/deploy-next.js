// Deploys the new site (site/app, Pocket v2) to the test address next.xmaslounge.pages.dev, while today's site keeps
// running at xmaslounge.pages.dev. Copies the checker's modules (the userscript file) next to the page, then
// `wrangler pages deploy app --branch next`, with the same /api (site/functions) as today's site.
// Run from anywhere: node site/deploy-next.js        (node site/deploy-next.js main: the switch-over, later)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname, branch = process.argv[2] || 'next';
fs.mkdirSync(path.join(here, 'app', 'lib'), { recursive: true });
fs.copyFileSync(path.join(here, '..', 'soma-xmas-checker.user.js'), path.join(here, 'app', 'lib', 'soma-xmas-checker.user.js'));
const wrangler = path.join(here, '..', 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const r = spawnSync(process.execPath, [wrangler, 'pages', 'deploy', 'app', '--project-name', 'xmaslounge', '--branch', branch, '--commit-dirty=true'], { cwd: here, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
