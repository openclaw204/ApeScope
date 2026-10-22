'use strict';
// Browser extension: manifest, API layer (compat.js) and the built main script running on top of it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { manifest, mainBody, bridgeBody, backgroundBody, version } = require('../scripts/build');
const { until, wait } = require('./harness');

const SHIM = fs.readFileSync(path.join(__dirname, '..', 'src', 'compat.js'), 'utf8');
const BG = backgroundBody('https://apescope.example');

// ---- Manifests ----
const chrome = manifest('chrome'), firefox = manifest('firefox');
for (const m of [chrome, firefox]) {
  assert.equal(m.manifest_version, 3); assert.equal(m.version, version); assert.ok(m.description.length <= 132, 'store limit for descriptions');
  assert.deepEqual(m.content_scripts[0].js, ['compat.js', 'apescope.js'], 'API layer loads before the main script');
  assert.equal(m.content_scripts[1].world, 'MAIN', 'bridge runs in the page context');
  for (const site of ['https://fomo.family/*', 'https://chatgpt.com/*', 'https://gmgn.ai/*', 'https://x.com/*', 'https://pump.fun/*']) assert.ok(m.content_scripts[0].matches.includes(site), site);
  assert.ok(!JSON.stringify(m).match(/github\.com\/[A-Za-z0-9-]+/), 'no account in the manifest');
}
assert.equal(chrome.background.service_worker, 'background.js'); assert.ok(!chrome.browser_specific_settings);
assert.deepEqual(firefox.background.scripts, ['background.js']); assert.match(firefox.browser_specific_settings.gecko.strict_min_version, /^1[2-9]\d/);
new vm.Script(mainBody); new vm.Script(bridgeBody);
assert.ok(!/==UserScript==|@grant|@match/.test(mainBody + bridgeBody), 'no userscript headers left');

// ---- Fake WebExtension API ----
function fakeBrowser(responder = () => ({ ok: true, status: 200, responseText: '{}', responseHeaders: '' })) {
  const data = {}, changeListeners = [], messageListeners = [], sent = [];
  const storage = { local: {
    get: async () => JSON.parse(JSON.stringify(data)),
    set: async obj => { const changes = {}; for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: JSON.parse(JSON.stringify(v)) }; data[k] = JSON.parse(JSON.stringify(v)); } setTimeout(() => changeListeners.forEach(cb => cb(changes, 'local')), 0); },
    remove: async k => { const changes = { [k]: { oldValue: data[k], newValue: undefined } }; delete data[k]; setTimeout(() => changeListeners.forEach(cb => cb(changes, 'local')), 0); },
  }, onChanged: { addListener: cb => changeListeners.push(cb) } };
  const runtime = { id: 'ext', sendMessage: async msg => { sent.push(msg); return responder(msg); }, onMessage: { addListener: cb => messageListeners.push(cb) } };
  return { api: { storage, runtime }, data, sent, messageListeners, remoteSet: (k, v) => storage.local.set({ [k]: v }) };
}

