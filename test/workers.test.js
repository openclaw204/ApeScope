'use strict';
const assert = require('node:assert/strict');
const { CORE, WORKER, gmStore, vm, until, wait } = require('./harness');

const ca = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

// ---- ChatGPT worker against a minimal fake chatgpt.com DOM ----
async function chatgpt() {
  const gm = gmStore();
  let clock = Date.now();
  const messages = [];
  const composer = { tagName: 'DIV', innerText: '', offsetParent: {}, focus() {}, dispatchEvent() { return true; }, replaceChildren() {} };
  let silent = false;
  const sendBtn = { disabled: false, offsetParent: {}, getAttribute: () => null, click() {
    messages.push({ role: 'user' });
    if (silent) return; // ChatGPT takes too long / never answers
    setTimeout(() => { // ChatGPT starts answering, then finishes
      const md = { innerText: 'Analysing…', textContent: '', querySelectorAll: () => [] };
      messages.push({ role: 'assistant', md });
      setTimeout(() => { md.innerText = 'Result: risky\n```json\n{"verdict":"risky","score":25}\n```'; md.querySelectorAll = () => [{ textContent: '{"verdict":"risky","score":25}' }]; }, 5);
    }, 5);
  } };
  const document = { readyState: 'complete', hidden: false, documentElement: { append() {} }, createElement: () => ({ style: {}, remove() {}, textContent: '' }),
    execCommand: (cmd, _, text) => { if (cmd === 'insertText') composer.innerText = text; return true; },
    querySelector: () => null,
    querySelectorAll: sel => sel.includes('assistant') ? messages.filter(m => m.role === 'assistant').map(m => ({ querySelector: () => m.md }))
      : sel.includes('prompt-textarea') ? [composer] : sel.includes('send-button') ? [sendBtn] : [] };
  const ctx = { document, location: { hostname: 'chatgpt.com', pathname: '/', search: '', href: 'https://chatgpt.com/c/test', assign() { throw Error('must not navigate on a fresh chat'); } },
    sessionStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); } },
    addEventListener() {}, setInterval() {}, setTimeout, Date: { now: () => clock }, HTMLTextAreaElement: function () {},
    DataTransfer: function () { this.items = { add() {} }; this.setData = () => {}; }, ClipboardEvent: function () {}, InputEvent: function () {}, Event: function () {}, File: function () {},
    atob: s => Buffer.from(s, 'base64').toString('binary'), Uint8Array, String, Number, Array, JSON, Math, Error, Object, Promise, RegExp, URL, URLSearchParams, BigInt, Map, Set, WeakSet, console, ...gm };
  vm.createContext(ctx);
  // Fake clock: sleep() advances time instantly so the 5s stability window passes quickly.
  const src = CORE.replace('const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));', 'const sleep = ms => new Promise(resolve => { globalThis.__advance(ms); setTimeout(resolve, 0); });');
  ctx.__advance = ms => { clock += ms; };
  vm.runInContext(src + '\n' + WORKER('runChatGPT') + '\nrunChatGPT();', ctx);
  assert.ok(gm.map.get('aps:ai-worker')?.ts, 'heartbeat written');

  // The worker only inserts the prompt; the user sends it, then the answer is read.
  gm.GM_setValue('aps:ai-request', { nonce: 'abc', kind: 'analysis', key: 'solana:' + ca, symbol: 'ROCKET', prompt: 'Please check ' + ca, autoSend: true, newChat: true, temporary: false, ts: clock });
  assert.ok(await until(() => gm.map.get('aps:ai-result')?.status === 'waiting'));
  assert.equal(composer.innerText, 'Please check ' + ca, 'prompt inserted');
  assert.equal(messages.filter(m => m.role === 'user').length, 0, 'never sends by itself, even if a request asks for it');
  sendBtn.click(); // the user presses Enter
  assert.ok(await until(() => ['done', 'error'].includes(gm.map.get('aps:ai-result')?.status)));
  const res = gm.map.get('aps:ai-result');
  assert.equal(res.status, 'done', res.error);
  assert.equal(res.json.verdict, 'risky'); assert.equal(res.kind, 'analysis'); assert.equal(res.url, 'https://chatgpt.com/c/test');

  const sent = messages.filter(m => m.role === 'user').length;
  gm.GM_setValue('aps:ai-request', { nonce: 'abc', kind: 'analysis', prompt: 'x', ts: clock });
  await wait(20); assert.equal(composer.innerText, 'Please check ' + ca, 'same request is never inserted twice');

  // No answer within 30 minutes is not an error: the job simply stays where it is.
  silent = true;
  gm.GM_setValue('aps:ai-request', { nonce: 'ghi', kind: 'analysis', key: 'solana:' + ca, prompt: 'Slow one', newChat: false, ts: clock });
  assert.ok(await until(() => gm.map.get('aps:ai-result')?.nonce === 'ghi' && gm.map.get('aps:ai-result')?.status === 'waiting'));
  sendBtn.click();
  await wait(60);
  assert.equal(gm.map.get('aps:ai-result').status, 'waiting', 'no error after the waiting window');
  assert.equal(messages.filter(m => m.role === 'user').length, sent + 1);
}

