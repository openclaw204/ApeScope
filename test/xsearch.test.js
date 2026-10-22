'use strict';
// X search without a tab: x.com's GraphQL SearchTimeline from background.js (mocked x.com), and the panel turning
// the results into the same events the X tab worker stores.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { backgroundBody } = require('../scripts/build');
const { loadPanel, until } = require('./harness');

const BG = backgroundBody();
const ca = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

// ---- A fake x.com deploy: app shell, main bundle, ondemand chunk ----
const keyBytes = Array.from({ length: 48 }, (_, i) => (i * 37 + 11) % 256);
const key = Buffer.from(keyBytes).toString('base64');
const row = i => Array.from({ length: 11 }, (_, j) => (i * 29 + j * 53 + 7) % 256).join(' ');
const pathD = 'M1 2 3 4 ' + Array.from({ length: 16 }, (_, i) => row(i)).join('C');
const svg = i => `<svg viewBox="0 0 24 24" id="loading-x-anim-${i}" aria-hidden="true"><g><path d="M18.244 2.25h3.308"></path><path d="${pathD}"></path></g></svg>`;
function shell(version) {
  return `<!DOCTYPE html><html><head><meta name="twitter-site-verification" content="${key}" />` +
    `<link rel="preload" href="https://abs.twimg.com/responsive-web/client-web/main.${version}a.js" as="script"/></head><body>` +
    [0, 1, 2, 3].map(svg).join('') +
    `<script>window.__INITIAL_STATE__={"featureSwitch":{"defaultConfig":{"feat_on":{"value":true},"feat_off":{"value":false}}}};` +
    `(e=>({59707:"ondemand.countries-ro",59924:"ondemand.s",60041:"i18n/emoji-gu"}[e]||e)+"."+({59707:"aaaa1111bbbb2222",59924:"81a348d6aed80cad",60041:"cccc3333dddd4444"})[e]+"a.js")</script></body></html>`;
}
const mainJs = qid => `e.exports={queryId:"Other123",operationName:"UserByScreenName",operationType:"query",metadata:{featureSwitches:[],fieldToggles:[]}};` +
  `e.exports={queryId:"${qid}",operationName:"SearchTimeline",operationType:"query",metadata:{featureSwitches:["feat_on","feat_off","feat_unknown"],fieldToggles:["withArticleRichContentState"]}}`;
const ondemand = 'function f(n){return [parseInt(n[31],16),parseInt(n[38],16),parseInt(n[20], 16),parseInt(n[32],16)]}';

// ---- SearchTimeline answer: plain tweet, visibility wrapper, module item, long post with t.co link, cursors ----
const user = (h, legacyOnly) => ({ result: legacyOnly ? { legacy: { screen_name: h } } : { core: { screen_name: h }, legacy: {} } });
const tweet = (id, h, text, created, extra = {}) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: user(h, id === '103') }, legacy: { id_str: id, full_text: text, created_at: created, entities: { urls: [] } }, ...extra });
const entry = result => ({ entryId: 'tweet-' + Math.random(), content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } } });
const timeline = {
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [
      entry(tweet('101', 'alice', `aping ${ca} now`, 'Sun Oct 18 09:15:00 +0000 2026')),
      entry({ __typename: 'TweetWithVisibilityResults', tweet: tweet('102', 'bob', `CA: ${ca}`, 'Sun Oct 18 09:10:00 +0000 2026') }),
      { entryId: 'module-1', content: { entryType: 'TimelineTimelineModule', items: [{ item: { itemContent: { tweet_results: { result: tweet('103', 'carol', 'chart https://t.co/abc', 'Sun Oct 18 09:05:00 +0000 2026', {
        legacy: { id_str: '103', full_text: 'chart https://t.co/abc', created_at: 'Sun Oct 18 09:05:00 +0000 2026', entities: { urls: [{ url: 'https://t.co/abc', expanded_url: `https://dexscreener.com/solana/${ca}` }] } } }) } } } }] } },
      entry(tweet('104', 'dave', 'no address in here', 'Sun Oct 18 09:00:00 +0000 2026')),
      entry(tweet('105', 'eve', `${ca} `, 'not a date')),
      entry(tweet('101', 'alice', `duplicate ${ca}`, 'Sun Oct 18 09:15:00 +0000 2026')),
      { entryId: 'cursor-top', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Top', value: 'TOP' } },
      { entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'BOTTOM-1' } }] },
    { type: 'TimelineReplaceEntry', entry: { content: { cursorType: 'Bottom', value: 'BOTTOM-2' } } }] } } } },
};

