// Deploys the Christmas Lounge site: copies the userscript next to the page, then `wrangler pages deploy`
// (wrangler comes from soma-fm/worker). Run from anywhere: node site/deploy.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
fs.copyFileSync(path.join(here, '..', 'soma-xmas-checker.user.js'), path.join(here, 'public', 'soma-xmas-checker.user.js'));
const wrangler = path.join(here, '..', 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const r = spawnSync(process.execPath, [wrangler, 'pages', 'deploy', '--project-name', 'xmaslounge', '--branch', 'main', '--commit-dirty=true'], { cwd: here, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