// ---- GMGN worker: answers a request with three same-origin fetches ----
async function gmgn() {
  const gm = gmStore(), calls = [];
  const bodies = {
    token_stat: { code: 0, data: { holder_count: 5668, top_bundler_trader_percentage: '0.3078', top_entrapment_trader_percentage: '0.3058', creator_created_count: 103 } },
    token_holder_stat: { code: 0, data: { smart_degen_count: 43, renowned_count: 44 } },
    token_fee_info: { code: 0, data: { security: { renounced_mint: true, burn_ratio: '1' } } },
  };
  const fetch = async path => { calls.push(path); const k = Object.keys(bodies).find(b => path.includes('/' + b + '/')); return { ok: true, status: 200, text: async () => JSON.stringify(bodies[k]) }; };
  const ctx = { fetch, location: { hostname: 'gmgn.ai', href: 'https://gmgn.ai/', search: '' }, sessionStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, setInterval() {}, setTimeout,
    URL, URLSearchParams, Number, Object, Array, Error, Math, Map, Date, BigInt, Set, WeakSet, Promise, RegExp, String, JSON, console, ...gm };
  vm.createContext(ctx);
  vm.runInContext(CORE + '\n' + WORKER('runGmgn') + '\nrunGmgn();', ctx);
  assert.ok(gm.map.get('aps:gmgn-worker')?.ts, 'GMGN heartbeat written');
  gm.GM_setValue('aps:gmgn-request', { nonce: 'g1', key: 'solana:' + ca, chain: 'sol', ca, ts: Date.now() });
  assert.ok(await until(() => gm.map.get('aps:gmgn-result')?.nonce === 'g1'));
  const r = gm.map.get('aps:gmgn-result');
  assert.equal(r.ok, true, r.error); assert.equal(r.key, 'solana:' + ca); assert.ok(Math.abs(r.data.bundlerPct - 30.78) < 1e-9); assert.equal(r.data.smartMoney, 43); assert.equal(r.data.burnPct, 100);
  assert.deepEqual(calls.sort(), ['/api/v1/mutil_window_token_info', `/api/v1/token_fee_distribution/sol/${ca}`, `/api/v1/token_fee_info/sol/${ca}`, `/api/v1/token_stat/sol/${ca}`, `/pf/api/v1/pump/callout/token?chain=sol&token=${ca}`, `/vas/api/v1/token_holder_stat/sol/${ca}`]);
  // Invalid requests are ignored (wrong chain slug / bad address)
  gm.GM_setValue('aps:gmgn-request', { nonce: 'g2', key: 'k', chain: 'evil', ca, ts: Date.now() });
  gm.GM_setValue('aps:gmgn-request', { nonce: 'g3', key: 'k', chain: 'sol', ca: '../../steal', ts: Date.now() });
  await wait(20); assert.equal(gm.map.get('aps:gmgn-result').nonce, 'g1', 'invalid requests ignored');
}

(async () => {
  await chatgpt(); await gmgn();
  console.log('PASS workers: ChatGPT auto-send + semi-automatic flow, no double send; GMGN same-origin fetch, input validation');
})().catch(e => { console.error(e); process.exitCode = 1; });