/** background.js in a vm with a scripted fetch and cookie store. */
function background({ ct0 = 'csrf123', cookies = true, answer }) {
  const listeners = [], calls = [], session = {};
  const state = { version: 'v1', qid: 'Qid111' };
  const api = { runtime: { id: 'ext', onMessage: { addListener: cb => listeners.push(cb) } }, action: { onClicked: { addListener() {} } },
    storage: { session: { get: async k => ({ [k]: session[k] }), set: async v => Object.assign(session, v) } },
    ...(cookies ? { cookies: { get: async ({ url, name }) => (url.startsWith('https://x.com') && name === 'ct0' && ct0 ? { name, value: ct0 } : null) } } : {}) };
  const respond = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => body });
  const fetch = async (url, o = {}) => {
    calls.push({ url, o });
    if (url === 'https://x.com/i/jf/') return respond(200, shell(state.version));
    if (url.startsWith('https://abs.twimg.com/responsive-web/client-web/main.')) return respond(200, mainJs(url.includes(state.version) ? state.qid : 'Stale'));
    if (url === 'https://abs.twimg.com/responsive-web/client-web/ondemand.s.81a348d6aed80cada.js') return respond(200, ondemand);
    if (url.startsWith('https://x.com/i/api/graphql/')) { const [status, body, headers] = answer(url, o); return respond(status, JSON.stringify(body), headers); }
    return respond(404, '');
  };
  const ctx = { chrome: api, console, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Promise, String, Number, Math, JSON, Array, Object, Date, RegExp, Error, Map, Uint8Array, TextEncoder,
    crypto: globalThis.crypto, atob, btoa, fetch };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(BG, ctx);
  const ask = msg => new Promise(r => listeners[0](msg, { id: 'ext' }, v => r(JSON.parse(JSON.stringify(v)))));   // plain objects (vm realm)
  return { ctx, ask, calls, state, session, x: vm.runInContext('xState', ctx) };
}
const searches = calls => calls.filter(c => c.url.startsWith('https://x.com/i/api/graphql/'));

