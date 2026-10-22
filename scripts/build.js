#!/usr/bin/env node
'use strict';
// Builds the ApeScope browser extension for Chrome and Firefox from src/.
//
//   npm run build                                   → dist/chrome, dist/firefox, dist/apescope-{chrome,firefox}-v<version>.zip
//   npm run build -- --update-base https://site      → also enables update checks against <site>/version.json and
//                                                     writes dist/updates/{version.json,updates.json} to publish there
//   npm run build -- --github owner/repo             → update check against that repository's GitHub releases
//   (or APESCOPE_UPDATE_BASE / APESCOPE_GITHUB_REPO)
// dist/release/ gets the files for a GitHub release with fixed names (apescope-chrome.zip, apescope-firefox.zip).
//
// Load unpacked: Chrome → chrome://extensions → Developer mode → "Load unpacked" → dist/chrome
//                Firefox → about:debugging → This Firefox → "Load Temporary Add-on" → dist/firefox/manifest.json
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const FIREFOX_ID = 'apescope@extension';

/** apescope.js is started by compat.js once the storage cache is loaded. */
const mainBody = `/* ApeScope ${version} — MIT License */\nglobalThis.__apescopeRun = function () {\n${src('apescope.js')}\n};\n`;
const bridgeBody = src('bridge.js');
function checkVersions() {
  for (const f of ['apescope.js', 'bridge.js']) {
    const v = /const VERSION = '([^']+)'/.exec(src(f))?.[1];
    if (v !== version) throw new Error(`src/${f} has VERSION ${v}, package.json has ${version}`);
  }
}

const SITES = ['https://fomo.family/*', 'https://www.fomo.family/*', 'https://pump.fun/*', 'https://www.pump.fun/*', 'https://x.com/*', 'https://twitter.com/*', 'https://chatgpt.com/*', 'https://gmgn.ai/*'];
function manifest(browser, updateBase = '', githubRepo = '') {
  const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
  const m = {
    manifest_version: 3,
    name: 'ApeScope',
    version,
    description: 'Memecoin due diligence next to the fomo chart: risk checks, holder analysis, look-alike tokens and one-click ChatGPT analysis.',
    icons,
    action: { default_title: 'ApeScope — show or hide the sidebar', default_icon: icons },
    // downloads: update from a release file (writes the extension's own folder); cookies: read x.com's ct0 for the
    // opt-in X search without a tab (sent back to x.com only)
    permissions: ['storage', 'unlimitedStorage', 'downloads', 'cookies', 'scripting'],   // scripting: read a project website's rendered text on request
    // Any host: project websites, domain registries and an optional custom Solana RPC can be anywhere.
    host_permissions: ['<all_urls>'],
    background: browser === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    content_scripts: [
      { matches: SITES, js: ['compat.js', 'apescope.js'], run_at: 'document_start' },
      { matches: SITES.slice(0, 4), js: ['bridge.js'], run_at: 'document_start', world: 'MAIN' },
    ],
  };
  if (browser === 'firefox') {
    m.browser_specific_settings = { gecko: { id: FIREFOX_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } }, gecko_android: { strict_min_version: '142.0' } };   // data_collection_permissions needs Firefox 140 (Android 142)
    if (updateBase) m.browser_specific_settings.gecko.update_url = updateBase + '/updates.json';   // self-hosted, signed .xpi
    // Signed .xpi from GitHub releases: Firefox reads updates.json from the latest release and installs newer versions itself.
    else if (githubRepo) m.browser_specific_settings.gecko.update_url = `https://github.com/${githubRepo}/releases/latest/download/updates.json`;
  } else m.minimum_chrome_version = '111';
  return m;
}
function backgroundBody(updateBase = '', githubRepo = '') {
  let bg = src('background.js');
  const marker = "const UPDATE_INFO_URL = '';", repoMarker = "const UPDATE_GITHUB_REPO = '';";
  if (!bg.includes(marker) || !bg.includes(repoMarker)) throw new Error('update markers missing in background.js');
  if (updateBase) bg = bg.replace(marker, `const UPDATE_INFO_URL = ${JSON.stringify(updateBase + '/version.json')};`);
  if (githubRepo) bg = bg.replace(repoMarker, `const UPDATE_GITHUB_REPO = ${JSON.stringify(githubRepo)};`);
  return bg;
}

