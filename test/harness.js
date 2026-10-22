'use strict';
// Test harness: loads slices of src/apescope.js into a Node vm context with fake storage / request APIs (the ones compat.js provides).
// No dependencies — run with `node test/run.js` (or `npm test`).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'apescope.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

function slice(from, to) {
  const a = MAIN.indexOf(from), b = MAIN.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`slice markers not found: ${from} → ${to}`);
  return MAIN.slice(a, b);
}
/** Everything above runPanel: constants, parsers, shared helpers. */
const CORE = slice('  const VERSION', '  async function runPanel() {');
/** The panel, with a hook that exposes its internals instead of starting the UI. */
const PANEL_END = "    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();\n  }";
function panelSource(exposed) {
  const body = slice('  async function runPanel() {', '  function searchUrl(ca) {');
  if (!body.includes(PANEL_END)) throw new Error('panel start marker not found');
  return body.replace(PANEL_END, `    globalThis.T = { ${exposed.join(', ')} };\n  }`);
}
const SEARCH_URL = slice('  function searchUrl(ca) {', '  // ====');
const WORKER = name => slice(`  function ${name}() {`, name === 'runChatGPT' ? '  try {\n    if (isFomo)' : '  // ====');

/** In-memory GM storage with working value-change listeners (like compat.js on top of chrome.storage). */
function gmStore() {
  const map = new Map(), listeners = new Map();
  return {
    map,
    GM_getValue: (k, d) => map.has(k) ? map.get(k) : d,
    GM_setValue: (k, v) => { const old = map.get(k); map.set(k, v); for (const cb of listeners.get(k) || []) cb(k, old, v, false); },
    GM_deleteValue: k => map.delete(k),
    GM_addValueChangeListener: (k, cb) => { listeners.set(k, [...(listeners.get(k) || []), cb]); return 1; },
  };
}
/** Minimal DOM node: enough for the panel's render functions (textContent only, no layout). */
function fakeNode(tag) {
  return {
    tag, children: [], style: {}, attrs: {}, textContent: '', className: '', value: '', open: false, dataset: {},
    get childElementCount() { return this.children.length; },
    append(...n) { this.children.push(...n.map(x => typeof x === 'string' ? { textContent: x, children: [] } : x)); },
    remove() { this.removed = true; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, cb) { (this.listeners ||= {})[type] = cb; }, replaceChildren(...n) { this.children = n; },
    querySelector: () => null, querySelectorAll: () => [], scrollTo() {},
  };
}
const text = n => n.removed ? '' : (n.textContent || '') + (n.attrs?.href ? ` <${n.attrs.href}>` : '') + ' ' + (n.children || []).map(text).join(' ');
const allText = n => text(n).replace(/\s+/g, ' ').trim();

/** Fake GM_xmlhttpRequest that answers from [regex, responder] routes. */
function fakeHttp(routes, log = []) {
  return o => {
    log.push(o.url);
    setTimeout(() => {
      const r = routes.find(([rx]) => rx.test(o.url));
      if (!r) return o.onload({ status: 404, responseText: '', responseHeaders: '' });
      const v = r[1](o);
      o.onload(v && 'status' in v && 'responseText' in v ? v : { status: 200, responseText: JSON.stringify(v), responseHeaders: '' });
    }, 0);
  };
}

/** Panel context: core + panel loaded, internals exposed as ctx.T. */
function loadPanel({ routes = [], exposed, href = 'https://fomo.family/', store = gmStore(), log = [] } = {}) {
  const u = new URL(href);
  const ctx = {
    URL, URLSearchParams, atob, btoa, Uint8Array, TextEncoder, crypto: globalThis.crypto, Intl, Number, Object, Array, Error, Math, Map, Date, BigInt, Set, WeakSet, Promise, RegExp, String, JSON, Blob, console,
    setTimeout, clearTimeout, setInterval: () => 0,
    location: { hostname: u.hostname, origin: u.origin, href, pathname: u.pathname, search: u.search },
    window: { postMessage() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    document: { createElement: fakeNode, documentElement: fakeNode('html'), head: fakeNode('head'), body: fakeNode('body'), querySelectorAll: () => [], readyState: 'complete' },
    sessionStorage: { getItem: () => null, setItem() {} }, Event: function () {}, addEventListener() {}, innerWidth: 1600, innerHeight: 900,
    GM_xmlhttpRequest: fakeHttp(routes, log), GM_openInTab() {}, GM_setClipboard() {}, GM_registerMenuCommand() {}, unsafeWindow: null,
    ...store,
  };
  vm.createContext(ctx);
  vm.runInContext(CORE + '\n' + SEARCH_URL + '\n' + panelSource(exposed) + '\nrunPanel();', ctx, { filename: 'apescope.js' });
  if (!ctx.T) throw new Error('panel hooks not exposed');
  return { ctx, T: ctx.T, store, log };
}
/** Core-only context (parsers and shared helpers as globals). */
function loadCore() {
  const store = gmStore();
  const ctx = { URL, URLSearchParams, Number, Object, Array, Error, Math, Map, Date, BigInt, Set, WeakSet, Promise, RegExp, String, JSON, console, setTimeout,
    location: { hostname: 'example.com', href: 'https://example.com/', search: '' }, sessionStorage: { getItem: () => null, setItem() {} }, ...store };
  vm.createContext(ctx);
  // Turn the top-level consts we want to inspect into globals.
  vm.runInContext(CORE + '\nglobalThis.C = { K, MSG, GMGN_CHAIN, VERSION, normalizeGmgn, normalizeGmgnExtra };', ctx, { filename: 'apescope.js' });
  return ctx;
}
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, tries = 400) { for (let i = 0; i < tries; i++) { if (fn()) return true; await wait(2); } return false; }

module.exports = { MAIN, BRIDGE, CORE, WORKER, SEARCH_URL, loadPanel, loadCore, gmStore, fakeNode, allText, wait, until, vm };
