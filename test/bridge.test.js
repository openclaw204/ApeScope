'use strict';
const assert = require('node:assert/strict');
const { BRIDGE, vm, wait } = require('./harness');

const ca = 'So11111111111111111111111111111111111111112';
function fakeDoc() {
  const byId = new Map();
  const make = tag => ({ tag, children: [], style: {}, textContent: '', title: '', id: '',
    append(...n) { this.children.push(...n); for (const x of n) if (x.id) byId.set(x.id, x); }, remove() { if (this.id) byId.delete(this.id); }, replaceChildren(...n) { this.children = n; } });
  return { byId, doc: { body: make('body'), createElement: make, getElementById: k => byId.get(k) || null, querySelector: () => null, querySelectorAll: () => [] } };
}
function setup({ closes = i => i + 1, api = null } = {}) {
  const { doc } = fakeDoc(), now = Math.floor(Date.now() / 60000) * 60;
  const canvas = { width: 1280, height: 500, getBoundingClientRect: () => ({ left: 10, top: 15, right: 650, bottom: 265, width: 640, height: 250 }), getContext: () => ({ drawImage() {}, fillRect() {} }), toDataURL: t => 'data:' + t + ';base64,QUJD' };
  doc.querySelectorAll = q => q === 'canvas' ? [canvas] : [];
  doc.createElement = (orig => tag => tag === 'canvas' ? { width: 0, height: 0, getContext: () => ({ drawImage() {}, fillRect() {} }), toDataURL: t => 'data:' + t + ';base64,REVG' } : orig(tag))(doc.createElement);
  const chart = { model: () => ({ mainSeries: () => ({ data: () => ({ bars: () => ({ each(cb) { for (let i = 0; i < 10; i++) cb(i, { value: [now - 9 * 60 + i * 60, closes(i), closes(i), closes(i), closes(i), 100] }); } }) }) }), timeScale: () => ({ indexToCoordinate: i => i * 50 }) }) };
  const frame = { contentWindow: { document: doc, chartWidgetCollection: { getAll: () => [chart] }, tradingViewApi: api }, getBoundingClientRect: () => ({ width: 800, height: 380 }) };
  const messages = [], handlers = {}, scheduled = [], win = { postMessage: m => messages.push(m), addEventListener: (type, cb) => handlers[type] = cb };
  const ctx = { window: win, document: { querySelectorAll: q => q === 'iframe' ? [frame] : [] }, location: { origin: 'https://fomo.family', hostname: 'fomo.family', pathname: '/tokens/solana/' + ca },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }), setInterval: cb => scheduled.push(cb), Date, Number, Array, URL, Math, JSON, console, String, Promise };
  vm.runInNewContext(BRIDGE, ctx);
  return { doc, ctx, now, messages, handlers, scheduled, win };
}
async function chartMarkers() {
  const { doc, ctx, now, messages, handlers, scheduled, win } = setup({ closes: i => i + 1 });
  assert.equal(scheduled.length, 1);
  handlers.message({ source: win, origin: ctx.location.origin, data: { type: 'APESCOPE_CHART_EVENTS', ca, events: [
    { id: 'x:1', source: 'x', ca, timestamp: now - 5 * 60 + 10, author: '@someone', text: 'signal', url: 'https://x.com/someone/status/123' },
    { id: 'pump:test', source: 'pump', ca, timestamp: now - 180, author: 'test', text: 'test', url: 'https://pump.fun/callouts' }] } });
  scheduled[0]();
  const health = messages.filter(m => m.type === 'APESCOPE_CHART_HEALTH').at(-1);
  assert.equal(health.collections, 1); assert.equal(health.bars, 10); assert.equal(health.markers, 2, 'markers on two historical candles');
  const layer = doc.getElementById('apescope-chart-layer');
  assert.equal(layer.children.length, 2); assert.equal(layer.children[0].children[0].tag, 'a');
  assert.match(layer.children[0].children[0].title, /@someone · 2\.00×\n/, 'tooltip shows the multiple since the signal (close 5 → 10)');
  ctx.location.pathname = '/tokens/solana/11111111111111111111111111111111';
  scheduled[0]();
  assert.equal(messages.at(-1).caMatch, false, 'never draws on another token after SPA navigation');
}
async function snapshot() {
  const big = { width: 3200, height: 1600, getContext: () => ({ drawImage() {}, fillRect() {} }), toDataURL: t => 'data:' + t + ';base64,QklH' };
  const { messages, handlers, win, ctx } = setup({ api: { takeClientScreenshot: async () => big } });
  handlers.message({ source: win, origin: ctx.location.origin, data: { type: 'APESCOPE_CHART_SNAPSHOT_REQ', id: 'snap1' } });
  await wait(10);
  const reply = messages.find(m => m.type === 'APESCOPE_CHART_SNAPSHOT');
  assert.ok(reply, 'bridge replied'); assert.equal(reply.id, 'snap1'); assert.equal(reply.bars.length, 10); assert.equal(reply.bars[0].v, 100);
  assert.equal(reply.image, 'data:image/jpeg;base64,REVG', 'large screenshot is downscaled into a new canvas'); assert.equal(reply.error, '');
  handlers.message({ source: {}, origin: 'https://evil.example', data: { type: 'APESCOPE_CHART_SNAPSHOT_REQ', id: 'x' } });
  await wait(10); assert.ok(!messages.some(m => m.id === 'x'), 'foreign origin ignored');
  // Without tradingViewApi the bridge stitches the chart canvases itself.
  const s2 = setup({ api: null });
  s2.handlers.message({ source: s2.win, origin: s2.ctx.location.origin, data: { type: 'APESCOPE_CHART_SNAPSHOT_REQ', id: 'snap2' } });
  await wait(10);
  assert.match(s2.messages.find(m => m.id === 'snap2').image, /^data:image\/jpeg;base64,/);
}
async function pumpCapture() {
  const messages = [], scheduled = [], handlers = {};
  let nativeGet = 0;
  const storage = new Map();
  const win = { postMessage: v => messages.push(v), addEventListener: (t, cb) => handlers[t] = cb, XMLHttpRequest: class XHR {},
    fetch: async () => { nativeGet++; return { status: 200, headers: { get: () => 'application/json' }, clone: () => ({ text: async () => '{"data":{"callouts":[]}}' }) }; } };
  for (const k of ['open', 'send', 'setRequestHeader']) win.XMLHttpRequest.prototype[k] = function () {};
  const ctx = { window: win, sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    location: { hostname: 'pump.fun', origin: 'https://pump.fun', search: '?apescope_worker=1', href: 'https://pump.fun/?apescope_worker=1' },
    setInterval: cb => scheduled.push(cb), URL, URLSearchParams, Headers, Promise, Date, Number, Array, JSON, Math, console, String };
  vm.runInNewContext(BRIDGE, ctx);
  assert.equal(scheduled.length, 1, 'worker activated by the URL flag');
  await win.fetch('https://advanced-api-v2.pump.fun/callout/list/mylist?sortBy=created');
  await new Promise(r => setImmediate(r));
  const event = messages.find(m => m.type === 'APESCOPE_PUMP_NETWORK' && m.source === 'page-fetch');
  assert.ok(event, 'captured the real callout JSON'); assert.equal(event.path, '/callout/list/mylist'); assert.ok(event.body.includes('callouts'));
  assert.ok(!('headers' in event), 'headers never leave the page bridge'); assert.equal(nativeGet, 1);
  // Without the flag nothing is hooked.
  const quiet = []; const ctx2 = { ...ctx, window: { ...win, postMessage: v => quiet.push(v) }, sessionStorage: { getItem: () => null, setItem() {} }, location: { ...ctx.location, search: '', href: 'https://pump.fun/' }, setInterval: () => { throw Error('should not schedule'); } };
  vm.runInNewContext(BRIDGE, ctx2); assert.equal(quiet.length, 0);
}
(async () => {
  await chartMarkers(); await snapshot(); await pumpCapture();
  console.log('PASS bridge: chart markers + performance tooltip, SPA guard, snapshot (API + canvas fallback), pump.fun capture without headers');
})().catch(e => { console.error(e); process.exitCode = 1; });