function build({ updateBase = '', githubRepo = '' } = {}) {
  checkVersions();
  if (githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) throw new Error('--github must look like owner/repo');
  if (updateBase && !/^https:\/\/[^\s"']+$/.test(updateBase)) throw new Error('--update-base must be an https URL');
  updateBase = updateBase.replace(/\/+$/, '');
  const main = mainBody;
  for (const [name, code] of [['apescope.js', main], ['bridge.js', bridgeBody], ['background.js', backgroundBody(updateBase, githubRepo)], ['compat.js', src('compat.js')]]) new vm.Script(code, { filename: name });
  const dist = path.join(root, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });   // dist/ is build output only
  for (const browser of ['chrome', 'firefox']) {
    const out = path.join(dist, browser);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(browser, updateBase, githubRepo), null, 2) + '\n');
    fs.writeFileSync(path.join(out, 'apescope.js'), main);
    fs.writeFileSync(path.join(out, 'bridge.js'), bridgeBody);
    fs.writeFileSync(path.join(out, 'background.js'), backgroundBody(updateBase, githubRepo));
    fs.copyFileSync(path.join(root, 'src', 'compat.js'), path.join(out, 'compat.js'));
    for (const n of [16, 32, 48, 128]) fs.copyFileSync(path.join(root, 'assets', 'brand', `icon-${n}.png`), path.join(out, 'icons', `icon-${n}.png`));
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE')); fs.copyFileSync(path.join(root, 'NOTICE'), path.join(out, 'NOTICE'));
    const zip = path.join(dist, `apescope-${browser}-v${version}.zip`);
    if (fs.existsSync(zip)) fs.unlinkSync(zip);
    execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: out });
    fs.mkdirSync(path.join(dist, 'release'), { recursive: true });
    fs.copyFileSync(zip, path.join(dist, 'release', `apescope-${browser}.zip`));   // fixed name: …/releases/latest/download/apescope-<browser>.zip
    console.log(`Built dist/${browser} and ${path.relative(root, zip)}`);
  }
  if (updateBase) {
    // Files to publish under the update base (e.g. the website): version.json for the in-app check,
    // updates.json for Firefox's automatic updates of a signed, self-hosted .xpi.
    const up = path.join(dist, 'updates');
    fs.mkdirSync(up, { recursive: true });
    fs.writeFileSync(path.join(up, 'version.json'), JSON.stringify({ version, page: updateBase + '/#install',
      chrome: `${updateBase}/download/apescope-chrome-v${version}.zip`, firefox: `${updateBase}/download/apescope-firefox-v${version}.xpi` }, null, 2) + '\n');
    fs.writeFileSync(path.join(up, 'updates.json'), JSON.stringify({ addons: { [FIREFOX_ID]: { updates: [{ version, update_link: `${updateBase}/download/apescope-firefox-v${version}.xpi` }] } } }, null, 2) + '\n');
    console.log('Wrote dist/updates/version.json and dist/updates/updates.json');
  }
}

module.exports = { manifest, mainBody, bridgeBody, backgroundBody, version, build, checkVersions };
if (require.main === module) {
  const i = process.argv.indexOf('--update-base');
  const g = process.argv.indexOf('--github');
  build({ updateBase: i > 0 ? process.argv[i + 1] || '' : process.env.APESCOPE_UPDATE_BASE || '', githubRepo: g > 0 ? process.argv[g + 1] || '' : process.env.APESCOPE_GITHUB_REPO || '' });
}
