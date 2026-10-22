'use strict';
const assert = require('node:assert/strict');
const { loadCore, MAIN, BRIDGE } = require('./harness');

const c = loadCore();
const mint = 'So11111111111111111111111111111111111111112';

// Addresses and time parsing
assert.equal(c.isValidMint(mint), true);
assert.equal(c.isValidMint('11111111111111111111111111111111'), true);
assert.equal(c.isValidMint('abcdefNOT_58'), false);
assert.equal(c.isValidMint('pumpfun'), false);
assert.equal(c.isValidAddress('0x' + 'a'.repeat(40), 'ethereum'), true);
assert.equal(c.isValidAddress('0x' + 'a'.repeat(40), 'solana'), false);
assert.equal(c.isValidAddress(mint, 'bsc'), false);
assert.equal(c.parseTime('2026-10-17T11:59:00.000Z'), Date.parse('2026-10-17T11:59:00.000Z') / 1000);
assert.equal(c.parseTime('garbage'), null);

// pump.fun payload traversal
const ts = new Date(Date.now() - 60_000).toISOString();
const item = { id: 'caller-post-4', createdAt: ts, user: { username: 'tester' }, coin: { mint }, content: 'buy this coin' };
const result = c.extractPumpPayload({ data: { callouts: [item] } });
assert.equal(result.length, 1, 'callout recognised');
assert.equal(result[0].ca, mint); assert.equal(result[0].author, 'tester'); assert.equal(result[0].text, 'buy this coin');
assert.equal(c.extractPumpPayload({ data: [{ mint, text: 'missing timestamp' }] }).length, 0);
assert.equal(c.extractPumpPayload({ data: [{ createdAt: ts, user: { address: mint }, text: 'a wallet is not a coin' }] }).length, 0);
assert.equal(c.mergeEvents(result, result).length, 1);
assert.equal(c.safeUrl('https://evil.example/steal', ['pump.fun']), '');

// Look-alike matching
assert.equal(c.normTok('$D\u00f3gwif-Hat!'), 'dogwifhat');
assert.equal(c.similarReason({ symbol: 'WIF', name: 'dogwifhat' }, { symbol: 'wif', name: 'other' }), 'same symbol');
assert.equal(c.similarReason({ symbol: 'PEPE', name: 'Pepe' }, { symbol: 'PEPE2', name: 'Pepe 2.0' }), 'name contains');
assert.equal(c.similarReason({ symbol: 'TRUMP', name: 'Official Trump' }, { symbol: 'TRUMPP', name: 'x' }), 'similar symbol');
assert.equal(c.similarReason({ symbol: 'BONK', name: 'Bonk' }, { symbol: 'SOL', name: 'Wrapped SOL' }), '');
assert.equal(c.editDistance('rocket', 'rockat', 2), 1);

// ChatGPT answer parsing
assert.deepEqual({ ...c.extractAiJson('Text\n```json\n{"verdict":"legit","score":80}\n```') }, { verdict: 'legit', score: 80 });
assert.equal(c.extractAiJson('Result {"trade":{"bias":"neutral","entries":[{"mcap":1}]}} end').trade.bias, 'neutral', 'balanced braces fallback');
assert.equal(c.extractAiJson('json\nCopy code', ['{"a":1}']).a, 1, 'code block preferred');
assert.equal(c.extractAiJson('no json here'), null);

// GitHub helpers
assert.deepEqual({ ...c.parseGithubTarget('https://github.com/rocketdev/rocket-app.git') }, { owner: 'rocketdev', repo: 'rocket-app' });
assert.equal(c.parseGithubTarget('https://github.com/topics/solana'), null);
assert.equal(c.parseGithubTarget('https://gitlab.com/a/b'), null);
assert.equal(c.githubCountFromLink('<https://x?per_page=1&page=37>; rel="last"', 1), 37);

