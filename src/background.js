/*
 * ApeScope — background (service worker in Chrome, event page in Firefox). MIT License.
 * Answers messages from ApeScope's own content scripts only: network requests without cookies, tab handling,
 * update checks, updates from a dropped release file and (opt-in) the X search through x.com's web API.
 */
'use strict';
const api = globalThis.browser ?? globalThis.chrome;
// Set by the build (--update-base): where version.json with the latest version lives. Empty = store updates only.
const UPDATE_INFO_URL = '';
// Set by the build (--github owner/repo, the release workflow passes its own repository): GitHub releases to check.
const UPDATE_GITHUB_REPO = '';

async function doFetch({ method = 'GET', url, headers = {}, data = null, timeout = 15000 }) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'invalid URL' };
  if (!['GET', 'POST'].includes(method)) return { ok: false, error: 'method not allowed' };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), Math.min(Number(timeout) || 15000, 30000));
  try {
    const res = await fetch(url, { method, headers, body: method === 'POST' ? data : undefined, credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: ctrl.signal });
    const text = await res.text();
    return { ok: true, status: res.status, responseText: text.slice(0, 5_000_000), finalUrl: res.url,
      responseHeaders: [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n') };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

async function openTab({ url, active = true, reuse = false }, sender) {
  if (!/^https:\/\//i.test(String(url || ''))) return;
  if (reuse) {
    const target = new URL(url);
    const tabs = await api.tabs.query({ url: target.origin + '/*' });
    const tab = tabs.find(t => t.url === url) || tabs[0];
    if (tab) {
      await api.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return;
    }
  }
  const from = sender?.tab;
  await api.tabs.create({ url, active, ...(from ? { windowId: from.windowId, index: from.index + 1 } : {}) });
}

/** 1.10.0 > 1.9.3 */
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
async function checkUpdate() {
  const current = api.runtime.getManifest().version, firefox = isFirefox();
  // 1) Store installs and signed self-hosted Firefox builds: the browser fetches the update itself.
  try {
    const r = await api.runtime.requestUpdateCheck();
    const status = Array.isArray(r) ? r[0] : r?.status ?? r, version = (Array.isArray(r) ? r[1] : r)?.version || '';
    if (status === 'update_available') return { status, version };
    if (status === 'throttled' && !UPDATE_INFO_URL && !UPDATE_GITHUB_REPO) return { status };   // otherwise ask our own release source
  } catch { /* unpacked / temporary installs cannot update themselves */ }
  // 2) Manually installed builds: compare with the published version.json and offer the download.
  if (UPDATE_INFO_URL) {
    const res = await doFetch({ url: UPDATE_INFO_URL + '?t=' + Date.now() });
    if (res.ok && res.status === 200) {
      try {
        const info = JSON.parse(res.responseText);
        if (info?.version && newer(info.version, current)) return { status: 'manual', version: String(info.version), url: String((firefox ? info.firefox : info.chrome) || info.page || '') };
      } catch {}
    }
  }
  // 3) GitHub releases of this project: offer the release page with the downloads.
  if (UPDATE_GITHUB_REPO) {
    const res = await doFetch({ url: `https://api.github.com/repos/${UPDATE_GITHUB_REPO}/releases/latest`, headers: { Accept: 'application/vnd.github+json' } });
    if (res.ok && res.status === 200) {
      try {
        const rel = JSON.parse(res.responseText), v = String(rel?.tag_name || '').replace(/^v/i, '');
        if (/^\d+\.\d+\.\d+$/.test(v) && newer(v, current)) {
          const asset = (Array.isArray(rel.assets) ? rel.assets : []).find(a => a?.name === (firefox ? 'apescope-firefox.xpi' : '') || a?.name === `apescope-${firefox ? 'firefox' : 'chrome'}.zip`);
          return { status: 'manual', version: v, url: String(asset?.browser_download_url || rel.html_url || '') };
        }
      } catch {}
    }
  }
  return { status: 'no_update', version: current };
}

// ---- Update from a release file (.zip / .xpi) -------------------------------------------------------------
// Unpacked (Chrome) and temporary (Firefox) installs read their files from a folder. If that folder is inside the
// Downloads folder, the extension can overwrite its own files there through the downloads API and then reload.
const isFirefox = () => api.runtime.getURL('').startsWith('moz-extension:');
const ALLOWED_FILE = /^(manifest\.json|[a-z-]+\.js|icons\/icon-\d+\.png|LICENSE)$/;
const REQUIRED_FILES = ['manifest.json', 'apescope.js', 'bridge.js', 'background.js', 'compat.js'];

/** Minimal ZIP reader (stored and deflated entries) using the central directory. */
async function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('not a ZIP file');
  const count = v.getUint16(eocd + 10, true), files = new Map();
  let p = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw Error('damaged ZIP file');
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/^\.\//, '');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('META-INF/') || name === 'mozilla-recommendation.json') continue;   // folders, Mozilla signature
    if (!ALLOWED_FILE.test(name)) throw Error('unexpected file in the package: ' + name.slice(0, 60));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true), raw = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
    else throw Error('unsupported compression in ' + name);
  }
  return files;
}
function b64ToBytes(b64) { const bin = atob(b64), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function bytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const done = d => { if (d.id !== id || !d.state) return; if (d.state.current === 'complete') { api.downloads.onChanged.removeListener(done); resolve(); } else if (d.state.current === 'interrupted') { api.downloads.onChanged.removeListener(done); reject(Error('saving was interrupted')); } };
    api.downloads.onChanged.addListener(done);
    api.downloads.search({ id }).then(([d]) => { if (d?.state === 'complete') { api.downloads.onChanged.removeListener(done); resolve(); } }).catch(() => {});
  });
}
async function writeFile(path, bytes, type) {
  // Firefox's background page can create blob URLs; Chrome's service worker cannot, so it uses a data URL.
  const url = isFirefox() ? URL.createObjectURL(new Blob([bytes], { type })) : `data:${type};base64,${bytesToB64(bytes)}`;
  try {
    const id = await api.downloads.download({ url, filename: path, conflictAction: 'overwrite', saveAs: false });
    await waitForDownload(id);
    api.downloads.erase({ id }).catch(() => {});   // keep the download list clean; the file stays
  } finally { if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10000); }
}
async function installFromFile({ data, folder }) {
  if (!api.downloads) return { ok: false, error: 'This build has no permission to write files.' };
  folder = String(folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!folder || folder.split('/').some(part => !part || part === '.' || part === '..' || !/^[\w .()-]+$/.test(part))) return { ok: false, error: 'Invalid folder name.' };
  const files = await readZip(b64ToBytes(String(data || '')));
  for (const f of REQUIRED_FILES) if (!files.has(f)) return { ok: false, error: 'Not an ApeScope package (missing ' + f + ').' };
  let manifest; try { manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))); } catch { return { ok: false, error: 'manifest.json is not readable.' }; }
  if (manifest.name !== 'ApeScope' || !/^\d+\.\d+\.\d+$/.test(manifest.version || '')) return { ok: false, error: 'Not an ApeScope package.' };
  const forFirefox = !!manifest.background?.scripts;
  if (forFirefox !== isFirefox()) return { ok: false, error: `This is the ${forFirefox ? 'Firefox' : 'Chrome'} package — use apescope-${isFirefox() ? 'firefox' : 'chrome'}-v….zip.` };
  const current = api.runtime.getManifest().version;
  const types = { js: 'text/javascript', json: 'application/json', png: 'image/png' };
  // Write everything except the manifest first: the manifest marks a complete update.
  const order = [...files.keys()].filter(n => n !== 'manifest.json').concat('manifest.json');
  for (const name of order) await writeFile(folder + '/' + name, files.get(name), types[name.split('.').pop()] || 'text/plain');
  // The extension reads its files from its folder, so its own manifest now shows the new version if the folder is right.
  let loaded = '';
  try { loaded = (await (await fetch(api.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' })).json()).version; } catch {}
  if (loaded !== manifest.version) return { ok: false, written: true, version: manifest.version, error: `The files were saved to Downloads/${folder}, but ApeScope is loaded from a different folder. Load it once from Downloads/${folder} (see Settings → Updates), then updates work from here.` };
  await api.storage.local.set({ 'aps:update-installed': { from: current, to: manifest.version, ts: Date.now() } });
  setTimeout(() => api.runtime.reload(), 300);
  return { ok: true, version: manifest.version, from: current };
}

// ---- X search without a tab (opt-in: Settings → Socials → "Search X without a tab") ------------------------
// Does what x.com's own web app does for a "Latest" search: GraphQL SearchTimeline with the public web-app bearer
// token, the user's session cookies, the ct0 cookie echoed as x-csrf-token and an x-client-transaction-id derived
// from x.com's app shell. The ct0 value is read only to send it back to x.com; nothing is stored or sent elsewhere.
// Query id, feature flags and the transaction-id inputs change with X's deploys, so they are read from x.com's own
// files (cached for 6 hours, reloaded once when X answers 404/400).
// Transaction id: port of the MIT-licensed x-client-transaction-id generator (github.com/Lqm1/x-client-transaction-id).
const X = {
  bearer: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  shell: 'https://x.com/i/jf/',   // the logged-out home page moved to a new app; this shell still carries the webpack runtime
  assets: 'https://abs.twimg.com/responsive-web/client-web/',
  minGapMs: 15000,                // X allows ~50 searches per 15 min per account: at most one call every 15 s from all tabs
  cacheMs: 25000, clientTtlMs: 6 * 3600e3,
};
const xState = { client: null, loading: null, lastCall: 0, blockedUntil: 0, cache: new Map(), step: 'idle' };

/** The pieces of the app shell (x.com/i/jf/) needed for the transaction id, the main bundle and feature flags. */
function xParseShell(html) {
  html = String(html || '');
  const main = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[0-9a-z]+\.js/.exec(html)?.[0] || '';
  // webpack runtime: {…,59924:"ondemand.s",…}[e]||e)+"."+({…,59924:"81a348d6aed80cad",…})[e]+"a.js"
  const chunk = /(\d+):\s*["']ondemand\.s["']/.exec(html)?.[1];
  let hash = chunk ? new RegExp(`\\b${chunk}:\\s*["']([0-9a-f]{8,})["']`).exec(html.slice(html.indexOf('ondemand.s')))?.[1] : '';
  if (!hash) hash = /["']ondemand\.s["']:\s*["']([0-9a-f]{8,})["']/.exec(html)?.[1] || '';   // older runtime layout
  const key = (/<meta[^>]*name=["']twitter-site-verification["'][^>]*content=["']([^"']+)["']/.exec(html) || /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter-site-verification["']/.exec(html))?.[1] || '';
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const at = html.indexOf(`id="loading-x-anim-${i}"`); if (at < 0) break;
    const svg = html.slice(at, html.indexOf('</svg>', at));
    const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
    frames.push(ds[1] || '');   // svg > g > second path, like the web app's loading animation
  }
  return { main, ondemand: hash ? `${X.assets}ondemand.s.${hash}a.js` : '', key, frames };
}
/** SearchTimeline's query id, feature switches and field toggles from the main bundle. */
function xParseMain(js) {
  const m = /queryId:"([\w-]+)",operationName:"SearchTimeline",operationType:"\w+",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]/.exec(String(js || ''));
  if (!m) return null;
  const names = s => (s.match(/"([\w]+)"/g) || []).map(x => x.slice(1, -1));
  return { queryId: m[1], featureNames: names(m[2]), fieldToggleNames: names(m[3]) };
}
/** Feature flag values as the web app would send them (defaults from the shell's config, unknown → false). */
function xFeatures(names, html) {
  const out = {};
  for (const n of names) out[n] = new RegExp(`"${n}":\\{"value":true\\}`).test(html);
  return out;
}

// -- transaction id ---------------------------------------------------------------------------------------
function xCubic(curves, time) {
  const calc = (a, b, m) => 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
  if (time <= 0) return (curves[0] > 0 ? curves[1] / curves[0] : curves[1] === 0 && curves[2] > 0 ? curves[3] / curves[2] : 0) * time;
  if (time >= 1) return 1 + (curves[2] < 1 ? (curves[3] - 1) / (curves[2] - 1) : curves[2] === 1 && curves[0] < 1 ? (curves[1] - 1) / (curves[0] - 1) : 0) * (time - 1);
  let start = 0, end = 1, mid = 0;
  while (start < end) {
    mid = (start + end) / 2;
    const x = calc(curves[0], curves[2], mid);
    if (Math.abs(time - x) < 0.00001) return calc(curves[1], curves[3], mid);
    if (x < time) start = mid; else end = mid;
  }
  return calc(curves[1], curves[3], mid);
}
function xFloatToHex(x) {
  const out = []; let q = Math.floor(x), f = x - q;
  while (q > 0) { q = Math.floor(x / 16); const r = Math.floor(x - q * 16); out.unshift(r > 9 ? String.fromCharCode(r + 55) : String(r)); x = q; }
  if (f === 0) return out.join('');
  out.push('.');
  while (f > 0) { f *= 16; const i = Math.floor(f); f -= i; out.push(i > 9 ? String.fromCharCode(i + 55) : String(i)); }
  return out.join('');
}
function xAnimate(frames, targetTime) {
  const solve = (v, min, max, rounding) => { const r = v * (max - min) / 255 + min; return rounding ? Math.floor(r) : Math.round(r * 100) / 100; };
  const lerp = (a, b, f) => a.map((v, i) => v * (1 - f) + b[i] * f);
  const from = [...frames.slice(0, 3), 1], to = [...frames.slice(3, 6), 1];
  const curves = frames.slice(7).map((v, i) => solve(v, i % 2 ? -1 : 0, 1, false));
  const val = xCubic(curves, targetTime);
  const color = lerp(from, to, val).map(v => v > 0 ? v : 0);
  const rad = lerp([0], [solve(frames[6], 60, 360, true)], val)[0] * Math.PI / 180;
  const parts = color.slice(0, -1).map(v => Math.round(v).toString(16));
  for (const v of [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)]) {
    const hex = xFloatToHex(Math.abs(Math.round(v * 100) / 100));
    parts.push(hex.startsWith('.') ? ('0' + hex).toLowerCase() : hex || '0');
  }
  parts.push('0', '0');
  return parts.join('').replace(/[.-]/g, '');
}
/** Per-deploy secret of the transaction id: verification key bytes + one frame of the loading animation. */
function xAnimationKey(keyBytes, frames, indices) {
  const [rowByte, ...timeBytes] = indices;
  const d = frames[keyBytes[5] % 4];
  if (!d) throw Error('X app shell: animation frames missing');
  const rows = d.slice(9).split('C').map(seg => { const c = seg.replace(/[^\d]+/g, ' ').trim(); return c ? c.split(/\s+/).map(Number) : []; });
  const row = rows[keyBytes[rowByte] % 16];
  if (!row?.length) throw Error('X app shell: animation data missing');
  const frameTime = Math.round(timeBytes.reduce((n, i) => n * (keyBytes[i] % 16), 1) / 10) * 10;
  return xAnimate(row, frameTime / 4096);
}
async function xTransactionId(client, method, path, nowMs = Date.now(), random = Math.floor(Math.random() * 256)) {
  const t = Math.floor((nowMs - 1682924400 * 1000) / 1000);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${method}!${path}!${t}obfiowerehiring${client.animationKey}`)));
  const bytes = [...client.keyBytes, t & 255, (t >> 8) & 255, (t >> 16) & 255, (t >> 24) & 255, ...hash.slice(0, 16), 3];
  return btoa(String.fromCharCode(random, ...bytes.map(b => b ^ random))).replace(/=/g, '');
}

/** Reads query id, features and transaction-id inputs from x.com's files (no cookies needed). */
async function xLoadClient() {
  const get = async url => { const r = await fetch(url, { credentials: 'omit', cache: 'no-store' }); if (!r.ok) throw Error(`${new URL(url).pathname.slice(0, 40)}: HTTP ${r.status}`); return r.text(); };
  const html = await get(X.shell), shell = xParseShell(html);
  if (!shell.main || !shell.ondemand || !shell.key) throw Error('X app shell changed (main bundle, ondemand chunk or key not found)');
  const [js, od] = await Promise.all([get(shell.main), get(shell.ondemand)]);
  const op = xParseMain(js);
  if (!op) throw Error('SearchTimeline not found in X\'s main bundle');
  const indices = [...od.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map(m => Number(m[1]));
  if (indices.length < 2) throw Error('X ondemand chunk changed (key indices not found)');
  const keyBytes = [...atob(shell.key)].map(c => c.charCodeAt(0));
  const client = { ts: Date.now(), queryId: op.queryId, features: xFeatures(op.featureNames, html), fieldToggles: Object.fromEntries(op.fieldToggleNames.map(n => [n, false])),
    keyBytes, animationKey: xAnimationKey(keyBytes, shell.frames, indices) };
  try { await api.storage.session?.set({ 'aps:x-client': client }); } catch {}
  return client;
}
async function xGetClient(fresh = false) {
  if (!fresh && !xState.client) { try { xState.client = (await api.storage.session?.get('aps:x-client'))?.['aps:x-client'] || null; } catch {} }
  if (!fresh && xState.client && Date.now() - xState.client.ts < X.clientTtlMs) return xState.client;
  xState.loading ||= xLoadClient().finally(() => { xState.loading = null; });
  return (xState.client = await xState.loading);
}

/** "Wed Oct 10 20:19:24 +0000 2018" → ms (not every engine's Date.parse reads this format). */
function xTime(s) {
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \+0000 (\d{4})$/.exec(String(s || ''));
  const mon = m ? 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3 : -1;
  return m && mon >= 0 ? Date.UTC(+m[6], mon, +m[2], +m[3], +m[4], +m[5]) : null;
}
/** Tweets (id, handle, text with expanded links, created ms) and the cursor to older results. */
function xParseTimeline(json) {
  const tweets = [], seen = new Set(); let cursor = '';
  const add = r => {
    if (r?.__typename === 'TweetWithVisibilityResults' || (r?.tweet && !r.legacy)) r = r.tweet;
    const legacy = r?.legacy, id = String(r?.rest_id || legacy?.id_str || '');
    if (!legacy || !/^\d{1,25}$/.test(id) || seen.has(id)) return;
    const user = r.core?.user_results?.result, handle = String(user?.core?.screen_name || user?.legacy?.screen_name || '');
    let text = String(r.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '');
    for (const u of [...(legacy.entities?.urls || []), ...(r.note_tweet?.note_tweet_results?.result?.entity_set?.urls || [])])
      if (u?.url && /^https?:\/\//.test(u.expanded_url || '')) text = text.split(u.url).join(u.expanded_url);
    const createdAt = xTime(legacy.created_at);
    if (!handle || !createdAt) return;
    seen.add(id); tweets.push({ id, handle, text: text.slice(0, 2000), createdAt });
  };
  const visit = c => {
    if (!c || typeof c !== 'object') return;
    if (c.cursorType === 'Bottom' && c.value) cursor = String(c.value);
    if (c.itemContent?.tweet_results?.result) add(c.itemContent.tweet_results.result);
    if (c.itemContent?.cursorType === 'Bottom' && c.itemContent.value) cursor = String(c.itemContent.value);
    for (const it of c.items || []) visit(it.item);
  };
  for (const ins of json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || []) {
    for (const e of ins.entries || []) visit(e.content);
    if (ins.entry) visit(ins.entry.content);
  }
  return { tweets, cursor };
}

async function xSearch({ query, cursor = '' }) {
  query = String(query || '').trim().slice(0, 200); cursor = String(cursor || '').slice(0, 500);
  if (!query) return { ok: false, code: 'input', error: 'empty query' };
  if (!api.cookies) return { ok: false, code: 'unsupported', error: 'this build has no access to the X login' };
  const t = Date.now(), cacheKey = query + '|' + cursor, hit = xState.cache.get(cacheKey);
  if (t < xState.blockedUntil) return { ok: false, code: 'rate', error: 'X rate limit reached', retryAt: xState.blockedUntil };
  if (hit && t - hit.ts < X.cacheMs) return hit.result;
  if (t - xState.lastCall < X.minGapMs) return { ok: false, code: 'busy', retryAt: xState.lastCall + X.minGapMs };
  xState.step = 'cookie';
  // Firefox keeps cookies per first-party when isolation is on: try the plain lookup, then the x.com partition.
  let ct0 = (await api.cookies.get({ url: 'https://x.com/', name: 'ct0' }).catch(() => null))?.value;
  if (!ct0) ct0 = (await api.cookies.get({ url: 'https://x.com/', name: 'ct0', firstPartyDomain: 'x.com' }).catch(() => null))?.value;
  if (!ct0) return { ok: false, code: 'login', error: 'not logged in on x.com in this browser — log in once on x.com' };
  xState.lastCall = t;
  for (let attempt = 0; attempt < 2; attempt++) {
    let client;
    xState.step = 'client';
    try { client = await xGetClient(attempt > 0); } catch (e) { return { ok: false, code: 'outdated', error: String(e?.message || e) }; }
    xState.step = 'search';
    const path = `/i/api/graphql/${client.queryId}/SearchTimeline`;
    const variables = { rawQuery: query, count: 20, querySource: 'typed_query', product: 'Latest', ...(cursor ? { cursor } : {}) };
    const url = 'https://x.com' + path + '?' + new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(client.features), fieldToggles: JSON.stringify(client.fieldToggles) });
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctrl.signal, headers: {
        authorization: 'Bearer ' + X.bearer, 'x-csrf-token': ct0, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en', 'x-client-transaction-id': await xTransactionId(client, 'GET', path), 'content-type': 'application/json' } });
    } catch (e) { return { ok: false, code: 'http', error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) }; }
    finally { clearTimeout(timer); }
    const remaining = Number(res.headers.get('x-rate-limit-remaining')), reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
    const rate = res.headers.get('x-rate-limit-remaining') != null && Number.isFinite(remaining) ? { remaining, reset: Number.isFinite(reset) ? reset : 0 } : null;
    if (res.status === 429) { xState.blockedUntil = reset > t ? reset : t + 15 * 60e3; return { ok: false, code: 'rate', error: 'X rate limit reached', retryAt: xState.blockedUntil, rate }; }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'login', error: `X refused the search (HTTP ${res.status}: logged out or account restricted?)` };
    if ((res.status === 404 || res.status === 400) && attempt === 0) continue;   // new deploy: reload query id, features and key once
    if (!res.ok) return { ok: false, code: res.status === 404 || res.status === 400 ? 'outdated' : 'http', error: `X search: HTTP ${res.status}` };
    let json; try { json = JSON.parse(await res.text()); } catch { return { ok: false, code: 'http', error: 'X search: unreadable answer' }; }
    if (!json?.data?.search_by_raw_query && json?.errors?.length) return { ok: false, code: 'outdated', error: 'X search: ' + String(json.errors[0]?.message || 'error').slice(0, 120) };
    const result = { ok: true, ...xParseTimeline(json), rate };
    if (rate && rate.remaining <= 1 && rate.reset > t) xState.blockedUntil = rate.reset;   // keep the last call for the user's own browsing
    xState.cache.set(cacheKey, { ts: t, result });
    if (xState.cache.size > 40) xState.cache.delete(xState.cache.keys().next().value);
    return result;
  }
  return { ok: false, code: 'outdated', error: 'X search: HTTP 404 after reloading X\'s app files' };
}

// ---- GMGN without a tab ----------------------------------------------------------------------------------
// The same five requests the GMGN tab makes, sent from the background with the browser's gmgn.ai cookies (including
// Cloudflare's clearance cookie once the user has opened gmgn.ai). If Cloudflare still answers with its check page,
// the panel falls back to the GMGN tab.
async function gmgnFetch({ chain, ca }) {
  if (!['sol', 'eth', 'bsc', 'base'].includes(chain) || !/^[0-9A-Za-z]{32,64}$/.test(String(ca || ''))) return { ok: false, error: 'invalid request' };
  let blocked = false;
  const get = async (path, body) => {
    try {
      const res = await fetch('https://gmgn.ai' + path, { method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
        headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      if (res.status === 403 || res.status === 503 || /^\s*</.test(text)) { blocked = true; return null; }
      if (!res.ok || text.length > 2_000_000) return null;
      const j = JSON.parse(text); return j && j.code !== undefined && Number(j.code) !== 0 ? null : j;
    } catch { return null; }
  };
  const c = chain, a = encodeURIComponent(ca);
  const [stat, holderStat, fee, info, dist, callouts] = await Promise.all([get(`/api/v1/token_stat/${c}/${a}`), get(`/vas/api/v1/token_holder_stat/${c}/${a}`), get(`/api/v1/token_fee_info/${c}/${a}`),
    get('/api/v1/mutil_window_token_info', { chain: c, addresses: [ca] }), get(`/api/v1/token_fee_distribution/${c}/${a}`), c === 'sol' ? get(`/pf/api/v1/pump/callout/token?chain=sol&token=${a}`) : null]);
  if (!stat && !holderStat && !fee) return { ok: false, blocked, error: blocked ? 'Cloudflare check' : 'no data' };
  return { ok: true, stat, holderStat, fee, info, dist, callouts };
}

// ---- Rendered text of a project website (only when the user clicks "Check the CA in a browser tab") ----------
// Single-page sites fill in the contract address with JavaScript. The page is opened in a background tab, its visible
// text plus link targets are read once it has loaded, and the tab is closed again.
async function renderText({ url }, sender) {
  if (!/^https:\/\/[^\s]+$/i.test(String(url || ''))) return { ok: false, error: 'invalid URL' };
  if (!api.scripting) return { ok: false, error: 'This build cannot read pages.' };
  const tab = await api.tabs.create({ url, active: false, ...(sender?.tab ? { windowId: sender.tab.windowId, index: sender.tab.index + 1 } : {}) });
  try {
    await new Promise(resolve => {
      const timer = setTimeout(done, 20000);
      function done() { clearTimeout(timer); api.tabs.onUpdated.removeListener(listen); resolve(); }
      function listen(id, info) { if (id === tab.id && info.status === 'complete') done(); }
      api.tabs.onUpdated.addListener(listen);
    });
    await new Promise(r => setTimeout(r, 4000));   // let the app fetch its data and render
    const [res] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const attrs = [...document.querySelectorAll('a[href],[data-ca],[data-address],input[value],[title]')].map(e => [e.getAttribute('href'), e.getAttribute('data-ca'), e.getAttribute('data-address'), e.getAttribute('value'), e.getAttribute('title')].filter(Boolean).join(' '));
      return (document.body?.innerText || '') + '\n' + attrs.join('\n');
    } });
    return { ok: true, text: String(res?.result || '').slice(0, 3_000_000) };
  } finally { api.tabs.remove(tab.id).catch(() => {}); }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return false;
  if (msg?.type === 'aps-xhr') { doFetch(msg).then(sendResponse); return true; }
  if (msg?.type === 'aps-open') { openTab(msg, sender).then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e?.message || e) })); return true; }
  if (msg?.type === 'aps-update-check') { checkUpdate().then(sendResponse, e => sendResponse({ status: 'error', error: String(e?.message || e) })); return true; }
  if (msg?.type === 'aps-render-text') { renderText(msg, sender).then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message || e) })); return true; }
  if (msg?.type === 'aps-update-file') { installFromFile(msg).then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message || e) })); return true; }
  if (msg?.type === 'aps-x-search') { xSearch(msg).then(r => sendResponse(r || { ok: false, code: 'http', error: 'X search returned nothing (step: ' + xState.step + ')' }), e => sendResponse({ ok: false, code: 'http', error: `${String(e?.message || e)} (step: ${xState.step})` })); return true; }
  if (msg?.type === 'aps-gmgn') { gmgnFetch(msg).then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message || e) })); return true; }
  if (msg?.type === 'aps-all-sites') { api.permissions.contains({ origins: ['<all_urls>'] }).then(v => sendResponse(!!v), () => sendResponse(false)); return true; }
  if (msg?.type === 'aps-open-options') { api.runtime.openOptionsPage().then(() => sendResponse(true), () => sendResponse(false)); return true; }
  if (msg?.type === 'aps-install-type') { (api.management?.getSelf?.() || Promise.resolve(null)).then(m => sendResponse(m?.installType || ''), () => sendResponse('')); return true; }
  if (msg?.type === 'aps-update-apply') { sendResponse({ ok: true }); setTimeout(() => api.runtime.reload(), 100); return true; }
  return false;
});

// A downloaded update waits until the user clicks "Update" in Settings (or the browser restarts).
api.runtime.onUpdateAvailable?.addListener(() => {});

// Toolbar button: toggle the sidebar on fomo.family, otherwise open fomo.family.
api.action.onClicked.addListener(async tab => {
  let handled = false;
  try { handled = (await api.tabs.sendMessage(tab.id, { type: 'aps-toggle' }))?.handled; } catch {}
  if (!handled) await api.tabs.create({ url: 'https://fomo.family/' });
});