(async () => {
  // ---- Parsing x.com's files ----
  {
    const { ctx } = background({ answer: () => [200, {}] });
    const parsed = vm.runInContext('xParseShell', ctx)(shell('v1'));
    assert.equal(parsed.main, 'https://abs.twimg.com/responsive-web/client-web/main.v1a.js');
    assert.equal(parsed.ondemand, 'https://abs.twimg.com/responsive-web/client-web/ondemand.s.81a348d6aed80cada.js', 'chunk id → hash from the webpack runtime');
    assert.equal(parsed.key, key); assert.equal(parsed.frames.length, 4); assert.equal(parsed.frames[2], pathD, 'second path of each loading frame');
    assert.equal(vm.runInContext('xParseShell', ctx)('<script>{"ondemand.s":"0123456789abcdef"}</script>').ondemand, 'https://abs.twimg.com/responsive-web/client-web/ondemand.s.0123456789abcdefa.js', 'older runtime layout');
    const op = vm.runInContext('xParseMain', ctx)(mainJs('Qid111'));
    assert.equal(op.queryId, 'Qid111', 'SearchTimeline, not the first operation'); assert.deepEqual([...op.featureNames], ['feat_on', 'feat_off', 'feat_unknown']);
    assert.equal(vm.runInContext('xParseMain', ctx)('nothing here'), null);
    assert.deepEqual({ ...vm.runInContext('xFeatures', ctx)(op.featureNames, shell('v1')) }, { feat_on: true, feat_off: false, feat_unknown: false }, 'defaults from the shell, unknown → false');
    assert.equal(vm.runInContext('xTime', ctx)('Sun Oct 18 09:15:00 +0000 2026'), Date.UTC(2026, 9, 18, 9, 15, 0)); assert.equal(vm.runInContext('xTime', ctx)('2026-10-18'), null);
    assert.equal(vm.runInContext('xFloatToHex', ctx)(255), 'FF'); assert.equal(vm.runInContext('xFloatToHex', ctx)(0.5), '.8'); assert.equal(vm.runInContext('xFloatToHex', ctx)(0), '');
    assert.ok(Math.abs(vm.runInContext('xCubic', ctx)([0, 0, 1, 1], 0.5) - 0.5) < 1e-4, 'symmetric easing curve');

    // Transaction id: random byte, then (key bytes, time, sha256 prefix, 3) XOR random — checked independently here.
    const client = await vm.runInContext('xLoadClient()', ctx);
    assert.equal(client.queryId, 'Qid111'); assert.deepEqual([...client.keyBytes], keyBytes); assert.match(client.animationKey, /^[0-9a-f]+$/);
    assert.deepEqual({ ...client.fieldToggles }, { withArticleRichContentState: false });
    ctx.__c = client;
    const nowMs = Date.UTC(2026, 9, 18, 10, 0, 0), path = '/i/api/graphql/Qid111/SearchTimeline';
    const tid = await vm.runInContext(`xTransactionId(__c, 'GET', ${JSON.stringify(path)}, ${nowMs}, 77)`, ctx);
    assert.ok(!tid.includes('='), 'no base64 padding');
    const raw = [...Buffer.from(tid, 'base64')], r = raw[0], plain = raw.slice(1).map(b => b ^ r);
    assert.equal(r, 77); assert.equal(raw.length, 1 + 48 + 4 + 16 + 1);
    const t = Math.floor((nowMs - 1682924400 * 1000) / 1000);
    assert.deepEqual(plain.slice(0, 48), keyBytes); assert.equal(plain[48] | plain[49] << 8 | plain[50] << 16 | plain[51] << 24, t);
    const hash = [...crypto.createHash('sha256').update(`GET!${path}!${t}obfiowerehiring${client.animationKey}`).digest()].slice(0, 16);
    assert.deepEqual(plain.slice(52, 68), hash); assert.equal(plain[68], 3);
    assert.notEqual(await vm.runInContext(`xTransactionId(__c, 'GET', '/i/api/graphql/Qid111/Other', ${nowMs}, 77)`, ctx), tid, 'bound to the path');
  }

  // ---- A search: headers like x.com's web app, parsed tweets, pacing and cache ----
  {
    const b = background({ answer: () => [200, timeline, { 'x-rate-limit-remaining': '48', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) }] });
    const r = await b.ask({ type: 'aps-x-search', query: `"${ca}"` });
    assert.ok(r.ok, r.error);
    const [call] = searches(b.calls), u = new URL(call.url), h = call.o.headers;
    assert.equal(u.pathname, '/i/api/graphql/Qid111/SearchTimeline'); assert.equal(call.o.credentials, 'include', 'uses the X session');
    assert.deepEqual(JSON.parse(u.searchParams.get('variables')), { rawQuery: `"${ca}"`, count: 20, querySource: 'typed_query', product: 'Latest' });
    assert.deepEqual(JSON.parse(u.searchParams.get('features')), { feat_on: true, feat_off: false, feat_unknown: false });
    assert.match(h.authorization, /^Bearer AAAA/); assert.equal(h['x-csrf-token'], 'csrf123', 'ct0 echoed'); assert.equal(h['x-twitter-auth-type'], 'OAuth2Session');
    assert.ok(h['x-client-transaction-id']?.length > 80);
    assert.ok(b.calls.filter(c => !c.url.startsWith('https://x.com/i/api/')).every(c => c.o.credentials === 'omit'), 'x.com\'s files are fetched without cookies');
    assert.deepEqual(r.tweets.map(x => x.id), ['101', '102', '103', '104'], 'wrapper + module unpacked, duplicate and undated posts dropped');
    assert.equal(r.tweets[2].handle, 'carol', 'legacy screen_name still read');
    assert.equal(r.tweets[2].text, `chart https://dexscreener.com/solana/${ca}`, 't.co links expanded (the CA is often only in a link)');
    assert.equal(r.tweets[0].createdAt, Date.UTC(2026, 9, 18, 9, 15)); assert.equal(r.cursor, 'BOTTOM-2'); assert.equal(r.rate.remaining, 48);
    assert.ok(b.session['aps:x-client']?.queryId, 'client cached for the browser session (service worker restarts)');

    assert.deepEqual(await b.ask({ type: 'aps-x-search', query: `"${ca}"` }), r, 'same query within 25 s → cached answer');
    const busy = await b.ask({ type: 'aps-x-search', query: '"other"' });
    assert.equal(busy.code, 'busy', 'one X call per 15 s across all tabs'); assert.ok(busy.retryAt > Date.now());
    assert.equal(searches(b.calls).length, 1);
    assert.equal((await b.ask({ type: 'aps-x-search', query: '  ' })).code, 'input');
  }

  // ---- New X deploy: 404 → reload query id / key once, then search again ----
  {
    let n = 0;
    const b = background({ answer: () => (++n === 1 ? [404, {}] : [200, timeline]) });
    assert.ok((await b.ask({ type: 'aps-x-search', query: 'x' })).ok, '404 → reload → 200');
    assert.equal(n, 2); assert.equal(b.calls.filter(c => c.url === 'https://x.com/i/jf/').length, 2, 'app shell reloaded after a 404');
    const b2 = background({ answer: () => [404, {}] });
    const out = await b2.ask({ type: 'aps-x-search', query: 'x' });
    assert.equal(out.code, 'outdated', 'still 404 after the reload → outdated (panel falls back to the tab)');
    assert.equal(searches(b2.calls).length, 2);
  }

  // ---- Rate limit, login, permissions ----
  {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const b = background({ answer: () => [429, {}, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(reset) }] });
    const r = await b.ask({ type: 'aps-x-search', query: 'x' });
    assert.equal(r.code, 'rate'); assert.equal(r.retryAt, reset * 1000);
    b.x.lastCall = 0;
    assert.equal((await b.ask({ type: 'aps-x-search', query: 'y' })).code, 'rate', 'no calls until X\'s reset time');
    assert.equal(searches(b.calls).length, 1);

    const low = background({ answer: () => [200, timeline, { 'x-rate-limit-remaining': '1', 'x-rate-limit-reset': String(reset) }] });
    assert.ok((await low.ask({ type: 'aps-x-search', query: 'x' })).ok); low.x.lastCall = 0;
    assert.equal((await low.ask({ type: 'aps-x-search', query: 'z' })).code, 'rate', 'last search of the window is left to the user');

    assert.equal((await background({ answer: () => [401, {}] }).ask({ type: 'aps-x-search', query: 'x' })).code, 'login');
    const loggedOut = background({ ct0: '', answer: () => [200, timeline] });
    assert.equal((await loggedOut.ask({ type: 'aps-x-search', query: 'x' })).code, 'login'); assert.equal(loggedOut.calls.length, 0, 'nothing sent without an X login');
    assert.equal((await background({ cookies: false, answer: () => [200, timeline] }).ask({ type: 'aps-x-search', query: 'x' })).code, 'unsupported');
    const errs = await background({ answer: () => [200, { errors: [{ message: 'Query: Unspecified' }] }] }).ask({ type: 'aps-x-search', query: 'x' });
    assert.equal(errs.code, 'outdated'); assert.match(errs.error, /Unspecified/);
  }

  // ---- Panel: results become the X tab worker's events; failures fall back to the tab ----
  {
    const exposed = ['s', 'prefs', 'xApi', 'xEventsFrom', 'pollXApi', 'autoSearchX', 'renderSettings', 'renderSocials'];
    const { ctx, T, store } = loadPanel({ exposed });
    const tweets = [
      { id: '101', handle: 'alice', text: `aping ${ca} now`, createdAt: Date.now() - 60000 },
      { id: '104', handle: 'dave', text: 'no address in here', createdAt: Date.now() - 60000 },
      { id: '106', handle: 'bad handle!', text: ca, createdAt: Date.now() },
      { id: '107', handle: 'frank', text: ca, createdAt: null }];
    const ev = JSON.parse(JSON.stringify(T.xEventsFrom(tweets, ca, 'solana')));
    assert.equal(ev.length, 1, 'CA required, valid handle, real timestamp');
    // Same shape as runX: { source, chain, ca, timestamp (s), author, text, url, id }
    assert.deepEqual(Object.keys(ev[0]).sort(), ['author', 'ca', 'chain', 'id', 'source', 'text', 'timestamp', 'url']);
    assert.deepEqual({ ...ev[0], timestamp: 0 }, { source: 'x', chain: 'solana', ca, timestamp: 0, author: '@alice', text: `aping ${ca} now`, url: 'https://x.com/alice/status/101', id: 'x:101' });
    assert.equal(ev[0].timestamp, Math.floor((Date.now() - 60000) / 1000));
    assert.equal(T.xEventsFrom([{ id: '9', handle: 'a', text: 'CA 0xABCDEF0123456789ABCDEF0123456789ABCDEF01', createdAt: Date.now() }], '0xabcdef0123456789abcdef0123456789abcdef01', 'base').length, 1, 'EVM: case-insensitive like runX');

    const asked = [], opened = [];
    let answer = { ok: true, tweets, cursor: 'C1', rate: { remaining: 47, reset: 0 } };
    ctx.GM_openInTab = url => opened.push(url);
    T.s.coin = { ca, chain: 'solana' }; T.prefs.autoX = true;
    await T.pollXApi(); assert.equal(asked.length, 0, 'off by default');
    ctx.APS_xSearch = async q => { asked.push(q); return answer; };
    T.prefs.xApi = true;
    T.autoSearchX(); assert.equal(opened.length, 0, 'no X tab while searching without one');
    await T.pollXApi();
    assert.deepEqual({ ...asked[0] }, { query: `"${ca}"`, cursor: '' });
    const stored = store.map.get('aps:x:solana:' + ca);
    assert.equal(stored.length, 1); assert.equal(stored[0].id, 'x:101');
    assert.equal(store.map.get('aps:x-health').via, 'api'); assert.match(store.map.get('aps:x-health').detail, /47 searches left/);
    T.xApi.next = 0; await T.pollXApi();
    assert.deepEqual({ ...asked[1] }, { query: `"${ca}"`, cursor: 'C1' }, 'second call of a new token reads one older page');
    T.xApi.next = 0; await T.pollXApi();
    assert.equal(asked[2].cursor, '', 'then only the newest posts');
    assert.ok(T.xApi.next - Date.now() >= 29000, 'polls at most every 30 s');

    answer = { ok: false, code: 'rate', retryAt: Date.now() + 600000 };
    T.xApi.next = 0; await T.pollXApi();
    assert.match(store.map.get('aps:x-error'), /rate limit/); assert.ok(T.xApi.next >= answer.retryAt); assert.equal(opened.length, 0, 'rate limit: wait, do not open a tab');

    answer = { ok: false, code: 'login', error: 'not logged in on x.com in this browser' };
    T.xApi.next = 0; await T.pollXApi();
    assert.match(store.map.get('aps:x-error'), /using the X tab instead/);
    assert.equal(opened.length, 1, 'falls back to the X tab worker'); assert.match(opened[0], /x\.com\/search\?q=.*apescope_worker=1/);
    T.xApi.next = 0; await T.pollXApi(); assert.equal(asked.length, 5, 'no more API calls for this token after the fallback');
    const { fakeNode, allText } = require('./harness');
    const box = fakeNode('div'); T.renderSettings(box);
    assert.match(allText(box), /Search X without a tab — uses your X login/); assert.match(allText(box), /50 searches per 15 minutes/);
    const soc = fakeNode('div'); T.renderSocials(soc); assert.match(allText(soc), /X search without a tab failed/);
  }
  console.log('PASS xsearch: x.com files parsed, transaction id, SearchTimeline headers/parsing, pacing, 404 reload, rate limit, login, panel events + tab fallback');
})().catch(e => { console.error(e); process.exit(1); });