// Candle resampling
const bars = Array.from({ length: 600 }, (_, i) => ({ t: 1.7e9 + i * 60, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
const rs = c.resampleBars(bars, 150);
assert.ok(rs.length <= 150); assert.equal(rs.at(-1).c, 599.5); assert.equal(rs[1].v, 5, '5m buckets sum the volume');

// GMGN normalisation (real response shapes from Oct 2026)
const g = c.C.normalizeGmgn(
  { code: 0, data: { holder_count: 5668, top_bundler_trader_percentage: '0.3078', top_entrapment_trader_percentage: '0.3058', top_rat_trader_percentage: '0', bot_degen_rate: '0.549', fresh_wallet_rate: '0.0636', top_10_holder_rate: '0.242', dev_team_hold_rate: '0', creator_created_count: 103, top70_sniper_hold_rate: '0' } },
  { code: 0, data: { smart_degen_count: 43, renowned_count: 44, sniper_count: 15, bundler_count: 1000, insider_count: 0, fresh_wallet_count: 1000 } },
  { code: 0, data: { security: { renounced_mint: true, renounced_freeze_account: true, burn_ratio: '1', buy_tax: '0', sell_tax: '0' } } });
assert.equal(g.holders, 5668); assert.ok(Math.abs(g.bundlerPct - 30.78) < 1e-9); assert.ok(Math.abs(g.phishingPct - 30.58) < 1e-9);
assert.equal(g.devCreated, 103); assert.equal(g.smartMoney, 43); assert.equal(g.bundlers, 1000); assert.equal(g.burnPct, 100); assert.equal(g.mintRenounced, true);
assert.throws(() => c.C.normalizeGmgn(null, null, null), /no data/);
// GMGN developer / fee details (real response shapes, Oct 2026)
const ex = c.C.normalizeGmgnExtra(
  { code: 0, data: [{ image_dup_count: 6, total_fee: '11.5641', trade_fee: '6.458', dev: { creator_address: '5MTjkAZMe1ur64ADTgnaYFN1ByTapu2RqcKYUdQNaE2E', creator_open_count: 26, creator_token_status: 'creator_close', twitter_rename_count: 2, twitter_name_change_history: [{ twitter_username: 'old_name' }], twitter_del_post_count: 1, fund_from: '' } }] },
  { code: 0, data: { launchpad: 'pump', platform_data: { is_locked: true, list: [{ wallet: '9mnaTmvz8aKLsFE29GshMaSpJP7b8uJqMHudMSQ9xf7N', royalty_bps: 10000, has_claimed_fee: false, is_charity: true, charities: [{ name: 'Friends of Fondation de France Inc' }] }, { wallet: '5MTjkAZMe1ur64ADTgnaYFN1ByTapu2RqcKYUdQNaE2E', royalty_bps: 0, has_claimed_fee: true, is_creator: true, twitter_username: 'Twenkkk' }] } } },
  { code: 0, data: { pool_fee_info_list: [{ creator_fee_bps: 30 }], launchpad: { launchpad_platform: 'Pump.fun', launchpad_progress: '1' } } });
assert.equal(ex.dev.address, '5MTjkAZMe1ur64ADTgnaYFN1ByTapu2RqcKYUdQNaE2E'); assert.equal(ex.dev.migrated, 26); assert.equal(ex.dev.status, 'creator_close');
assert.equal(ex.dev.xRenames, 2); assert.deepEqual([...ex.dev.xHistory], ['old_name']); assert.equal(ex.imageDup, 6); assert.ok(Math.abs(ex.feesPaid - 11.5641) < 1e-9);
assert.equal(ex.creatorFeePct, 0.3); assert.equal(ex.launchpad, 'Pump.fun'); assert.equal(ex.bonding, 1); assert.equal(ex.feeSplitLocked, true);
assert.equal(ex.recipients[0].sharePct, 100); assert.equal(ex.recipients[0].charity, 'Friends of Fondation de France Inc'); assert.equal(ex.recipients[1].claimed, true); assert.equal(ex.recipients[1].xUser, 'Twenkkk');
assert.deepEqual({ ...c.C.normalizeGmgnExtra(null, null, null).dev, xHistory: [] }, { address: '', status: '', migrated: null, fundedBy: '', xRenames: null, xDeletedPosts: null, xHistory: [] }, 'missing data is tolerated');
assert.deepEqual({ ...c.C.GMGN_CHAIN }, { solana: 'sol', ethereum: 'eth', bsc: 'bsc', base: 'base' });

// Release hygiene: English only, one version everywhere, no userscript headers
const pkgVersion = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8')).version;
for (const [name, src] of [['src/apescope.js', MAIN], ['src/bridge.js', BRIDGE]]) {
  assert.ok(!/[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/.test(src), name + ' contains German umlauts');
  assert.ok(!/==UserScript==|\.user\.js/.test(src), name + ' contains userscript headers');
  assert.ok(src.includes(`const VERSION = '${pkgVersion}'`), name + ' VERSION matches package.json');
}
assert.equal(c.C.VERSION, pkgVersion);
console.log('PASS core: addresses, time, pump.fun parsing, look-alikes, AI JSON, GitHub, candles, GMGN, release hygiene');
