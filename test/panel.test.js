'use strict';
const assert = require('node:assert/strict');
const { loadPanel, fakeNode, allText, wait, until } = require('./harness');

const ca = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', evm = '0xabcdef0123456789abcdef0123456789abcdef01', other = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const json = v => ({ status: 200, responseText: JSON.stringify(v), responseHeaders: '' });
const routes = [
  [/geckoterminal\.com\/api\/v2\/networks\/solana\/tokens\/.+\/info/, () => ({ data: { attributes: { name: 'Dogwif Rocket', symbol: 'ROCKET', description: 'Code: https://github.com/rocketdev/rocket-app', websites: ['https://rocket.example'], twitter_handle: 'RocketCoin/status/123', telegram_handle: 'rocketchat', gt_score: 41.2, holders: { count: 812, distribution_percentage: { top_10: '31.5' } } } } })],
  [/lite-api\.jup\.ag/, () => [{ id: ca, name: 'Dogwif Rocket', symbol: 'ROCKET', organicScore: 22.4, organicScoreLabel: 'low', isVerified: false, holderCount: 801, dev: other, launchpad: 'pump.fun', twitter: 'https://twitter.com/rocketcoin',
    audit: { devMigrations: 7, devMints: 2713, topHoldersPercentage: 28, isSus: true, mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, stats5m: { holderChange: -0.5, buyVolume: 100, sellVolume: 300, numBuys: 3, numSells: 9 }, stats24h: { holderChange: 40, buyVolume: 50000, sellVolume: 30000 }, stats1h: { holderChange: 4.2, numTraders: 120, numOrganicBuyers: 14, buyVolume: 9000, sellVolume: 12000, buyOrganicVolume: 800 } }]],
  [/api\.github\.com\/repos\/rocketdev\/rocket-app\/commits\?per_page=1/, () => ({ ...json([{}]), responseHeaders: 'link: <https://api.github.com/x?per_page=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&page=37>; rel="last"\r\n' })],
  [/api\.github\.com\/repos\/rocketdev\/rocket-app\/commits\?per_page=5/, () => [{ commit: { author: { date: '2026-10-10T10:00:00Z', name: 'x' }, message: 'add swap ui\n\nmore' }, author: { login: 'rdev' } }]],
  [/api\.github\.com\/repos\/rocketdev\/rocket-app\/contributors/, () => [{}]],
  [/api\.github\.com\/repos\/rocketdev\/rocket-app$/, () => ({ full_name: 'rocketdev/rocket-app', created_at: '2026-10-01T00:00:00Z', pushed_at: '2026-10-12T00:00:00Z', stargazers_count: 3, forks_count: 0, fork: false, language: 'TypeScript', size: 420 })],
  [/dexscreener\.com\/latest\/dex\/search/, () => ({ pairs: [
    { chainId: 'base', baseToken: { address: '0x' + '7'.repeat(40), name: 'Rocket', symbol: 'ROCKET' }, liquidity: { usd: 5000 }, marketCap: 90000, pairCreatedAt: Date.now() - 2 * 3600e3, url: 'https://dexscreener.com/base/x', pairAddress: '0x' + '8'.repeat(40) },
    { chainId: 'solana', baseToken: { address: other, name: 'Dogwif Rockets', symbol: 'ROCKETS' }, liquidity: { usd: 80000 }, marketCap: 2e6, pairCreatedAt: Date.now() - 40 * 86400e3, url: 'https://dexscreener.com/solana/y' },
    { chainId: 'solana', baseToken: { address: ca, name: 'Dogwif Rocket', symbol: 'ROCKET' }, liquidity: { usd: 1 }, marketCap: 1 },
    { chainId: 'solana', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' }, liquidity: { usd: 9e9 } }] })],
  [/latest\/dex\/tokens\//, () => ({ pairs: [
    { chainId: 'base', baseToken: { address: evm }, liquidity: { usd: 5000 } }, { chainId: 'arbitrum', baseToken: { address: evm }, liquidity: { usd: 40000 } },
    { chainId: 'unknownchain', baseToken: { address: evm }, liquidity: { usd: 9e9 } }] })],
  [/api\.rugcheck\.xyz/, () => ({ score_normalised: 12, lpLockedPct: 99.5, risks: [{ name: 'Low Liquidity', level: 'danger', value: '$1k' }] })],
  [/rdap\.org\/domain\/rocket\.example/, () => ({ events: [{ eventAction: 'registration', eventDate: new Date(Date.now() - 3 * 86400e3).toISOString() }, { eventAction: 'expiration', eventDate: '2027-10-01T00:00:00Z' }],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Namecheap']]] }] })],
  [/^https:\/\/rocket\.example\//, () => ({ status: 200, finalUrl: 'https://rocket.example/', responseText: '<html><head><title>Rocket &amp; Co</title><meta name="description" content="To the moon"><meta name="generator" content="Framer"></head><body>CA: ' + ca + ' <a href="https://x.com/rocketcoin">x</a></body></html>' })],
  [/api\.fxtwitter\.com\/rocketcoin/, () => ({ code: 200, user: { screen_name: 'RocketCoin', name: 'Rocket', followers: 50, following: 10, tweets: 12, joined: new Date(Date.now() - 10 * 86400e3).toUTCString(), description: 'Rocket to the moon' } })],
  // Vibe Station answers like the official RPC, except getSlot (rate-limited) to exercise the fallback
  [/public\.rpc\.solanavibestation\.com/, o => JSON.parse(o.data).method === 'getSlot' ? { status: 429, responseText: '', responseHeaders: '' } : ({ jsonrpc: '2.0', id: 1, result: rpc(JSON.parse(o.data)) })],
  [/api\.geckoterminal\.com\/api\/v2\/networks\/solana\/pools\/.*\/ohlcv\//, () => { const now = Math.floor(Date.now() / 60000) * 60; return { data: { attributes: { ohlcv_list: Array.from({ length: 600 }, (_, i) => { const p = 0.0001 * (1 + Math.sin(i / 40) * 0.3 + i / 2000); return [now - (599 - i) * 60, p, p * 1.02, p * 0.98, p * 1.005, 500 + (i % 7) * 100]; }) } } }; }],
  // single-page website: CA only in a JSON API named in a lazily imported chunk
  [/^https:\/\/spa\.example\/assets\/main\.js/, () => ({ status: 200, responseText: 'import("./chunk-a.js");const x="/api/user/me";', responseHeaders: '' })],
  [/^https:\/\/spa\.example\/assets\/chunk-a\.js/, () => ({ status: 200, responseText: 'fetch("/api/bubbles/directory")', responseHeaders: '' })],
  [/^https:\/\/spa\.example\/api\/bubbles\/directory/, () => ({ status: 200, responseText: JSON.stringify({ items: [{ address: ca }, { address: 'H7oXa1kPwVvB5n6Wq3Gm3pLzBmQe1yVxR4a9f3wGpump' }] }), responseHeaders: '' })],
  [/frontend-api-v3\.pump\.fun\/coins-v3\//, () => ({ mint: ca, creator: W.B, bonding_curve: CURVE, pool_address: 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', complete: true, ath_market_cap: 106000 })],
  [/frontend-api-v3\.pump\.fun\/mint-positions\//, () => ({ positions: [
    { userName: 'DontFadeFelix', xUsername: 'felix', amountHeld: 5, pnlUsd: 354, callout: { calloutId: 'c1', calledOutAtMcap: 39949, multiple: 0.83, maxMultiplier: 2.6, thesis: 'Cracked dev, see https://x.com/dev/status/1 now', calloutTimestamp: new Date(Date.now() - 3600e3).toISOString(), likes: 4, viewCount: 1200 } },
    { userName: 'nocall', amountHeld: 1 }], totalCount: 2 })],
  [/frontend-api-v3\.pump\.fun\/users\/batch/, o => JSON.parse(o.data).addresses.map(a => ({ address: a, username: a === W.A ? 'DontFadeFelix' : 'bigcaller', followers: a === W.A ? 31 : 4000, x_username: a === W.A ? null : 'bigx' }))],
  [/api\.fxtwitter\.com\/bigx/, () => ({ code: 200, user: { screen_name: 'bigx', name: 'Big', followers: 25000, following: 1, tweets: 10, joined: new Date(Date.now() - 900 * 86400e3).toUTCString() } })],
  [/fun-block\.pump\.fun\/sharing-config\//, () => ({ address: CFG, admin: W.B, mint: ca, adminRevoked: true, shareholders: [{ address: SH, shareBps: 10000, kind: 'social', social: { platform: 'GitHub', username: 'ghuntley' } }] })],
  [/raw\.githubusercontent\.com/, () => ({ status: 404, responseText: '', responseHeaders: '' })],
  [/api\.mainnet-beta\.solana\.com/, o => ({ jsonrpc: '2.0', id: 1, result: rpc(JSON.parse(o.data)) })],
  [/my\.rpc\.example/, () => ({ jsonrpc: '2.0', id: 1, result: 222 })],
  [/api\.gopluslabs\.io\/api\/v1\/solana/, () => ({ code: 1, result: { [ca]: { holder_count: '12', holders: [{ address: ca, percent: '0.5' }] } } })],
];
// Solana RPC mock: 3 holder wallets + 1 pool; wallets A and B were funded by the same wallet F.
const W = { A: 'GGAYfbQZykqBDVJZWpfxRxX8PS6inqQUmyyXEWe2xSuB', B: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', C: '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', F: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', POOL: 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ' };
const SYS = '11111111111111111111111111111111';
// pump.fun: bonding curve (off-curve PDA) whose creator field points to a fee-sharing config; SH receives the fees
const CURVE = '9RrW8GpuEeENSBkrmSCRXWxESM2ZyxsNWQk1UtHWpgnx', CFG = '7LSECZujvo5qR4DkUL3coQHMBr8ZW4KEqtkktFdp3qcj', SH = '6J75NLePVriqbDNPJ5HKE3tZzGS2Ktfb8WdpxZJRcfhp';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58bytes = str => { let n = 0n; for (const ch of str) n = n * 58n + BigInt(B58.indexOf(ch)); const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } while (out.length < 32) out.unshift(0); return Buffer.from(out); };
function rpc({ method, params }) {
  if (method === 'getSlot') return 111;
  if (method === 'getTokenSupply') return { value: { uiAmount: 1000 } };
  if (method === 'getTokenLargestAccounts') return { value: ['a1', 'a2', 'a3', 'a4'].map((a, i) => ({ address: a, uiAmountString: String([300, 80, 60, 40][i]) })) };
  if (method === 'getMultipleAccounts' && params[1]?.encoding === 'jsonParsed') return { value: params[0].map(a => ({ data: { parsed: { info: { owner: { a1: W.POOL, a2: W.A, a3: W.B, a4: W.C }[a] } } } })) };
  if (method === 'getMultipleAccounts') return { value: params[0].map(o => ({ owner: o === W.POOL ? 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' : SYS })) };
  if (method === 'getAccountInfo' && params[1]?.encoding === 'jsonParsed') return { value: { data: { parsed: { info: { owner: { a1: W.POOL, a2: W.A, a3: W.B, a4: W.C }[params[0]] } } } } };
  if (method === 'getAccountInfo' && params[0] === CURVE) { const b = Buffer.alloc(150); b58bytes(CFG).copy(b, 49); return { value: { data: [b.toString('base64'), 'base64'] } }; }
  if (method === 'getSignaturesForAddress' && params[0] === SH) return [{ signature: 'claim1', blockTime: Math.floor(Date.now() / 1000) - 7200 }, { signature: 'dist1', blockTime: Math.floor(Date.now() / 1000) - 9000 }];
  if (method === 'getTransaction' && params[0] === 'claim1') return { transaction: { message: { accountKeys: [{ pubkey: 'x' }, { pubkey: SH }] } }, meta: { preBalances: [0, 12.9e9], postBalances: [0, 0.0015e9], logMessages: ['Program log: Instruction: ClaimSocialFeePda'] } };
  if (method === 'getTransaction' && params[0] === 'dist1') return { transaction: { message: { accountKeys: [{ pubkey: SH }] } }, meta: { preBalances: [0.0015e9], postBalances: [12.9e9], logMessages: ['Program log: Instruction: DistributeCreatorFees'] } };
  if (method === 'getSignaturesForAddress') return [{ signature: 'sig-' + params[0], blockTime: Math.floor(Date.now() / 1000) - (params[0] === W.A ? 3600 : 30 * 86400) }];
  if (method === 'getTransaction') { const o = params[0].slice(4); return { transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: o === W.C ? W.POOL : W.F, destination: o } } }] } }, meta: {} }; }
  return { value: [] };
}
const exposed = ['s', 'prefs', 'CHAINS', 'tokenKey', 'pct', 'flagsFromToken', 'normalizeSecurity', 'bestPair', 'marketFromPair', 'applyOrders', 'normalizeRugcheck', 'autoDetectChain', 'requestJson',
  'normalizeGtInfo', 'normalizeJup', 'refreshProject', 'refreshGithub', 'refreshSimilar', 'projectLinks', 'quickLinks', 'buildChecks', 'countChecks', 'buildPrompt', 'onAiResult', 'onGmgnResult', 'refreshGmgn',
  'validEvent', 'buildTradePrompt', 'normalizeGmgnCallouts', 'pumpCallers', 'deepCaScan', 'LIVE', 'isOnCurve', 'top10Pct', 'refreshPump', 'caPresence', 'otherContracts', 'textWithLinks', 'backgroundWatches', 'flowWindows', 'refreshClusters', 'parseFomoResponse', 'onFomoFeed', 'fomoCallers', 'pushCss', 'fitZoomFor', 'solRPC', 'registrableDomain', 'analyzePage', 'renderOverview', 'renderProject', 'renderSocials', 'renderAi', 'renderWatchlist', 'renderSettings', 'setPush', 'selectCoin',
  'pushStyleText: () => pushStyle?.textContent', 'aiPrefsRef: () => aiPrefs'];
const { T, store, log } = loadPanel({ routes, exposed });
T.LIVE.rpcGap = 0; T.LIVE.rpcRetry = 0;   // no RPC pacing in tests

(async () => {
  // Chains, keys, GoPlus
  for (const c of ['arbitrum', 'polygon', 'avalanche', 'sonic', 'abstract', 'berachain', 'monad', 'robinhood']) assert.ok(T.CHAINS[c]?.dex, 'chain ' + c);
  assert.equal(T.tokenKey('ethereum', evm.toUpperCase().replace(/^0X/, '0x')), 'ethereum:' + evm);
  assert.equal(T.pct('0.5'), 50); assert.equal(T.pct(null), null);
  const risks = T.flagsFromToken({ is_honeypot: '1', is_proxy: '1', holders: [{ percent: '0.85' }] }, 'bsc');
  assert.ok(risks.some(x => x.title === 'Honeypot')); assert.ok(risks.some(x => x.title === 'Top-10 concentration'));
  const sec = T.normalizeSecurity({ code: 1, result: { [evm]: { holder_count: '5', creator_percent: '0.031', holders: [], lp_holders: [
    { address: '0x000000000000000000000000000000000000dead', percent: '0.6', is_locked: 0 }, { address: '0x' + '5'.repeat(40), percent: '0.3', is_locked: 1 },
    { address: '0xdeadbeef00000000000000000000000000000001', percent: '0.1', is_locked: 0 }] } } }, evm, 'bsc');
  assert.equal(sec.creatorPct, 3.1); assert.ok(Math.abs(sec.lpLockedPct - 90) < 1e-9, 'burn + locked, not a random address containing "dead"');

  // DexScreener market + orders
  const pair = side => ({ chainId: 'bsc', dexId: 'pancakeswap', pairAddress: evm, baseToken: { address: side === 'base' ? evm : '0x' + '1'.repeat(40), symbol: 'T', name: 'Token' }, quoteToken: { address: side === 'quote' ? evm : '0x' + '2'.repeat(40) },
    liquidity: { usd: 20000 }, marketCap: 1000000, volume: { m5: 200, h1: 1200 }, txns: { m5: { buys: 30, sells: 20 } }, info: { socials: [{ type: 'twitter', url: 'https://x.com/t' }] } });
  const m = T.marketFromPair(pair('base'), evm, 'bsc');
  assert.equal(m.marketCap, 1000000); assert.equal(m.liqMcapPct, 2); assert.equal(m.volVelocity, 2); assert.equal(m.avgTrade5m, 4); assert.equal(m.suspectedBumpBot, true); assert.equal(m.name, 'Token');
  assert.equal(T.marketFromPair(pair('quote'), evm, 'bsc').marketCap, null, 'never label the base token MC as the quote token MC');
  assert.equal(T.bestPair([pair('base')], evm, 'bsc').dexId, 'pancakeswap');
  assert.equal(T.applyOrders({ ...m }, null).dexPaid, null, 'failed orders request stays unknown');
  assert.equal(T.applyOrders({ ...m }, { orders: [], boosts: [] }).dexPaid, false, 'real Oct 2026 shape');
  const paid = T.applyOrders({ ...m }, [{ type: 'tokenProfile', status: 'approved' }, { type: 'communityTakeover', status: 'approved' }]);
  assert.equal(paid.dexPaid, true); assert.equal(paid.ctoActive, true);
  assert.equal(T.normalizeRugcheck({ score_normalised: 7, lpLockedPct: 100, risks: [{ name: 'Mutable metadata', level: 'warn' }] }, 'k').risks[0].level, 'warn');
  assert.equal(T.validEvent({ id: 'x:22', ca: evm, author: 'tester', source: 'x', timestamp: Math.floor(Date.now() / 1000) }), true);

  // Network allow-list + EVM auto chain
  assert.equal((await T.requestJson('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report/summary')).lpLockedPct, 99.5);
  await assert.rejects(T.requestJson('https://evil.example.com/x'), /Host not allowed/);
  const look = T.autoDetectChain(evm); assert.equal(look.pending, true); assert.equal(T.autoDetectChain(evm), look, 'one lookup per address');
  await until(() => !look.pending); assert.equal(look.chain, 'arbitrum', 'highest summed liquidity among supported chains');

  // Project sources, links, GitHub, look-alikes
  const s = T.s;
  T.selectCoin({ ca, chain: 'solana' }, true);
  s.market = T.marketFromPair({ chainId: 'solana', dexId: 'pumpswap', pairAddress: 'Pair1111111111111111111111111111111111111111', url: 'https://dexscreener.com/solana/pair', baseToken: { address: ca, symbol: 'ROCKET', name: 'Dogwif Rocket' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112' }, liquidity: { usd: 30000 }, marketCap: 250000, priceUsd: 0.00025, volume: { m5: 4000, h1: 20000 }, txns: { m5: { buys: 40, sells: 30 } },
    pairCreatedAt: Date.now() - 3 * 3600e3, info: { socials: [{ type: 'twitter', url: 'https://x.com/rocketcoin' }, { type: 'twitter', url: 'https://x.com/i/communities/1900' }], websites: [{ url: 'https://rocket.example/' }] } }, ca, 'solana');
  const prompt = await T.buildPrompt(null, false, { project: true, chart: false });
  assert.equal(s.project.jup.devMints, 2713); assert.equal(s.project.jup.isSus, true);
  const links = T.projectLinks();
  assert.equal(links.filter(l => l.kind === 'X').length, 1, 'x.com/rocketcoin, twitter.com/rocketcoin and x.com/RocketCoin/status/123 are one account');
  assert.equal(links.filter(l => l.kind === 'X community').length, 1, 'X communities are kept');
  assert.equal(links.filter(l => l.kind === 'Website').length, 1, 'trailing slash de-duplicated');
  assert.ok(links.some(l => l.kind === 'GitHub' && l.src === 'description')); assert.ok(links.some(l => l.kind === 'Telegram'));
  assert.equal(s.github.items[0].commits, 37); assert.equal(s.github.items[0].recentCommits[0].msg, 'add swap ui');
  assert.equal(s.similar.list.length, 2, 'own token and unrelated SOL filtered'); assert.equal(s.similar.list[0].chain, 'base', 'newest first');
  const ql = T.quickLinks().map(q => q.label);
  for (const l of ['FOMO', 'Padre', 'DexScreener', 'GMGN', 'Bubblemaps', 'RugCheck', 'Search CA on X', 'Search $ROCKET on X']) assert.ok(ql.includes(l), l);
  assert.equal(T.quickLinks().find(q => q.label === 'Padre').url, 'https://trade.padre.gg/trade/solana/Pair1111111111111111111111111111111111111111', 'Padre uses the pool address');
  assert.ok(!T.quickLinks().find(q => q.label === 'Search CA on X').url.includes('apescope_worker'), 'user-facing X link has no worker flag');
  for (const needle of [ca, 'https://rocket.example', 'Commits 37'.toLowerCase(), 'tokens created by dev: 2713', 'suspicious (isSus): yes', '$ROCKET "Rocket"', '```json', '"verdict"', 'AUTOMATED CHECKS'])
    assert.ok(prompt.toLowerCase().includes(needle.toLowerCase()), 'project prompt contains ' + needle);
  assert.ok(!prompt.includes('"trade"'), 'project-only prompt has no trade schema');
  // Background RPC work (wallet clusters, spaced out by the RPC throttle) may still run here; only API sources count.
  const apiCalls = () => log.filter(u => !/rpc|solana/i.test(u)).length;
  const before = apiCalls(); await T.buildPrompt(null, false, { project: true, chart: false }); assert.equal(apiCalls(), before, 'sources are cached');

  // Combined prompt with chart: bars in price units are converted to market cap (supply = 1e9)
  const snap = { bars: Array.from({ length: 30 }, (_, i) => ({ t: 1.7e9 + i * 15, o: 0.0002, h: 0.0003, l: 0.0001, c: 0.00025, v: 10 })), image: 'data:image/jpeg;base64,AAAA' };
  const cp = await T.buildPrompt(snap, true, { project: true, chart: true });
  assert.ok(cp.includes('"verdict"') && cp.includes('"trade"'), 'one JSON schema with both parts');
  assert.ok(cp.includes('market cap USD (converted from price)')); assert.ok(cp.includes('screenshot attached')); assert.ok(cp.includes(',250000,'), 'close converted to MC');
  assert.ok(cp.includes('original resolution 15s'));
  const chartOnly = await T.buildPrompt(snap, false, { project: false, chart: true });
  assert.ok(!chartOnly.includes('"verdict"') && chartOnly.includes('"trade"') && !chartOnly.includes('=== GITHUB'));

  // GMGN client: request is written, answer from the worker is applied
  T.refreshGmgn(true);
  const req = store.map.get('aps:gmgn-request');
  assert.equal(req.chain, 'sol'); assert.equal(req.ca, ca);
  T.onGmgnResult({ nonce: req.nonce, key: req.key, ok: true, ts: Date.now(), data: { bundlerPct: 30.78, phishingPct: 2, insiderPct: 0, botPct: 54.9, devCreated: 103, smartMoney: 43, kols: 44, burnPct: 100, evil: 'x',
    extra: { dev: { address: other, status: 'creator_close', migrated: 26, fundedBy: 'not-an-address', xRenames: 2, xDeletedPosts: 0, xHistory: ['oldname'] }, imageDup: 6, feesPaid: 11.56, creatorFeePct: 0.3, launchpad: 'Pump.fun', bonding: 1,
      recipients: [{ wallet: other, sharePct: 100, xUser: 'Twenkkk', claimed: false, creator: true }, { wallet: 'evil', xUser: '<script>', sharePct: 'x' }] } } });
  assert.equal(s.gmgn.data.extra.dev.fundedBy, '', 'invalid addresses dropped'); assert.equal(s.gmgn.data.extra.recipients[1].wallet, ''); assert.equal(s.gmgn.data.extra.recipients[1].xUser, '', 'invalid X names dropped');
  assert.equal(s.gmgn.data.bundlerPct, 30.78); assert.equal(s.gmgn.data.evil, null, 'non-numeric values are dropped'); assert.equal(s.loading.gmgn, false);

  // Grouped checks
  s.sec = T.normalizeSecurity({ code: 1, result: { [ca]: { holder_count: '12', holders: [
    { account: 'Pair1111111111111111111111111111111111111111', token_account: 'EKVxV8213jGb85mSYhQeW42J1tkZhTi9BLBEFEduu7GL', percent: '0.40' },   // the pool: not a holder
    { account: 'D9gQ6RhKEpnobPBUdWY5bPQt2p3zGk3iVz6ChpUi2ArA', token_account: 'EKVxV8213jGb85mSYhQeW42J1tkZhTi9BLBEFEduu7GL', percent: '0.30' },
    { account: CURVE, token_account: 'EKVxV8213jGb85mSYhQeW42J1tkZhTi9BLBEFEduu7GL', percent: '0.25' },                                          // off-curve PDA
    { account: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', token_account: 'EKVxV8213jGb85mSYhQeW42J1tkZhTi9BLBEFEduu7GL', percent: '0.20' }] } } }, ca, 'solana'); s.secFlags = [];
  assert.ok(T.isOnCurve('GGAYfbQZykqBDVJZWpfxRxX8PS6inqQUmyyXEWe2xSuB') && !T.isOnCurve(CURVE) && !T.isOnCurve(SH), 'wallets on the curve, PDAs off');
  s.clusters = null;   // otherwise the cluster check's own holder list is used
  assert.ok(Math.abs(T.top10Pct() - 50) < 1e-9, 'top 10 without pool and bonding curve');
  s.rugcheck = T.normalizeRugcheck({ score_normalised: 5, lpLockedPct: 100, risks: [{ name: 'Low Liquidity', level: 'danger', value: '$1k' }] }, 'k');
  const checks = T.buildChecks(), by = lvl => checks.filter(c => c.level === lvl).map(c => c.label);
  assert.ok(by('bad').includes('Bundlers'), 'GMGN bundlers 30.78% → red');
  assert.ok(by('bad').includes('Serial deployer'), '2713 dev tokens → red');
  assert.ok(by('bad').includes('Flagged as suspicious'));
  assert.ok(by('bad').includes('Low Liquidity'), 'RugCheck danger → red');
  assert.ok(by('bad').includes('Top 10 holders'), '50% → red'); assert.match(JSON.stringify(checks.find(c => c.label === 'Top 10 holders')), /excl\. pools/);
  assert.ok(by('good').includes('Smart money holders') && by('good').includes('LP locked or burned') && by('good').includes('Mint & freeze authority revoked'));
  assert.ok(by('warn').includes('Look-alikes launched in the last 14 days'));
  assert.ok(by('bad').includes('Logo reused by other tokens'), '6 reuses → red'); assert.ok(by('warn').includes('X account was renamed')); assert.ok(by('info').includes('Dev sold everything')); assert.ok(by('info').includes('Fees paid by traders'));
  assert.equal(typeof checks.find(c => c.label === 'Bundlers').action, 'function', 'checks link to their page');
  const ql2 = T.quickLinks(); assert.equal(ql2.find(q => q.label === 'Axiom').url, 'https://axiom.trade/meme/Pair1111111111111111111111111111111111111111'); assert.ok(ql2.find(q => q.label === 'Photon')); assert.equal(ql2.find(q => q.label === 'pump.fun')?.group, 'trade', 'launchpad from Jupiter (pump.fun)');
  assert.ok(by('info').includes('Fresh pool') === false, 'pool is 3h old');
  assert.equal(checks.filter(c => c.label === 'Tokens created by dev').length, 0, 'dev history shown once');
  const counts = T.countChecks(); assert.equal(counts.bad, by('bad').length);

  // Buy/sell pressure + holder growth from Jupiter windows
  const fw = T.flowWindows(), f1 = fw.find(r => r.k === 'h1'), f5 = fw.find(r => r.k === 'm5');
  assert.ok(Math.abs(f1.share - 100 * 9000 / 21000) < 1e-9, '1h share by volume'); assert.equal(f1.holderChange, 4.2); assert.equal(f5.share, 25);
  assert.ok(T.buildChecks().some(c => c.label === 'Holders growing (1h)' && c.level === 'good'));
  // Wallet clusters: A and B share funder F (38% of supply); pool and C are not a cluster
  s.sec = { ...s.sec, holders: [] };   // RPC path: owners of the largest token accounts
  await T.refreshClusters(true);
  assert.equal(s.clusters.fresh.count, 1, 'wallet A started 1 h ago → fresh');
  assert.ok(T.buildChecks().some(c => /fresh wallets/i.test(c.label)), 'fresh-wallet check shown');
  assert.equal(s.clusters.checked, 3, 'pool skipped (not a wallet)'); assert.equal(s.clusters.clusters.length, 1);
  assert.equal(s.clusters.clusters[0].funder, W.F); assert.equal(s.clusters.clusters[0].holders.length, 2); assert.ok(Math.abs(s.clusters.clusters[0].pct - 14) < 1e-9);
  assert.ok(T.buildChecks().some(c => c.label === 'Wallet cluster among top holders' && c.level === 'bad'));
  // fomo: theses, top holders (followers) and trade details in the format fomo's API returns
  const iso = sec => new Date(Date.now() - sec * 1000).toISOString();
  const thesis = (id, userId, handle, text, sec, extra = {}) => ({ type: 'thesis', id, tradeId: 'tr' + id, createdAt: iso(sec), userId, displayName: handle.toUpperCase(), userHandle: handle, verified: false, twitter: null,
    comment: { id, userId, comment: text, marketCapAtCreation: 50000 + sec, numLikes: 2, createdAt: iso(sec) }, numReplies: 0, authorTrade: { usdValue: 250, unrealizedPnlUsd: 40, realizedPnlUsd: 0 }, tokenAddress: ca, isDev: false, ...extra });
  const feed = JSON.stringify({ success: true, responseObject: { items: [thesis('t1', 'u1', 'alpha', 'Strong team', 600), thesis('t2', 'u2', 'beta', 'Send it', 300, { isDev: true }), thesis('t3', 'u1', 'alpha', 'Still holding', 60)], hasNextPage: true, count: 829 } });
  const top = JSON.stringify({ success: true, responseObject: [{ tokenAddress: ca, totalHolders: 1056, topHolders: [
    { user: { id: 'u1', userHandle: 'alpha', displayName: 'Alpha', followers: 42556 }, value: 30000, pnl: 20000, isDev: false, comment: { comment: 'x' } },
    { user: { id: 'u9', userHandle: 'whale', displayName: 'Whale', followers: 900 }, value: 9000, pnl: -100, isDev: false }] }] });
  const details = JSON.stringify({ success: true, responseObject: { buyCount5m: 30, sellCount5m: 10, buyVolume5m: '3000', sellVolume5m: '1000', buyCount1: 247, sellCount1: 247, buyVolume1: '16335', sellVolume1: '16835', buyVolume4: '1', sellVolume4: '1', buyVolume24: '5', sellVolume24: '5', holders: 1056 } });
  assert.equal(T.parseFomoResponse('/feed/token/thesis', feed).items.length, 3);
  T.onFomoFeed({ path: '/feed/token/thesis', token: 'So11111111111111111111111111111111111111112', body: feed }); assert.ok(!s.fomo || s.fomo.key !== 'solana:' + ca || !s.fomo.theses.size, 'other token ignored');
  T.onFomoFeed({ path: '/feed/token/thesis', token: ca, body: feed }); T.onFomoFeed({ path: '/feed/token/sortedThesis', token: ca, body: feed });
  T.onFomoFeed({ path: '/hodlers/top', token: '', body: top });                              // token from the response body
  T.onFomoFeed({ path: '/proxy/tokenDetails', token: '', pageToken: ca, body: details });       // token from the open page
  assert.equal(s.fomo.theses.size, 3, 'de-duplicated'); assert.equal(s.fomo.total, 829); assert.equal(s.fomo.totalHolders, 1056);
  const callers = T.fomoCallers(); assert.equal(callers[0].author, 'alpha'); assert.equal(callers[0].calls, 2); assert.equal(callers[0].followers, 42556, 'followers from the top-holder list'); assert.equal(callers[0].firstMc, 50600);
  assert.ok(callers.find(c => c.author === 'beta').isDev);
  assert.equal(T.flowWindows().find(r => r.k === 'm5').share, 75, 'fomo trade volume preferred');
  assert.ok(T.buildChecks().some(c => c.label === 'Dev posted a fomo thesis')); assert.ok(T.buildChecks().some(c => c.label === 'Big fomo accounts holding'));

  // AI result storage (combined kind only)
  T.onAiResult({ nonce: 'n1', kind: 'analysis', key: 'solana:' + ca, status: 'done', ts: Date.now(), text: 'x', json: { verdict: 'risky', score: 30, trade: { bias: 'bearish', action: 'wait' } }, url: 'https://chatgpt.com/c/abc' });
  assert.equal(store.map.get('aps:ai:solana:' + ca).analysis.json.verdict, 'risky'); assert.equal(s.aiResults.analysis.url, 'https://chatgpt.com/c/abc');
  T.onAiResult({ nonce: 'n2', kind: 'evil', key: 'k', status: 'done', ts: Date.now() }); assert.ok(!store.map.has('aps:ai:k'), 'unknown kinds ignored');
  assert.ok(T.buildChecks().some(c => c.label === 'ChatGPT verdict' && c.level === 'bad'));
  assert.deepEqual({ ...T.aiPrefsRef() }, { project: true, chart: true, screenshot: true, newChat: true, temporary: false }, 'no auto-send, temporary chat off by default');

  // Solana RPC: public fallback chain, custom RPC first
  assert.equal(await T.solRPC('getSlot', []), 111, 'Vibe Station rate-limited (429) → official endpoint answers');
  assert.match(s.statuses.rpc, /api\.mainnet-beta\.solana\.com/);
  T.prefs.rpcUrl = 'https://my.rpc.example/'; assert.equal(await T.solRPC('getSlot', []), 222, 'custom RPC is tried first'); T.prefs.rpcUrl = '';
  assert.equal(T.registrableDomain('app.token.xyz'), 'token.xyz'); assert.equal(T.registrableDomain('www.shop.co.uk'), 'shop.co.uk');
  const pg = T.analyzePage('<title>A &amp; B</title><meta property="og:description" content="Hi"><script src="/_next/static/x.js"></script>' + evm.toUpperCase().replace('0X', '0x'), evm);
  assert.equal(pg.title, 'A & B'); assert.equal(pg.description, 'Hi'); assert.equal(pg.builder, 'Vercel'); assert.equal(pg.hasCA, true, 'EVM CA matched case-insensitively');

  // Website + X intelligence (loaded with the project prompt above)
  assert.equal(s.intel.web[0].domain, 'rocket.example'); assert.equal(s.intel.web[0].rdap.registrar, 'Namecheap'); assert.equal(s.intel.web[0].page.hasCA, true); assert.equal(s.intel.web[0].page.builder, 'Framer');
  assert.equal(s.intel.x[0].user.handle, 'RocketCoin'); assert.equal(s.intel.x[0].user.followers, 50);
  const ic = T.buildChecks(), lvl = l => ic.find(c => c.label === l)?.level;
  assert.equal(lvl('Website domain age'), 'bad', 'domain registered 3 days ago'); assert.equal(lvl('CA shown on project page'), 'good');
  // A page that shows a different pump-style CA → red; no CA at all → warning
  const otherCa = 'H7oXa1kPwVvB5n6Wq3Gm3pLzBmQe1yVxR4a9f3wGpump';
  assert.equal(JSON.stringify(T.otherContracts('Buy now! CA: ' + otherCa + ' and program 11111111111111111111111111111111', ca)), JSON.stringify([otherCa]));
  const webBackup = s.intel.web[0].page;
  s.intel.web[0].page = { ...webBackup, hasCA: false, otherCa: [otherCa] }; assert.equal(T.buildChecks().find(c => c.label === 'Other CA on project page')?.level, 'bad');
  s.intel.web[0].page = { ...webBackup, hasCA: false, otherCa: [] }; assert.equal(T.buildChecks().find(c => c.label === 'CA not found on project pages')?.level, 'warn');
  s.intel.web[0].page = webBackup;
  // GMGN's copy of the pump.fun callouts (older ones included) is merged; followers from pump.fun (batch) and X
  T.onGmgnResult({ nonce: 'g-c', key: 'solana:' + ca, ts: Date.now(), ok: true, data: { ...s.gmgn.data }, callouts: T.normalizeGmgnCallouts({ code: 0, data: { items: [
    { id: 'c1', coin_mint: ca, wallet: W.A, user_name: 'DontFadeFelix', thesis: 'dup of c1', called_out_at_mcap: 39949, max_multiplier: 2.6, created_at: Math.floor(Date.now() / 1000) - 3600, likes: 4 },
    { id: 'g2', coin_mint: ca, wallet: W.B, user_name: 'bigcaller', thesis: 'older call only on GMGN', called_out_at_mcap: 9000, max_multiplier: 9.5, created_at: Math.floor(Date.now() / 1000) - 86400, likes: 30, position: { amount_held: 0, is_exited: true } },
    { id: 'other', coin_mint: 'So11111111111111111111111111111111111111112', user_name: 'x', thesis: 'other coin', created_at: Math.floor(Date.now() / 1000) }] } }, ca) });
  await until(() => s.callerFollowers?.x?.bigx != null, 4000);
  assert.equal(s.pump.callouts.length, 2, 'merged by id, other coins dropped'); assert.ok(s.events.some(e => e.id === 'pump:g2'), 'GMGN-only callout becomes an event');
  const pc = T.pumpCallers(); assert.equal(pc[0].author, 'bigcaller', 'sorted by followers'); assert.equal(pc[0].xFollowers, 25000); assert.equal(pc[0].pumpFollowers, 4000); assert.equal(pc[0].holding, false);
  assert.ok(T.buildChecks().some(c => c.label === 'Big callers on pump.fun'));
  // Trade setup prompt: chart and trading data only, multi-timeframe candles in market cap, scenarios schema
  const tp = await T.buildTradePrompt(null, false);
  for (const n of ['ENTRY and EXIT', 'PRICE ↔ MARKET CAP', '15-MINUTE CANDLES', '5-MINUTE CANDLES', '1-MINUTE CANDLES', 'High-volume market-cap zones', 'VWAP 1h', 'BUY / SELL PRESSURE', 'SUPPLY THAT CAN BE SOLD', 'Developer:', '"scenarios"', '"noTradeIf"', 'PUMP.FUN CALLOUTS'])
    assert.ok(tp.includes(n), 'trade prompt contains ' + n);
  assert.ok(!tp.includes('Website(s): open'), 'no project tasks in the trade prompt');
  // Website that loads its CA at runtime: found through script → chunk → same-site API (user/auth endpoints skipped)
  const deep = await T.deepCaScan('https://spa.example/', '<html><script type="module" src="/assets/main.js"></script></html>', ca);
  assert.equal(deep.hasCA, true); assert.equal(deep.caIn, 'api /api/bubbles/directory'); assert.ok(!log.some(u => /\/api\/user\/me/.test(u)), 'user endpoints are not requested');
  // Links inside texts are clickable
  const box = fakeNode('div'); T.textWithLinks(box, 'see https://x.com/a/status/1. ok');
  assert.match(allText(box), /see x\.com\/a\/status\/1 <https:\/\/x\.com\/a\/status\/1> \. ok/);
  // pump.fun: callouts from the public API (no tab), fee sharing + claims on-chain
  await T.refreshPump(true); await until(() => s.pump?.fees && !s.loading.fees, 4000);
  assert.equal(s.pump.callouts.length, 2, 'pump.fun API + the older GMGN callout'); assert.equal(s.pump.callouts.find(c => c.id === 'c1').maxMultiple, 2.6); assert.equal(s.pump.coin.bondingCurve, CURVE);
  assert.ok(s.events.some(e => e.source === 'pump' && e.id === 'pump:c1'), 'callouts become pump.fun events (chart markers, activity)');
  const sh = s.pump.fees.shareholders[0]; assert.equal(s.pump.fees.feeOwner, CFG, 'creator field of the bonding curve'); assert.equal(sh.username, 'ghuntley');
  assert.equal(sh.claims, 1); assert.ok(Math.abs(sh.claimed - 12.8985) < 1e-6); assert.ok(Math.abs(sh.received - 12.8985) < 1e-6);
  const fc = T.buildChecks(); assert.ok(fc.some(c => c.label === 'Creator fees go to')); assert.ok(fc.some(c => c.label === 'Fees claimed')); assert.ok(fc.some(c => c.label === 'pump.fun callouts'));
  assert.equal(lvl('X account age'), 'warn', 'X account 10 days old'); assert.equal(lvl('X followers'), 'warn');
  const p2 = await T.buildPrompt(null, false, { project: true, chart: false });
  for (const n of ['=== WEBSITE', 'registrar Namecheap', 'CA in static HTML: yes', '=== X ACCOUNT', '@RocketCoin (Rocket)', 'followers 50']) assert.ok(p2.includes(n), 'prompt contains ' + n);

  // Docked sidebar pushes the page aside
  T.setPush('right', 380); assert.match(T.pushStyleText(), /margin-right:380px!important;width:calc\(100% - 380px\)!important/);
  T.setPush('', 0); assert.equal(T.pushStyleText(), '');
  // Page fit: zoom only when fixed minimum widths overflow, sidebar width compensated
  assert.equal(T.fitZoomFor(1060, 1000), 1); assert.equal(T.fitZoomFor(1060, 1080), 1, 'within 3% tolerance'); assert.equal(T.fitZoomFor(1060, 1320), 0.803); assert.equal(T.fitZoomFor(500, 2000), 0.6, 'never below 60%');
  assert.match(T.pushCss('left', 380, 0.8), /zoom:0\.8!important;margin-left:475\.00px!important;width:1525\.00px!important/, 'test window is 1600px wide → (1600-380)/0.8');
  assert.equal(T.pushCss('', 380, 0.8), '');

  // Render smoke test of every tab (fake DOM, no network for already-loaded data)
  s.aiJob = { nonce: 'x', key: 'solana:' + ca, status: 'waiting', ts: Date.now() };
  for (const [name, fn, needles] of [
    ['overview', T.renderOverview, ['Red flags', 'Warnings', 'Good signs', 'Bundlers', 'Serial deployer', 'Buy / sell pressure', '1 hour', '+4.2%', 'Holders & clusters', 'Developer', 'Tokens launched', 'GMGN ↗', 'sold everything', 'X account renamed', 'Logo used by other tokens', 'Trade', 'Padre', 'Axiom', 'Market details', 'Security details', 'Holders']],
    ['project', T.renderProject, ['Project', 'Website ↗', 'rocket.example', 'shows CA', 'GitHub ↗', 'rocketdev/rocket-app · 37 commits', 'Trade', 'Axiom', 'Photon', 'pump.fun', 'Research', 'Bubblemaps', 'Holders & traders', 'Phishing', 'Holder list on GMGN', 'Fees & rewards', 'Creator fee', '0.3% of volume', 'Fees paid by traders', '11.56 SOL', '@Twenkkk ↗', 'not claimed', 'Fee sharing (pump.fun)', 'GitHub @ghuntley ↗', 'claimed 1× 12.90 SOL', 'Admin rights revoked', 'Trading', 'Look-alikes', 'sorted by market cap', 'Open']],
    ['socials', T.renderSocials, ['fomo theses', 'Top 10 callers by followers (2 callers loaded, 1 without follower data)', '<https://fomo.family/profile/alpha>', '<https://pump.fun/callouts/', 'pump.fun callouts', 'max 2.60×', 'pump.fun page', 'Biggest fomo accounts holding', '42.56K followers', 'alpha', 'fomo theses: 829', 'Community', 'X ↗', '@RocketCoin', '10d old', '50 followers', 'X community ↗', 'Telegram ↗', 'Activity', '5 min', '24 hours', '𝕏 posts: 0', 'pump.fun calls: 2', 'Top 10 callers by followers (2 callers · incl. GMGN)', '𝕏 25K · 4K on pump.fun', 'Search X for this token', 'X posts']],
    ['ai', T.renderAi, ['Analyze with ChatGPT', 'Project check', 'Chart & trade plan', 'press Enter there', 'Open ChatGPT', 'Verdict: risky', 'Trade: bearish']],
    ['watchlist', T.renderWatchlist, ['Add current token', 'Watched tokens']],
    ['settings', T.renderSettings, ['Sidebar', 'Fit the page', 'Checks', 'GMGN holder analysis', 'Website & X checks', 'Alerts', 'Solana RPC', 'Advanced', 'Developer tools', 'not financial advice']]]) {
    const root = fakeNode('div'); fn(root); const t = allText(root);
    if (name === 'project') assert.ok(t.indexOf('$ROCKETS ') < t.indexOf('$ROCKET <'), 'look-alikes sorted by market cap (2M before 90K)');
    if (name !== 'settings') for (const hidden of ['Test chart marker', 'Copy diagnostics', 'Last prompt']) assert.ok(!t.includes(hidden), name + ' hides developer item ' + hidden);
    for (const src of ['FxTwitter', 'RDAP', 'GoPlus', 'Source:']) assert.ok(!t.includes(src), name + ' tab does not name the data source ' + src);
    for (const n of needles) assert.ok(t.includes(n), `${name} tab shows "${n}"`);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(t), `${name} tab has no undefined/NaN`);
  }
  await wait(5);
  console.log('PASS panel: chains, GoPlus, market/orders, allow-list, auto chain, sources, links, GitHub, vamps, prompts, GMGN, grouped checks, AI, sidebar push, all tabs render');
})().catch(e => { console.error(e); process.exitCode = 1; });