(async () => {
  // ---- API layer semantics ----
  {
    const b = fakeBrowser(msg => msg.type === 'aps-xhr' ? { ok: true, status: 201, responseText: '{"a":1}', responseHeaders: 'x: y', finalUrl: msg.url } : { ok: true });
    b.data['aps:seed'] = { n: 1 };
    const ctx = { chrome: b.api, console, setTimeout, JSON, Object, Map, Set, String, Promise, navigator: {}, document: { getElementById: () => null, dispatchEvent() {} }, window: {}, CustomEvent: function () {} };
    ctx.globalThis = ctx;
    let started = false; ctx.__apescopeRun = () => { started = true; };
    vm.createContext(ctx); vm.runInContext(SHIM, ctx);
    assert.ok(await until(() => started), 'main script starts after the storage cache is loaded');
    assert.deepEqual({ ...ctx.GM_getValue('aps:seed') }, { n: 1 }); assert.equal(ctx.GM_getValue('missing', 7), 7);
    const v = ctx.GM_getValue('aps:seed'); v.n = 99; assert.equal(ctx.GM_getValue('aps:seed').n, 1, 'reads are copies');
    const seen = [];
    ctx.GM_addValueChangeListener('aps:k', (k, o, n, remote) => seen.push([n, remote]));
    ctx.GM_setValue('aps:k', 'mine'); assert.equal(ctx.GM_getValue('aps:k'), 'mine', 'write is visible immediately');
    await wait(5); b.remoteSet('aps:k', 'theirs'); await wait(5);
    assert.deepEqual(seen, [['mine', false], ['theirs', true]], 'own writes are local, other tabs are remote');
    assert.equal(ctx.GM_getValue('aps:k'), 'theirs', 'cache follows other tabs');
    const res = await new Promise(r => ctx.GM_xmlhttpRequest({ method: 'POST', url: 'https://api.example/x', data: '{}', headers: { 'Content-Type': 'application/json' }, onload: r, onerror: r }));
    assert.equal(res.status, 201); assert.equal(res.responseText, '{"a":1}'); assert.equal(res.finalUrl, 'https://api.example/x');
    assert.equal(b.sent.find(m => m.type === 'aps-xhr').method, 'POST');
    ctx.GM_openInTab('https://chatgpt.com/', { active: true, reuse: true });
    assert.deepEqual({ ...b.sent.at(-1) }, { type: 'aps-open', url: 'https://chatgpt.com/', active: true, reuse: true });
    // Toolbar button: only handled where the panel exists
    let reply = null; b.messageListeners[0]({ type: 'aps-toggle' }, {}, r => { reply = r; }); assert.equal(reply.handled, false);
  }

  // ---- Built main script on top of the API layer: the GMGN worker answers through chrome.storage ----
  {
    const b = fakeBrowser();
    const ca = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const bodies = { token_stat: { code: 0, data: { holder_count: 5, top_bundler_trader_percentage: '0.5' } }, token_holder_stat: { code: 0, data: { smart_degen_count: 2 } }, token_fee_info: { code: 0, data: { security: {} } } };
    const ctx = { chrome: b.api, console, setTimeout, setInterval: () => 0, JSON, Object, Map, Set, WeakSet, Array, Number, String, Promise, RegExp, Error, Math, Date, BigInt, URL, URLSearchParams,
      navigator: {}, CustomEvent: function () {}, addEventListener() {}, window: {}, document: { getElementById: () => null, dispatchEvent() {}, readyState: 'complete' },
      location: { hostname: 'gmgn.ai', href: 'https://gmgn.ai/', search: '' }, sessionStorage: { getItem: () => null, setItem() {} },
      fetch: async p => ({ ok: true, status: 200, text: async () => JSON.stringify(bodies[Object.keys(bodies).find(k => p.includes('/' + k + '/'))]) }) };
    ctx.globalThis = ctx;
    vm.createContext(ctx); vm.runInContext(SHIM + '\n' + mainBody, ctx);
    assert.ok(await until(() => b.data['aps:gmgn-worker']?.ts), 'GMGN worker heartbeat written to chrome.storage');
    b.remoteSet('aps:gmgn-request', { nonce: 'n1', key: 'solana:' + ca, chain: 'sol', ca, ts: Date.now() });
    assert.ok(await until(() => b.data['aps:gmgn-result']?.nonce === 'n1'), 'GMGN worker answered');
    assert.equal(b.data['aps:gmgn-result'].data.bundlerPct, 50); assert.equal(b.data['aps:gmgn-result'].data.smartMoney, 2);
  }

  // ---- Background: only own messages, GET/POST only, cookies never sent ----
  {
    const listeners = [], fetched = [];
    const api = { runtime: { id: 'ext', onMessage: { addListener: cb => listeners.push(cb) } }, action: { onClicked: { addListener() {} } }, tabs: { query: async () => [], create: async () => {}, update: async () => {} }, windows: { update: async () => {} } };
    const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, Promise, String, Number, Math,
      fetch: async (url, o) => { fetched.push(o); return { status: 200, url, headers: new Map([['content-type', 'application/json']]), text: async () => '{}' }; } };
    ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BG, ctx);
    const ask = (msg, sender = { id: 'ext' }) => new Promise(r => { if (!listeners[0](msg, sender, r)) r('ignored'); });
    assert.equal(await ask({ type: 'aps-xhr', url: 'https://a.example/' }, { id: 'evil' }), 'ignored', 'foreign senders ignored');
    assert.equal((await ask({ type: 'aps-xhr', method: 'DELETE', url: 'https://a.example/' })).error, 'method not allowed');
    assert.equal((await ask({ type: 'aps-xhr', url: 'file:///etc/passwd' })).error, 'invalid URL');
    const ok = await ask({ type: 'aps-xhr', url: 'https://a.example/x' });
    assert.equal(ok.status, 200); assert.equal(fetched.at(-1).credentials, 'omit');
  }
  // ---- Updates: store / signed installs via requestUpdateCheck, manual installs via version.json ----
  {
    const run = async ({ check, info, firefox = false }) => {
      const listeners = [];
      const api = { runtime: { id: 'ext', getManifest: () => ({ version: '1.4.0' }), getURL: p => (firefox ? 'moz-extension://x/' : 'chrome-extension://x/') + p, requestUpdateCheck: check, reload() {}, onMessage: { addListener: cb => listeners.push(cb) }, onUpdateAvailable: { addListener() {} } },
        action: { onClicked: { addListener() {} } }, tabs: {}, windows: {} };
      const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, Promise, String, Number, Math, JSON, Array,
        fetch: async url => ({ status: 200, url, headers: new Map(), text: async () => JSON.stringify(info) }) };
      if (firefox) ctx.browser = api;
      ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BG, ctx);
      return new Promise(r => listeners[0]({ type: 'aps-update-check' }, { id: 'ext' }, r));
    };
    assert.equal((await run({ check: async () => ({ status: 'update_available', version: '1.5.0' }) })).status, 'update_available', 'Chrome store update');
    assert.equal((await run({ check: async () => ['update_available', { version: '1.5.0' }] })).version, '1.5.0', 'Firefox result shape');
    const manual = await run({ check: async () => { throw new Error('unpacked'); }, info: { version: '1.10.0', chrome: 'https://apescope.example/download/c.zip', firefox: 'https://apescope.example/download/f.xpi' } });
    assert.equal(manual.status, 'manual'); assert.equal(manual.url, 'https://apescope.example/download/c.zip', 'version compare is numeric (1.10 > 1.4)');
    assert.equal((await run({ check: async () => ({ status: 'no_update' }), info: { version: '1.4.0' } })).status, 'no_update');
    assert.ok(firefox.browser_specific_settings.gecko.update_url === undefined, 'no Firefox update_url without --update-base');
    assert.equal(manifest('firefox', 'https://apescope.example').browser_specific_settings.gecko.update_url, 'https://apescope.example/updates.json');
  }
  // ---- Update from a release file: unpack, check, write into the extension folder, reload ----
  {
    const { execFileSync } = require('node:child_process'), os = require('node:os');
    const pack = browser => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-zip-')), m = { ...manifest(browser), version: '9.9.9' };
      fs.mkdirSync(path.join(dir, 'icons'));
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
      for (const f of ['apescope.js', 'bridge.js', 'background.js', 'compat.js']) fs.writeFileSync(path.join(dir, f), '// ' + f + '\n'.repeat(3000));
      fs.writeFileSync(path.join(dir, 'icons', 'icon-16.png'), Buffer.from([137, 80, 78, 71]));
      execFileSync('zip', ['-q', '-r', path.join(dir, 'p.zip'), '.'], { cwd: dir });
      const b64 = fs.readFileSync(path.join(dir, 'p.zip')).toString('base64'); fs.rmSync(dir, { recursive: true, force: true }); return b64;
    };
    const install = async ({ data, firefox = false, sameFolder = true, folder = 'ApeScope' }) => {
      const listeners = [], written = new Map(), changed = [];
      let reloaded = false, stored = null;
      const api = { runtime: { id: 'ext', getManifest: () => ({ version: '1.5.0' }), getURL: p => (firefox ? 'moz-extension://x/' : 'chrome-extension://x/') + p, reload() { reloaded = true; }, onMessage: { addListener: cb => listeners.push(cb) }, onUpdateAvailable: { addListener() {} } },
        storage: { local: { set: async v => { stored = v; } } }, action: { onClicked: { addListener() {} } }, tabs: {}, windows: {},
        downloads: { download: async o => { const id = written.size + 1; written.set(o.filename, { url: o.url, conflict: o.conflictAction }); setTimeout(() => changed.forEach(cb => cb({ id, state: { current: 'complete' } })), 1); return id; },
          onChanged: { addListener: cb => changed.push(cb), removeListener: cb => changed.splice(changed.indexOf(cb), 1) }, search: async () => [], erase: async () => [] } };
      const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, Promise, String, Number, Math, JSON, Array, Map, Uint8Array, DataView, TextDecoder, Blob, Response, DecompressionStream, atob, btoa,
        fetch: async url => ({ json: async () => ({ version: sameFolder && written.has(folder + '/manifest.json') ? '9.9.9' : '1.5.0' }) }) };
      if (firefox) ctx.browser = api;
      ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BG, ctx);
      const r = await new Promise(res => listeners[0]({ type: 'aps-update-file', data, folder }, { id: 'ext' }, res));
      await wait(400);
      return { r, written, reloaded, stored };
    };
    const chromeZip = pack('chrome'), firefoxZip = pack('firefox');
    let t = await install({ data: chromeZip });
    assert.ok(t.r.ok, t.r.error); assert.equal(t.r.version, '9.9.9'); assert.ok(t.reloaded, 'reloads after writing');
    assert.deepEqual([...t.written.keys()].at(-1), 'ApeScope/manifest.json', 'manifest written last'); assert.ok(t.written.has('ApeScope/icons/icon-16.png'));
    assert.ok([...t.written.values()].every(w => w.conflict === 'overwrite' && w.url.startsWith('data:')), 'Chrome: data URLs, overwrite');
    assert.equal(t.stored['aps:update-installed'].to, '9.9.9');
    t = await install({ data: firefoxZip, firefox: true }); assert.ok(t.r.ok, t.r.error);
    t = await install({ data: chromeZip, firefox: true }); assert.ok(!t.r.ok && /Chrome package/.test(t.r.error), 'wrong browser package refused'); assert.equal(t.written.size, 0);
    t = await install({ data: chromeZip, sameFolder: false }); assert.ok(!t.r.ok && t.r.written && /different folder/.test(t.r.error), 'loaded from another folder → no reload'); assert.ok(!t.reloaded);
    t = await install({ data: chromeZip, folder: '../etc' }); assert.ok(!t.r.ok && /Invalid folder/.test(t.r.error));
    t = await install({ data: Buffer.from('hello').toString('base64') }); assert.ok(!t.r.ok && /not a ZIP/.test(t.r.error));
    assert.ok(chrome.permissions.includes('downloads') && firefox.permissions.includes('downloads'));
  }
  // ---- Update check against the project's GitHub releases (repository set by the build) ----
  {
    const BGH = backgroundBody('', 'owner/apescope');
    const run = async (tag, current = '1.0.0') => {
      const listeners = [];
      const api = { runtime: { id: 'ext', getManifest: () => ({ version: current }), getURL: p => 'chrome-extension://x/' + p, requestUpdateCheck: async () => { throw new Error('unpacked'); }, onMessage: { addListener: cb => listeners.push(cb) }, onUpdateAvailable: { addListener() {} } },
        action: { onClicked: { addListener() {} } }, tabs: {}, windows: {} };
      const urls = [];
      const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, Promise, String, Number, Math, JSON, Array,
        fetch: async url => { urls.push(url); return { status: 200, url, headers: new Map(), text: async () => JSON.stringify({ tag_name: tag, html_url: 'https://github.com/owner/apescope/releases/tag/' + tag,
          assets: [{ name: 'apescope-chrome.zip', browser_download_url: 'https://github.com/owner/apescope/releases/download/' + tag + '/apescope-chrome.zip' }] }) }; } };
      ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BGH, ctx);
      return { r: await new Promise(res => listeners[0]({ type: 'aps-update-check' }, { id: 'ext' }, res)), urls };
    };
    let u = await run('v1.2.0');
    assert.equal(u.r.status, 'manual'); assert.equal(u.r.version, '1.2.0'); assert.ok(u.r.url.endsWith('/apescope-chrome.zip'), 'direct download of the Chrome zip');
    assert.ok(u.urls.some(x => x.startsWith('https://api.github.com/repos/owner/apescope/releases/latest')));
    assert.equal((await run('v1.0.0')).r.status, 'no_update', 'same version → nothing to do');
    {   // Chrome answers "throttled" for unpacked installs: the GitHub release check still runs
      const listeners = [];
      const api = { runtime: { id: 'ext', getManifest: () => ({ version: '1.0.0' }), getURL: p => 'chrome-extension://x/' + p, requestUpdateCheck: async () => ({ status: 'throttled' }), onMessage: { addListener: cb => listeners.push(cb) }, onUpdateAvailable: { addListener() {} } },
        action: { onClicked: { addListener() {} } }, tabs: {}, windows: {} };
      const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, Promise, String, Number, Math, JSON, Array,
        fetch: async url => ({ status: 200, url, headers: new Map(), text: async () => JSON.stringify({ tag_name: 'v1.3.0', html_url: 'https://github.com/owner/apescope/releases/tag/v1.3.0', assets: [] }) }) };
      ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BGH, ctx);
      const r = await new Promise(res => listeners[0]({ type: 'aps-update-check' }, { id: 'ext' }, res));
      assert.equal(r.status, 'manual'); assert.equal(r.version, '1.3.0');
    }
    assert.throws(() => require('../scripts/build').build({ githubRepo: 'not a repo' }), /owner\/repo/);
  }
  // ---- GMGN without a tab: background requests with the browser's cookies; Cloudflare page → fallback ----
  {
    const gm = async html => {
      const listeners = [], calls = [];
      const api = { runtime: { id: 'ext', getManifest: () => ({ version: '1.0.0' }), getURL: p => 'chrome-extension://x/' + p, onMessage: { addListener: cb => listeners.push(cb) }, onUpdateAvailable: { addListener() {} } },
        action: { onClicked: { addListener() {} } }, tabs: {}, windows: {} };
      const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Promise, String, Number, Math, JSON, Array, Map, encodeURIComponent,
        fetch: async (url, o) => { calls.push([url, o.credentials]); return { status: html ? 403 : 200, ok: !html, text: async () => html || JSON.stringify({ code: 0, data: { holder_count: 10 } }) }; } };
      ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BG, ctx);
      const r = await new Promise(res => listeners[0]({ type: 'aps-gmgn', chain: 'sol', ca: 'So11111111111111111111111111111111111111112' }, { id: 'ext' }, res));
      return { r, calls };
    };
    let g = await gm('');
    assert.ok(g.r.ok && g.r.stat.data.holder_count === 10); assert.equal(g.calls.length, 6, 'five data requests + pump.fun callouts (Solana)'); assert.ok(g.calls.some(([u]) => u.includes('/pf/api/v1/pump/callout/token?chain=sol&token='))); assert.ok(g.calls.every(([u, c]) => u.startsWith('https://gmgn.ai/') && c === 'include'), 'gmgn.ai with the browser cookies');
    g = await gm('<html>Just a moment…</html>');
    assert.ok(!g.r.ok && g.r.blocked, 'Cloudflare check → the panel falls back to the GMGN tab');
  }
  console.log('PASS extension: manifests (Chrome + Firefox), API layer storage/listeners/xhr/tabs, built script runs on it, background restrictions');
})().catch(e => { console.error(e); process.exitCode = 1; });
