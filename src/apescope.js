/*
 * ApeScope — content script. MIT License.
 *
 * One file, several roles depending on the site it runs on:
 *   fomo.family  → the sidebar (runPanel)
 *   x.com        → X search worker, only in tabs opened from the sidebar (runX)
 *   pump.fun     → pump.fun callout worker, only in tabs opened from the sidebar (runPump)
 *   gmgn.ai      → GMGN worker: answers token requests with same-origin, read-only API calls (runGmgn)
 *   chatgpt.com  → ChatGPT worker: fills in a prompt the user started and reads the answer back (runChatGPT)
 * The roles exchange data through extension storage. Storage, network and tab access go through the small
 * API in compat.js (GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_openInTab, …).
 *
 * Privacy: no cookies, tokens or keys are read or exported. Public APIs only see the contract address
 * being looked up. Nothing is ever traded or signed. Exception, opt-in (Settings → Socials → "Search X without a
 * tab"): background.js reads x.com's ct0 cookie to send it back to x.com with the search, like x.com itself does.
 */(() => {
  'use strict';

  const VERSION = '1.0.3';
  const APP = 'ApeScope';
  const K = Object.freeze({
    query: 'aps:query', xFeedPrefix: 'aps:x:', xHealth: 'aps:x-health', xError: 'aps:x-error',
    pumpHealth: 'aps:pump-health', pumpError: 'aps:pump-error', pumpCache: 'aps:pump-cache', pumpDiag: 'aps:pump-diag',
    options: 'aps:options', chartDiag: 'aps:chart-diag',
    aiRequest: 'aps:ai-request', aiResult: 'aps:ai-result', aiWorker: 'aps:ai-worker', aiPrefs: 'aps:ai-prefs',
    gmgnRequest: 'aps:gmgn-request', gmgnResult: 'aps:gmgn-result', gmgnWorker: 'aps:gmgn-worker',
  });
  // Messages exchanged with the page-context script (bridge.js).
  const MSG = Object.freeze({
    chartEvents: 'APESCOPE_CHART_EVENTS', chartHealth: 'APESCOPE_CHART_HEALTH',
    snapshotRequest: 'APESCOPE_CHART_SNAPSHOT_REQ', snapshot: 'APESCOPE_CHART_SNAPSHOT', pumpNetwork: 'APESCOPE_PUMP_NETWORK', fomoFeed: 'APESCOPE_FOMO_FEED',
  });
  const WORKER_PARAM = 'apescope_worker';
  const MINT_RX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  // X search reloads (X allows roughly 50 searches per 15 min) and pump.fun callout polls.
  const DEFAULT_OPTIONS = { xPollMs: 30_000, pumpPollMs: 10_000, maxEvents: 250 };
  const options = { ...DEFAULT_OPTIONS, ...(GM_getValue(K.options, {}) || {}) };
  const origin = location.hostname.replace(/^www\./, '');
  const isFomo = origin === 'fomo.family';
  const isPump = origin === 'pump.fun';
  const isX = origin === 'x.com' || origin === 'twitter.com';
  const isChatGPT = origin === 'chatgpt.com';
  const isGmgn = origin === 'gmgn.ai';
  const maxAgeMs = 30 * 24 * 3600_000;
  const now = () => Date.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const string = v => typeof v === 'string' ? v : '';
  const trim = (v, n = 180) => string(v).trim().slice(0, n);

  function isCalloutUrl(value) {
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' && (u.hostname === 'pump.fun' || u.hostname.endsWith('.pump.fun')) && /^\/callouts?(?:\/|$)/i.test(u.pathname);
    } catch { return false; }
  }
  function safePath(value) {
    try { return new URL(value).pathname.replace(/\/[A-Za-z0-9_-]{30,}/g, '/{id}').slice(0, 100); }
    catch { return '[invalid-url]'; }
  }
  function isValidMint(s) {
    if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
    // Solana addresses are base58-encoded 32-byte public keys; reject random wallet-ish text.
    let n = 0n;
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (const c of s) { const i = alphabet.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
    let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
    const zeros = (s.match(/^1*/) || [''])[0].length;
    return bytes + zeros === 32;
  }
  function isValidEVM(s) { return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s); }
  function isValidAddress(s, chain) { return chain === 'solana' ? isValidMint(s) : chain ? isValidEVM(s) : isValidMint(s) || isValidEVM(s); }
  function mintsFrom(s) {
    return [...new Set((string(s).match(MINT_RX) || []).filter(isValidMint))];
  }
  function parseTime(value) {
    if (value == null) return null;
    let t;
    if (typeof value === 'number') t = value < 1e11 ? value * 1000 : value;
    else if (/^\d{10,13}$/.test(String(value))) t = Number(value) < 1e11 ? Number(value) * 1000 : Number(value);
    else t = Date.parse(String(value));
    if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > now() + 86_400_000) return null;
    return Math.floor(t / 1000);
  }
  function fromTimeObj(obj) {
    for (const key of ['calledAt', 'calloutAt', 'postedAt', 'publishedAt', 'createdAt', 'timestamp', 'time', 'date', 'created_at', 'published_at', 'created_timestamp', 'callout_timestamp', 'createdTime', 'postCreatedAt']) {
      const t = parseTime(obj[key]); if (t) return t;
    }
    return null; // never assign the polling time to historical callouts
  }
  function safeUrl(value, allowedHosts) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || !allowedHosts.includes(u.hostname.replace(/^www\./, ''))) return '';
      return u.toString();
    } catch { return ''; }
  }
  function normalizePumpItem(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const coin = obj.coin || obj.token || obj.tokenData || obj.coinData || {};
    const candidates = [obj.mint, obj.coinMint, obj.tokenMint, obj.coinAddress, obj.tokenAddress, obj.contractAddress,
      obj.baseMint, coin.mint, coin.coinMint, coin.tokenMint, coin.address, coin.contractAddress];
    const ca = candidates.find(isValidMint);
    if (!ca) return null;
    const timestamp = fromTimeObj(obj); // post/callout time required
    if (!timestamp) return null;
    const authorObj = obj.author || obj.user || obj.caller || obj.creator || obj.calloutUser || {};
    const author = trim(obj.username || obj.handle || obj.authorName || authorObj.username || authorObj.handle || authorObj.name || obj.userName, 65) || 'pump.fun caller';
    const body = trim(obj.content || obj.message || obj.text || obj.body || obj.description || obj.title, 500);
    const id = trim(String(obj.id || obj._id || obj.calloutId || obj.uuid || ''), 100);
    const permalink = safeUrl(obj.url || obj.link || obj.permalink, ['pump.fun']);
    return {
      source: 'pump', ca, timestamp, author, text: body || 'pump.fun callout',
      url: permalink || 'https://pump.fun/callouts',
      id: 'pump:' + (id || [ca, timestamp, author, body].join(':')),
    };
  }
  function extractPumpPayload(payload, telemetry) {
    // Unknown/unofficial schema: traverse JSON arrays and nested objects with field-based validation.
    // No blind address+time regex matching: that would generate false positives from unrelated wallets.
    let root = payload;
    if (typeof root === 'string') {
      try { root = JSON.parse(root); }
      catch {
        // Next.js RSC transport can contain JSON fragments on numbered lines.
        const fragments = [];
        for (const line of root.split('\n').slice(0, 800)) {
          const raw = line.replace(/^\d+:\s*/, '').trim();
          if (raw[0] === '{' || raw[0] === '[') { try { fragments.push(JSON.parse(raw)); } catch {} }
        }
        root = fragments;
      }
    }
    const found = new Map();
    if (telemetry) {
      telemetry.type = typeof root === 'object' ? (Array.isArray(root) ? 'array' : 'object') : typeof root;
      telemetry.objects = 0; telemetry.candidates = 0; telemetry.missingCA = 0; telemetry.missingTime = 0; telemetry.sampleKeys = [];
    }
    const seen = new WeakSet();
    const queue = [{ node: root, depth: 0 }];
    let visited = 0, head = 0;
    while (head < queue.length && visited++ < 14_000) {
      const { node, depth } = queue[head++];
      if (!node || typeof node !== 'object' || seen.has(node) || depth > 10) continue;
      seen.add(node);
      if (Array.isArray(node)) { for (const entry of node.slice(0, 1500)) queue.push({ node: entry, depth: depth + 1 }); continue; }
      if (telemetry) {
        telemetry.objects++;
        const keys = Object.keys(node).slice(0, 30);
        if (telemetry.sampleKeys.length < 4 && keys.length >= 3)
          telemetry.sampleKeys.push(keys.map(k => /^[a-z_$][a-z0-9_$-]{0,48}$/i.test(k) ? k : '[key]'));
        if (keys.some(k => /(?:mint|token|coin|callout|caller|created|timestamp|post)/i.test(k))) {
          telemetry.candidates++;
          const coin = node.coin || node.token || node.tokenData || node.coinData || {};
          const address = [node.mint, node.coinMint, node.tokenMint, node.coinAddress, node.tokenAddress, node.contractAddress, node.baseMint, coin.mint, coin.coinMint, coin.tokenMint, coin.address, coin.contractAddress].find(isValidMint);
          if (!address) telemetry.missingCA++;
          else if (!fromTimeObj(node)) telemetry.missingTime++;
        }
      }
      const item = normalizePumpItem(node);
      if (item) found.set(item.id, item);
      for (const [key, value] of Object.entries(node).slice(0, 120)) {
        if (typeof value === 'object' && value !== null && !['wallet', 'holders', 'transactions'].includes(key))
          queue.push({ node: value, depth: depth + 1 });
      }
    }
    return [...found.values()].sort((a, b) => b.timestamp - a.timestamp);
  }
  function mergeEvents(existing, incoming, limit = options.maxEvents) {
    const out = new Map();
    for (const ev of [...existing, ...incoming]) {
      if (!ev || !isValidAddress(ev.ca) || !parseTime(ev.timestamp) && !(Number(ev.timestamp) > 1e9 && Number(ev.timestamp) < 1e11)) continue;
      if (typeof ev.id !== 'string' || !['pump', 'x'].includes(ev.source)) continue;
      if (ev.timestamp * 1000 < now() - maxAgeMs) continue;
      out.set(ev.id, ev);
    }
    return [...out.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  // ---- Shared helpers (panel + workers) ------------------------------------------------------
  /** Normalise a token name/symbol for look-alike comparison: lowercase, no accents, alphanumerics only. */
  function normTok(v) {
    return String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  }
  /** Levenshtein distance with early exit (returns max+1 when the distance exceeds max). */
  function editDistance(a, b, max = 3) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  /** Why `cand` looks like `target` (vamp / copycat), or '' if it does not. */
  function similarReason(target, cand) {
    const ts = normTok(target.symbol), tn = normTok(target.name), cs = normTok(cand.symbol), cn = normTok(cand.name);
    if (ts && cs === ts) return 'same symbol';
    if (tn.length >= 3 && cn === tn) return 'same name';
    if (tn.length >= 4 && cn.length >= 4 && (cn.includes(tn) || tn.includes(cn))) return 'name contains';
    if (ts.length >= 3 && cs.length >= 3 && (cs.includes(ts) || ts.includes(cs)) && Math.abs(cs.length - ts.length) <= 4) return 'similar symbol';
    if (ts.length >= 4 && editDistance(ts, cs, 1) <= 1) return 'similar symbol';
    if (tn.length >= 5 && editDistance(tn, cn, 2) <= 2) return 'similar name';
    return '';
  }
  /** Extract the last JSON object from a ChatGPT answer (code block preferred, then a balanced {...}). */
  function extractAiJson(text, codeBlocks = []) {
    const tryParse = v => { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
    for (const block of [...codeBlocks].reverse()) { const o = tryParse(String(block).trim()); if (o) return o; }
    const fenced = [...String(text || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1]).reverse();
    for (const f of fenced) { const o = tryParse(f.trim()); if (o) return o; }
    const t = String(text || '');
    for (let end = t.lastIndexOf('}'); end > 0; end = t.lastIndexOf('}', end - 1)) {
      let depth = 0;
      for (let i = end; i >= 0; i--) {
        if (t[i] === '}') depth++;
        else if (t[i] === '{' && --depth === 0) { const o = tryParse(t.slice(i, end + 1)); if (o) return o; break; }
      }
    }
    return null;
  }
  /** github.com/owner[/repo] → {owner, repo} (repo may be ''), or null for non-project pages. */
  function parseGithubTarget(url) {
    try {
      const u = new URL(url);
      if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
      const [owner, repo] = u.pathname.split('/').filter(Boolean);
      if (!owner || /^(features|topics|orgs|sponsors|marketplace|explore|login|signup|about|pricing|settings|search)$/i.test(owner)) return null;
      if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) return null;
      const r = repo && /^[A-Za-z0-9_.-]{1,100}$/.test(repo) ? repo.replace(/\.git$/, '') : '';
      return { owner, repo: r };
    } catch { return null; }
  }
  /** Total item count from a GitHub `Link` header when requesting per_page=1. */
  function githubCountFromLink(linkHeader, fallback) {
    const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(String(linkHeader || ''));
    return m ? Number(m[1]) : fallback;
  }
  /** Downsample OHLCV rows ({t,o,h,l,c,v}, t in seconds, sorted) to at most `maxRows` buckets. */
  function resampleBars(rows, maxRows = 150) {
    if (!Array.isArray(rows) || rows.length <= maxRows) return Array.isArray(rows) ? rows.slice() : [];
    const span = rows.at(-1).t - rows[0].t;
    const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 86400];
    const step = steps.find(st => span / st <= maxRows) || 86400;
    const out = [];
    for (const r of rows) {
      const bt = Math.floor(r.t / step) * step, last = out.at(-1);
      if (last && last.t === bt) { last.h = Math.max(last.h, r.h); last.l = Math.min(last.l, r.l); last.c = r.c; last.v = (last.v || 0) + (r.v || 0); }
      else out.push({ t: bt, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0 });
    }
    return out.slice(-maxRows);
  }
  /** GMGN chain slug for our chain keys (GMGN API + website). */
  const GMGN_CHAIN = Object.freeze({ solana: 'sol', ethereum: 'eth', bsc: 'bsc', base: 'base' });
  /** Normalise the three GMGN endpoints into one flat object (rates → percent, 1000 = capped count). */
  function normalizeGmgn(stat, holderStat, fee) {
    const d = stat?.data || {}, h = holderStat?.data || {}, sec = fee?.data?.security || {};
    const rate = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n * 100; };
    const count = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    if (!stat?.data && !holderStat?.data && !fee?.data) throw new Error('GMGN: no data for this token');
    return {
      holders: count(d.holder_count), top10Pct: rate(d.top_10_holder_rate ?? sec.top_10_holder_rate),
      bundlerPct: rate(d.top_bundler_trader_percentage), phishingPct: rate(d.top_entrapment_trader_percentage),
      insiderPct: rate(d.top_rat_trader_percentage), botPct: rate(d.bot_degen_rate), freshPct: rate(d.fresh_wallet_rate),
      devHoldPct: rate(d.dev_team_hold_rate ?? d.creator_hold_rate), sniperHoldPct: rate(d.top70_sniper_hold_rate),
      devCreated: count(d.creator_created_count), smartMoney: count(h.smart_degen_count), kols: count(h.renowned_count),
      snipers: count(h.sniper_count), bundlers: count(h.bundler_count), insiders: count(h.insider_count), freshWallets: count(h.fresh_wallet_count),
      mintRenounced: typeof sec.renounced_mint === 'boolean' ? sec.renounced_mint : null,
      freezeRenounced: typeof sec.renounced_freeze_account === 'boolean' ? sec.renounced_freeze_account : null,
      burnPct: rate(sec.burn_ratio), honeypot: sec.is_honeypot === true || Number(sec.honeypot) === 1 ? true : null,
      buyTaxPct: rate(sec.buy_tax), sellTaxPct: rate(sec.sell_tax),
    };
  }
  /** Developer, fee and launchpad details from GMGN's token info and fee distribution (all optional). */
  /** pump.fun callouts as GMGN serves them (/pf/api/v1/pump/callout/token, up to 200 per coin, more than pump.fun's own 50). */
  function normalizeGmgnCallouts(j, ca) {
    const items = Array.isArray(j?.data?.items) ? j.data.items : Array.isArray(j?.data) ? j.data : [];
    const num = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
    return items.slice(0, 250).map(c => {
      const id = String(c?.id || '').slice(0, 60), ts = parseTime(c?.created_at);
      if (!id || !ts || (c.coin_mint && c.coin_mint !== ca)) return null;
      const wallet = isValidMint(String(c.wallet || '')) ? c.wallet : '', pos = c.position || {};
      return { id, author: String(c.user_name || 'unknown').slice(0, 40), x: /^\w{1,15}$/.test(c.x_username || '') ? c.x_username : '', wallet,
        text: String(c.thesis_translation?.en || c.thesis || '').slice(0, 600), ts, mc: num(c.called_out_at_mcap), multiple: num(c.multiple), maxMultiple: num(c.max_multiplier),
        likes: num(c.likes) || 0, views: num(c.view_count) || 0, replies: num(c.reply_count) || 0, pnl: num(pos.pnl_usd), holding: pos.is_exited === true ? false : num(pos.amount_held) == null ? true : num(pos.amount_held) > 0,
        lowQuality: false, url: `https://pump.fun/callouts/${encodeURIComponent(ca)}/${encodeURIComponent(id)}` };
    }).filter(Boolean);
  }
  function normalizeGmgnExtra(info, dist, fee) {
    const d = (Array.isArray(info?.data) ? info.data[0] : info?.data) || {}, dev = d.dev || {}, pd = dist?.data?.platform_data || {}, lp = fee?.data?.launchpad || {};
    const pool = (Array.isArray(fee?.data?.pool_fee_info_list) ? fee.data.pool_fee_info_list : [])[0] || {};
    const num = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
    const str = (v, n = 60) => typeof v === 'string' ? v.slice(0, n) : '';
    return {
      dev: {
        address: str(dev.creator_address, 64), status: str(dev.creator_token_status, 30), migrated: num(dev.creator_open_count),
        fundedBy: str(dev.fund_from, 64), xRenames: num(dev.twitter_rename_count), xDeletedPosts: num(dev.twitter_del_post_count),
        xHistory: (Array.isArray(dev.twitter_name_change_history) ? dev.twitter_name_change_history : []).slice(0, 5).map(x => str(typeof x === 'string' ? x : x?.twitter_username || x?.username || x?.name, 40)).filter(Boolean),
      },
      imageDup: num(d.image_dup_count), feesPaid: num(d.total_fee), tradeFees: num(d.trade_fee),
      launchpad: str(lp.launchpad_platform || dist?.data?.launchpad, 30), bonding: num(lp.launchpad_progress),
      creatorFeePct: num(pool.creator_fee_bps) != null ? Number(pool.creator_fee_bps) / 100 : null, feeSplitLocked: pd.is_locked === true,
      recipients: (Array.isArray(pd.list) ? pd.list : []).slice(0, 8).map(r => ({
        wallet: str(r?.wallet, 64), sharePct: num(r?.royalty_bps) != null ? Number(r.royalty_bps) / 100 : null, xUser: str(r?.twitter_username, 30),
        claimed: r?.has_claimed_fee === true, creator: r?.is_creator === true, charity: str(r?.charities?.[0]?.name, 60),
      })),
    };
  }
  function setStatus(key, ok, detail, extras = {}) {
    GM_setValue(key, { ok, detail: trim(detail, 180), ts: now(), ...extras });
  }
  /** Worker tabs (X, pump.fun) only act when opened by the panel (URL flag), then stay active for the tab session. */
  function activateWorker() {
    const q = new URLSearchParams(location.search);
    if (q.has(WORKER_PARAM)) sessionStorage.setItem('aps:worker', '1');
    return sessionStorage.getItem('aps:worker') === '1';
  }
  const formatTime = ts => new Date(ts * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ============================================================================================
  // Panel (fomo.family)
  // ============================================================================================
  async function runPanel() {
    // The panel never submits trades, touches wallets or modifies the website's own event handlers.
    const CHAINS = {
      solana: { name: 'Solana', id: null, dex: 'solana', gecko: 'solana', explorer: 'https://solscan.io/account/' },
      ethereum: { name: 'Ethereum', id: 1, dex: 'ethereum', gecko: 'eth', explorer: 'https://etherscan.io/address/' },
      bsc: { name: 'BNB Chain', id: 56, dex: 'bsc', gecko: 'bsc', explorer: 'https://bscscan.com/address/' },
      base: { name: 'Base', id: 8453, dex: 'base', gecko: 'base', explorer: 'https://basescan.org/address/' },
      arbitrum: { name: 'Arbitrum', id: 42161, dex: 'arbitrum', gecko: 'arbitrum', explorer: 'https://arbiscan.io/address/' },
      polygon: { name: 'Polygon', id: 137, dex: 'polygon', gecko: 'polygon_pos', explorer: 'https://polygonscan.com/address/' },
      avalanche: { name: 'Avalanche', id: 43114, dex: 'avalanche', gecko: 'avax', explorer: 'https://snowtrace.io/address/' },
      sonic: { name: 'Sonic', id: 146, dex: 'sonic', gecko: 'sonic', explorer: 'https://sonicscan.org/address/' },
      abstract: { name: 'Abstract', id: 2741, dex: 'abstract', gecko: 'abstract', explorer: 'https://abscan.org/address/' },
      berachain: { name: 'Berachain', id: 80094, dex: 'berachain', gecko: 'berachain', explorer: 'https://berascan.com/address/' },
      monad: { name: 'Monad', id: 143, dex: 'monad', gecko: 'monad', explorer: 'https://monadexplorer.com/address/' },
      robinhood: { name: 'Robinhood', id: 4663, dex: 'robinhood', gecko: null, explorer: '' },
    };
    const LOCAL = { ui: 'aps:ui', watches: 'aps:watchlist', notices: 'aps:alerts', preferences: 'aps:preferences', manual: 'aps:manual-events' };
    const DEFAULT_PREF = { dex: true, security: true, honeypot: true, gmgn: true, gmgnAutoOpen: true, webChecks: true, dev: false, chartX: true, chartPump: true, rpcUrl: '', installFolder: 'ApeScope', autoX: true, xApi: false, alerts: false, minLiq: 10000, liqDropPct: 20, volumeSpike: 3, watchRefresh: 120 };
    const DEFAULT_UI = { dock: 'right', fit: 'adapt', width: 380, x: 18, y: 90, w: 400, h: 640, collapsed: false, tab: 'overview', open: { market: false, security: false, holders: false } };
    const TABS = [['overview', 'Overview'], ['project', 'Project'], ['socials', 'Socials'], ['ai', 'AI'], ['watchlist', 'Watchlist'], ['settings', '⚙']];
    const load = (key, def) => { const v = GM_getValue(key, def); return v == null ? def : v; };
    const put = (key, value) => GM_setValue(key, value);
    const prefs = { ...DEFAULT_PREF, ...load(LOCAL.preferences, {}) };
    let uiSettings = { ...DEFAULT_UI, ...load(LOCAL.ui, {}) };
    if (!TABS.some(([id]) => id === uiSettings.tab)) uiSettings.tab = 'overview';
    let watches = Array.isArray(load(LOCAL.watches, [])) ? load(LOCAL.watches, []).slice(0, 100) : [];
    let notices = Array.isArray(load(LOCAL.notices, [])) ? load(LOCAL.notices, []).slice(-100) : [];
    const s = {
      coin: null, manual: false, seenUrl: '', events: [], testEvents: [], market: null, pairs: [], sec: null, hp: null, rugcheck: null,
      project: null, github: null, similar: null, gmgn: null, intel: null, aiResults: {}, aiJob: null, aiPrompt: null, aiBuilding: false, secFlags: [],
      history: [], ohlc: [], ohlcError: '', creatorSecurity: null, statuses: {}, loading: {}, errors: {}, rpcAccounts: [],
      lastEventHash: '', lastDexAt: 0, lastSecAt: 0, lastOhlcAt: 0, lastMarketKey: '', lastSecurityKey: '',
    };
    let root, host, panel, body, tabStrip, identity, launcher, resizer, input, chainSel, statusBox, pushStyle;
    let scheduledRender = 0, drag = null, lastPush = '';
    const lastNotify = new Set();
    const tokenKey = (chain, ca) => `${chain}:${chain === 'solana' ? ca : ca.toLowerCase()}`;
    const norm = ca => isValidEVM(ca) ? ca.toLowerCase() : ca;
    const sameAddr = (a, b) => norm(a) === norm(b);
    const curKey = () => s.coin ? tokenKey(s.coin.chain, s.coin.ca) : '';
    const safeNum = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
    const money = v => v == null || !Number.isFinite(Number(v)) ? '—' : '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(v));
    const number = v => v == null || !Number.isFinite(Number(v)) ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(v));
    const short = v => typeof v === 'string' && v.length > 23 ? `${v.slice(0, 6)}…${v.slice(-5)}` : (v || '—');
    const pctTxt = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d) + '%';
    const yn = v => v === true ? 'yes' : v === false ? 'no' : 'unknown';
    const age = ms => { if (!ms) return '—'; const d = (Date.now() - ms) / 1000; return d < 3600 ? Math.max(1, Math.round(d / 60)) + 'm' : d < 86400 ? Math.round(d / 3600) + 'h' : d < 86400 * 60 ? Math.round(d / 86400) + 'd' : d < 86400 * 365 ? Math.round(d / 86400 / 30) + 'mo' : (d / 86400 / 365).toFixed(1) + 'y'; };
    const isoUtc = ms => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
    const localTime = ms => new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    function safeHttp(u) { try { const x = new URL(String(u || '').trim()); return ['https:', 'http:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } }

    // ---- DOM helpers (textContent only; no innerHTML anywhere) ----
    function el(tag, attributes = {}, parent = null) {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attributes)) {
        if (k === 'text') n.textContent = String(v);
        else if (k === 'class') n.className = v;
        else if (k === 'onclick') n.addEventListener('click', v);
        else if (k === 'style') Object.assign(n.style, v);
        else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
      }
      if (parent) parent.append(n);
      return n;
    }
    function link(text, url, cls = '') {
      const a = el('a', { text, href: url, target: '_blank', rel: 'noopener noreferrer', class: cls });
      if (!safeHttp(url)) a.removeAttribute('href');
      return a;
    }
    /** Text with every http(s) URL turned into a link (X links in theses, callouts and posts). */
    function textWithLinks(parent, text, cls = '') {
      const d = el('div', { class: cls }, parent), t = String(text || ''), re = /https?:\/\/[^\s<>"'\]]+/g; let last = 0, m;
      while ((m = re.exec(t))) {
        const u = m[0].replace(/[.,;:!?)]+$/, ''); if (!u) continue;
        el('span', { text: t.slice(last, m.index) }, d);
        d.append(link(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) + (u.length > 70 ? '…' : ''), u));
        last = m.index + u.length; re.lastIndex = last;
      }
      el('span', { text: t.slice(last) }, d);
      return d;
    }
    function button(parent, name, fn, cls = '') { return el('button', { class: 'btn ' + cls, text: name, onclick: fn, type: 'button' }, parent); }
    function row(parent, label, value, sub = '') {
      const d = el('div', { class: 'row' }, parent); el('span', { text: label }, d); el('b', { text: String(value) }, d);
      if (sub) el('div', { class: 'sub', text: sub }, parent);
      return d;
    }
    function metric(parent, label, value, cls = '') { const d = el('div', { class: 'metric ' + cls }, parent); el('span', { text: label }, d); el('strong', { text: String(value) }, d); return d; }
    function section(parent, title, extra = '') { const d = el('section', { class: 'card' }, parent); const h = el('h3', { text: title }, d); if (extra) el('span', { class: 'sub', text: extra }, h); return d; }
    /** Collapsible card; open/closed state is remembered per key. */
    function collapsible(parent, key, title, summaryText = '') {
      const d = el('details', { class: 'card' }, parent); d.open = !!uiSettings.open?.[key];
      const sm = el('summary', {}, d); el('span', { text: title }, sm); if (summaryText) el('span', { class: 'sub', text: summaryText }, sm);
      d.addEventListener('toggle', () => { uiSettings.open = { ...uiSettings.open, [key]: d.open }; persistLayout(); });
      return d;
    }
    function svg(tag, attrs, parent) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (parent) parent.append(n); return n; }
    function logo(parent, size = 18) {
      const g = svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' }, parent), id = 'aps-grad-' + Math.random().toString(36).slice(2, 7);
      const lg = svg('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 }, svg('defs', {}, g));
      for (const [o, c] of [[0, '#19e07a'], [0.55, '#00d4e6'], [1, '#0a8dff']]) svg('stop', { offset: o, 'stop-color': c }, lg);
      svg('circle', { cx: 12, cy: 12, r: 8.5, stroke: `url(#${id})`, 'stroke-width': 2.4 }, g);
      svg('circle', { cx: 12, cy: 12, r: 2.2, fill: '#19e07a' }, g);
      for (const d of ['M12 1v5', 'M12 18v5', 'M1 12h5', 'M18 12h5']) svg('path', { d, stroke: `url(#${id})`, 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
      return g;
    }

    // ---- Layout: docked sidebar (pushes the page aside), floating window, or collapsed launcher ----
    const CSS = `:host{all:initial;--bg:#0b0f17;--surface:#121926;--surface2:#182233;--border:#253248;--text:#e6edf6;--muted:#8d9bb2;
        --accent:#19e07a;--accent2:#00d4e6;--accent3:#0a8dff;--grad:linear-gradient(90deg,#19e07a,#00d4e6 55%,#0a8dff);--good:#3ddc97;--warn:#f5a524;--bad:#ff5c6c;--info:#5aa9ff;font:12px/1.4 Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:var(--text)}
      *{box-sizing:border-box}
      .panel{position:relative;width:100%;height:100%;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);overflow:hidden;box-shadow:0 18px 40px #000a}
      .panel.docked{border-radius:0;border-top:0;border-bottom:0;box-shadow:0 0 24px #0008}.panel.float{border-radius:12px}
      .head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:linear-gradient(180deg,#151e2e,#111826);border-bottom:1px solid var(--border);user-select:none}
      .panel.float .head{cursor:move}
      .brand{display:flex;align-items:center;gap:7px;color:var(--accent2);font-weight:800;font-size:14px;letter-spacing:.2px;flex:1;min-width:0}
      .brand>span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}.brand small{color:var(--muted);font-weight:500;font-size:10px}
      .iconbtn{border:1px solid transparent;background:transparent;color:var(--muted);border-radius:6px;padding:3px 6px;cursor:pointer;font-size:12px;line-height:1}
      .iconbtn:hover{background:var(--surface2);color:var(--text)}.iconbtn.on{color:var(--accent);border-color:#16503a;background:#0e2a22}
      .identity{padding:8px 10px 8px;border-bottom:1px solid var(--border)}
      .idline{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}.sym{font-size:16px;font-weight:800}.name{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
      .badge{font-size:10px;font-weight:700;border-radius:999px;padding:1px 7px;background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
      .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-top:6px}
      .stat{background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:4px 6px;min-width:0}.stat span{display:block;color:var(--muted);font-size:9.5px;text-transform:uppercase;letter-spacing:.4px}
      .stat b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .score{display:flex;gap:5px;margin-top:6px}.score button{flex:1;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);padding:4px;cursor:pointer;font-weight:700;font-size:11px}
      .score .bad{color:var(--bad)}.score .warn{color:var(--warn)}.score .good{color:var(--good)}
      .tabs{display:flex;gap:2px;padding:0 6px;border-bottom:1px solid var(--border);background:#0e141f}
      .tabs button{flex:1;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);padding:8px 2px 7px;cursor:pointer;font:600 11.5px Inter,system-ui,sans-serif}
      .tabs button:hover{color:var(--text)}.tabs button.sel{color:var(--text);border-bottom-color:var(--accent2)}
      .content{flex:1;min-height:0;overflow:auto;padding:8px 10px 14px;overscroll-behavior:contain;scrollbar-width:thin}
      .card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin:8px 0}
      .card h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);display:flex;justify-content:space-between;gap:8px}
      details.card>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:8px;font-weight:700;color:var(--text)}details.card>summary .sub{margin-left:auto;font-weight:500}
      details.card>summary::-webkit-details-marker{display:none}details.card>summary::before{content:'▸';color:var(--muted);margin-right:6px}
      details.card[open]>summary::before{content:'▾'}details.card[open]>summary{margin-bottom:6px}
      .row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed #1e293b}.row:last-child{border-bottom:0}
      .row span{color:var(--muted)}.row b{text-align:right;overflow-wrap:anywhere;font-weight:600}
      .sub{font-size:10.5px;color:var(--muted)}.note{padding:7px 9px;border-radius:8px;background:var(--surface2);border:1px solid var(--border);white-space:pre-line;overflow-wrap:anywhere;margin:6px 0}
      .note.good{border-color:#1f5a43;background:#0f2a21}.note.warn{border-color:#5a4417;background:#2a2110}.note.bad{border-color:#5d2430;background:#2a1117}
      .good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.info{color:var(--info)}
      a{color:#7cc4ff;text-decoration:none}a:hover{text-decoration:underline}
      .line{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:5px 0}
      .opt{display:flex;align-items:flex-start;gap:8px;margin:6px 0;cursor:pointer}.opt input{margin-top:2px;flex:none}.opt span{flex:1}
      .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
      .metric{background:var(--surface2);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:2px}.metric span{color:var(--muted);font-size:10px}.metric strong{font-size:14px}
      input,select,textarea{padding:6px 7px;border:1px solid var(--border);border-radius:7px;background:#070b12;color:var(--text);font:11.5px Inter,system-ui,sans-serif;max-width:100%}
      input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid #1c6b55;outline-offset:0}
      input[type=checkbox]{accent-color:var(--accent);margin:0}textarea{width:100%;min-height:90px;resize:vertical}
      .btn{background:var(--surface2);color:var(--text);border:1px solid var(--border);padding:5px 9px;border-radius:7px;font:600 11px Inter,system-ui,sans-serif;cursor:pointer}
      .btn:hover{border-color:#3a4a66}.btn.primary{background:var(--grad);color:#03141a;border-color:transparent}.btn.primary:hover{filter:brightness(1.1)}
      .btn:disabled{opacity:.5;cursor:default}
      .checks{display:flex;flex-direction:column;gap:3px}
      .check{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:7px;background:var(--surface2);border-left:3px solid var(--border)}
      .check.bad{border-left-color:var(--bad)}.check.warn{border-left-color:var(--warn)}.check.good{border-left-color:var(--good)}.check.info{border-left-color:var(--info)}
      .check .ic{width:14px;text-align:center;font-weight:800}.check .lbl{flex:1;color:var(--text)}.check .val{color:var(--muted);font-weight:600;text-align:right;white-space:nowrap}
      .check .src{font-size:9px;color:#5f6d84;margin-left:4px}.check.click{cursor:pointer}.check.click:hover{background:#1e2a3e}
      .chips{display:flex;flex-wrap:wrap;gap:5px}
      .irow{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed #1e293b;min-width:0}.irow:last-child{border-bottom:0}
      .ilabel{font-weight:700;white-space:nowrap}.ilabel.muted{color:var(--muted)}.idetail{flex:1;min-width:0;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pill{font-size:10px;font-weight:700;border-radius:999px;padding:1px 7px;border:1px solid var(--border);white-space:nowrap}.pill.good{color:var(--good);border-color:#1f5a43}.pill.warn{color:var(--warn);border-color:#5a4417}.pill.bad{color:var(--bad);border-color:#5d2430}
      .flow{display:grid;grid-template-columns:62px minmax(0,1fr) 42px 52px;gap:8px;align-items:center;padding:3px 0}.flow.head{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding-bottom:2px}.flow>b{text-align:right;font-size:12px}.flow>b.good{color:var(--good)}.flow>b.bad{color:var(--bad)}.flow .bar{height:7px;border-radius:4px;background:color-mix(in srgb,var(--bad) 55%,transparent);overflow:hidden}.flow .bar>i{display:block;height:100%;background:var(--good)}
      .live{margin-left:auto;font-size:10px;color:var(--muted)}.live.on{color:var(--good)}
      .drop{border:1px dashed var(--border);border-radius:10px;padding:14px;text-align:center;color:var(--muted);cursor:pointer;margin:6px 0}.drop:hover,.drop.over{border-color:var(--accent);color:var(--text)}.drop.busy{cursor:progress;color:var(--accent)}
      .addr{display:inline-flex;align-items:center;gap:3px}.addr .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.copy{background:none;border:0;color:var(--muted);cursor:pointer;padding:0 2px;font-size:11px}.copy:hover{color:var(--accent)}
      .thesis{border-top:1px solid var(--border);padding:5px 0;font-size:12px;overflow-wrap:anywhere}
      .grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin-bottom:6px}.metric.good strong{color:var(--good)}.metric.warn strong{color:var(--warn)}.metric.bad strong{color:var(--bad)}.metric.info strong{color:var(--info)}
      .metric.good,.metric.warn,.metric.bad,.metric.info{color:var(--text)}
      .vamp{padding:7px 0;border-top:1px solid #1e293b}.vamp:first-of-type{border-top:0}.vhead{display:flex;align-items:center;gap:6px;min-width:0}.vhead .name{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
      .vstats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin:5px 0}.vstats div{background:var(--surface2);border-radius:6px;padding:3px 6px}.vstats span{display:block;font-size:9.5px;color:var(--muted);text-transform:uppercase}.vstats b{font-size:12px}
      .vacts{display:flex;gap:10px;font-size:11px}
      .wrow{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed #1e293b}.wrow.current .wname{color:var(--accent)}.wname{font-weight:800}
      .chip.muted{color:var(--muted)}.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-size:11px;font-weight:600}
      .chip:hover{border-color:var(--accent);text-decoration:none}
      .event{padding:7px 0;border-top:1px solid #1e293b;overflow-wrap:anywhere}.event:first-of-type{border-top:0}
      .tag{font-size:9.5px;font-weight:800;border-radius:4px;padding:1px 5px;background:#1f4b63;margin-right:6px}.tag.pump{background:#5c3f0b;color:#ffcf70}.tag.telegram{background:#284a74}
      .event .text{white-space:pre-wrap;margin-top:4px;color:#cdd7e4;max-height:160px;overflow:auto}
      .foot{display:none;padding:6px 10px;border-top:1px solid var(--border);font-size:11px;color:var(--text);background:#0e141f}.foot.show{display:flex}
      .resizer{position:absolute;z-index:3;touch-action:none}.resizer.edge{top:0;bottom:0;width:6px;cursor:ew-resize}.resizer.edge:hover{background:#19e07a33}
      .resizer.corner{right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 55%,#5f6d84 56%,#5f6d84 62%,transparent 63%,transparent 70%,#5f6d84 71%,#5f6d84 77%,transparent 78%)}
      .launcher{width:100%;height:100%;border:1px solid var(--border);background:var(--bg);color:var(--accent);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;box-shadow:0 6px 20px #0009;padding:6px 0}
      .launcher span{writing-mode:vertical-rl;font:800 11px Inter,system-ui,sans-serif;letter-spacing:1px}
      .launcher .dot{width:8px;height:8px;border-radius:50%}
      [hidden]{display:none!important}`;

    function persistLayout() { put(LOCAL.ui, uiSettings); }
    // ---- Page fit: keep the website complete next to the docked sidebar ---------------------------
    // Stage 1: shrink the page to the free width. Stage 2 ("adapt"): elements that a site sizes with the full
    // viewport (100vw) or pins to the window edge (position: fixed) are moved into the free area. Stage 3: if
    // fixed minimum widths still overflow, the page is scaled down by exactly the missing amount.
    const fitTouched = new Map(); // element → its original inline values, restored when undocking
    let fitZoom = 1, fitViewport = 0;
    /** Zoom needed so that `needed` CSS px fit into `avail` px (1 = no zoom). */
    function fitZoomFor(avail, needed) { return needed > avail * 1.03 ? Math.max(0.6, Math.floor(avail / needed * 1000) / 1000) : 1; }
    function pushCss(side, width, zoom = 1) {
      if (!side) return '';
      if (zoom >= 1) return `html{margin-${side}:${width}px!important;width:calc(100% - ${width}px)!important;min-width:0!important;position:relative!important}`;
      const avail = innerWidth - width;
      return `html{zoom:${zoom}!important;margin-${side}:${(width / zoom).toFixed(2)}px!important;width:${(avail / zoom).toFixed(2)}px!important;min-width:0!important;position:relative!important}`;
    }
    function restoreFit() {
      for (const [e, orig] of fitTouched) for (const [k, v] of Object.entries(orig)) v ? e.style.setProperty(k, v.value, v.priority) : e.style.removeProperty(k);
      fitTouched.clear();
    }
    function setStyle(e, prop, value) {
      if (!fitTouched.has(e)) fitTouched.set(e, {});
      const orig = fitTouched.get(e);
      if (!(prop in orig)) { const v = e.style.getPropertyValue(prop); orig[prop] = v ? { value: v, priority: e.style.getPropertyPriority(prop) } : null; }
      e.style.setProperty(prop, value, 'important');
    }
    function setPush(side, width) {
      if (!pushStyle) { pushStyle = document.createElement('style'); pushStyle.id = 'apescope-push'; (document.head || document.documentElement).append(pushStyle); }
      if (!side) { fitZoom = 1; restoreFit(); }
      const css = pushCss(side, width, fitZoom);
      if (css === lastPush) return;
      lastPush = css; pushStyle.textContent = css;
      if (host) host.style.zoom = fitZoom < 1 ? String(1 / fitZoom) : '';   // the sidebar itself is never scaled
      // Charts and responsive layouts recalculate on resize; fire one so they adapt to the new width.
      setTimeout(() => { window.dispatchEvent(new Event('resize')); setTimeout(adaptPage, 250); }, 50);
    }
    function adaptPage() {
      const u = uiSettings;
      if (!host || u.collapsed || !['left', 'right'].includes(u.dock) || u.fit !== 'adapt' || !document.body) return;
      const W = u.width, avail = innerWidth - W, x0 = u.dock === 'left' ? W : 0, x1 = x0 + avail, z = fitZoom;
      const px = v => v.toFixed(1) + 'px';
      // Pinned elements are positioned from their ORIGINAL offsets, so repeated passes and zoom changes stay stable.
      const placeFixed = (e, o) => {
        setStyle(e, 'left', o.L == null ? 'auto' : px(x0 / z + o.L));
        setStyle(e, 'right', o.R == null ? 'auto' : px((innerWidth - x1) / z + o.R));
        setStyle(e, 'max-width', px(avail / z));
      };
      for (const [e, o] of fitTouched) { if (!e.isConnected) { fitTouched.delete(e); continue; } if (o.fixed) placeFixed(e, o.fixed); if (o.vh) setStyle(e, o.vh, px(innerHeight / z)); }
      for (const e of document.body.querySelectorAll('*')) {
        if (e === host || host.contains(e) || fitTouched.get(e)?.fixed) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 40 || r.height < 2) continue;
        const outside = r.left < x0 - 1 || r.right > x1 + 1, tall = z < 1 && Math.abs(r.height - innerHeight * z) < 3;
        if (!outside && !tall) continue;
        const cs = getComputedStyle(e);
        if (outside && cs.position === 'fixed') {
          // Browsers report resolved pixels even for 'auto', so derive the anchor from the geometry:
          // full-width bars keep both edges, everything else stays on the edge it is closer to.
          const L = r.left / z, R = (innerWidth - r.right) / z, full = r.width >= innerWidth * z * 0.9;
          const o = full ? { L, R } : R < L ? { L: null, R } : { L, R: null };
          setStyle(e, '--aps-fixed', '1'); fitTouched.get(e).fixed = o; placeFixed(e, o);
        } else if (outside && (Math.abs(parseFloat(cs.width) - innerWidth) < 2 || Math.abs(parseFloat(cs.minWidth) - innerWidth) < 2)) {
          setStyle(e, 'width', '100%'); setStyle(e, 'min-width', '0px'); // sized with 100vw
        }
        if (tall) for (const prop of ['height', 'min-height']) if (Math.abs(parseFloat(cs[prop === 'height' ? 'height' : 'minHeight']) - innerHeight) < 2) { setStyle(e, prop, px(innerHeight / z)); fitTouched.get(e).vh = prop; }
      }
      // Whatever still overflows comes from fixed minimum widths: scale the page by exactly that amount.
      const needed = Math.max(document.body.scrollWidth, document.body.clientWidth) * fitZoom, nz = fitZoomFor(avail, needed);
      if (nz < 1 && nz < fitZoom - 0.005) { fitZoom = nz; setPush(u.dock, W); }
    }
    function applyLayout() {
      if (!host) return;
      const u = uiSettings, docked = u.dock === 'left' || u.dock === 'right', side = u.dock === 'left' ? 'left' : 'right';
      host.style.cssText = 'position:fixed;z-index:2147482000;color-scheme:dark;';
      if (fitZoom < 1 && !u.collapsed && u.dock !== 'float') host.style.zoom = String(1 / fitZoom);
      if (u.collapsed) {
        Object.assign(host.style, { top: '38%', [side]: '0', width: '30px', height: '132px' });
        panel.hidden = true; launcher.hidden = false; resizer.hidden = true; setPush('', 0);
        launcher.style.borderRadius = side === 'left' ? '0 10px 10px 0' : '10px 0 0 10px';
        return;
      }
      panel.hidden = false; launcher.hidden = true; resizer.hidden = false;
      panel.className = 'panel ' + (docked ? 'docked' : 'float');
      if (docked) {
        u.width = Math.round(Math.max(300, Math.min(Number(u.width) || 380, 720, innerWidth - 320)));
        Object.assign(host.style, { top: '0', bottom: '0', height: '100vh', width: u.width + 'px', [side]: '0' });
        resizer.className = 'resizer edge'; resizer.style.left = side === 'right' ? '0' : ''; resizer.style.right = side === 'left' ? '0' : '';
        if (fitViewport !== innerWidth) { fitViewport = innerWidth; fitZoom = 1; }   // re-measure after a real window resize
        if (u.fit === 'overlay') setPush('', 0); else setPush(side, u.width);
      } else {
        u.w = Math.max(320, Math.min(Number(u.w) || 400, innerWidth - 12)); u.h = Math.max(260, Math.min(Number(u.h) || 640, innerHeight - 12));
        u.x = Math.min(Math.max(0, Number(u.x) || 0), Math.max(0, innerWidth - u.w)); u.y = Math.min(Math.max(0, Number(u.y) || 0), Math.max(0, innerHeight - 60));
        Object.assign(host.style, { left: u.x + 'px', top: u.y + 'px', width: u.w + 'px', height: u.h + 'px' });
        resizer.className = 'resizer corner'; resizer.style.left = ''; resizer.style.right = '';
        setPush('', 0);
      }
    }
    function setDock(mode) { uiSettings.dock = mode; uiSettings.collapsed = false; fitZoom = 1; restoreFit(); lastPush = null; applyLayout(); persistLayout(); render(); }
    function setCollapsed(v) { uiSettings.collapsed = v; applyLayout(); persistLayout(); if (!v) render(); }
    function swapTab(id) { uiSettings.tab = id; persistLayout(); render(); body?.scrollTo?.(0, 0); }
    function makeUI() {
      if (host) return;
      host = el('div', { id: 'apescope-root' });
      root = host.attachShadow({ mode: 'open' });
      el('style', { text: CSS }, root);
      panel = el('div', { class: 'panel' }, root);
      const head = el('header', { class: 'head' }, panel);
      const brand = el('div', { class: 'brand' }, head); logo(brand); el('span', { text: APP }, brand); el('small', { text: 'v' + VERSION }, brand);
      const dockBtn = (label, mode, title) => { const b = el('button', { class: 'iconbtn' + (uiSettings.dock === mode ? ' on' : ''), text: label, title, type: 'button' }, head); b.dataset.mode = mode; b.onclick = () => setDock(mode); return b; };
      dockBtn('◧', 'left', 'Dock left (pushes the page)'); dockBtn('◨', 'right', 'Dock right (pushes the page)'); dockBtn('⧉', 'float', 'Floating window');
      el('button', { class: 'iconbtn', text: '—', title: 'Collapse', type: 'button', onclick: () => setCollapsed(true) }, head);
      identity = el('div', { class: 'identity' }, panel);
      tabStrip = el('nav', { class: 'tabs' }, panel);
      body = el('div', { class: 'content' }, panel);
      const foot = el('footer', { class: 'foot' }, panel);
      statusBox = el('span', { text: '' }, foot);
      resizer = el('div', { class: 'resizer', title: 'Drag to resize' }, root);
      launcher = el('button', { class: 'launcher', title: 'Open ' + APP, type: 'button', onclick: () => setCollapsed(false) }, root);
      logo(launcher, 16); el('span', { text: APP }, launcher); el('i', { class: 'dot' }, launcher);
      // Drag (floating) and resize (both modes) with pointer capture.
      head.addEventListener('pointerdown', e => {
        if (uiSettings.dock !== 'float' || e.button !== 0 || e.target.closest('button')) return;
        drag = { mode: 'move', id: e.pointerId, sx: e.clientX, sy: e.clientY, x: uiSettings.x, y: uiSettings.y }; head.setPointerCapture(e.pointerId); e.preventDefault();
      });
      head.addEventListener('pointermove', e => { if (drag?.mode !== 'move' || drag.id !== e.pointerId) return; uiSettings.x = drag.x + e.clientX - drag.sx; uiSettings.y = drag.y + e.clientY - drag.sy; applyLayout(); });
      resizer.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        drag = { mode: 'resize', id: e.pointerId, sx: e.clientX, sy: e.clientY, width: uiSettings.width, w: uiSettings.w, h: uiSettings.h }; resizer.setPointerCapture(e.pointerId); e.preventDefault();
      });
      resizer.addEventListener('pointermove', e => {
        if (drag?.mode !== 'resize' || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.sx;
        fitZoom = 1;
        if (uiSettings.dock === 'right') uiSettings.width = drag.width - dx;
        else if (uiSettings.dock === 'left') uiSettings.width = drag.width + dx;
        else { uiSettings.w = drag.w + dx; uiSettings.h = drag.h + e.clientY - drag.sy; }
        applyLayout();
      });
      const endDrag = e => { if (drag && drag.id === e.pointerId) { drag = null; persistLayout(); } };
      for (const n of [head, resizer]) { n.addEventListener('pointerup', endDrag); n.addEventListener('pointercancel', endDrag); }
      document.documentElement.append(host); applyLayout(); render();
    }

    // ---- Rendering ---------------------------------------------------------------------------
    function render() {
      if (!root || uiSettings.collapsed) return;
      for (const b of root.querySelectorAll('.head .iconbtn[data-mode]')) b.classList.toggle('on', b.dataset.mode === uiSettings.dock);
      renderIdentity();
      tabStrip.replaceChildren();
      for (const [id, label] of TABS) { const b = button(tabStrip, label, () => swapTab(id)); b.className = uiSettings.tab === id ? 'sel' : ''; if (id === 'settings') b.title = 'Settings'; }
      body.replaceChildren();
      ({ overview: renderOverview, project: renderProject, socials: renderSocials, ai: renderAi, watchlist: renderWatchlist, settings: renderSettings })[uiSettings.tab]?.(body);
      const dot = launcher.querySelector('.dot'), c = countChecks();
      if (dot) dot.style.background = c.bad ? 'var(--bad)' : c.warn ? 'var(--warn)' : c.good ? 'var(--good)' : 'var(--muted)';
    }
    let toastTimer = 0;
    function alertLine(m) {
      if (!statusBox) return;
      statusBox.textContent = String(m).slice(0, 120); statusBox.parentElement.classList.add('show');
      clearTimeout(toastTimer); toastTimer = setTimeout(() => { statusBox.textContent = ''; statusBox.parentElement.classList.remove('show'); }, 4500);
    }
    function scheduleRender() {
      if (scheduledRender) return;
      scheduledRender = setTimeout(() => {
        scheduledRender = 0;
        const active = root?.activeElement;
        if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return; // never steal focus while typing
        render();
      }, 220);
    }
    function tokenNames() {
      const m = s.market, p = s.project || {};
      return { symbol: m?.symbol || p.jup?.symbol || p.gt?.symbol || '', name: m?.name || p.jup?.name || p.gt?.name || '' };
    }
    function renderIdentity() {
      identity.replaceChildren();
      if (!s.coin) { el('div', { class: 'sub', text: s.errors.detect || 'Open a token on fomo to analyse it.' }, identity); return; }
      const m = s.market, { symbol, name } = tokenNames();
      const line = el('div', { class: 'idline' }, identity);
      el('span', { class: 'sym', text: symbol ? '$' + symbol : short(s.coin.ca) }, line);
      if (name) el('span', { class: 'name', text: name }, line);
      line.append(addrLink(s.coin.ca));
      el('span', { class: 'badge', text: CHAINS[s.coin.chain].name }, line);
      if (m?.createdAt) el('span', { class: 'badge', text: age(m.createdAt) + ' old' }, line);
      if (s.lastDexAt && s.lastMarketKey === curKey()) {
        const secs = Math.round((Date.now() - s.lastDexAt) / 1000);
        el('span', { class: 'live ' + (secs <= 20 ? 'on' : ''), title: 'Market data age — refreshed every few seconds', text: secs <= 20 ? '● live' : '● ' + secs + ' s' }, line);
      }
      const st = el('div', { class: 'stats' }, identity);
      const stat = (label, value, cls = '') => { const d = el('div', { class: 'stat' }, st); el('span', { text: label }, d); el('b', { text: value, class: cls }, d); };
      const holders = s.gmgn?.key === curKey() ? s.gmgn.data?.holders : null;
      stat('MCap', m ? money(m.marketCap) : s.loading.dex ? '…' : '—');
      stat('Liquidity', m ? money(m.liquidity) : '—');
      stat('Vol 1h', m ? money(m.volume1h) : '—');
      if (m?.change5m != null) stat('5m', (m.change5m > 0 ? '+' : '') + m.change5m + '%', m.change5m >= 0 ? 'good' : 'bad');
      else stat('Holders', number(holders ?? s.project?.jup?.holders ?? s.sec?.holder_count));
      const c = countChecks(), score = el('div', { class: 'score' }, identity);
      for (const [lvl, icon, label] of [['bad', '✖', 'red'], ['warn', '▲', 'warn'], ['good', '✔', 'good']])
        el('button', { class: lvl, type: 'button', text: `${icon} ${c[lvl]} ${label}`, title: 'Show checks', onclick: () => swapTab('overview') }, score);
    }

    // ---- Checks: every quick-decision signal in one list, grouped by severity ----------------
    function buildChecks() {
      const out = [];
      const add = (level, label, value = '', src = '', action = null) => out.push({ level, label, value: String(value ?? ''), src,
        action: typeof action === 'string' ? (action ? () => GM_openInTab(action, { active: true }) : null) : action });
      const gmTok = GMGN_CHAIN[s.coin?.chain] ? `https://gmgn.ai/${GMGN_CHAIN[s.coin.chain]}/token/${s.coin.ca}` : '', bubbles = GMGN_CHAIN[s.coin?.chain] ? `https://app.bubblemaps.io/${GMGN_CHAIN[s.coin.chain]}/token/${s.coin.ca}` : '';
      if (!s.coin) return out;
      const m = s.market, sec = s.sec, rc = s.rugcheck, p = s.project?.key === curKey() ? s.project : null, j = p?.jup;
      const g = s.gmgn?.key === curKey() ? s.gmgn.data : null;
      if (m) {
        if (m.dexPaid === true) add('good', 'DexScreener profile paid', 'yes', 'DexScreener');
        else if (m.dexProcessing) add('info', 'DexScreener payment processing', '⏳', 'DexScreener');
        else if (m.dexPaid === false) add('warn', 'DexScreener profile not paid', 'no', 'DexScreener');
        if (m.ctoActive) add('good', 'Community takeover (CTO)', 'active', 'DexScreener');
        if (m.adsActive) add('info', 'DexScreener ads running', 'yes', 'DexScreener');
        if (m.boosts > 0) add('info', 'Active boosts', '⚡ ' + m.boosts, 'DexScreener');
        if (m.liqMcapPct != null) add(m.liqMcapPct < 3 ? 'bad' : m.liqMcapPct < 7 ? 'warn' : 'good', 'Liquidity vs. market cap', pctTxt(m.liqMcapPct), 'DexScreener');
        if (m.liquidity != null && m.liquidity < prefs.minLiq) add('bad', 'Liquidity below your limit', money(m.liquidity), 'DexScreener');
        if (m.volVelocity != null) add(m.volVelocity >= 2 ? 'good' : m.volVelocity < 0.5 ? 'warn' : 'info', 'Volume velocity (5m vs. 1h avg)', m.volVelocity.toFixed(1) + '×', 'DexScreener');
        if (m.suspectedBumpBot) add('bad', 'Bump-bot pattern (many tiny trades)', 'avg ' + money(m.avgTrade5m), 'DexScreener');
        if (m.createdAt && Date.now() - m.createdAt < 3600e3) add('info', 'Fresh pool', age(m.createdAt) + ' old', 'DexScreener');
      }
      if (s.coin && (m || p) && !projectLinks().length) add('warn', 'No website or socials found', '', 'DexScreener/Jupiter/GT', () => swapTab('project'));
      if (sec) {
        for (const f of s.secFlags) add(f.severity === 'high' ? 'bad' : 'warn', f.title, f.detail, 'GoPlus');
        if (!s.secFlags.length) add('good', 'No contract risk flags', 'not an audit', 'GoPlus');
        const t10 = s.coin.chain === 'solana' ? top10Pct() : sec.top10Pct;
        if (t10 != null) add(t10 > 35 ? 'bad' : t10 > 22 ? 'warn' : 'good', 'Top 10 holders', pctTxt(t10, 0) + (s.coin.chain === 'solana' ? ' · excl. pools' : ''), 'GoPlus', bubbles);
        if (sec.creatorPct != null) add(sec.creatorPct > 5 ? 'bad' : 'good', 'Creator holds', pctTxt(sec.creatorPct), 'GoPlus');
      } else if (g?.top10Pct != null) add(g.top10Pct > 35 ? 'bad' : g.top10Pct > 22 ? 'warn' : 'good', 'Top 10 holders', pctTxt(g.top10Pct, 0), 'GMGN', bubbles);
      const lpSources = [[sec?.lpLockedPct, 'GoPlus'], [s.coin.chain === 'solana' ? g?.burnPct : null, 'GMGN'], [rc?.lpLockedPct, 'RugCheck']];
      const lp = lpSources.find(([v]) => v != null);
      if (lp) add(lp[0] >= 90 ? 'good' : lp[0] >= 50 ? 'warn' : 'bad', 'LP locked or burned', pctTxt(lp[0], 0), lp[1], s.coin.chain === 'solana' ? 'https://rugcheck.xyz/tokens/' + s.coin.ca : '');
      if (s.hp?.isHoneypot === true) add('bad', 'Honeypot (sell simulation failed)', 'critical', 'Honeypot.is');
      else if (s.hp?.isHoneypot === false) add('good', 'Sell simulation passed', `tax ${s.hp.buyTax ?? '—'}% / ${s.hp.sellTax ?? '—'}%`, 'Honeypot.is');
      if (s.hp?.sellTax > 10) add('warn', 'High sell tax', s.hp.sellTax + '%', 'Honeypot.is');
      if (rc) {
        for (const r of rc.risks.filter(r => r.level === 'danger').slice(0, 4)) add('bad', r.name, r.value, 'RugCheck');
        const warns = rc.risks.filter(r => r.level === 'warn');
        if (warns.length) add('warn', warns.length === 1 ? warns[0].name : warns.length + ' risk warnings', warns.length === 1 ? warns[0].value : warns.map(r => r.name).slice(0, 2).join(', '), 'RugCheck');
        if (!rc.risks.length) add('good', 'Rug report clean', '', 'RugCheck');
      }
      if (j) {
        if (j.organicScore != null) {
          // Jupiter rates how much volume comes from real, established traders. New coins start near 0 (snipers, bots,
          // fresh wallets dominate), so the score only means something after a few hours of trading.
          const ageH = s.market?.createdAt ? (Date.now() - s.market.createdAt) / 3600e3 : null, sc = Math.round(j.organicScore);
          if (ageH != null && ageH < 6) add(sc >= 30 ? 'good' : 'info', 'Organic trading score', sc + ' · coin < 6 h, not meaningful yet', 'Jupiter');
          else add(sc >= 60 ? 'good' : sc >= 25 ? 'info' : ageH != null && ageH < 48 ? 'warn' : 'bad', 'Organic trading score', sc + (j.organicLabel ? ' · ' + j.organicLabel : ''), 'Jupiter');
        }
        if (j.isSus) add('bad', 'Flagged as suspicious', 'isSus', 'Jupiter');
        if (j.verified) add('good', 'Verified token', 'yes', 'Jupiter');
        if (j.mintDisabled === false) add('bad', 'Mint authority enabled', '', 'Jupiter');
        if (j.freezeDisabled === false) add('bad', 'Freeze authority enabled', '', 'Jupiter');
        if (j.mintDisabled === true && j.freezeDisabled === true) add('good', 'Mint & freeze authority revoked', '', 'Jupiter');
      }
      const devCreated = j?.devMints ?? g?.devCreated;
      if (devCreated > 1) add(devCreated >= 10 ? 'bad' : 'warn', devCreated >= 10 ? 'Serial deployer' : 'Dev launched other tokens', number(devCreated) + ' tokens' + (j?.devMigrations != null ? ` · ${j.devMigrations} migrated` : ''), j?.devMints != null ? 'Jupiter' : 'GMGN', gmgnWallet(g?.extra?.dev?.address || j?.dev) || (() => swapTab('overview')));
      if (g) {
        const tier = (v, warn, bad) => v > bad ? 'bad' : v > warn ? 'warn' : 'good';
        if (g.bundlerPct != null) add(tier(g.bundlerPct, 10, 25), 'Bundlers', pctTxt(g.bundlerPct), 'GMGN', gmTok);
        if (g.phishingPct != null) add(tier(g.phishingPct, 5, 20), 'Phishing / entrapment wallets', pctTxt(g.phishingPct), 'GMGN', gmTok);
        if (g.insiderPct != null) add(tier(g.insiderPct, 5, 15), 'Insiders (rat traders)', pctTxt(g.insiderPct), 'GMGN', gmTok);
        if (g.devHoldPct != null && g.devHoldPct > 0) add(tier(g.devHoldPct, 2, 5), 'Dev team holds', pctTxt(g.devHoldPct), 'GMGN');
        if (g.sniperHoldPct != null && g.sniperHoldPct > 0) add(g.sniperHoldPct > 10 ? 'warn' : 'info', 'Snipers still hold', pctTxt(g.sniperHoldPct), 'GMGN');
        if (g.botPct != null) add(g.botPct > 60 ? 'warn' : 'info', 'Bot traders', pctTxt(g.botPct, 0), 'GMGN');

        if (g.smartMoney != null) add(g.smartMoney >= 5 ? 'good' : 'info', 'Smart money holders', capped(g.smartMoney), 'GMGN');
        if (g.kols != null && g.kols > 0) add(g.kols >= 3 ? 'good' : 'info', 'KOL holders', capped(g.kols), 'GMGN');
      } else if (prefs.gmgn && GMGN_CHAIN[s.coin.chain]) {
        const blocked = /security check/.test(s.errors.gmgn || '');
        if (s.loading.gmgn) add('info', 'Loading holder analysis…', '', 'GMGN');
        else if (blocked) add('warn', 'GMGN needs a security check', 'open GMGN', 'GMGN', () => GM_openInTab('https://gmgn.ai/', { active: true, reuse: true }));
        else add('info', 'Holder analysis not loaded', 'connect GMGN', 'GMGN', () => openGmgnWorker(true));
      }
      const intel = s.intel?.key === curKey() ? s.intel : null;
      for (const w of intel?.web || []) {
        if (w.rdap?.registered) { const d = (Date.now() - w.rdap.registered) / 86400000; add(d < 7 ? 'bad' : d < 30 ? 'warn' : d >= 180 ? 'good' : 'info', 'Website domain age', `${w.domain} · ${age(w.rdap.registered)}`, 'RDAP', w.url); }
        if (!w.page?.ok && (w.page || w.error)) add('warn', 'Website not reachable', w.domain + (w.page?.status ? ' · HTTP ' + w.page.status : ''), 'website', () => swapTab('project'));
      }
      {
        const pages = caPresence();
        const other = pages.find(x => x.status === 'other'), found = pages.filter(x => x.status === 'found');
        if (other) add('bad', 'Other CA on project page', `${other.label}: ${short(other.other)}`, other.kind, other.url);
        else if (found.length) add('good', 'CA shown on project page', found.map(x => x.label).join(', '), found[0].kind, found[0].url);
        else if (pages.length) add('warn', 'CA not found on project pages', pages.map(x => x.label).join(', '), pages[0].kind, pages[0].url);
      }
      for (const x of intel?.x || []) {
        const u = x.user; if (!u) continue;
        if (u.joined) { const d = (Date.now() - u.joined) / 86400000; add(d < 7 ? 'bad' : d < 30 ? 'warn' : d >= 365 ? 'good' : 'info', 'X account age', '@' + u.handle + ' · ' + age(u.joined), 'FxTwitter', 'https://x.com/' + u.handle); }
        if (u.followers != null) add(u.followers < 100 ? 'warn' : u.followers >= 10000 ? 'good' : 'info', 'X followers', number(u.followers), 'FxTwitter', 'https://x.com/' + u.handle);
      }
      const sim = s.similar?.key === curKey() ? s.similar.list : [];
      const ownCreated = m?.createdAt, { symbol } = tokenNames();
      const original = sim.find(x => normTok(x.symbol) === normTok(symbol) && x.createdAt && ownCreated && x.createdAt < ownCreated && (x.marketCap || 0) > (m?.marketCap || 0));
      if (original) add('bad', 'Possible copycat of an older token', `$${original.symbol} on ${CHAINS[original.chain]?.name || original.chainId} · ${money(original.marketCap)}`, 'DexScreener', () => swapTab('project'));
      const gx = g?.extra;
      if (gx) {
        if (gx.imageDup > 0) add(gx.imageDup >= 3 ? 'bad' : 'warn', 'Logo reused by other tokens', String(gx.imageDup), 'GMGN', gmTok);
        if (gx.dev.xRenames > 0) add('warn', 'X account was renamed', gx.dev.xRenames + '×', 'GMGN');
        if (gx.dev.xDeletedPosts > 0) add('warn', 'Deleted X posts', String(gx.dev.xDeletedPosts), 'GMGN');
        if (gx.dev.status === 'creator_close') add('info', 'Dev sold everything', '', 'GMGN', gmgnWallet(gx.dev.address));
        if (gx.feesPaid != null) add('info', 'Fees paid by traders', gx.feesPaid.toFixed(2) + ' SOL', 'GMGN', () => swapTab('project'));
      }
      const h1 = flowWindows().find(r => r.k === 'h1');
      if (h1?.share != null) { if (h1.share < 35) add('bad', 'Heavy selling (1h)', h1.share.toFixed(0) + '% buys', h1.byVolume ? 'Jupiter' : 'DexScreener', () => swapTab('overview')); else if (h1.share > 65) add('good', 'Strong buying (1h)', h1.share.toFixed(0) + '% buys', h1.byVolume ? 'Jupiter' : 'DexScreener', () => swapTab('overview')); }
      {
        const cf = s.clusters?.key === curKey() ? s.clusters.fresh : null, gfr = s.gmgn?.key === curKey() ? s.gmgn.data?.freshPct ?? null : null;
        if (cf || gfr != null) {
          const parts = [cf ? `${cf.count} of ${s.clusters.checked} top wallets (${pctTxt(cf.pct, 0)})` : '', gfr != null ? `GMGN ${pctTxt(gfr, 0)} of holders` : ''].filter(Boolean).join(' · ');
          const lvl = (cf && (cf.count >= 5 || cf.pct >= 20)) || gfr > 40 ? 'bad' : (cf && (cf.count >= 3 || cf.pct >= 10)) || gfr > 25 ? 'warn' : 'good';
          add(lvl, lvl === 'good' ? 'Few fresh wallets' : 'Fresh wallets', parts, 'RPC / GMGN', () => swapTab('overview'));
        }
      }
      const pf = s.pump?.key === curKey() ? s.pump : null;
      if (pf?.callouts.length) {
        const big = pumpCallers().filter(c => (c.xFollowers || 0) >= 10000);
        if (big.length) add('good', 'Big callers on pump.fun', `${big.length} with 10K+ X followers`, 'pump.fun', () => swapTab('socials'));
        const best = Math.max(...pf.callouts.map(c => c.maxMultiple || 0));
        add(pf.callouts.length >= 5 ? 'good' : 'info', 'pump.fun callouts', `${pf.callouts.length}${best >= 2 ? ' · best ' + best.toFixed(1) + '×' : ''}`, 'pump.fun', () => swapTab('socials'));
      }
      const fees = pf?.fees;
      if (fees?.shareholders?.length) {
        const sh = fees.shareholders, claimed = sh.reduce((n, x) => n + (x.claimed || 0), 0), claims = sh.reduce((n, x) => n + (x.claims || 0), 0);
        add('info', 'Creator fees go to', sh.map(x => (x.platform ? x.platform + ' @' + x.username : short(x.address)) + ' ' + (x.bps / 100) + '%').join(', '), 'pump.fun', () => swapTab('project'));
        if (claims) add('info', 'Fees claimed', `${claims}× · ${claimed.toFixed(2)} SOL`, 'on-chain', () => swapTab('project'));
      }
      const fo = fomoData();
      if (fo) {
        const callers = fomoCallers(), big = (fo.top || []).filter(h => h.followers >= 10000 && h.value > 0);
        if (callers.some(c => c.isDev)) add('info', 'Dev posted a fomo thesis', '@' + callers.find(c => c.isDev).author, 'fomo', () => swapTab('socials'));
        if (big.length) add('good', 'Big fomo accounts holding', big.length + ' with 10K+ followers', 'fomo', () => swapTab('socials'));
        const hour = fomoTheses().filter(i => i.ts >= Math.floor(Date.now() / 1000) - 3600).length;
        if (hour >= 10) add('info', 'fomo theses (1h)', String(hour), 'fomo', () => swapTab('socials'));
      }
      if (h1?.holderChange != null) { if (h1.holderChange <= -1) add('warn', 'Holders decreasing (1h)', changeTxt(h1.holderChange), 'Jupiter'); else if (h1.holderChange >= 3) add('good', 'Holders growing (1h)', changeTxt(h1.holderChange), 'Jupiter'); }
      const cl = s.clusters?.key === curKey() ? s.clusters : null, devAddr = g?.extra?.dev?.address || j?.dev || '';
      if (cl) {
        const top = cl.clusters[0];
        if (cl.clusters.some(c => c.funder === devAddr)) add('bad', 'Top holders funded by the dev', cl.clusters.find(c => c.funder === devAddr).holders.length + ' wallets', 'RPC', gmgnWallet(devAddr));
        if (top) add(top.pct >= 10 ? 'bad' : 'warn', 'Wallet cluster among top holders', `${top.holders.length} wallets · ${pctTxt(top.pct)}`, 'RPC', gmgnWallet(top.funder));
        else if (cl.checked) add('good', 'No wallet clusters in top holders', cl.checked + ' wallets checked', 'RPC');
      } else if (s.loading.clusters) add('info', 'Checking wallet clusters…', '', 'RPC');
      const recent = recentSimilar();
      if (recent.length) add('warn', 'Look-alikes launched in the last 14 days', recent.length, 'DexScreener', () => swapTab('project'));
      const past = Math.floor(Date.now() / 1000), fresh = s.events.filter(e => e.timestamp >= past - 900 && e.source !== 'manual').length;
      if (fresh >= 3) add('good', 'Active social signals', fresh + ' in 15m', 'X / pump.fun', () => swapTab('socials'));
      const ai = s.aiResults?.analysis?.json;
      if (ai?.verdict) add(/legit/i.test(ai.verdict) ? 'good' : /scam|risky/i.test(ai.verdict) ? 'bad' : 'warn', 'ChatGPT verdict', String(ai.verdict).slice(0, 20) + (ai.score != null ? ' · ' + ai.score + '/100' : ''), 'AI', () => swapTab('ai'));
      if (ai?.trade?.action) add(/enter now/i.test(ai.trade.action) ? 'good' : /don.t|avoid/i.test(ai.trade.action) ? 'bad' : 'info', 'ChatGPT trade plan', String(ai.trade.action).slice(0, 24), 'AI', () => swapTab('ai'));
      return out;
    }
    const capped = n => n >= 1000 ? '1000+' : number(n);
    function countChecks() { const c = { bad: 0, warn: 0, good: 0, info: 0 }; for (const x of buildChecks()) c[x.level]++; return c; }
    function renderChecks(parent, checks) {
      const groups = [['bad', '✖', 'Red flags'], ['warn', '▲', 'Warnings'], ['good', '✔', 'Good signs'], ['info', 'ℹ', 'Info']];
      for (const [lvl, icon, title] of groups) {
        const items = checks.filter(c => c.level === lvl);
        if (!items.length) continue;
        const card = section(parent, title, String(items.length)), list = el('div', { class: 'checks' }, card);
        for (const c of items) {
          const r = el('div', { class: 'check ' + lvl + (c.action ? ' click' : '') }, list);
          el('span', { class: 'ic ' + lvl, text: icon }, r);
          el('span', { class: 'lbl', text: c.label }, r);
          if (c.value) el('span', { class: 'val', text: c.value }, r);
          if (c.action) r.addEventListener('click', c.action);
        }
      }
    }
    function renderLinkChips(parent) {
      const chips = el('div', { class: 'chips' }, parent);
      for (const q of quickLinks().filter(q => q.group === 'trade' || ['DexScreener', 'Bubblemaps'].includes(q.label)))
        if (!(q.label === 'FOMO' && location.pathname.includes(s.coin.ca))) chips.append(link(q.label, q.url, 'chip'));
      return chips;
    }

    // ---- Tab: Overview -----------------------------------------------------------------------
    function renderOverview(parent) {
      for (const k of ['detect', 'dex']) if (s.errors[k]) el('div', { class: 'note warn', text: s.errors[k] }, parent);
      if (!s.coin) { el('div', { class: 'note', text: 'Open a token on fomo — ApeScope follows the token you are looking at.' }, parent); return; }
      const checks = buildChecks();
      if (!checks.length) el('div', { class: 'note', text: s.loading.dex || s.loading.sec ? 'Loading data…' : 'No data yet.' }, parent);
      renderChecks(parent, checks);
      renderDevCard(section(parent, 'Developer'));
      renderFlowCard(section(parent, 'Buy / sell pressure'));
      renderLinkChips(section(parent, 'Trade'));
      renderMarketDetails(collapsible(parent, 'market', 'Market details', s.market ? money(s.market.marketCap) + ' MC' : ''));
      renderSecurityDetails(collapsible(parent, 'security', 'Security details', s.secFlags.length ? s.secFlags.length + ' GoPlus flags' : ''));
      renderHolders(collapsible(parent, 'holders', 'Holders & clusters', s.clusters?.key === curKey() && s.clusters.clusters.length ? s.clusters.clusters.length + ' cluster(s)' : s.sec?.holder_count ? number(s.sec.holder_count) + ' holders' : ''));
    }
    function renderMarketDetails(box) {
      const m = s.market;
      if (!m) { el('div', { class: 'sub', text: s.loading.dex ? 'Loading…' : s.errors.dex || 'No market data.' }, box); button(box, 'Load market data', () => refreshMarket(true)); return; }
      const g = el('div', { class: 'grid' }, box);
      metric(g, 'Market cap', money(m.marketCap)); metric(g, 'FDV', money(m.fdv)); metric(g, 'Liquidity', money(m.liquidity)); metric(g, 'Price', m.priceUsd ? '$' + Number(m.priceUsd).toPrecision(4) : '—');
      row(box, 'Volume 5m / 1h / 24h', `${money(m.volume5m)} / ${money(m.volume1h)} / ${money(m.volume24h)}`);
      row(box, 'Buys / sells 5m', `${number(m.buys5m)} / ${number(m.sells5m)}`); row(box, 'Avg. trade 5m', money(m.avgTrade5m));
      row(box, 'Change 5m', m.change5m == null ? '—' : m.change5m + '%'); row(box, 'Pool created', m.createdAt ? localTime(m.createdAt) + ' · ' + age(m.createdAt) : '—');
      { const pr = row(box, 'DEX / pool', m.dex || '—'); if (m.pair) pr.append(addrLink(m.pair, m.url || explorerUrl(m.pair))); } row(box, 'DexScreener paid', m.dexPaid === true ? 'yes' : m.dexProcessing ? 'processing' : m.dexPaid === false ? 'no' : 'unknown');
      const old = s.history.find(h => h.ts < Date.now() - 5 * 60e3);
      if (old?.liquidity && m.liquidity != null) row(box, 'Liquidity change', ((m.liquidity / old.liquidity - 1) * 100).toFixed(1) + '%');
      const l = el('div', { class: 'line' }, box); button(l, 'Reload', () => refreshMarket(true)); if (m.url) l.append(link('Open DexScreener ↗', m.url));
    }
    function renderSecurityDetails(box) {
      const l = el('div', { class: 'line' }, box); button(l, 'Re-check', () => refreshSecurity(true));
      if (s.loading.sec) el('div', { class: 'sub', text: 'Loading…' }, box);
      if (s.errors.sec) el('div', { class: 'note warn', text: s.errors.sec }, box);
      if (s.sec) {
        row(box, 'Holders', number(s.sec.holder_count)); row(box, 'Top 10 (reported accounts)', pctTxt(s.sec.top10Pct));
        row(box, 'Creator share', pctTxt(s.sec.creatorPct, 2)); row(box, 'LP locked / burned', pctTxt(s.sec.lpLockedPct));
        { const cr = row(box, 'Creator', s.sec.creator ? '' : '—'); if (s.sec.creator) cr.append(addrLink(s.sec.creator)); }
        if (s.sec.creator && CHAINS[s.coin.chain].explorer && isValidAddress(s.sec.creator, s.coin.chain)) {
          const c = el('div', { class: 'line' }, box); c.append(link('Creator in explorer ↗', CHAINS[s.coin.chain].explorer + s.sec.creator)); button(c, 'Check creator address', loadCreatorRisk);
        }
        if (s.creatorSecurity) el('div', { class: 'note ' + (s.creatorSecurity.risk ? 'bad' : ''), text: 'Creator address: ' + s.creatorSecurity.message }, box);
      }
      if (s.coin.chain === 'solana') {
        const rc = s.rugcheck, h = el('div', { class: 'sub', text: 'Rug report' }, box); h.style.marginTop = '8px';
        if (!rc) el('div', { class: 'sub', text: s.loading.rugcheck ? 'Loading…' : s.errors.rugcheck || 'No rug report.' }, box);
        else {
          row(box, 'Risk score (lower is better)', rc.score ?? '—'); row(box, 'LP locked', pctTxt(rc.lpLockedPct));
          for (const r of rc.risks) el('div', { class: 'note ' + (r.level === 'danger' ? 'bad' : r.level === 'warn' ? 'warn' : ''), text: r.name + (r.value ? ' · ' + r.value : '') + (r.description ? '\n' + r.description : '') }, box);
        }
      }
      if (['ethereum', 'bsc', 'base'].includes(s.coin.chain)) {
        const hp = s.hp;
        if (!hp) el('div', { class: 'sub', text: 'Sell simulation: ' + (s.loading.honeypot ? 'loading…' : s.errors.honeypot || 'not available') }, box);
        else { row(box, 'Honeypot (sell simulation)', hp.isHoneypot === true ? 'YES — critical' : hp.isHoneypot === false ? 'no' : 'unknown'); row(box, 'Buy / sell tax', `${hp.buyTax ?? '—'}% / ${hp.sellTax ?? '—'}%`); if (hp.error) el('div', { class: 'note warn', text: hp.error }, box); }
      }
    }
    function renderHolders(box) {
      const sec = s.sec;
      renderClusters(box);
      if (!sec?.holders?.length) el('div', { class: 'sub', text: 'No holder list available.' }, box);
      for (const h of sec?.holders?.slice(0, 12) || []) {
        const d = el('div', { class: 'row' }, box);
        d.append(CHAINS[s.coin.chain].explorer && isValidAddress(h.address, s.coin.chain) ? link(short(h.address) + (h.tag ? ' · ' + h.tag : ''), CHAINS[s.coin.chain].explorer + h.address) : el('span', { text: short(h.address) }));
        el('b', { text: h.percent == null ? '—' : h.percent.toFixed(2) + '%' }, d);
      }
      const snaps = s.history.filter(h => h.holders != null);
      if (snaps.length > 1) row(box, 'Holder change since first local snapshot', String(snaps.at(-1).holders - snaps[0].holders));
      if (s.coin.chain === 'solana') {
        button(box, 'Load largest holders', async () => {
          try { const j = await solRPC('getTokenLargestAccounts', [s.coin.ca]); s.rpcAccounts = (j?.value || []).map(x => ({ address: x.address, amount: x.uiAmountString })); alertLine('Largest holders loaded'); }
          catch (e) { alertLine(e.message); }
          scheduleRender();
        });
        for (const w of s.rpcAccounts.slice(0, 20)) { const d = el('div', { class: 'row' }, box); d.append(link(short(w.address), CHAINS.solana.explorer + w.address)); el('b', { text: number(Number(w.amount)) }, d); }
      }
    }

    // ---- Buy/sell pressure and holder growth (Jupiter windows on Solana, DexScreener transactions elsewhere) ----
    function flowWindows() {
      // fomo's own trade counts are refreshed every ~10 s and preferred; Jupiter adds 6 h and holder change.
      const jw = s.project?.key === curKey() ? s.project.jup?.windows : null, mt = s.market?.txns, fw = s.fomo?.key === curKey() ? s.fomo.details?.windows : null;
      return [['m5', '5 min'], ['h1', '1 hour'], ['h6', '6 hours'], ['h24', '24 hours']].map(([k, label]) => {
        const fo = fw?.[k], j = fo?.buyVol != null ? { ...jw?.[k], ...fo } : jw?.[k], d = mt?.[k];
        const buyVol = j?.buyVol ?? null, sellVol = j?.sellVol ?? null, buys = j?.buys ?? d?.buys ?? null, sells = j?.sells ?? d?.sells ?? null;
        const share = buyVol != null && sellVol != null && buyVol + sellVol > 0 ? 100 * buyVol / (buyVol + sellVol)
          : buys != null && sells != null && buys + sells > 0 ? 100 * buys / (buys + sells) : null;
        return { k, label, share, buyVol, sellVol, buys, sells, holderChange: j?.holderChange ?? null, byVolume: buyVol != null };
      });
    }
    /** Signed percent change; changes below 0.05 % are shown as ±0 % (no -0.0 %). */
    function changeTxt(v) { return v == null ? '—' : Math.abs(v) < 0.05 ? '±0%' : (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) < 1 ? 2 : 1) + '%'; }
    function renderFlowCard(box) {
      const rows = flowWindows().filter(r => r.share != null || r.holderChange != null);
      if (!rows.length) { el('div', { class: 'sub', text: s.loading.dex || s.loading.project ? 'Loading…' : 'No trading data.' }, box); return; }
      const head = el('div', { class: 'flow head' }, box); for (const t of ['', 'Buys vs. sells', 'Buys', 'Holders']) el('span', { text: t }, head);
      for (const r of rows) {
        const line = el('div', { class: 'flow' }, box);
        el('span', { class: 'sub', text: r.label }, line);
        const bar = el('div', { class: 'bar', title: r.byVolume ? `buy ${money(r.buyVol)} / sell ${money(r.sellVol)}` : `${r.buys ?? '—'} buys / ${r.sells ?? '—'} sells` }, line);
        if (r.share != null) el('i', { style: { width: r.share.toFixed(1) + '%' } }, bar);
        el('b', { class: r.share == null ? '' : r.share >= 60 ? 'good' : r.share < 40 ? 'bad' : '', text: r.share == null ? '—' : r.share.toFixed(0) + '%' }, line);
        el('b', { class: r.holderChange == null || Math.abs(r.holderChange) < 0.05 ? '' : r.holderChange > 0 ? 'good' : 'bad', text: changeTxt(r.holderChange) }, line);
      }
      const snaps = s.history.filter(h => h.holders != null), now = snaps.at(-1), ago = snaps.find(h => h.ts >= Date.now() - 15 * 60e3);
      if (now && ago && now !== ago) el('div', { class: 'sub', text: `Holders while this tab was open: ${number(ago.holders)} → ${number(now.holders)}` }, box);
      el('div', { class: 'sub', text: rows.some(r => r.byVolume) ? 'Share of buy volume; holder change in %.' : 'Share of buy transactions.' }, box);
    }

    // ---- Solana address helpers ----
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function b58decode(str) {
      let n = 0n; for (const ch of String(str)) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
      const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
      for (const ch of String(str)) { if (ch !== '1') break; out.unshift(0); }
      return Uint8Array.from(out);
    }
    function b58encode(bytes) {
      let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
      let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
      for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
      return out;
    }
    const ED_P = 2n ** 255n - 19n;
    const modPow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
    const ED_D = (-121665n * modPow(121666n, ED_P - 2n, ED_P) % ED_P + ED_P) % ED_P;
    /** True for keys on the ed25519 curve (normal wallets); program-derived addresses (pools, bonding curves, vaults) are off-curve. */
    function isOnCurve(address) {
      const b = b58decode(address); if (!b || b.length !== 32) return false;
      let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
      if (y >= ED_P) return false;
      const y2 = y * y % ED_P, u = (y2 - 1n + ED_P) % ED_P, v = (ED_D * y2 + 1n) % ED_P;
      const x2 = u * modPow(v, ED_P - 2n, ED_P) % ED_P;
      return x2 === 0n || modPow(x2, (ED_P - 1n) / 2n, ED_P) === 1n;
    }
    /** Pools, bonding curves and other program accounts that hold tokens but are not holders (like Bubblemaps). */
    function nonHolderAddresses() {
      const out = new Set((s.pairs || []).map(p => p?.pairAddress).filter(Boolean));
      const pc = s.pump?.key === curKey() ? s.pump.coin : null;
      if (pc) for (const a of [pc.bondingCurve, pc.pool]) if (a) out.add(a);
      return out;
    }
    /** Top holders as owner wallets with % of supply, pools and program accounts removed. */
    function realHolders() {
      const skip = nonHolderAddresses(), sol = s.coin?.chain === 'solana';
      const fromClusters = s.clusters?.key === curKey() ? s.clusters.holders : null;
      if (fromClusters?.length) return fromClusters.map(h => ({ owner: h.owner, pct: h.pct }));
      return (s.sec?.holders || []).filter(h => h.owner && !skip.has(h.owner) && !skip.has(h.address) && (!sol || isOnCurve(h.owner)) && !/pool|amm|raydium|meteora|orca|pump|lock|burn|dead/i.test(h.tag || ''))
        .map(h => ({ owner: h.owner, pct: h.percent }));
    }
    function top10Pct() {
      const hs = realHolders(); if (!hs.length) return null;
      return hs.slice(0, 10).reduce((n, h) => n + (h.pct || 0), 0);
    }

    // ---- Wallet clusters: top holders funded by the same wallet (Solana, via RPC) ----
    const SYSTEM_PROGRAM = '11111111111111111111111111111111';
    /** Owner wallets of the largest token accounts via RPC (fallback when GoPlus has no holder list). */
    async function holdersFromRpc(ca) {
      const largest = await solRPC('getTokenLargestAccounts', [ca]), supply = await solRPC('getTokenSupply', [ca]);
      const total = Number(supply?.value?.uiAmount) || 0, skip = nonHolderAddresses(), byOwner = new Map();
      for (const a of (largest?.value || []).slice(0, 16)) {
        const info = await solRPC('getAccountInfo', [a.address, { encoding: 'jsonParsed' }]).catch(() => null);
        const o = info?.value?.data?.parsed?.info?.owner;
        if (!isValidMint(o) || skip.has(o) || !isOnCurve(o)) continue;
        byOwner.set(o, (byOwner.get(o) || 0) + (Number(a.uiAmountString ?? a.uiAmount) || 0));
      }
      return [...byOwner].map(([owner, amt]) => ({ owner, pct: total ? 100 * amt / total : null }));
    }
    const FRESH_DAYS = 3;
    async function refreshClusters(force = false) {
      if (!s.coin || s.coin.chain !== 'solana' || s.loading.clusters) return;
      const key = curKey(), ca = s.coin.ca;
      if (!force && s.clusters?.key === key) return;
      const here = () => key === curKey();
      s.loading.clusters = true; delete s.errors.clusters; scheduleRender();
      try {
        let top = (s.sec?.holders || []).length ? realHolders() : [];
        if (!top.length) top = await holdersFromRpc(ca);
        if (!top.length) throw Error('no holder data');
        const holders = [];
        for (const h of top.slice(0, 12)) {
          if (!here()) return;
          let funder = null, firstTs = null, txs = null;
          try {
            const sigs = await solRPC('getSignaturesForAddress', [h.owner, { limit: 1000 }]);
            txs = Array.isArray(sigs) ? sigs.length : null;
            if (txs && txs < 1000) {   // very active wallets: first funding is out of reach (and they are not fresh)
              firstTs = Number(sigs.at(-1).blockTime) || null;
              const tx = await solRPC('getTransaction', [sigs.at(-1).signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
              const ins = [...(tx?.transaction?.message?.instructions || []), ...(tx?.meta?.innerInstructions || []).flatMap(x => x?.instructions || [])];
              const f = ins.find(x => x?.program === 'system' && ['transfer', 'createAccount', 'transferWithSeed'].includes(x?.parsed?.type) && (x.parsed.info?.destination === h.owner || x.parsed.info?.newAccount === h.owner));
              funder = f?.parsed?.info?.source || null;
              if (funder === h.owner || !isValidMint(funder || '')) funder = null;
            }
          } catch {}
          holders.push({ owner: h.owner, pct: h.pct, funder, firstTs, txs });
        }
        const groups = new Map();
        for (const h of holders) if (h.funder) groups.set(h.funder, [...(groups.get(h.funder) || []), h]);
        const clusters = [...groups.entries()].filter(([, hs]) => hs.length >= 2).map(([funder, hs]) => ({ funder, holders: hs, pct: hs.reduce((n, h) => n + (h.pct || 0), 0) })).sort((a, b) => b.pct - a.pct);
        const freshList = holders.filter(h => h.firstTs && Date.now() / 1000 - h.firstTs < FRESH_DAYS * 86400);
        if (here()) s.clusters = { key, ts: Date.now(), checked: holders.length, clusters, holders, fresh: { count: freshList.length, pct: freshList.reduce((n, h) => n + (h.pct || 0), 0) } };
      } catch (e) { if (here()) s.errors.clusters = e.message; }
      finally { s.loading.clusters = false; scheduleRender(); }
    }
    function renderClusters(box) {
      if (s.coin.chain !== 'solana') return;
      const c = s.clusters?.key === curKey() ? s.clusters : null, h = el('div', { class: 'sub', text: 'Wallet clusters (top holders with the same funding wallet)' }, box); h.style.marginTop = '8px';
      if (s.loading.clusters) { el('div', { class: 'sub', text: 'Checking funding wallets…' }, box); return; }
      if (s.errors.clusters) el('div', { class: 'note warn', text: s.errors.clusters }, box);
      if (!c) { button(box, 'Find wallet clusters', () => refreshClusters(true)); return; }
      if (!c.clusters.length) el('div', { class: 'note good', text: `No cluster among ${c.checked} top wallets.` }, box);
      if (c.fresh) el('div', { class: 'sub', text: `Fresh wallets (first activity < ${FRESH_DAYS} days): ${c.fresh.count} of ${c.checked} top wallets · ${pctTxt(c.fresh.pct, 1)} of supply` }, box);
      const dev = gmgnExtra()?.dev?.address || s.project?.jup?.dev || '';
      for (const cl of c.clusters) {
        const r = infoRow(box, short(cl.funder), gmgnWallet(cl.funder), `${cl.holders.length} wallets · ${pctTxt(cl.pct)} of supply`, cl.funder === dev ? 'dev' : cl.pct >= 10 ? 'high' : '', cl.funder === dev || cl.pct >= 10 ? 'bad' : 'warn');
        for (const w of cl.holders) infoRow(box, '↳ ' + short(w.owner), gmgnWallet(w.owner), pctTxt(w.pct, 2));
      }
    }

    // ---- fomo: theses, top holders and trade counts, read from the responses fomo itself loads ----
    // fomo polls these about every 10 s while a token is open, so the data stay live without own requests.
    //   /feed/token/thesis, /feed/token/sortedThesis → responseObject.items[] (thesis + author + author's trade)
    //   /hodlers/top                                 → responseObject[0].topHolders[] (fomo users incl. followers)
    //   /proxy/tokenDetails                          → buy/sell counts and volumes for 5m / 1h / 4h / 24h, holders
    const fstr = (v, n = 80) => typeof v === 'string' ? v.trim().slice(0, n) : '';
    const fnum = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
    function fomoThesisFrom(o) {
      const c = o.comment && typeof o.comment === 'object' ? o.comment : {}, t = o.authorTrade || {};
      const text = fstr(typeof o.comment === 'string' ? o.comment : c.comment ?? o.thesis ?? o.text, 500);
      const handle = fstr(o.userHandle ?? o.user?.userHandle ?? o.user?.username, 40);
      if (!text || !handle) return null;
      const pnl = [t.unrealizedPnlUsd, t.realizedPnlUsd].map(fnum).filter(v => v != null);
      return {
        id: fstr(String(o.id ?? c.id ?? ''), 90), userId: fstr(o.userId ?? c.userId ?? o.user?.id, 40), author: handle, name: fstr(o.displayName ?? o.user?.displayName, 60),
        text, ts: parseTime(o.createdAt ?? c.createdAt), mc: fnum(c.marketCapAtCreation), likes: fnum(c.numLikes) || 0, replies: fnum(o.numReplies) || 0,
        position: fnum(t.usdValue), pnl: pnl.length ? pnl.reduce((a, b) => a + b, 0) : null, closed: !!t.closedAt, isDev: o.isDev === true, verified: o.verified === true,
      };
    }
    function fomoHolderFrom(h) {
      const u = h?.user || {};
      const handle = fstr(u.userHandle ?? u.username, 40);
      if (!handle) return null;
      return { userId: fstr(u.id, 40), author: handle, name: fstr(u.displayName, 60), followers: fnum(u.followers), value: fnum(h.value), pnl: fnum(h.pnl),
        isDev: h.isDev === true, verified: u.verified === true, hasThesis: !!h.comment };
    }
    /** Parses one fomo response; returns what it contained (theses, top holders, trade details). */
    function parseFomoResponse(path, body) {
      let j; try { j = JSON.parse(body); } catch { return null; }
      const r = j?.responseObject ?? j;
      if (/\/hodlers\/top/.test(path)) {
        const o = Array.isArray(r) ? r[0] : r;
        return { kind: 'top', token: fstr(o?.tokenAddress, 60), totalHolders: fnum(o?.totalHolders), holders: (o?.topHolders || []).slice(0, 300).map(fomoHolderFrom).filter(Boolean) };
      }
      if (/\/proxy\/tokenDetails/.test(path)) {
        if (!r || typeof r !== 'object') return null;
        const win = { m5: '5m', h1: '1', h4: '4', h24: '24' }, d = { kind: 'details', holders: fnum(r.holders), top10: fnum(r.top10HoldersPercent), windows: {} };
        for (const [k, sfx] of Object.entries(win)) d.windows[k] = { buys: fnum(r['buyCount' + sfx]), sells: fnum(r['sellCount' + sfx]), buyVol: fnum(r['buyVolume' + sfx]), sellVol: fnum(r['sellVolume' + sfx]), buyers: fnum(r['uniqueBuys' + sfx]), sellers: fnum(r['uniqueSells' + sfx]) };
        return d;
      }
      const items = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
      return { kind: 'theses', total: fnum(r?.count), token: fstr(items[0]?.tokenAddress ?? items[0]?.comment?.tokenAddress, 60), items: items.slice(0, 800).map(fomoThesisFrom).filter(Boolean) };
    }
    function onFomoFeed(d) {
      if (!s.coin || typeof d.body !== 'string' || typeof d.path !== 'string') return;
      const p = parseFomoResponse(d.path, d.body);
      if (!p) return;
      const token = d.token || p.token || d.pageToken || '';
      if (!token || !sameAddr(token, s.coin.ca)) return;   // only data of the token shown in the sidebar
      const key = curKey(), f = s.fomo?.key === key ? s.fomo : (s.fomo = { key, theses: new Map(), total: null, top: null, totalHolders: null, details: null, ts: 0 });
      f.ts = Date.now();
      if (p.kind === 'theses') { for (const it of p.items) f.theses.set(it.id || it.author + ':' + it.ts, it); if (p.total != null) f.total = Math.max(p.total, f.total || 0); }
      else if (p.kind === 'top') { f.top = p.holders; f.totalHolders = p.totalHolders; }
      else if (p.kind === 'details') f.details = p;
      if (!s.fomoSample) s.fomoSample = JSON.stringify(p, (k, v) => typeof v === 'string' ? v.slice(0, 60) : v).slice(0, 4000);
      scheduleRender();
    }
    const fomoData = () => s.fomo?.key === curKey() ? s.fomo : null;
    const fomoTheses = () => [...(fomoData()?.theses.values() || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    /** Callers = authors of theses, with followers / position from fomo's top-holder list when they appear there. */
    function fomoCallers() {
      const f = fomoData(), by = new Map(), top = new Map((f?.top || []).map(h => [h.userId || h.author, h]));
      for (const it of fomoTheses()) {
        const id = it.userId || it.author, h = top.get(id) || top.get(it.author);
        const r = by.get(id) || { author: it.author, name: it.name, followers: h?.followers ?? null, calls: 0, first: Infinity, last: 0, firstMc: null, position: it.position, pnl: it.pnl, holding: h?.value ?? null, likes: 0, isDev: false, verified: it.verified };
        r.calls++; r.likes += it.likes; r.last = Math.max(r.last, it.ts || 0); r.isDev ||= it.isDev;
        if (it.ts && it.ts < r.first) { r.first = it.ts; r.firstMc = it.mc; }
        by.set(id, r);
      }
      return [...by.values()].sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1) || b.calls - a.calls);
    }
    function renderFomoCallers(parent) {
      const f = fomoData(), items = fomoTheses(), box = section(parent, 'fomo callers', f?.total != null ? number(f.total) + ' theses' : items.length ? String(items.length) : '');
      if (!f) { el('div', { class: 'sub', text: 'Appears once fomo shows this token (be logged in on fomo).' }, box); return; }
      const callers = fomoCallers(), past = Math.floor(Date.now() / 1000), hour = items.filter(i => i.ts >= past - 3600).length;
      const g = el('div', { class: 'grid4' }, box);
      metric(g, 'Theses', number(f.total ?? items.length)); metric(g, 'Last hour', hour, activityCls(hour, 5));
      metric(g, 'fomo holders', number(f.totalHolders)); metric(g, 'Followers top 10', number(callers.filter(c => c.followers != null).sort((a, b) => b.followers - a.followers).slice(0, 10).reduce((n, c) => n + c.followers, 0)));
      const ranked = callers.filter(c => c.followers != null).sort((a, b) => b.followers - a.followers).slice(0, 10);
      if (callers.length) {
        el('div', { class: 'sub', text: `Top 10 callers by followers (${callers.length} callers loaded${callers.length > ranked.length ? ', ' + (callers.length - ranked.length) + ' without follower data' : ''})` }, box);
        for (const c of ranked) {
          const parts = [c.followers != null ? number(c.followers) + ' followers' : '', c.calls + (c.calls === 1 ? ' thesis' : ' theses'), c.firstMc ? 'first at ' + money(c.firstMc) : '', c.position ? money(c.position) + ' position' : ''].filter(Boolean);
          infoRow(box, '@' + c.author, fomoProfile(c.author), parts.join(' · '), c.isDev ? 'dev' : c.pnl != null && Math.abs(c.pnl) >= 1 ? (c.pnl > 0 ? '+' : '−') + money(Math.abs(c.pnl)) : c.last ? age(c.last * 1000) : '', c.isDev ? 'bad' : c.pnl > 0 ? 'good' : c.pnl < 0 ? 'bad' : '');
        }
      }
      const whales = (f.top || []).filter(h => h.followers != null && h.value > 0).sort((a, b) => b.followers - a.followers).slice(0, 5);
      if (whales.length) {
        el('div', { class: 'sub', text: 'Biggest fomo accounts holding' }, box);
        for (const h of whales) infoRow(box, '@' + h.author, fomoProfile(h.author), `${number(h.followers)} followers · ${money(h.value)}${h.hasThesis ? ' · thesis' : ''}`, h.pnl != null && Math.abs(h.pnl) >= 1 ? (h.pnl > 0 ? '+' : '−') + money(Math.abs(h.pnl)) : '', h.pnl > 0 ? 'good' : h.pnl < 0 ? 'bad' : '');
      }
      if (items.length) {
        el('div', { class: 'sub', text: 'Latest theses' }, box);
        for (const it of items.slice(0, 5)) {
          const r = el('div', { class: 'thesis' }, box);
          const top = el('div', { class: 'sub' }, r); top.append(link('@' + it.author, fomoProfile(it.author)));
          top.append(` · ${it.ts ? age(it.ts * 1000) + ' ago' : ''}${it.mc ? ' · at ' + money(it.mc) : ''}${it.likes ? ' · ♥ ' + it.likes : ''}`);
          textWithLinks(r, it.text);
        }
      }
    }

    // ---- Updates (browser extension) ----
    const extHost = globalThis.apescopeHost || null;
    extHost?.installType?.().then(t => { s.installType = t || ''; }).catch(() => {});
    async function checkForUpdate(manual = false) {
      if (!extHost) return;
      s.update = { status: 'checking' }; if (manual) render();
      try { s.update = await extHost.checkUpdate() || { status: 'no_update' }; } catch (e) { s.update = { status: 'error', error: String(e?.message || e) }; }
      put('aps:update-checked', Date.now()); scheduleRender();
    }
    function renderUpdates(parent) {
      if (!extHost) return;
      const box = section(parent, 'Updates'), u = s.update || {}, r = el('div', { class: 'line' }, box);
      el('span', { text: 'Version ' + VERSION, style: { flex: '1' } }, r);
      if (u.status === 'update_available') button(r, 'Update to ' + (u.version || 'new version'), () => extHost.applyUpdate(), 'primary');
      else if (u.status === 'manual' && u.url) r.append(link('Download ' + u.version, u.url, 'chip'));
      else button(r, u.status === 'checking' ? 'Checking…' : 'Check for updates', () => checkForUpdate(true));
      const msg = { no_update: 'You have the latest version.', throttled: 'Checked recently, try again later.', error: 'Update check failed' + (u.error ? ': ' + u.error : '') + '.',
        manual: `Version ${u.version} is available — download it and replace the installed files.`, update_available: 'Click to install and restart ApeScope.' }[u.status];
      if (msg) el('div', { class: 'sub', text: msg }, box);
      if (extHost.installFile) renderFileUpdate(box);
    }
    // Update from a release file: the package is unpacked by the background and written over the installed files.
    let filePicker = null;
    async function installUpdateFile(file) {
      if (!file) return;
      if (!/\.(zip|xpi)$/i.test(file.name)) { s.fileUpdate = { error: 'Choose apescope-firefox-v….zip / .xpi or apescope-chrome-v….zip.' }; return render(); }
      if (file.size > 20e6) { s.fileUpdate = { error: 'File too large.' }; return render(); }
      s.fileUpdate = { busy: true, name: file.name }; render();
      try {
        // A data URL is a plain string: Firefox does not let content scripts read the bytes of page-owned buffers directly.
        const dataUrl = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(Error('the file could not be read')); fr.readAsDataURL(file); });
        const r = await extHost.installFile(dataUrl.slice(dataUrl.indexOf(',') + 1), prefs.installFolder || 'ApeScope');
        s.fileUpdate = r?.ok ? { done: true, version: r.version } : { error: r?.error || 'Update failed.' };
      } catch (e) { s.fileUpdate = { error: String(e?.message || e) }; }
      render();
    }
    function renderFileUpdate(box) {
      const f = s.fileUpdate || {};
      if (s.installType === 'normal') {   // permanently installed (signed) build: the browser installs updates itself
        el('div', { class: 'sub', text: 'To update by hand, drag the new .xpi / .zip onto the browser window (Firefox) or use the extension page (Chrome).' }, box);
        return;
      }
      el('div', { class: 'sub', text: 'Install from file', style: { marginTop: '10px', fontWeight: '600' } }, box);
      if (!filePicker) {   // lives outside the re-rendered panel so the file dialog survives redraws
        filePicker = el('input', { type: 'file', accept: '.zip,.xpi', style: { display: 'none' } }, root);
        filePicker.addEventListener('change', () => { const file = filePicker.files?.[0]; filePicker.value = ''; installUpdateFile(file); });
      }
      const drop = el('div', { class: 'drop' + (f.busy ? ' busy' : ''), text: f.busy ? 'Installing ' + f.name + '…' : f.done ? `Version ${f.version} installed — restarting…` : 'Drop the release .zip here or click to choose it' }, box);
      drop.addEventListener('click', () => { if (!f.busy) filePicker.click(); });
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (!f.busy) installUpdateFile(e.dataTransfer?.files?.[0]); });
      if (f.error) el('div', { class: 'note warn', text: f.error }, box);

    }

    // ---- Tab: Project ------------------------------------------------------------------------
    const gmgnExtra = () => s.gmgn?.key === curKey() ? s.gmgn.data?.extra || null : null;
    const gmgnWallet = addr => GMGN_CHAIN[s.coin?.chain] && addr ? `https://gmgn.ai/${GMGN_CHAIN[s.coin.chain]}/address/${addr}` : '';
    const explorerUrl = addr => CHAINS[s.coin?.chain]?.explorer && addr ? CHAINS[s.coin.chain].explorer + addr : '';
    const explorerFor = (chain, addr) => CHAINS[chain]?.explorer && addr ? CHAINS[chain].explorer + addr : '';
    const fomoProfile = handle => handle ? 'https://fomo.family/profile/' + encodeURIComponent(handle) : '';
    const pumpProfile = wallet => isValidMint(wallet || '') ? 'https://pump.fun/profile/' + wallet : '';
    /** A shortened address that opens the block explorer (full address on hover) with a copy button next to it. */
    function addrLink(addr, url = '') {
      const w = el('span', { class: 'addr' });
      const a = link(short(addr), url || explorerUrl(addr) || gmgnWallet(addr), 'mono'); a.title = addr; w.append(a);
      el('button', { class: 'copy', type: 'button', text: '⧉', title: 'Copy address', onclick: e => { e.preventDefault(); e.stopPropagation(); GM_setClipboard(addr, 'text'); alertLine('Address copied'); } }, w);
      return w;
    }
    /** One line: label link · details · optional status chip; missing items are shown, not hidden. */
    function infoRow(parent, label, url, detail = '', chip = '', chipCls = '') {
      const r = el('div', { class: 'irow' }, parent);
      r.append(url ? link(label + ' ↗', url, 'ilabel') : el('span', { class: 'ilabel muted', text: label }));
      el('span', { class: 'idetail', text: detail }, r);
      if (chip) el('span', { class: 'pill ' + chipCls, text: chip }, r);
      return r;
    }
    function renderProject(parent) {
      if (!s.coin) { el('div', { class: 'note', text: 'No token selected.' }, parent); return; }
      refreshProject(); refreshGithub(); refreshSimilar(); refreshGmgn(); refreshIntel(); refreshPump();
      const busy = s.loading.project || s.loading.similar || s.loading.github || s.loading.gmgn || s.loading.intel;
      const top = el('div', { class: 'line' }, parent);
      button(top, 'Reload', () => { s.github = null; s.gmgn = null; s.intel = null; refreshProject(true); refreshSimilar(true); refreshGmgn(true); });
      if (busy) el('span', { class: 'sub', text: 'loading…' }, top);
      renderProjectLinks(section(parent, 'Project'));
      const groups = { trade: 'Trade', research: 'Research' };
      for (const [g, title] of Object.entries(groups)) { const c = el('div', { class: 'chips' }, section(parent, title)); for (const q of quickLinks().filter(q => q.group === g)) c.append(link(q.label, q.url, 'chip')); }
      const p = s.project?.key === curKey() ? s.project : null;
      if (p?.gt?.description) el('div', { class: 'note', text: p.gt.description }, section(parent, 'Description'));
      renderGmgnCard(section(parent, 'Holders & traders'));
      renderFeesCard(section(parent, 'Fees & rewards'));
      renderPumpFees(parent);
      if (p?.jup || p?.gt) {
        const j = p.jup, x = section(parent, 'Trading');
        if (j) { row(x, 'Organic score', j.organicScore == null ? '—' : Math.round(j.organicScore) + (j.organicLabel ? ' (' + j.organicLabel + ')' : '')); row(x, 'Holders', number(j.holders)); row(x, 'Traders 1h', number(j.traders1h)); row(x, 'Verified', yn(j.verified)); if (j.isSus) el('div', { class: 'note bad', text: 'Flagged as suspicious.' }, x); }
        if (p.gt?.gtScore != null) row(x, 'GT score', p.gt.gtScore.toFixed(1));
      }
      renderSimilar(section(parent, 'Look-alikes / vamps'));
    }
    /** Opens the website in a background tab, reads the rendered text once it has loaded, closes the tab. */
    async function renderCaCheck(url) {
      if (!extHost?.renderText || s.renderCheck) return;
      const key = curKey(), ca = s.coin.ca; s.renderCheck = url; render();
      try {
        const r = await extHost.renderText(url);
        if (!r?.ok) throw Error(r?.error || 'the page could not be read');
        const w = s.intel?.key === key ? s.intel.web.find(x => x.url === url) : null;
        const has = isValidEVM(ca) ? r.text.toLowerCase().includes(ca.toLowerCase()) : r.text.includes(ca);
        if (w?.page) { w.page.hasCA = has; w.page.caIn = has ? 'the rendered page' : w.page.caIn; if (has) w.page.otherCa = []; else w.page.otherCa = otherContracts(r.text, ca); }
        alertLine(has ? 'CA found on the rendered page' : 'CA not found on the rendered page');
      } catch (e) { alertLine(e.message); }
      finally { s.renderCheck = ''; render(); }
    }
    function renderProjectLinks(box) {
      const links = projectLinks(), intel = s.intel?.key === curKey() ? s.intel : null, gh = s.github?.key === curKey() ? s.github : null;
      const sites = links.filter(l => l.kind === 'Website');
      if (!sites.length) infoRow(box, 'Website', '', s.project ? 'not found' : 'loading…', s.project ? '✗' : '', 'bad');
      for (const l of sites) {
        const w = intel?.web.find(x => x.url === l.url), domain = l.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '');
        const parts = [domain];
        if (w?.rdap?.registered) parts.push('domain ' + age(w.rdap.registered) + ' old');
        if (w?.page && !w.page.ok) parts.push('not reachable');
        const young = w?.rdap?.registered && Date.now() - w.rdap.registered < 30 * 86400000;
        if (w?.page?.caIn) parts.push('CA found in ' + w.page.caIn.replace(/^api /, 'the site API '));
        infoRow(box, 'Website', l.url, parts.join(' · '), w?.page ? (w.page.hasCA ? 'shows CA' : w.page.otherCa?.length ? 'other CA' : 'no CA') : '', young || w?.page?.otherCa?.length ? 'bad' : w?.page?.hasCA ? 'good' : '');
        if (w?.needsAccess && extHost?.openOptions) {
          const ar = el('div', { class: 'line' }, box);
          button(ar, 'Allow website checks', () => extHost.openOptions(), 'primary');
          el('span', { class: 'sub', text: 'Needs access to project websites (asked once, on the extension\'s settings page).' }, ar);
        }
        if (w?.page?.ok && !w.page.hasCA && extHost?.renderText) {
          const rr = el('div', { class: 'line' }, box);
          button(rr, s.renderCheck === l.url ? 'Checking in a tab…' : 'Check the CA in a browser tab', () => renderCaCheck(l.url));
          el('span', { class: 'sub', text: 'Opens the site briefly in a background tab — it runs the site\'s own scripts.' }, rr);
        }
      }
      const repos = links.filter(l => l.kind === 'GitHub');
      for (const l of repos) {
        const t = parseGithubTarget(l.url), it = gh?.items.find(i => t && i.url.toLowerCase().includes((t.owner + (t.repo ? '/' + t.repo : '')).toLowerCase()));
        const name = t ? t.owner + (t.repo ? '/' + t.repo : '') : '';
        const detail = it?.type === 'repo' ? `${name} · ${it.commits ?? '—'} commits · updated ${age(it.pushedAt)} ago${it.isFork ? ' · fork' : ''}` : it ? `${name} · ${it.publicRepos ?? '—'} repos` : name;
        infoRow(box, 'GitHub', l.url, detail, it?.type === 'repo' && (it.isFork || it.commits < 5) ? 'weak' : '', 'warn');
      }
      for (const l of links.filter(l => !['Website', 'GitHub', 'X', 'X community', 'Telegram', 'Discord'].includes(l.kind))) infoRow(box, l.kind, l.url, l.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40));
      const lp = launchpadLink(); if (lp) infoRow(box, 'Launchpad', lp.url, lp.label);
    }
    function renderGmgnCard(box) {
      if (!GMGN_CHAIN[s.coin.chain]) { el('div', { class: 'sub', text: 'Not available for this chain.' }, box); return; }
      const g = s.gmgn?.key === curKey() ? s.gmgn.data : null;
      if (!g) {
        el('div', { class: 'sub', text: s.loading.gmgn ? 'Loading…' : s.errors.gmgn || 'Needs a GMGN tab.' }, box);
        const gb = el('div', { class: 'line' }, box);
        button(gb, gmgnWorkerOnline() ? 'Load' : 'Connect GMGN', () => openGmgnWorker(true));
        if (/security check/.test(s.errors.gmgn || '')) button(gb, 'Open GMGN tab', () => GM_openInTab('https://gmgn.ai/', { active: true, reuse: true }));
        return;
      }
      const tier = (v, w, b) => v == null ? '' : v > b ? 'bad' : v > w ? 'warn' : 'good';
      const grid = el('div', { class: 'grid' }, box);
      metric(grid, 'Bundlers', pctTxt(g.bundlerPct), tier(g.bundlerPct, 10, 25)); metric(grid, 'Phishing', pctTxt(g.phishingPct), tier(g.phishingPct, 5, 20));
      metric(grid, 'Insiders', pctTxt(g.insiderPct), tier(g.insiderPct, 5, 15)); metric(grid, 'Bots', pctTxt(g.botPct, 0), g.botPct > 60 ? 'warn' : '');
      row(box, 'Holders', number(g.holders)); row(box, 'Top 10', pctTxt(g.top10Pct)); row(box, 'Snipers still hold', pctTxt(g.sniperHoldPct)); row(box, 'Fresh wallets', pctTxt(g.freshPct, 0));
      row(box, 'Smart money / KOLs', `${capped(g.smartMoney)} / ${capped(g.kols)}`);
      box.append(link('Holder list on GMGN ↗', `https://gmgn.ai/${GMGN_CHAIN[s.coin.chain]}/token/${s.coin.ca}`));
    }
    function renderFeesCard(box) {
      const x = gmgnExtra(), m = s.market;
      if (!x) { el('div', { class: 'sub', text: s.loading.gmgn ? 'Loading…' : GMGN_CHAIN[s.coin.chain] ? 'Loaded together with the holder analysis.' : 'Not available for this chain.' }, box); return; }
      if (x.launchpad) row(box, 'Launchpad', x.launchpad + (x.bonding != null && x.bonding < 1 ? ` · bonding ${(x.bonding * 100).toFixed(0)}%` : x.bonding === 1 ? ' · migrated' : ''));
      if (x.creatorFeePct != null) row(box, 'Creator fee', x.creatorFeePct + '% of volume');
      if (x.creatorFeePct != null && m?.volume24h != null) row(box, 'Creator fees (24h, est.)', money(m.volume24h * x.creatorFeePct / 100));
      if (x.feesPaid != null) row(box, 'Fees paid by traders', x.feesPaid.toFixed(2) + ' SOL');
      if (x.recipients.length) {
        el('div', { class: 'sub', text: 'Fee recipients' + (x.feeSplitLocked ? ' · split locked' : '') }, box);
        for (const r of x.recipients) {
          const who = r.charity ? r.charity : r.xUser ? '@' + r.xUser : short(r.wallet);
          const rr = infoRow(box, who, r.xUser && !r.charity ? 'https://x.com/' + r.xUser : gmgnWallet(r.wallet), (r.sharePct != null ? r.sharePct + '%' : '') + (r.creator ? ' · creator' : ''), r.claimed ? 'claimed' : 'not claimed', r.claimed ? 'good' : '');
          if (r.wallet && (r.xUser || r.charity)) rr.querySelector?.('.idetail')?.append?.(' · ', link('wallet', gmgnWallet(r.wallet)));
        }
      } else if (x.creatorFeePct == null && x.feesPaid == null) el('div', { class: 'sub', text: 'No fee data for this token.' }, box);
    }
    function renderSimilar(parent) {
      if (s.errors.similar) el('div', { class: 'note warn', text: s.errors.similar }, parent);
      const list = (s.similar?.key === curKey() ? s.similar.list : []).slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
      if (!list.length) { el('div', { class: 'sub', text: s.loading.similar ? 'Searching…' : s.similar?.key === curKey() ? 'No look-alike tokens found.' : 'Searching…' }, parent); return; }
      const own = s.market, { symbol } = tokenNames();
      if (own) el('div', { class: 'sub', text: `This token: ${money(own.marketCap)} MC · ${age(own.createdAt)} old · ${list.length} look-alikes, sorted by market cap` }, parent);
      const ageCls = ms => !ms ? '' : Date.now() - ms < 3600e3 ? 'bad' : Date.now() - ms < 86400e3 ? 'warn' : Date.now() - ms < 14 * 86400e3 ? 'info' : '';
      const mcCls = v => v >= 1e6 ? 'good' : v >= 1e5 ? 'info' : '';
      for (const x of list.slice(0, 15)) {
        const card = el('div', { class: 'vamp' }, parent), head = el('div', { class: 'vhead' }, card);
        el('span', { class: 'badge', text: CHAINS[x.chain]?.name || x.chainId }, head);
        const nm = link('$' + x.symbol, fomoUrl(x.chain, x.ca) || x.url); nm.style.fontWeight = '700'; head.append(nm); el('span', { class: 'name', text: x.name }, head);
        head.append(addrLink(x.ca, explorerFor(x.chain, x.ca)));
        const older = own?.createdAt && x.createdAt && x.createdAt < own.createdAt;
        if (older && normTok(x.symbol) === normTok(symbol) && (x.marketCap || 0) > (own?.marketCap || 0)) el('span', { class: 'pill good', text: 'likely original' }, head);
        const st = el('div', { class: 'vstats' }, card);
        const cell = (label, value, cls) => { const c = el('div', {}, st); el('span', { text: label }, c); el('b', { class: cls, text: value }, c); };
        cell('MCap', money(x.marketCap), mcCls(x.marketCap)); cell('Liquidity', money(x.liquidity), x.liquidity < 1000 ? 'bad' : '');
        cell('Age', age(x.createdAt) + (older ? ' · older' : ' · newer'), ageCls(x.createdAt));
        const acts = el('div', { class: 'vacts' }, card), f = fomoUrl(x.chain, x.ca), pd = padreUrl(x.chain, x.pair || x.ca);
        if (f) acts.append(link('FOMO', f)); if (pd) acts.append(link('Padre', pd)); if (x.url) acts.append(link('DexScreener', x.url));
        if (f) el('a', { text: 'Open', href: f, onclick: e => { e.preventDefault(); openToken({ ca: x.ca, chain: x.chain }); } }, acts);
      }
    }

    // ---- Tab: Socials ------------------------------------------------------------------------
    /** Activity colour: none = red, some = orange, plenty for the time window = green. */
    const activityCls = (n, plenty) => n === 0 ? 'bad' : n >= plenty ? 'good' : 'warn';
    function renderSocials(parent) {
      if (!s.coin) { el('div', { class: 'note', text: 'No token selected.' }, parent); return; }
      const links = projectLinks(), intel = s.intel?.key === curKey() ? s.intel : null, x = gmgnExtra();
      const com = section(parent, 'Community');
      const accounts = links.filter(l => l.kind === 'X');
      if (!accounts.length) infoRow(com, 'X', '', s.project ? 'not found' : 'loading…', s.project ? '✗' : '', 'bad');
      for (const l of accounts) {
        const u = intel?.x.find(i => i.handle.toLowerCase() === xHandleOf(l.url).toLowerCase())?.user;
        const parts = ['@' + (u?.handle || xHandleOf(l.url))];
        if (u?.joined) parts.push(age(u.joined) + ' old'); if (u?.followers != null) parts.push(number(u.followers) + ' followers');
        const young = u?.joined && Date.now() - u.joined < 30 * 86400000;
        infoRow(com, 'X', l.url, parts.join(' · '), x?.dev?.xRenames > 0 ? `renamed ${x.dev.xRenames}×` : u?.verified ? 'verified' : '', x?.dev?.xRenames > 0 || young ? 'warn' : 'good');
      }
      for (const l of links.filter(l => l.kind === 'X community')) infoRow(com, 'X community', l.url, '');
      const tg = links.filter(l => l.kind === 'Telegram');
      if (!tg.length) infoRow(com, 'Telegram', '', s.project ? 'not found' : '', '', '');
      for (const l of tg) infoRow(com, 'Telegram', l.url, l.url.replace(/^https?:\/\/(www\.)?/, ''));
      for (const l of links.filter(l => l.kind === 'Discord')) infoRow(com, 'Discord', l.url, l.url.replace(/^https?:\/\/(www\.)?/, ''));

      const act = section(parent, 'Activity'), past = Math.floor(Date.now() / 1000), real = s.events.filter(e => e.source !== 'manual');
      // Everything people post about the token counts: X posts, pump.fun callouts and fomo theses.
      const all = [...real, ...fomoTheses().filter(t => t.ts).map(t => ({ source: 'fomo', timestamp: t.ts }))];
      const g = el('div', { class: 'grid4' }, act);
      for (const [label, secs, plenty] of [['5 min', 300, 3], ['15 min', 900, 5], ['1 hour', 3600, 10], ['24 hours', 86400, 25]]) {
        const win = all.filter(e => e.timestamp >= past - secs), n = win.length;
        const d = metric(g, label, n, activityCls(n, plenty));
        const by = ['x', 'pump', 'fomo'].map(k => [k, win.filter(e => e.source === k).length]).filter(([, c]) => c);
        if (by.length) el('small', { class: 'sub', text: by.map(([k, c]) => ({ x: '𝕏', pump: 'PF', fomo: 'fomo' }[k]) + ' ' + c).join(' · ') }, d);
      }
      const src = el('div', { class: 'chips' }, act);
      const bySource = [['x', '𝕏 posts'], ['pump', 'pump.fun calls'], ['telegram', 'Telegram']];
      for (const [k, label] of bySource) {
        if (k !== 'x' && s.coin.chain !== 'solana' && k === 'pump') continue;
        const all = real.filter(e => e.source === k), day = all.filter(e => e.timestamp >= past - 86400).length;
        if (k === 'telegram' && !all.length) continue;
        el('span', { class: 'chip ' + (all.length ? '' : 'muted'), text: `${label}: ${all.length}${all.length ? ' · ' + day + ' today' : ''}` }, src);
      }
      const fomoCount = fomoData()?.total ?? fomoData()?.theses.size ?? 0, fomoDay = fomoTheses().filter(t => t.ts >= past - 86400).length;
      if (fomoCount) el('span', { class: 'chip', text: 'fomo theses: ' + number(fomoCount) + (fomoDay ? ' · ' + fomoDay + ' today' : '') }, src);
      const x0 = load(K.xHealth, {}), pump = load(K.pumpHealth, {}), live = h => h?.ts && Date.now() - h.ts < 120000;
      const ctr = el('div', { class: 'line' }, act);
      button(ctr, live(x0) ? (x0.via === 'api' ? '𝕏 search running (no tab)' : '𝕏 search running') : 'Search X for this token', openWorkerX, live(x0) ? '' : 'primary');
      if (s.coin.chain === 'solana') ctr.append(link('pump.fun page ↗', 'https://pump.fun/coin/' + s.coin.ca, 'btn'));
      if (load(K.xError, '')) {
        const n = el('div', { class: 'note warn' }, act); el('div', { text: load(K.xError, '') }, n);
        if (/log ?in|logged out|refused/i.test(load(K.xError, ''))) button(n, 'Log in to X', () => GM_openInTab('https://x.com/i/flow/login', { active: true }));
      }

      renderFomoCallers(parent);
      renderPumpCallouts(parent);
      // pump.fun callouts have their own section above; here only X (and other) posts, no duplicates.
      const posts = s.pump?.key === curKey() ? real.filter(e => e.source !== 'pump') : real;
      const list = section(parent, 'X posts', String(posts.length));
      if (!posts.length) el('div', { class: 'sub', text: prefs.xApi && xApiAvailable() && xApi.fellBack !== curKey() ? 'No posts yet — X is searched in the background (no tab).' : prefs.autoX ? 'No posts yet — the X search runs in a background tab.' : 'No posts yet — start the X search.' }, list);
      for (const ev of posts.slice(0, 100)) {
        const it = el('div', { class: 'event' }, list), top = el('div', {}, it);
        el('span', { class: 'tag ' + ev.source, text: ev.source === 'pump' ? 'PUMP.FUN' : ev.source.toUpperCase() }, top);
        top.append(ev.url && /^https:\/\//.test(ev.url) ? link(ev.author, ev.url) : el('strong', { text: ev.author }));
        el('span', { class: 'sub', text: ' · ' + age(ev.timestamp * 1000) + ' ago' }, top);
        textWithLinks(it, trim(ev.text, 650), 'text');
      }
    }

    // ---- Developer card (Overview) -------------------------------------------------------------
    function renderDevCard(box) {
      const x = gmgnExtra(), j = s.project?.key === curKey() ? s.project.jup : null, g = s.gmgn?.key === curKey() ? s.gmgn.data : null;
      const addr = x?.dev?.address || j?.dev || s.sec?.creator || '';
      if (!addr) { el('div', { class: 'sub', text: s.loading.project || s.loading.gmgn ? 'Loading…' : 'Developer unknown.' }, box); return; }
      const r = el('div', { class: 'line' }, box); r.append(addrLink(addr));
      for (const [label, url] of [['GMGN', gmgnWallet(addr)], ['Explorer', explorerUrl(addr)], ['pump.fun', s.coin.chain === 'solana' ? 'https://pump.fun/profile/' + addr : '']]) if (url) r.append(link(label + ' ↗', url, 'chip'));
      const created = j?.devMints ?? g?.devCreated, migrated = j?.devMigrations ?? x?.dev?.migrated;
      if (created != null) row(box, 'Tokens launched', number(created) + (migrated != null ? ` · ${number(migrated)} migrated` : ''));
      const status = { creator_close: 'sold everything', creator_hold: 'still holds', creator_add: 'bought more', creator_sell: 'sold part' }[x?.dev?.status] || x?.dev?.status;
      if (status || g?.devHoldPct != null) row(box, 'Dev position', [status, g?.devHoldPct ? pctTxt(g.devHoldPct) + ' of supply' : ''].filter(Boolean).join(' · '));
      if (x?.dev?.fundedBy) { const fr = row(box, 'Funded by', ''); fr.querySelector?.('b')?.remove?.(); fr.append(addrLink(x.dev.fundedBy)); fr.append(link(' GMGN ↗', gmgnWallet(x.dev.fundedBy))); }
      if (x?.dev?.xRenames > 0) row(box, 'X account renamed', x.dev.xRenames + '×' + (x.dev.xHistory.length ? ' (' + x.dev.xHistory.join(', ') + ')' : ''));
      if (x?.imageDup > 0) row(box, 'Logo used by other tokens', String(x.imageDup));
    }

    // ---- Tab: Watchlist ----------------------------------------------------------------------
    function openToken(w) {
      const f = fomoUrl(w.chain, w.ca);
      if (f && isFomo) location.assign(f); else if (f) GM_openInTab(f, { active: true }); else selectCoin(w, true);
    }

    // ---- Tab: AI -----------------------------------------------------------------------------
    // The panel does not wait for ChatGPT: once the prompt is sent the job is done. If the answer can be read
    // back later it simply appears here.
    const AI_STATUS = { requested: 'Opening ChatGPT…', claimed: 'Opening ChatGPT…', navigating: 'Opening ChatGPT…', inserted: 'Inserting the prompt…',
      waiting: 'Prompt is in ChatGPT — press Enter there', sent: 'Sent to ChatGPT ✓', running: 'Sent to ChatGPT ✓', done: 'Answer received ✓', error: 'Could not send' };
    function openChatGPT() { GM_openInTab(/^https:\/\/chatgpt\.com\//.test(s.aiJob?.url || '') ? s.aiJob.url : 'https://chatgpt.com/', { active: true, insert: true, reuse: true }); }
    function renderAi(parent) {
      const card = section(parent, 'ChatGPT analysis');
      const chk = (parentEl, label, name) => { const l = el('label', { class: 'opt' }, parentEl), c = el('input', { type: 'checkbox' }, l); c.checked = !!aiPrefs[name]; el('span', { text: label }, l); c.addEventListener('change', () => { aiPrefs[name] = c.checked; put(K.aiPrefs, aiPrefs); render(); }); };
      chk(card, 'Project check — website, X, GitHub, holders', 'project');
      chk(card, 'Chart & trade plan', 'chart');
      if (aiPrefs.chart) chk(card, 'Include a chart screenshot', 'screenshot');
      const none = !aiPrefs.project && !aiPrefs.chart, act = el('div', { class: 'line' }, card);
      const go = button(act, s.aiBuilding ? 'Collecting data…' : 'Analyze with ChatGPT', () => startAi(), 'primary'); go.disabled = !!s.aiBuilding || !s.coin || none;
      const ts = section(parent, 'Trade setup only');
      el('div', { class: 'sub', text: 'Entry and exit scenarios from chart and trading data only: candles (1m / 5m / 15m), volume zones, buy/sell pressure, holders, bundlers, snipers, fresh wallets, dev, liquidity, callers. No project check.' }, ts);
      const tr = el('div', { class: 'line' }, ts);
      const tg = button(tr, s.aiBuilding ? 'Collecting data…' : 'Trade setup with ChatGPT', () => startAi('trade'), 'primary'); tg.disabled = !!s.aiBuilding || !s.coin;


      const job = s.aiJob;
      if (job && job.key === curKey()) {
        const r = el('div', { class: 'line note ' + (job.status === 'error' ? 'bad' : 'good') }, card);
        el('span', { text: (AI_STATUS[job.status] || job.status) + (job.status === 'error' && job.error ? ' — ' + job.error : ''), style: { flex: '1' } }, r);
        if (['waiting', 'sent', 'running', 'done', 'inserted'].includes(job.status)) button(r, 'Open ChatGPT', openChatGPT);
      }
      if (s.aiPrompt?.note) el('div', { class: 'sub', text: s.aiPrompt.note }, card);
      const opt = el('details', { class: 'card' }, card); el('summary', { text: 'Options' }, opt);
      chk(opt, 'Send automatically', 'autoSend'); chk(opt, 'New chat for every analysis', 'newChat'); chk(opt, 'Temporary chat', 'temporary');
      if (s.aiResults?.analysis?.json) renderAiResult(parent, s.aiResults.analysis);   // only when ChatGPT's answer could be read back
      if (prefs.dev && s.aiPrompt) {
        const d = collapsible(parent, 'lastPrompt', 'Last prompt', s.aiPrompt.text.length + ' chars' + (s.aiPrompt.hasImage ? ' · screenshot' : ''));
        el('textarea', { readonly: 'readonly', style: { minHeight: '180px', fontSize: '10.5px' } }, d).value = s.aiPrompt.text;
      }
    }
    function renderAiResult(parent, r) {
      const card = section(parent, 'Latest analysis');
      if (!r) { el('div', { class: 'sub', text: 'No analysis for this token yet.' }, card); return; }
      el('div', { class: 'sub', text: age(r.ts) + ' ago' }, card);
      const j = r.json, txt = v => String(v ?? '').slice(0, 400);
      const list = (title, arr, cls) => { if (!Array.isArray(arr) || !arr.length) return; el('div', { class: 'sub', text: title }, card); for (const x of arr.slice(0, 10)) el('div', { class: cls, text: '• ' + txt(x) }, card); };
      if (j?.verdict) {
        const v = txt(j.verdict);
        el('div', { class: 'note ' + (/legit/i.test(v) ? 'good' : /scam|risky/i.test(v) ? 'bad' : 'warn'), text: `Verdict: ${v}${j.score != null ? ' · score ' + txt(j.score) + '/100' : ''} · vamp risk: ${txt(j.vampRisk) || '—'}` }, card);
        if (j.summary) el('div', { class: 'note', text: txt(j.summary) }, card);
        list('Green flags', j.greenFlags, 'good'); list('Red flags', j.redFlags, 'bad');
        for (const [lab, k] of [['Website', 'website'], ['GitHub', 'github'], ['X / Twitter', 'twitter'], ['Use case', 'useCase'], ['Original token', 'original']]) if (j[k]) row(card, lab, txt(j[k]));
      }
      const t = j?.trade;
      if (t && typeof t === 'object') {
        const b = txt(t.bias);
        el('div', { class: 'note ' + (/bull/i.test(b) ? 'good' : /bear|avoid/i.test(b) ? 'bad' : 'warn'), text: `Trade: ${b || '—'} · ${txt(t.action) || '—'} · phase: ${txt(t.phase) || '—'} · confidence ${txt(t.confidence) || '—'}%` }, card);
        if (t.summary) el('div', { class: 'note', text: txt(t.summary) }, card);
        for (const e of Array.isArray(t.entries) ? t.entries.slice(0, 5) : []) row(card, 'Entry · ' + txt(e?.type), money(e?.mcap), txt(e?.condition));
        if (t.invalidation) row(card, 'Invalidation', money(t.invalidation.mcap), txt(t.invalidation.reason));
        for (const x of Array.isArray(t.targets) ? t.targets.slice(0, 5) : []) row(card, 'Target' + (x?.sellPct ? ' · sell ' + txt(x.sellPct) + '%' : ''), money(x?.mcap), txt(x?.note));
        if (Array.isArray(t.supports) && t.supports.length) row(card, 'Supports', t.supports.slice(0, 6).map(money).join(' · '));
        if (Array.isArray(t.resistances) && t.resistances.length) row(card, 'Resistances', t.resistances.slice(0, 6).map(money).join(' · '));
        for (const sc of Array.isArray(t.scenarios) ? t.scenarios.slice(0, 5) : []) row(card, 'Scenario · ' + txt(sc?.name), `${money(sc?.entryMcap)} → ${(Array.isArray(sc?.targetsMcap) ? sc.targetsMcap : []).slice(0, 4).map(money).join(' / ')} · stop ${money(sc?.stopMcap)}`, `${txt(sc?.trigger)}${sc?.rr ? ' · R:R ' + txt(sc.rr) : ''}${sc?.probability ? ' · ' + txt(sc.probability) + '%' : ''}`);
        if (t.dumpRisk) row(card, 'Dump risk', txt(t.dumpRisk));
        if (Array.isArray(t.noTradeIf) && t.noTradeIf.length) list('Do not trade if', t.noTradeIf, 'bad');
        if (t.positionSizePct) row(card, 'Position size', txt(t.positionSizePct) + '% of budget');
        if (t.timeframe) row(card, 'Time frame', txt(t.timeframe));
      }
      if (!j) el('div', { class: 'note warn', text: 'No summary block in the answer — see the full answer.' }, card);
      const d = el('details', {}, card); el('summary', { text: 'Full answer' }, d); el('div', { class: 'note', text: r.text }, d);
      if (/^https:\/\/chatgpt\.com\//.test(r.url || '')) card.append(link('Open in ChatGPT ↗', r.url));
    }

    // ---- Tab: Watchlist ----------------------------------------------------------------------
    function renderWatchlist(parent) {
      if (s.coin) {
        const l = el('div', { class: 'line' }, parent);
        if (watches.some(w => w.key === curKey())) el('span', { class: 'pill good', text: '✓ This token is on your watchlist' }, l); else button(l, 'Add current token', toggleWatch, 'primary');
      }
      const list = section(parent, 'Watched tokens', String(watches.length));
      if (!watches.length) el('div', { class: 'sub', text: 'Nothing watched yet.' }, list);
      for (const w of watches) {
        const m = load('aps:lastmarket:' + w.key, null), r = el('div', { class: 'wrow' + (w.key === curKey() ? ' current' : '') }, list);
        const name = el('a', { class: 'wname', href: fomoUrl(w.chain, w.ca) || '#', text: (m?.symbol ? '$' + m.symbol : short(w.ca)), title: 'Open on fomo' }, r);
        name.addEventListener('click', e => { e.preventDefault(); openToken(w); });
        el('span', { class: 'badge', text: CHAINS[w.chain]?.name || w.chain }, r);
        el('span', { class: 'idetail', text: m ? `${money(m.marketCap)} MC · ${money(m.liquidity)} liq${m.change5m != null ? ' · 5m ' + (m.change5m > 0 ? '+' : '') + m.change5m + '%' : ''}` : '' }, r);
        el('button', { class: 'iconbtn', type: 'button', text: '×', title: 'Remove', onclick: () => { watches = watches.filter(x => x.key !== w.key); put(LOCAL.watches, watches); render(); } }, r);
      }
      if (prefs.alerts || notices.length) {
        const al = section(parent, 'Alerts');
        for (const n of notices.slice(-25).reverse()) el('div', { class: 'event', text: localTime(n.ts) + ' · ' + n.message }, al);
        if (!notices.length) el('div', { class: 'sub', text: 'No alerts yet.' }, al);
      }
    }

    // ---- Tab: Settings -----------------------------------------------------------------------
    function renderSettings(parent) {
      renderUpdates(parent);
      if (extHost?.openOptions) {
        const wb = section(parent, 'Website check');
        el('div', { class: 'sub', text: s.siteAccess === false ? 'Off: ApeScope has no access to project websites, so it cannot look for the CA there.' : 'Looks for the contract address on project websites and GitHub. Access to project websites is managed on the extension\'s settings page.' }, wb);
        button(el('div', { class: 'line' }, wb), s.siteAccess === false ? 'Allow website checks' : 'Open the settings page', () => extHost.openOptions(), s.siteAccess === false ? 'primary' : '');
      }
      const toggle = (box, key, name, after) => {
        const l = el('label', { class: 'opt' }, box), cb = el('input', { type: 'checkbox' }, l); cb.checked = !!prefs[key]; el('span', { text: name }, l);
        cb.addEventListener('change', () => { prefs[key] = cb.checked; put(LOCAL.preferences, prefs); after?.(cb.checked); render(); });
      };
      const lay = section(parent, 'Sidebar'), d = el('div', { class: 'line' }, lay);
      for (const [mode, label] of [['left', 'Left'], ['right', 'Right'], ['float', 'Floating']]) button(d, label, () => setDock(mode), uiSettings.dock === mode ? 'primary' : '');
      const fr = el('div', { class: 'row' }, lay); el('span', { text: 'Fit the page' }, fr);
      const fs = el('select', {}, fr);
      for (const [v, t] of [['adapt', 'Adapt'], ['shrink', 'Shrink only'], ['overlay', 'Do not move the page']]) { const o = el('option', { value: v, text: t }, fs); if ((uiSettings.fit || 'adapt') === v) o.selected = true; }
      fs.addEventListener('change', () => { uiSettings.fit = fs.value; fitZoom = 1; restoreFit(); lastPush = null; persistLayout(); applyLayout(); });

      const ch = section(parent, 'Chart');
      toggle(ch, 'chartX', 'Show X posts on the chart (X)', () => publishChart());
      toggle(ch, 'chartPump', 'Show pump.fun calls on the chart (PF)', () => publishChart());
      const soc = section(parent, 'Socials');
      toggle(soc, 'autoX', 'Search X automatically (opens the X search in a background tab once per token)', () => { autoXKey = ''; });
      if (xApiAvailable()) {
        toggle(soc, 'xApi', 'Search X without a tab — uses your X login', () => { autoXKey = ''; Object.assign(xApi, { key: '', next: 0, fellBack: '' }); });
        el('div', { class: 'sub', text: 'Experimental. Calls x.com\'s own web API from the background with your session (you must be logged in on x.com in this browser). Automated use is against X\'s terms: X allows about 50 searches per 15 minutes and may lock accounts that search a lot — ApeScope stays at one search per 30 s per token and stops when X says the limit is reached. If it fails, the X tab is used.' }, soc);
      }
      const src = section(parent, 'Checks');
      toggle(src, 'dex', 'Market data'); toggle(src, 'security', 'Contract security'); toggle(src, 'honeypot', 'Sell simulation (ETH, BSC, Base)');
      toggle(src, 'gmgn', 'GMGN holder analysis'); toggle(src, 'webChecks', 'Website & X checks');
      const ml = el('div', { class: 'row' }, src); el('span', { text: 'Minimum liquidity ($)' }, ml);
      const mi = el('input', { type: 'number', value: prefs.minLiq, min: 100, max: 1000000, step: 100, style: { width: '96px' } }, ml);
      mi.addEventListener('change', () => { prefs.minLiq = Math.min(1e6, Math.max(100, Number(mi.value) || 100)); put(LOCAL.preferences, prefs); });

      const al = section(parent, 'Alerts');
      toggle(al, 'alerts', 'Notify me about liquidity drops, volume spikes and social bursts', on => { if (on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); });
      if (prefs.alerts) for (const [key, name, min, max] of [['liqDropPct', 'Liquidity drop (%)', 1, 99], ['volumeSpike', 'Volume spike (×)', 1.2, 100]]) {
        const r = el('div', { class: 'row' }, al); el('span', { text: name }, r);
        const inp = el('input', { type: 'number', value: prefs[key], min, max, step: 1, style: { width: '96px' } }, r);
        inp.addEventListener('change', () => { prefs[key] = Math.min(max, Math.max(min, Number(inp.value) || min)); put(LOCAL.preferences, prefs); });
      }

      const rpc = section(parent, 'Solana RPC');
      const rr = el('div', { class: 'line' }, rpc);
      const rin = el('input', { type: 'url', placeholder: 'Optional — your own RPC URL', value: prefs.rpcUrl || '', spellcheck: 'false', style: { flex: '1' } }, rr);
      rin.addEventListener('change', () => {
        const v = rin.value.trim();
        if (v && !/^https:\/\/[^\s"'<>]+$/.test(v)) { alertLine('The RPC URL must start with https://'); rin.value = prefs.rpcUrl || ''; return; }
        prefs.rpcUrl = v; put(LOCAL.preferences, prefs); alertLine(v ? 'RPC saved' : 'Using the free public RPC');
      });
      button(rr, 'Test', async () => { try { await solRPC('getSlot', []); alertLine('RPC works'); } catch (e) { alertLine(e.message); } scheduleRender(); });

      const dev = section(parent, 'Advanced');
      toggle(dev, 'dev', 'Developer tools');
      if (prefs.dev) {
        const chart = load(K.chartDiag, {}), x = load(K.xHealth, {}), pump = load(K.pumpHealth, {});
        const b = el('div', { class: 'line' }, dev);
        const lr = el('div', { class: 'line' }, dev), cs = el('select', {}, lr);
        for (const [k2, c2] of Object.entries(CHAINS)) el('option', { value: k2, text: c2.name }, cs);
        const ci = el('input', { placeholder: 'Contract address', spellcheck: 'false', style: { flex: '1' } }, lr);
        button(lr, 'Load', () => { const ca = ci.value.trim(); if (!isValidAddress(ca, cs.value)) return alertLine('Invalid address for ' + CHAINS[cs.value].name); selectCoin({ ca, chain: cs.value }, true); swapTab('overview'); });
        button(b, 'Test chart marker', testMarker); button(b, 'Copy diagnostics', copyDiagnostics);
        if (s.fomoSample) button(b, 'Copy fomo data sample', () => { GM_setClipboard(s.fomoSample, 'text'); alertLine('Sample copied'); });
        button(b, 'Re-check clusters', () => refreshClusters(true));
        button(b, 'Export data', () => download('apescope-backup.json', JSON.stringify({ version: VERSION, watchlist: watches, alerts: notices, prefs, history: s.history }, null, 2), 'application/json'));
        if (notices.length) button(b, 'Clear alerts', () => { notices = []; put(LOCAL.notices, notices); render(); });
        row(dev, 'Chart markers', `${chart.markers ?? 0}${chart.error ? ' · ' + chart.error : ''}`);
        row(dev, 'X worker', x.detail || '—'); row(dev, 'pump.fun worker', pump.detail || '—');
        row(dev, 'ChatGPT / GMGN tab', `${aiWorkerOnline() ? 'online' : 'offline'} / ${gmgnWorkerOnline() ? 'online' : 'offline'}`);
        for (const k of ['dex', 'sec', 'rugcheck', 'honeypot', 'gmgn', 'rpc', 'ohlc', 'watch']) row(dev, k, s.errors[k] || s.statuses[k] || '—');
        const errs = Object.entries(s.project?.errors || {}); if (errs.length) row(dev, 'Sources unavailable', errs.map(([k, v]) => k + ': ' + v).join(' · '));
      }
      el('div', { class: 'sub', text: `${APP} v${VERSION} · not financial advice` }, parent);
    }

    // ---- Token detection ---------------------------------------------------------------------
    function getCoinFromRoute() {
      const route = decodeURIComponent(location.pathname + location.search + location.hash), raw = location.href;
      let chain = '';
      const aliases = [['solana', /\b(?:solana|sol)\b/i], ['bsc', /\b(?:bsc|bnb|binance)\b/i], ['ethereum', /\b(?:ethereum|eth)\b/i], ['base', /\bbase\b/i], ['monad', /\bmonad\b/i], ['robinhood', /\brobinhood\b/i]];
      // Chain hints must be whole route / query segments, not coincidental token names.
      for (const [name, rx] of aliases) if (rx.test(route.replace(/[\/#?&=_-]/g, ' '))) { chain = name; break; }
      if (/\/(?:tokens?|trade|coin)\//i.test(route)) { for (const [name, c] of Object.entries(CHAINS)) if (c.id && new RegExp('(?:/|=)' + c.id + '(?:/|&|$)').test(route)) chain = name; }
      const u = new URL(raw);
      for (const k of ['chain', 'network', 'chainId']) {
        const v = u.searchParams.get(k);
        if (v) for (const [name, c] of Object.entries(CHAINS)) if (v.toLowerCase() === name || String(c.id) === v || ['bnb', 'binance'].includes(v.toLowerCase()) && name === 'bsc' || v.toLowerCase() === 'eth' && name === 'ethereum') chain = name;
      }
      let ca = '';
      for (const k of ['mint', 'token', 'tokenAddress', 'contractAddress', 'address', 'ca']) { const val = u.searchParams.get(k); if (isValidAddress(val)) { ca = val; break; } }
      if (!ca && /(?:^|\/)token(?:s)?\/|\/trade\/|\/coin\//i.test(route)) {
        const match = decodeURIComponent(u.pathname).match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/); if (match && isValidAddress(match[0])) ca = match[0];
      }
      if (!ca) {
        const selectors = '[data-clipboard-text],[data-testid*="address" i],[aria-label*="contract" i],[aria-label*="mint" i]';
        for (const e of [...document.querySelectorAll(selectors)].slice(0, 110)) {
          if (host?.contains(e)) continue;
          const txt = [e.getAttribute('data-clipboard-text'), e.getAttribute('aria-label'), e.textContent].filter(Boolean).join(' ');
          const m = txt.match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g)?.find(x => isValidAddress(x));
          if (m) { ca = m; break; }
        }
      }
      if (!ca) return null;
      if (isValidEVM(ca) && (!chain || chain === 'solana')) {
        // Never silently assume Ethereum for a 0x address: the same CA can exist on several chains.
        const prev = s.coin; if (prev && isValidEVM(prev.ca) && sameAddr(prev.ca, ca) && prev.chain !== 'solana') chain = prev.chain;
        else return { ca, chain: '', needsChain: true };
      }
      if (isValidMint(ca)) chain = 'solana';
      return { ca, chain };
    }
    // A 0x address can exist on several chains: ask DexScreener once per address and pick the supported
    // chain with the highest summed liquidity. Results are cached; failures retry after 60s.
    const chainLookups = new Map();
    function autoDetectChain(ca) {
      const k = ca.toLowerCase(), prev = chainLookups.get(k);
      if (prev && (prev.chain || prev.pending || Date.now() - prev.ts < 60000)) return prev;
      const entry = { pending: true, chain: '', ts: Date.now() }; chainLookups.set(k, entry);
      requestJson('https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(ca)).then(res => {
        const totals = new Map();
        for (const p of Array.isArray(res?.pairs) ? res.pairs : []) {
          if (!sameAddr(p?.baseToken?.address, ca) && !sameAddr(p?.quoteToken?.address, ca)) continue;
          const c = Object.keys(CHAINS).find(key => key !== 'solana' && CHAINS[key].dex === p.chainId);
          if (c) totals.set(c, (totals.get(c) || 0) + (Number(p.liquidity?.usd) || 0));
        }
        entry.chain = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      }).catch(() => {}).finally(() => { entry.pending = false; entry.ts = Date.now(); try { detectCoin(); scheduleRender(); } catch {} });
      return entry;
    }
    function detectCoin(force = false) {
      if (!force && s.manual && s.seenUrl === location.href) return;
      if (s.seenUrl !== location.href) { s.manual = false; s.seenUrl = location.href; }
      const d = getCoinFromRoute(); if (!d) return;
      if (d.needsChain) {
        if (s.coin && !sameAddr(s.coin.ca, d.ca)) { s.coin = null; s.market = null; s.events = []; window.postMessage({ type: MSG.chartEvents, clear: true }, location.origin); }
        const look = autoDetectChain(d.ca);
        if (look.chain) { s.errors.detect = ''; selectCoin({ ca: d.ca, chain: look.chain }, false); return; }
        s.errors.detect = look.pending ? 'Detecting the EVM chain via DexScreener…' : 'EVM address found but the chain could not be detected — pick the chain and press Load.';
        scheduleRender(); return;
      }
      s.errors.detect = ''; if (!s.coin || curKey() !== tokenKey(d.chain, d.ca)) selectCoin(d, false);
    }
    function selectCoin({ ca, chain }, manual = false) {
      if (!CHAINS[chain] || !isValidAddress(ca, chain)) return false;
      const k = tokenKey(chain, ca); s.manual = manual; s.seenUrl = location.href;
      if (k === curKey()) { scheduleRender(); return true; }
      Object.assign(s, { coin: { ca, chain }, market: null, pairs: [], sec: null, hp: null, rugcheck: null, project: null, github: null, similar: null, gmgn: null, intel: null, clusters: null,
        aiResults: load('aps:ai:' + k, {}), aiPrompt: null, secFlags: [], ohlc: [], ohlcError: '', history: load('aps:history:' + k, []), testEvents: [],
        creatorSecurity: null, events: [], errors: {}, rpcAccounts: [], lastEventHash: '', lastMarketKey: '', lastSecurityKey: '', lastOhlcAt: 0 });
      s.loading.gmgn = false;
      put(K.query, { ca, chain, ts: Date.now(), nonce: Math.random().toString(16).slice(2) });
      pullEvents(); publishChart(); refreshMarket(); refreshSecurity(); refreshProject(); refreshGmgn(); refreshPump(true); scheduleRender();
      setTimeout(() => { if (k === curKey()) refreshClusters(); }, 8000);   // many RPC calls: start after the main data
      return true;
    }

    // ---- Social events (X / pump.fun workers, imports) and chart markers ----------------------
    function validEvent(ev) { return ev && isValidAddress(ev.ca) && ['x', 'pump', 'telegram', 'manual', 'wallet'].includes(ev.source) && typeof ev.id === 'string' && parseTime(ev.timestamp) && typeof ev.author === 'string'; }
    function pullEvents() {
      if (!s.coin) return;
      const key = curKey(), xs = [...load(K.xFeedPrefix + key, []), ...(s.coin.chain === 'solana' ? load(K.xFeedPrefix + s.coin.ca, []) : [])];
      const ps = s.coin.chain === 'solana' ? [...load(K.pumpCache, []), ...(s.pump?.key === key ? s.pumpEvents || [] : [])] : [];
      const all = [...xs, ...ps, ...s.testEvents].filter(ev => validEvent(ev) && sameAddr(ev.ca, s.coin.ca) && (!ev.chain || ev.chain === s.coin.chain));
      const m = new Map(); for (const e of all) m.set(e.source + ':' + e.id, { ...e, chain: s.coin.chain });
      const incoming = [...m.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
      const hash = incoming.map(e => e.source + e.id + e.timestamp).join('|'); s.events = incoming;
      if (hash !== s.lastEventHash) { s.lastEventHash = hash; publishChart(); if (prefs.alerts) detectSocialAlerts(incoming); scheduleRender(); }
    }
    function publishChart() {
      if (!s.coin) return;
      window.postMessage({ type: MSG.chartEvents, ca: s.coin.ca, chain: s.coin.chain,
        events: s.events.filter(e => e.source === 'x' ? prefs.chartX : e.source === 'pump' ? prefs.chartPump : true).slice(0, 180).map(e => ({ ca: e.ca, id: e.id, source: e.source, timestamp: e.timestamp, author: e.author, text: e.text, url: e.url })) }, location.origin);
    }
    /** Starts the X search in a background tab once per token when none is running (Settings → Sidebar → "Search X automatically"). */
    let autoXKey = '';
    function autoSearchX() {
      if (!s.coin || !prefs.autoX || autoXKey === curKey()) return;
      if (prefs.xApi && xApiAvailable() && xApi.fellBack !== curKey()) return;   // searched without a tab (pollXApi)
      const h = load(K.xHealth, {}); autoXKey = curKey();
      if (h?.ts && h.via !== 'api' && Date.now() - h.ts < 60000) { put(K.query, { ca: s.coin.ca, chain: s.coin.chain, ts: Date.now() }); return; }   // running tab follows the token
      GM_openInTab(searchUrl(s.coin.ca), { active: false });
    }
    function openWorkerX() { if (s.coin) GM_openInTab(searchUrl(s.coin.ca), { active: true, insert: true }); }
    // ---- X search without a tab (Settings → Socials → "Search X without a tab", off by default) ----
    // background.js runs x.com's own SearchTimeline request with the user's X session and paces all tabs (one call
    // per 15 s, nothing while X reports the rate limit). Results become the same events the X tab worker stores.
    const xApiAvailable = () => typeof APS_xSearch === 'function';
    const xApi = { key: '', next: 0, pages: 0, cursor: '', busy: false, fellBack: '' };
    /** SearchTimeline tweets → X events exactly like the X tab worker (runX) produces them. */
    function xEventsFrom(tweets, ca, chain) {
      const has = isValidMint(ca) ? t => t.includes(ca) : t => t.toLowerCase().includes(ca.toLowerCase());
      const out = [];
      for (const t of Array.isArray(tweets) ? tweets : []) {
        const id = String(t?.id || ''), handle = String(t?.handle || ''), text = String(t?.text || '');
        if (!/^\d{1,25}$/.test(id) || !/^\w{1,15}$/.test(handle) || !has(text)) continue;
        const timestamp = parseTime(t.createdAt); if (!timestamp) continue;   // never invent post timestamps
        out.push({ source: 'x', chain, ca, timestamp, author: '@' + handle, text: trim(text, 500), url: `https://x.com/${handle}/status/${id}`, id: 'x:' + id });
      }
      return out;
    }
    async function pollXApi() {
      if (!prefs.xApi || !s.coin || !xApiAvailable() || xApi.busy) return;
      const key = curKey(), { ca, chain } = s.coin;
      if (xApi.key !== key) Object.assign(xApi, { key, next: 0, pages: 0, cursor: '' });
      if (xApi.fellBack === key || Date.now() < xApi.next) return;
      xApi.busy = true;
      try {
        // A new token: newest page plus one older page; afterwards only the newest posts.
        const older = xApi.pages === 1 && xApi.cursor;
        const r = await APS_xSearch({ query: '"' + ca + '"', cursor: older ? xApi.cursor : '' }) || {};
        if (key !== curKey()) return;
        if (r.ok) {
          const found = xEventsFrom(r.tweets, ca, chain), skey = K.xFeedPrefix + key, previous = load(skey, []), merged = mergeEvents(previous, found, 400);
          if (merged.length !== previous.length || found.some(x => !previous.some(y => x.id === y.id))) put(skey, merged);
          setStatus(K.xHealth, true, `searched without a tab; ${merged.length} posts stored for this CA` + (r.rate ? ` · ${r.rate.remaining} searches left` : ''), { ca, via: 'api' });
          put(K.xError, '');
          xApi.pages++; xApi.cursor = r.cursor || '';
          xApi.next = Date.now() + (xApi.pages === 1 && xApi.cursor ? 16000 : Math.max(options.xPollMs, 30000));
        } else if (r.code === 'busy') xApi.next = Math.max(Date.now() + 2000, Number(r.retryAt) || 0);
        else if (r.code === 'rate') {
          xApi.next = Math.max(Date.now() + 60000, Number(r.retryAt) || 0);
          put(K.xError, 'X rate limit reached — next search without a tab at ' + new Date(xApi.next).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
        } else {
          // Logged out, X changed its web app, network error: use the X tab for this token instead.
          xApi.next = Date.now() + 5 * 60000; xApi.fellBack = key;
          put(K.xError, 'X search without a tab failed: ' + trim(r.error || 'unknown error', 120) + (prefs.autoX ? ' — using the X tab instead.' : ' — use "Search X for this token".'));
          if (prefs.autoX) { autoXKey = ''; autoSearchX(); }
        }
      } catch (e) { xApi.next = Date.now() + 60000; put(K.xError, 'X search without a tab: ' + trim(String(e?.message || e), 120)); }
      finally { xApi.busy = false; }
    }
    function testMarker() {
      if (!s.coin) return;
      s.testEvents = [{ source: 'manual', chain: s.coin.chain, ca: s.coin.ca, id: 'test:' + curKey(), timestamp: Math.floor(Date.now() / 1000), author: 'TEST', text: 'Local test marker, not a real post', url: '' }];
      pullEvents();
    }
    function copyDiagnostics() {
      const d = { version: VERSION, time: new Date().toISOString(), coin: s.coin, chart: load(K.chartDiag, {}), pump: load(K.pumpDiag, []), x: load(K.xHealth, {}), pumpHealth: load(K.pumpHealth, {}),
        gmgnWorker: gmgnWorkerOnline(), aiWorker: aiWorkerOnline(), errors: s.errors, statuses: s.statuses,
        eventsBySource: Object.fromEntries(['x', 'pump', 'manual', 'telegram'].map(k => [k, s.events.filter(e => e.source === k).length])),
        marketKeys: s.market ? Object.keys(s.market) : [], securityKeys: s.sec ? Object.keys(s.sec) : [], watchCount: watches.length, layout: { dock: uiSettings.dock, width: uiSettings.width } };
      const out = JSON.stringify(d, null, 2);
      try { GM_setClipboard(out, 'text'); alertLine('Diagnostics copied'); } catch { alertLine('Clipboard not available'); }
      scheduleRender();
    }
    function download(name, content, type) {
      const blob = new Blob([content], { type }), href = URL.createObjectURL(blob), a = el('a', { href, download: name });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 3000);
    }
    function toggleWatch() {
      if (!s.coin) return;
      const k = curKey();
      if (watches.some(x => x.key === k)) watches = watches.filter(x => x.key !== k); else watches.unshift({ key: k, ...s.coin, ts: Date.now() });
      watches = watches.slice(-100); put(LOCAL.watches, watches); render();
    }
    function notify(msg) {
      notices.push({ ts: Date.now(), message: msg }); notices = notices.slice(-100); put(LOCAL.notices, notices);
      if (prefs.alerts && 'Notification' in window && Notification.permission === 'granted' && document.hidden) { try { new Notification(APP, { body: msg.slice(0, 180) }); } catch {} }
      scheduleRender();
    }
    function detectSocialAlerts(events) {
      const last5 = events.filter(e => e.timestamp >= Math.floor(Date.now() / 1000) - 300 && e.source !== 'manual');
      if (last5.length >= 3) { const k = curKey() + ':social:' + Math.floor(Date.now() / 300000); if (!lastNotify.has(k)) { lastNotify.add(k); notify(`${short(s.coin.ca)}: ${last5.length} social signals in 5m`); } }
    }

    // ---- Network: allow-listed public APIs only -----------------------------------------------
    const API_HOSTS = /^https:\/\/(?:api\.dexscreener\.com|api\.gopluslabs\.io|api\.honeypot\.is|api\.geckoterminal\.com|api\.rugcheck\.xyz|api\.mainnet-beta\.solana\.com|public\.rpc\.solanavibestation\.com|api\.github\.com|lite-api\.jup\.ag|api\.fxtwitter\.com|rdap\.org|frontend-api-v3\.pump\.fun|fun-block\.pump\.fun|raw\.githubusercontent\.com)\//;
    function requestJson(url, opts = {}) {
      return new Promise((resolve, reject) => {
        // Allow-listed public APIs only; the one exception is the custom Solana RPC the user entered in Settings.
        if (!API_HOSTS.test(url) && !(opts.customRpc && url === prefs.rpcUrl)) return reject(Error('Host not allowed'));
        GM_xmlhttpRequest({ method: opts.method || 'GET', url, headers: opts.headers || { Accept: 'application/json' }, data: opts.data, timeout: opts.timeout || 14000, anonymous: true, withCredentials: false,
          onload: r => {
            if (r.status < 200 || r.status >= 300) return reject(Error('HTTP ' + r.status));
            if (r.responseText.length > 3_000_000) return reject(Error('Response too large'));
            try { const json = JSON.parse(r.responseText); resolve(opts.withHeaders ? { json, headers: String(r.responseHeaders || '') } : json); } catch { reject(Error('Invalid JSON')); }
          },
          ontimeout: () => reject(Error('Timeout')), onerror: () => reject(Error('Network error')) });
      });
    }
    /** GET a project website as text (no cookies, never executed or rendered — only parsed for a few facts). */
    function requestPage(url) {
      return new Promise((resolve, reject) => {
        const u = safeHttp(url); if (!u) return reject(Error('invalid URL'));
        GM_xmlhttpRequest({ method: 'GET', url: u, headers: { Accept: 'text/html,application/xhtml+xml' }, timeout: 12000, anonymous: true, withCredentials: false,
          onload: r => resolve({ status: r.status, finalUrl: String(r.finalUrl || u), html: String(r.responseText || '').slice(0, 1_500_000) }),
          ontimeout: () => reject(Error('Timeout')), onerror: () => reject(Error('Network error')) });
      });
    }

    // ---- DexScreener market -------------------------------------------------------------------
    function bestPair(pairs, ca, chain) {
      return (Array.isArray(pairs) ? pairs : []).filter(p => p?.chainId === CHAINS[chain]?.dex && (sameAddr(p.baseToken?.address, ca) || sameAddr(p.quoteToken?.address, ca)))
        .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0] || null;
    }
    function baseMarketFromPair(p, ca, chain) {
      const isBase = sameAddr(p.baseToken?.address, ca);
      return { chain, ca, ts: Date.now(), symbol: isBase ? p.baseToken?.symbol : p.quoteToken?.symbol,
        marketCap: isBase ? safeNum(p.marketCap) : null, fdv: isBase ? safeNum(p.fdv) : null, liquidity: safeNum(p.liquidity?.usd), priceUsd: isBase ? safeNum(p.priceUsd) : null,
        volume5m: safeNum(p.volume?.m5), volume1h: safeNum(p.volume?.h1), volume24h: safeNum(p.volume?.h24),
        buys5m: safeNum(p.txns?.m5?.buys), sells5m: safeNum(p.txns?.m5?.sells), change5m: safeNum(p.priceChange?.m5),
        dex: String(p.dexId || ''), pair: String(p.pairAddress || ''), url: /^https:\/\/dexscreener\.com\//.test(p.url || '') ? p.url : '',
        boosts: safeNum(p.boosts?.active), createdAt: safeNum(p.pairCreatedAt), tokenPosition: isBase ? 'base' : 'quote' };
    }
    /** Raw DexScreener pair plus derived quick-decision metrics. */
    function marketFromPair(p, ca, chain) {
      const m = baseMarketFromPair(p, ca, chain), tx5m = (m.buys5m || 0) + (m.sells5m || 0);
      m.avgTrade5m = tx5m > 0 && m.volume5m != null ? m.volume5m / tx5m : null;
      m.volVelocity = m.volume1h > 0 && m.volume5m != null ? m.volume5m / (m.volume1h / 12) : null; // 5m vs. the average 5m slice of the last hour
      m.liqMcapPct = m.marketCap > 0 && m.liquidity != null ? 100 * m.liquidity / m.marketCap : null;
      m.suspectedBumpBot = tx5m >= 40 && m.avgTrade5m != null && m.avgTrade5m < 6;                   // many tiny trades = volume bot
      m.socials = Array.isArray(p.info?.socials) ? p.info.socials.slice(0, 10).map(x => ({ type: String(x?.type || '').slice(0, 30), url: String(x?.url || '').slice(0, 300) })) : [];
      m.websites = Array.isArray(p.info?.websites) ? p.info.websites.slice(0, 5).map(x => String(x?.url || '').slice(0, 300)).filter(Boolean) : [];
      m.websiteLabels = Object.fromEntries((Array.isArray(p.info?.websites) ? p.info.websites : []).slice(0, 5).map(x => [String(x?.url || '').slice(0, 300), String(x?.label || '').slice(0, 20)]));
      m.hasSocials = m.socials.length > 0 || m.websites.length > 0;
      const tok = sameAddr(p.baseToken?.address, ca) ? p.baseToken : p.quoteToken; m.name = String(tok?.name || '').slice(0, 80);
      m.txns = Object.fromEntries(['m5', 'h1', 'h6', 'h24'].map(k => [k, { buys: safeNum(p.txns?.[k]?.buys), sells: safeNum(p.txns?.[k]?.sells), volume: safeNum(p.volume?.[k]), change: safeNum(p.priceChange?.[k]) }]));
      m.dexPaid = null; m.dexProcessing = false; m.ctoActive = false; m.adsActive = false;
      return m;
    }
    /** DexScreener orders: a missing/failed answer stays "unknown" (never shown as unpaid). */
    function applyOrders(m, raw) {
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.orders) ? raw.orders : null; if (!list) return m;
      const has = (type, status) => list.some(o => o?.type === type && o?.status === status);
      m.dexPaid = has('tokenProfile', 'approved'); m.dexProcessing = !m.dexPaid && has('tokenProfile', 'processing');
      m.ctoActive = has('communityTakeover', 'approved'); m.adsActive = has('tokenAd', 'approved'); return m;
    }
    function appendSnapshot(key, m) {
      let h = load('aps:history:' + key, []); if (!Array.isArray(h)) h = [];
      const p = h.at(-1), entry = { ts: Date.now(), marketCap: m.marketCap, priceUsd: m.priceUsd, liquidity: m.liquidity, volume5m: m.volume5m, holders: (s.fomo?.key === key ? s.fomo.details?.holders : null) ?? s.sec?.holder_count ?? null };
      if (!p || Date.now() - p.ts >= 30_000) { h.push(entry); h = h.filter(x => x.ts > Date.now() - 7 * 86400000).slice(-700); put('aps:history:' + key, h); }
      if (key === curKey()) s.history = h;
      return p;
    }
    function marketAlerts(key, m, old) {
      if (!prefs.alerts || !m) return;
      let reason = '';
      if (m.liquidity != null && m.liquidity < prefs.minLiq) reason = 'liquidity below ' + money(prefs.minLiq);
      if (old && m.liquidity != null && old.liquidity > 0 && 100 * (1 - m.liquidity / old.liquidity) >= prefs.liqDropPct) reason = 'liquidity dropped ' + (100 * (1 - m.liquidity / old.liquidity)).toFixed(1) + '%';
      if (old && old.volume5m > 0 && m.volume5m > 0 && m.volume5m / old.volume5m >= prefs.volumeSpike) reason = '5m volume spike ' + (m.volume5m / old.volume5m).toFixed(1) + '× (overlapping windows)';
      if (reason) { const id = key + reason.split(' ')[0] + Math.floor(Date.now() / 300000); if (!lastNotify.has(id)) { lastNotify.add(id); notify((m.symbol ? '$' + m.symbol : key) + ': ' + reason); } }
    }
    async function marketQuery(coin, background = false) {
      const key = tokenKey(coin.chain, coin.ca), dexChain = CHAINS[coin.chain].dex, addr = encodeURIComponent(coin.ca);
      // Pairs: 300 requests/min allowed → every few seconds. Paid orders (60/min, rarely change) at most once a minute.
      const ordersFresh = s.ordersCache?.key === key && Date.now() - s.ordersCache.ts < 60_000;
      const [j, orders] = await Promise.all([requestJson('https://api.dexscreener.com/token-pairs/v1/' + dexChain + '/' + addr),
        background ? Promise.resolve(null) : ordersFresh ? Promise.resolve(s.ordersCache.orders)
          : requestJson('https://api.dexscreener.com/orders/v1/' + dexChain + '/' + addr).then(o => { s.ordersCache = { key, ts: Date.now(), orders: o }; return o; }).catch(() => null)]);
      const pair = bestPair(j, coin.ca, coin.chain); if (!pair) throw Error('No matching DexScreener pair found');
      const m = applyOrders(marketFromPair(pair, coin.ca, coin.chain), orders);
      const prior = load('aps:lastmarket:' + key, null); put('aps:lastmarket:' + key, m);
      marketAlerts(key, m, prior);
      if (!background && key === curKey()) { s.market = m; s.pairs = j; s.lastDexAt = Date.now(); s.statuses.dex = 'OK · ' + new Date().toLocaleTimeString('en-GB'); appendSnapshot(key, m); refreshSimilar(); scheduleRender(); }
      return m;
    }
    async function refreshMarket(force = false) {
      if (!s.coin || !prefs.dex || s.loading.dex) return;
      if (!force && s.lastMarketKey === curKey() && Date.now() - s.lastDexAt < LIVE.market - 500) return;
      const coin = { ...s.coin }, key = curKey(); s.loading.dex = true; s.lastMarketKey = key;
      try { await marketQuery(coin); if (key === curKey()) delete s.errors.dex; }
      catch (e) { if (key === curKey()) s.errors.dex = 'DexScreener: ' + e.message; }
      finally { s.loading.dex = false; scheduleRender(); }
    }

    // ---- GoPlus / RugCheck / Honeypot.is ------------------------------------------------------
    function pct(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? (n <= 1 ? n * 100 : n) : null; }
    function flagsFromToken(t, chain) {
      const flags = []; const add = (cond, title, detail, severity = 'high') => { if (cond === true) flags.push({ title, detail, severity }); };
      if (chain === 'solana') {
        add(t.mintable === '1' || t.mint_authority_status === '1' || (typeof t.mint_authority === 'string' && t.mint_authority.length > 20), 'Mint authority', 'New tokens may be minted.');
        add(t.freezable === '1' || t.freeze_authority_status === '1' || (typeof t.freeze_authority === 'string' && t.freeze_authority.length > 20), 'Freeze authority', 'Accounts may be frozen.');
        add(t.transfer_hook_upgradable === '1', 'Transfer hook', 'Transfer hook can be changed.');
      } else {
        add(t.is_honeypot === '1', 'Honeypot', 'GoPlus reports a honeypot.'); add(t.cannot_sell_all === '1' || t.cannot_sell_all === 'true', 'Sell block', 'Selling may be restricted.');
        add(t.is_blacklisted === '1', 'Blacklist', 'Contract has a blacklist function.'); add(t.is_mintable === '1', 'Mintable', 'More tokens can be minted.');
        add(t.is_proxy === '1', 'Proxy contract', 'Implementation can be changed.', 'medium'); add(t.hidden_owner === '1', 'Hidden owner', 'Hidden owner function.');
        add(t.is_open_source === '0', 'Unverified source', 'Contract source code is not verified.', 'medium');
        const sell = Number(t.sell_tax); if (Number.isFinite(sell) && sell > 0.2) add(true, 'High sell tax', (sell * 100).toFixed(1) + '%', 'medium');
      }
      const top = (t.holders || []).reduce((n, h) => n + (pct(h.percent) || 0), 0);
      if (top > 60) add(true, 'Top-10 concentration', top.toFixed(1) + '% in reported accounts', 'medium');
      return flags;
    }
    function normalizeSecurity(data, ca, chain) {
      if (data?.code != null && Number(data.code) !== 1) throw Error('GoPlus: ' + String(data.message || data.code).slice(0, 110));
      const r = data?.result || {}, result = r[ca] || r[ca.toLowerCase()] || r[ca.toUpperCase()] || Object.entries(r).find(([k]) => sameAddr(k, ca))?.[1] || r;
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length) throw Error('No GoPlus token profile');
      const holders = Array.isArray(result.holders) ? result.holders.map(h => ({ address: h.address || h.token_account || '', owner: isValidAddress(h.account || '') ? h.account : isValidAddress(h.owner || '') ? h.owner : '', percent: pct(h.percent), tag: String(h.tag || '').slice(0, 30) })).filter(x => isValidAddress(x.address)).slice(0, 20) : [];
      const top10Pct = holders.length ? holders.slice(0, 10).reduce((n, h) => n + (h.percent || 0), 0) : null;
      const creatorPct = pct(result.creator_percent), lpHolders = Array.isArray(result.lp_holders) ? result.lp_holders : [];
      const isBurnAddr = a => /^0x0{40}$|^0x0{36}dead$/i.test(String(a || ''));
      const lpLockedPct = lpHolders.length ? Math.min(100, lpHolders.filter(l => String(l?.is_locked) === '1' || isBurnAddr(l?.address) || /burn|dead|lock/i.test(String(l?.tag || ''))).reduce((n, l) => n + (pct(l.percent) || 0), 0)) : null;
      return { raw: result, holder_count: safeNum(result.holder_count), creator: result.creator_address || result.creator || result.owner_address || '', creatorPct, lpLockedPct, holders, top10Pct };
    }
    async function refreshSecurity(force = false) {
      if (!s.coin || !prefs.security || s.loading.sec) return;
      const coin = { ...s.coin }, key = curKey();
      if (!force && s.lastSecurityKey === key && Date.now() - s.lastSecAt < LIVE.security - 500) return;
      s.loading.sec = true; s.lastSecurityKey = key;
      const u = coin.chain === 'solana' ? 'https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=' + encodeURIComponent(coin.ca)
        : `https://api.gopluslabs.io/api/v1/token_security/${CHAINS[coin.chain].id}?contract_addresses=${encodeURIComponent(coin.ca)}`;
      try {
        const sec = normalizeSecurity(await requestJson(u), coin.ca, coin.chain);
        if (key === curKey()) { s.sec = sec; s.secFlags = flagsFromToken(sec.raw, coin.chain); s.lastSecAt = Date.now(); s.statuses.sec = 'OK'; delete s.errors.sec; if (s.market) appendSnapshot(key, s.market); }
      } catch (e) { if (key === curKey()) s.errors.sec = e.message; }
      finally { s.loading.sec = false; scheduleRender(); }
      if (key === curKey() && coin.chain === 'solana') refreshRugcheck(force);
      if (key === curKey() && prefs.honeypot && ['ethereum', 'bsc', 'base'].includes(coin.chain)) refreshHoneypot(force);
    }
    function normalizeRugcheck(rc, key) {
      if (!rc || typeof rc !== 'object' || Array.isArray(rc)) throw Error('Invalid RugCheck response');
      const risks = Array.isArray(rc.risks) ? rc.risks.slice(0, 20).map(r => ({ name: String(r?.name || '?').slice(0, 80), level: String(r?.level || '').slice(0, 12),
        value: String(r?.value || '').slice(0, 60), description: String(r?.description || '').slice(0, 200) })) : [];
      return { key, ts: Date.now(), score: safeNum(rc.score_normalised ?? rc.score), lpLockedPct: safeNum(rc.lpLockedPct), risks };
    }
    async function refreshRugcheck(force = false) {
      if (!s.coin || s.coin.chain !== 'solana' || s.loading.rugcheck) return;
      const coin = { ...s.coin }, key = curKey(); if (!force && s.rugcheck?.key === key && Date.now() - s.rugcheck.ts < 180000) return;
      s.loading.rugcheck = true;
      try { const rc = await requestJson('https://api.rugcheck.xyz/v1/tokens/' + encodeURIComponent(coin.ca) + '/report/summary'); if (key === curKey()) { s.rugcheck = normalizeRugcheck(rc, key); s.statuses.rugcheck = 'OK'; delete s.errors.rugcheck; } }
      catch (e) { if (key === curKey()) s.errors.rugcheck = e.message; }
      finally { s.loading.rugcheck = false; scheduleRender(); }
    }
    async function refreshHoneypot(force = false) {
      if (!s.coin || !prefs.honeypot || s.loading.honeypot || !['ethereum', 'bsc', 'base'].includes(s.coin.chain)) return;
      const coin = { ...s.coin }, key = curKey(); if (!force && s.hp?.key === key && Date.now() - s.hp.ts < 180000) return;
      s.loading.honeypot = true;
      try {
        const d = await requestJson(`https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(coin.ca)}&chainID=${CHAINS[coin.chain].id}`);
        if (key === curKey()) {
          s.hp = { key, ts: Date.now(), isHoneypot: typeof d.honeypotResult?.isHoneypot === 'boolean' ? d.honeypotResult.isHoneypot : null,
            buyTax: safeNum(d.simulationResult?.buyTax), sellTax: safeNum(d.simulationResult?.sellTax), error: d.simulationError ? JSON.stringify(d.simulationError).slice(0, 200) : '' };
          s.statuses.honeypot = 'OK'; delete s.errors.honeypot;
        }
      } catch (e) { if (key === curKey()) s.errors.honeypot = e.message; }
      finally { s.loading.honeypot = false; scheduleRender(); }
    }
    async function loadCreatorRisk() {
      if (!s.coin || !s.sec?.creator || !isValidAddress(s.sec.creator, s.coin.chain)) return;
      const coin = { ...s.coin }, key = curKey(), creator = s.sec.creator;
      try {
        const j = await requestJson('https://api.gopluslabs.io/api/v1/address_security/' + encodeURIComponent(creator) + (CHAINS[coin.chain].id ? '?chain_id=' + CHAINS[coin.chain].id : ''));
        if (j.code != null && Number(j.code) !== 1) throw Error('GoPlus: ' + (j.message || j.code));
        const d = j.result || {}, flagged = ['honeypot_related_address', 'phishing_activities', 'blackmail_activities', 'stealing_attack', 'malicious_mining_activities', 'darkweb_transactions'].filter(k => String(d[k]) === '1');
        if (key === curKey()) s.creatorSecurity = { risk: flagged.length > 0, message: flagged.length ? flagged.join(', ') : 'no positive flags in the returned data (not an all-clear)' };
      } catch (e) { if (key === curKey()) s.creatorSecurity = { risk: false, message: 'lookup unavailable: ' + e.message }; }
      scheduleRender();
    }

    // ---- Links ---------------------------------------------------------------------------------
    const FOMO_CHAINS = ['solana', 'base', 'bsc', 'ethereum', 'monad', 'robinhood']; // chains listed on fomo.family
    const fomoUrl = (chain, ca) => FOMO_CHAINS.includes(chain) ? 'https://fomo.family/tokens/' + chain + '/' + ca : '';
    // Padre opens tokens by pool address (e.g. trade.padre.gg/trade/solana/<PumpSwap pool>); falls back to the CA.
    const padreUrl = (chain, id) => chain === 'solana' && id ? 'https://trade.padre.gg/trade/solana/' + id : '';
    /** The token's launchpad page (pump.fun, letsbonk.fun, Bags, Believe), if known. */
    function launchpadLink(coin = s.coin) {
      if (!coin || coin.chain !== 'solana') return null;
      const lp = (s.project?.jup?.launchpad || gmgnExtra()?.launchpad || '').toLowerCase(), ca = coin.ca;
      if (/pump/.test(lp) || (!lp && /pump$/.test(ca))) return { label: 'pump.fun', url: 'https://pump.fun/coin/' + ca };
      if (/bonk/.test(lp) || (!lp && /bonk$/.test(ca))) return { label: 'letsbonk.fun', url: 'https://letsbonk.fun/token/' + ca };
      if (/bags/.test(lp)) return { label: 'Bags', url: 'https://bags.fm/' + ca };
      if (/believe/.test(lp)) return { label: 'Believe', url: 'https://believe.app/coin/' + ca };
      return null;
    }
    /** One-click links grouped as trade (platforms), research and search. */
    function quickLinks(coin = s.coin, m = s.market) {
      if (!coin) return [];
      const { chain, ca } = coin, c = CHAINS[chain] || {}, sym = m?.symbol || s.project?.jup?.symbol || '', gm = GMGN_CHAIN[chain], pair = m?.pair && /^[\w-]{10,100}$/.test(m.pair) ? m.pair : '';
      const lp = launchpadLink(coin);
      return [
        ['trade', 'FOMO', fomoUrl(chain, ca)], ['trade', 'Padre', padreUrl(chain, pair || ca)],
        ['trade', 'Axiom', chain === 'solana' && pair ? 'https://axiom.trade/meme/' + pair : ''],
        ['trade', 'Photon', chain === 'solana' && pair ? 'https://photon-sol.tinyastro.io/en/lp/' + pair : ''],
        ['trade', 'GMGN', gm ? 'https://gmgn.ai/' + gm + '/token/' + ca : ''], ['trade', lp?.label || '', lp?.url || ''],
        ['research', 'DexScreener', m?.url || (c.dex ? 'https://dexscreener.com/' + c.dex + '/' + ca : '')],
        ['research', 'Bubblemaps', gm ? 'https://app.bubblemaps.io/' + gm + '/token/' + ca : ''], ['research', 'RugCheck', chain === 'solana' ? 'https://rugcheck.xyz/tokens/' + ca : ''],
        ['research', 'GeckoTerminal', c.gecko && pair ? 'https://www.geckoterminal.com/' + c.gecko + '/pools/' + pair : ''], ['research', 'Explorer', c.explorer ? c.explorer + ca : ''],
        ['research', 'Search CA on X', searchUrl(ca).replace(/&apescope_worker=1$/, '')], ['research', 'Search $' + sym + ' on X', sym ? 'https://x.com/search?q=' + encodeURIComponent('$' + sym) + '&f=live' : ''],
      ].filter(([, label, u]) => label && u).map(([group, label, url]) => ({ group, label, url }));
    }

    /** Website / socials / GitHub of the project, merged from all sources and de-duplicated (X by handle). */
    function projectLinks() {
      const m = s.market || {}, p = s.project?.key === curKey() ? s.project : {}, seen = new Set(), out = [];
      const kindOf = (type, url) => {
        const t = String(type || '').toLowerCase();
        if (/twitter|^x$/.test(t) || /\/\/(www\.)?(x|twitter)\.com\//i.test(url)) return 'X';
        if (/telegram/.test(t) || /\/\/t\.me\//i.test(url)) return 'Telegram';
        if (/discord/.test(t) || /discord\.(gg|com)/i.test(url)) return 'Discord';
        if (/\/\/(www\.)?github\.com\//i.test(url)) return 'GitHub';
        return t && t !== 'website' ? t[0].toUpperCase() + t.slice(1, 20) : 'Website';
      };
      const keyOf = (kind, u) => {
        const x = new URL(u);
        if (kind === 'X') {
          const seg = x.pathname.split('/').filter(Boolean);
          if (!seg.length || ['search', 'intent', 'home', 'hashtag', 'share'].includes(seg[0].toLowerCase())) return null;
          return seg[0] === 'i' ? 'x:/' + x.pathname.toLowerCase() : 'x:' + seg[0].toLowerCase(); // one entry per X account; communities kept as-is
        }
        return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase();
      };
      const add = (type, url, src) => {
        const u = safeHttp(url); if (!u) return;
        const kind = kindOf(type, u), k = keyOf(kind, u); if (!k || seen.has(k)) return;
        seen.add(k); out.push({ kind: kind === 'X' && k.startsWith('x:/') ? 'X community' : kind, url: kind === 'X' && !k.startsWith('x:/') ? 'https://x.com/' + k.slice(2) : u, src });
      };
      for (const w of m.websites || []) { const lb = (m.websiteLabels || {})[w] || ''; add(/^website$/i.test(lb) ? '' : lb, w, 'DexScreener'); }   // e.g. "Docs", "Whitepaper"
      for (const x of m.socials || []) add(x.type, x.url, 'DexScreener');
      const gt = p.gt;
      if (gt) {
        for (const w of gt.websites) add('', w, 'GeckoTerminal');
        if (gt.twitter) add('twitter', 'https://x.com/' + gt.twitter, 'GeckoTerminal');
        if (gt.telegram) add('telegram', 'https://t.me/' + gt.telegram, 'GeckoTerminal');
        if (gt.discord) add('discord', gt.discord, 'GeckoTerminal');
      }
      const j = p.jup; if (j) { add('', j.website, 'Jupiter'); add('twitter', j.twitter, 'Jupiter'); }
      for (const u of String(gt?.description || '').match(/https:\/\/(?:www\.)?github\.com\/[^\s)"'<>,]+/gi) || []) add('', u, 'description');
      return out.slice(0, 20);
    }

    // ---- Free extra sources: GeckoTerminal token info, Jupiter token API --------------------------
    function normalizeGtInfo(j) {
      const a = j?.data?.attributes; if (!a || typeof a !== 'object') throw Error('GeckoTerminal: no token info');
      const dist = a.holders?.distribution_percentage || {};
      return { name: String(a.name || '').slice(0, 80), symbol: String(a.symbol || '').slice(0, 30), description: String(a.description || '').slice(0, 1200),
        websites: (Array.isArray(a.websites) ? a.websites : []).slice(0, 5).map(String), twitter: String(a.twitter_handle || '').replace(/^@/, '').slice(0, 60),
        telegram: String(a.telegram_handle || '').replace(/^@/, '').slice(0, 60), discord: String(a.discord_url || '').slice(0, 200), gtScore: safeNum(a.gt_score),
        holders: safeNum(a.holders?.count), top10Pct: safeNum(dist.top_10) };
    }
    function normalizeJup(arr, ca) {
      const t = (Array.isArray(arr) ? arr : []).find(x => x?.id === ca); if (!t) throw Error('Jupiter: token not found');
      const au = t.audit || {}, h1 = t.stats1h || {};
      const xUrl = v => { v = String(v || '').trim(); return /^https?:\/\//i.test(v) ? v : /^@?[A-Za-z0-9_]{1,15}$/.test(v) ? 'https://x.com/' + v.replace(/^@/, '') : ''; };
      return { name: String(t.name || '').slice(0, 80), symbol: String(t.symbol || '').slice(0, 30), organicScore: safeNum(t.organicScore), organicLabel: String(t.organicScoreLabel || '').slice(0, 12),
        verified: t.isVerified === true, holders: safeNum(t.holderCount), dev: isValidMint(t.dev) ? t.dev : '', launchpad: String(t.launchpad || '').slice(0, 30),
        devMigrations: safeNum(au.devMigrations), devMints: safeNum(au.devMints), devBalancePct: safeNum(au.devBalancePercentage), topHoldersPct: safeNum(au.topHoldersPercentage),
        isSus: au.isSus === true, mintDisabled: au.mintAuthorityDisabled ?? null, freezeDisabled: au.freezeAuthorityDisabled ?? null, twitter: xUrl(t.twitter), website: safeHttp(t.website),
        tags: (Array.isArray(t.tags) ? t.tags : []).slice(0, 8).map(x => String(x).slice(0, 24)), traders1h: safeNum(h1.numTraders), organicBuyers1h: safeNum(h1.numOrganicBuyers),
        buyVol1h: safeNum(h1.buyVolume), sellVol1h: safeNum(h1.sellVolume), organicBuyVol1h: safeNum(h1.buyOrganicVolume), graduatedAt: String(t.graduatedAt || '').slice(0, 30),
        windows: Object.fromEntries([['m5', t.stats5m], ['h1', t.stats1h], ['h6', t.stats6h], ['h24', t.stats24h]].map(([k, w]) => [k, w ? { holderChange: safeNum(w.holderChange), priceChange: safeNum(w.priceChange), buyVol: safeNum(w.buyVolume), sellVol: safeNum(w.sellVolume), buys: safeNum(w.numBuys), sells: safeNum(w.numSells), traders: safeNum(w.numTraders), netBuyers: safeNum(w.numNetBuyers) } : null])) };
    }
    async function refreshProject(force = false) {
      if (!s.coin || s.loading.project) return;
      const coin = { ...s.coin }, key = curKey();
      if (!force && s.project?.key === key && Date.now() - s.project.ts < 600000) return;
      s.loading.project = true;
      const p = { key, ts: Date.now(), gt: null, jup: null, errors: {} }, c = CHAINS[coin.chain], tasks = [];
      if (c.gecko) tasks.push(requestJson('https://api.geckoterminal.com/api/v2/networks/' + c.gecko + '/tokens/' + encodeURIComponent(coin.chain === 'solana' ? coin.ca : coin.ca.toLowerCase()) + '/info')
        .then(j => { p.gt = normalizeGtInfo(j); }).catch(e => { p.errors.GeckoTerminal = e.message; }));
      if (coin.chain === 'solana') tasks.push(requestJson('https://lite-api.jup.ag/tokens/v2/search?query=' + encodeURIComponent(coin.ca)).then(j => { p.jup = normalizeJup(j, coin.ca); }).catch(e => { p.errors.Jupiter = e.message; }));
      try { await Promise.all(tasks); }
      finally { s.loading.project = false; if (key === curKey()) { s.project = p; refreshSimilar(); refreshIntel(); } scheduleRender(); }
    }

    // ---- GitHub facts via the public API (60 requests/hour without login) ----------------------
    const githubCache = new Map();
    async function githubFacts(t) {
      const id = (t.owner + '/' + t.repo).toLowerCase(), hit = githubCache.get(id); if (hit && Date.now() - hit.ts < 1800000) return hit.data;
      const gh = u => requestJson('https://api.github.com/' + u, { headers: { Accept: 'application/vnd.github+json' }, withHeaders: true });
      const linkOf = r => /^link:(.*)$/im.exec(r?.headers || '')?.[1] || '';
      let data;
      if (t.repo) {
        const base = 'repos/' + t.owner + '/' + t.repo;
        const [repo, count, recent, contrib] = await Promise.all([gh(base), gh(base + '/commits?per_page=1').catch(() => null), gh(base + '/commits?per_page=5').catch(() => null), gh(base + '/contributors?per_page=1&anon=1').catch(() => null)]);
        const r = repo.json || {};
        data = { type: 'repo', url: 'https://github.com/' + r.full_name, name: String(r.full_name || '').slice(0, 100), description: String(r.description || '').slice(0, 300),
          createdAt: Date.parse(r.created_at) || null, pushedAt: Date.parse(r.pushed_at) || null, stars: safeNum(r.stargazers_count), forks: safeNum(r.forks_count),
          isFork: r.fork === true, parent: String(r.parent?.full_name || ''), language: String(r.language || ''), sizeKb: safeNum(r.size), archived: r.archived === true, license: String(r.license?.spdx_id || ''),
          commits: Array.isArray(count?.json) ? githubCountFromLink(linkOf(count), count.json.length) : null,
          contributors: Array.isArray(contrib?.json) ? githubCountFromLink(linkOf(contrib), contrib.json.length) : null,
          recentCommits: (Array.isArray(recent?.json) ? recent.json : []).slice(0, 5).map(c => ({ date: Date.parse(c?.commit?.author?.date) || null, msg: String(c?.commit?.message || '').split('\n')[0].slice(0, 90), author: String(c?.author?.login || c?.commit?.author?.name || '').slice(0, 40) })) };
      } else {
        const [u, repos] = await Promise.all([gh('users/' + t.owner), gh('users/' + t.owner + '/repos?sort=pushed&per_page=6').catch(() => null)]), j = u.json || {};
        data = { type: 'owner', url: 'https://github.com/' + t.owner, name: String(j.login || t.owner), kind: String(j.type || ''), createdAt: Date.parse(j.created_at) || null, publicRepos: safeNum(j.public_repos), followers: safeNum(j.followers),
          repos: (Array.isArray(repos?.json) ? repos.json : []).map(r => ({ name: String(r?.name || '').slice(0, 60), pushedAt: Date.parse(r?.pushed_at) || null, stars: safeNum(r?.stargazers_count), fork: r?.fork === true, description: String(r?.description || '').slice(0, 120) })) };
      }
      const readmeOf = (o, r) => requestPage(`https://raw.githubusercontent.com/${o}/${r}/HEAD/README.md`).then(x => x.status === 200 ? x.html.slice(0, 300_000) : '').catch(() => '');
      data.text = [data.description || '', t.repo ? await readmeOf(t.owner, t.repo) : await readmeOf(t.owner, t.owner)].join('\n');
      githubCache.set(id, { ts: Date.now(), data }); return data;
    }
    async function refreshGithub(force = false) {
      if (!s.coin || s.loading.github) return;
      const key = curKey();
      if (s.project?.key !== key) return; // links are only complete once the project sources are loaded
      if (!force && s.github?.key === key) return;
      const targets = [];
      for (const l of projectLinks()) { const t = parseGithubTarget(l.url); if (t && !targets.some(x => (x.owner + '/' + x.repo).toLowerCase() === (t.owner + '/' + t.repo).toLowerCase())) targets.push(t); }
      const items = [], errors = [];
      if (targets.length) {
        s.loading.github = true; scheduleRender();
        for (const t of targets.slice(0, 2)) {
          try { items.push(await githubFacts(t)); }
          catch (e) { errors.push(t.owner + (t.repo ? '/' + t.repo : '') + ': ' + (/HTTP 403/.test(e.message) ? 'GitHub rate limit (60/h) reached' : /HTTP 404/.test(e.message) ? 'not found' : e.message)); }
        }
        s.loading.github = false;
      }
      if (key === curKey()) s.github = { key, items, errors };
      scheduleRender();
    }

    // ---- Website + X intelligence: domain age (RDAP), static page facts, X profile (FxTwitter) ----
    const decodeHtml = t => String(t || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    /** example.co.uk → example.co.uk, app.token.xyz → token.xyz */
    function registrableDomain(host) {
      const p = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
      const twoPart = p.length > 2 && /^(co|com|org|net|gov|ac|edu|ltd|plc)$/.test(p.at(-2));
      return p.slice(twoPart ? -3 : -2).join('.');
    }
    function normalizeRdap(j) {
      if (!j || typeof j !== 'object') throw Error('RDAP: no data');
      const ev = a => Date.parse((Array.isArray(j.events) ? j.events : []).find(e => e?.eventAction === a)?.eventDate) || null;
      const registrar = (Array.isArray(j.entities) ? j.entities : []).find(e => Array.isArray(e?.roles) && e.roles.includes('registrar'));
      const fn = registrar?.vcardArray?.[1]?.find?.(x => x?.[0] === 'fn')?.[3];
      return { registered: ev('registration'), expires: ev('expiration'), changed: ev('last changed'), registrar: String(fn || '').slice(0, 60), status: (Array.isArray(j.status) ? j.status : []).slice(0, 4).map(x => String(x).slice(0, 40)) };
    }
    const SITE_BUILDERS = [['Wix', /wixstatic|wix\.com/i], ['Webflow', /webflow/i], ['Framer', /framerusercontent|framer\.com/i], ['Carrd', /carrd\.co/i], ['Squarespace', /squarespace/i],
      ['WordPress', /wp-content|wordpress/i], ['Shopify', /cdn\.shopify/i], ['GitBook', /gitbook/i], ['Notion', /notion\.site|notion\.so/i], ['Linktree', /linktr\.ee/i], ['Vercel', /_next\/static|vercel/i]];
    /** Contract-looking addresses in a text other than the token itself (pump-style mints, or next to "CA" / "contract"). */
    function otherContracts(text, ca) {
      const out = new Set(), t = String(text || '').slice(0, 2_000_000), evm = isValidEVM(ca);
      const label = /(?:\bCA\b|contract(?:\s*address)?|token\s*address|\bmint\b)\W{0,12}/gi;
      for (const m of t.matchAll(evm ? /0x[0-9a-fA-F]{40}/g : /[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
        const a = m[0]; if (sameAddr(a, ca) || !isValidAddress(a, evm ? s.coin?.chain : 'solana')) continue;
        const before = t.slice(Math.max(0, m.index - 40), m.index); label.lastIndex = 0;
        if (label.test(before)) out.add(a);
        if (out.size >= 3) break;
      }
      return [...out];
    }
    /** Website and GitHub pages of the project: is this CA shown, a different one, or none? */
    function caPresence() {
      const out = [], intel = s.intel?.key === curKey() ? s.intel : null;
      for (const w of intel?.web || []) if (w.page?.ok) out.push({ kind: 'website', label: w.domain, url: w.url, status: w.page.hasCA ? 'found' : w.page.otherCa?.length ? 'other' : 'missing', other: w.page.otherCa?.[0] || '' });
      for (const g of s.github?.key === curKey() ? s.github.items : []) {
        if (typeof g.text !== 'string') continue;
        const has = isValidEVM(s.coin.ca) ? g.text.toLowerCase().includes(s.coin.ca.toLowerCase()) : g.text.includes(s.coin.ca), oth = has ? [] : otherContracts(g.text, s.coin.ca);
        out.push({ kind: 'GitHub', label: 'GitHub ' + g.name, url: g.url, status: has ? 'found' : oth.length ? 'other' : 'missing', other: oth[0] || '' });
      }
      return out;
    }
    /** Websites built as single-page apps load the CA at runtime. Search, without running anything:
     *  1) the site's own script files and the chunks they import, 2) same-site API endpoints named in those scripts
     *  (GET only, no cookies). Returns { hasCA, caIn, otherCa, checked }. */
    async function deepCaScan(pageUrl, html, ca) {
      const base = new URL(pageUrl), site = registrableDomain(base.hostname), evm = isValidEVM(ca), needle = evm ? ca.toLowerCase() : ca;
      const has = t => (evm ? String(t).toLowerCase() : String(t)).includes(needle);
      const sameSite = u => { try { const x = new URL(u, base); return x.protocol === 'https:' && registrableDomain(x.hostname) === site ? x : null; } catch { return null; } };
      const queue = [...html.matchAll(/<(?:script[^>]+src|link[^>]+rel=["']?(?:modulepreload|preload)["']?[^>]+href)=["']([^"']+\.m?js[^"']*)["']/gi)].map(m => m[1]);
      const seen = new Set(), apis = new Set(), others = new Set();
      let bytes = 0, checked = 0;
      while (queue.length && checked < 24 && bytes < 8e6) {
        const u = sameSite(queue.shift()); if (!u || seen.has(u.href)) continue;
        seen.add(u.href); checked++;
        const js = await requestPage(u.href).catch(() => null); if (!js || js.status >= 400) continue;
        bytes += js.html.length;
        if (has(js.html)) return { hasCA: true, caIn: 'script', otherCa: [], checked };
        for (const o of otherContracts(js.html, ca)) others.add(o);
        // chunks: import("./x.js"), "./x.js", "/assets/x.js", "/_next/static/chunks/x.js"
        for (const m of js.html.matchAll(/["'`]((?:\.\.?\/|\/assets\/|\/_next\/static\/chunks\/|\/static\/js\/)[\w.~@/-]{1,120}\.m?js)["'`]/g)) if (queue.length < 80) queue.push(new URL(m[1], u).href);
        for (const m of js.html.matchAll(/["'`](\/(?:api|v1|v2|config|public)\/[\w./-]{1,80})["'`]/g))
          if (!/auth|login|logout|admin|session|user|wallet|socket|rpc|upload|delete|update|create/i.test(m[1])) apis.add(m[1]);
      }
      for (const path of [...apis].slice(0, 10)) {
        const u = sameSite(path); if (!u) continue;
        const r = await requestPage(u.href).catch(() => null); checked++;
        if (r && r.status < 400 && has(r.html)) return { hasCA: true, caIn: 'api ' + path, otherCa: [], checked };
      }
      return { hasCA: false, otherCa: [...others].slice(0, 3), checked };
    }
    function analyzePage(html, ca) {
      const meta = name => { const tag = (new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i').exec(html) || [''])[0]; return decodeHtml((/content=["']([^"']*)["']/i.exec(tag) || [])[1] || ''); };
      const title = decodeHtml((/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html) || [])[1] || '').slice(0, 140);
      const builder = meta('generator').slice(0, 40) || SITE_BUILDERS.find(([, rx]) => rx.test(html))?.[0] || '';
      const hay = isValidEVM(ca) ? html.toLowerCase() : html, needle = isValidEVM(ca) ? ca.toLowerCase() : ca;
      const socials = [...new Set((html.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|t\.me|discord\.gg|github\.com)\/[^\s"'<>)]{1,80}/gi) || []).map(u => u.replace(/[/?#]+$/, '')))].slice(0, 12);
      const hasCA = hay.includes(needle);
      // Script bundles of single-page sites, to search for the CA as well (same site only, see refreshIntel).
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map(m => m[1]).slice(0, 6);
      return { title, description: (meta('description') || meta('og:description')).slice(0, 240), builder, hasCA, otherCa: hasCA ? [] : otherContracts(html, ca), scripts, socials, bytes: html.length };
    }
    function xHandleOf(url) {
      try { const seg = new URL(url).pathname.split('/').filter(Boolean); return seg[0] && seg[0] !== 'i' && /^[A-Za-z0-9_]{1,15}$/.test(seg[0]) ? seg[0] : ''; } catch { return ''; }
    }
    function normalizeFx(j) {
      const u = j?.user; if (!u || Number(j.code) !== 200) throw Error('X profile not found');
      return { handle: String(u.screen_name || '').slice(0, 20), name: String(u.name || '').slice(0, 60), description: String(u.description || '').replace(/\s+/g, ' ').slice(0, 280),
        followers: safeNum(u.followers), following: safeNum(u.following), tweets: safeNum(u.tweets), joined: Date.parse(u.joined) || null,
        verified: u.verification?.verified === true || u.verified === true, protected: u.protected === true };
    }
    const intelCache = new Map();
    async function cached(id, ttl, fn) { const hit = intelCache.get(id); if (hit && Date.now() - hit.ts < ttl) return hit.v; const v = await fn(); intelCache.set(id, { ts: Date.now(), v }); return v; }
    async function refreshIntel(force = false) {
      if (!s.coin || !prefs.webChecks || s.loading.intel) return;
      const key = curKey(), coin = { ...s.coin };
      if (s.project?.key !== key) return;                       // links are only complete once the project sources are loaded
      if (!force && s.intel?.key === key) return;
      const links = projectLinks();
      const sites = [...new Map(links.filter(l => l.kind === 'Website').map(l => [registrableDomain(new URL(l.url).hostname), l])).values()].slice(0, 2);
      const handles = [...new Set(links.filter(l => l.kind === 'X').map(l => xHandleOf(l.url)).filter(Boolean).map(h => h.toLowerCase()))].slice(0, 2);
      if (!sites.length && !handles.length) { s.intel = { key, web: [], x: [] }; return; }
      s.loading.intel = true; scheduleRender();
      // Project websites can be on any domain: fetching them needs the optional all-sites permission (options page).
      const pageAccess = extHost?.allSites ? await extHost.allSites() : true;
      s.siteAccess = pageAccess;
      const web = await Promise.all(sites.map(async l => {
        const domain = registrableDomain(new URL(l.url).hostname), out = { url: l.url, domain, rdap: null, page: null, error: '', needsAccess: !pageAccess };
        const [rd, pg] = await Promise.allSettled([
          cached('rdap:' + domain, 6 * 3600e3, async () => normalizeRdap(await requestJson('https://rdap.org/domain/' + encodeURIComponent(domain), { headers: { Accept: 'application/rdap+json, application/json' } }))),
          !pageAccess ? Promise.reject(Error('no access to project websites')) : cached('page:' + l.url + ':' + coin.ca, 1800e3, async () => {
            const r = await requestPage(l.url), a = { status: r.status, ok: r.status >= 200 && r.status < 400, finalUrl: r.finalUrl, ...analyzePage(r.html, coin.ca) };
            if (a.ok && !a.hasCA) Object.assign(a, await deepCaScan(r.finalUrl || l.url, r.html, coin.ca));
            delete a.scripts; return a;
          })]);
        if (rd.status === 'fulfilled') out.rdap = rd.value; else out.rdapError = rd.reason?.message || 'failed';
        if (pg.status === 'fulfilled') out.page = pg.value; else if (pageAccess) out.error = pg.reason?.message || 'failed';
        return out;
      }));
      const x = await Promise.all(handles.map(async h => {
        try { return { handle: h, user: await cached('fx:' + h, 1800e3, async () => normalizeFx(await requestJson('https://api.fxtwitter.com/' + encodeURIComponent(h)))) }; }
        catch (e) { return { handle: h, user: null, error: e.message }; }
      }));
      s.loading.intel = false;
      if (key === curKey()) s.intel = { key, web, x };
      scheduleRender();
    }

    // ---- Look-alike tokens (vamps) across all chains via DexScreener search -------------------
    /** Jupiter only (organic score, buy/sell volume and holder change per window) — refreshed often, unlike the rest of the project data. */
    async function refreshJupiter() {
      if (!s.coin || s.coin.chain !== 'solana' || s.loading.jup || s.project?.key !== curKey() || Date.now() - (s.jupAt || 0) < LIVE.jupiter - 500) return;
      const key = curKey(), ca = s.coin.ca; s.loading.jup = true; s.jupAt = Date.now();
      try { const jup = normalizeJup(await requestJson('https://lite-api.jup.ag/tokens/v2/search?query=' + encodeURIComponent(ca)), ca); if (jup && key === curKey() && s.project?.key === key) { s.project.jup = jup; scheduleRender(); } }
      catch {} finally { s.loading.jup = false; }
    }
    // ---- pump.fun public API (no login, no tab): coin, callouts, fee sharing and claims ----
    const PUMP_API = 'https://frontend-api-v3.pump.fun';
    function normalizePumpCoin(j) {
      const a = v => isValidMint(String(v || '')) ? String(v) : '';
      return { creator: a(j.creator), bondingCurve: a(j.bonding_curve), pool: a(j.pool_address || j.pump_swap_pool), complete: j.complete === true,
        athMc: safeNum(j.ath_market_cap ?? j.usd_ath_market_cap), replies: safeNum(j.reply_count), twitter: safeHttp(j.twitter) || '', website: safeHttp(j.website) || '', telegram: safeHttp(j.telegram) || '' };
    }
    function pumpCalloutFrom(pos, ca) {
      const c = pos?.callout; if (!c || !c.calloutId) return null;
      const ts = parseTime(c.calloutTimestamp); if (!ts) return null;
      return { id: String(c.calloutId).slice(0, 60), author: String(pos.userName || 'unknown').slice(0, 40), x: String(pos.xUsername || '').slice(0, 40), text: String(c.thesis || '').slice(0, 600), ts,
        mc: safeNum(c.calledOutAtMcap), multiple: safeNum(c.multiple), maxMultiple: safeNum(c.maxMultiplier), likes: safeNum(c.likes) || 0, views: safeNum(c.viewCount) || 0,
        replies: safeNum(c.replyCount) || 0, pnl: safeNum(pos.pnlUsd), holding: Number(pos.amountHeld) > 0, lowQuality: pos.lowQuality === true,
        wallet: isValidMint(pos.walletAddress || '') ? pos.walletAddress : '', url: `https://pump.fun/callouts/${encodeURIComponent(ca)}/${encodeURIComponent(c.calloutId)}` };
    }
    async function refreshPump(force = false) {
      if (!s.coin || s.coin.chain !== 'solana' || s.loading.pump) return;
      const key = curKey(), ca = s.coin.ca, prev = s.pump?.key === key ? s.pump : null;
      if (!force && prev && Date.now() - prev.ts < LIVE.pump - 500) return;
      if (prev?.notPump && !force) return;
      s.loading.pump = true;
      try {
        const needCoin = !prev?.coin || Date.now() - prev.coinTs > 120000;
        const [coin, pos] = await Promise.all([needCoin ? requestJson(PUMP_API + '/coins-v3/' + ca).catch(() => null) : Promise.resolve(null),
          requestJson(PUMP_API + '/mint-positions/' + ca + '?sortBy=TOP&pageSize=50').catch(() => null)]);
        if (key !== curKey()) return;
        const c = coin?.mint === ca ? normalizePumpCoin(coin) : prev?.coin ?? null;
        const own = (Array.isArray(pos?.positions) ? pos.positions : []).map(p => pumpCalloutFrom(p, ca)).filter(Boolean);
        const callouts = mergeCallouts(own, s.gmgnCallouts?.key === key ? s.gmgnCallouts.items : []);
        s.pump = { key, ts: Date.now(), coinTs: coin?.mint === ca ? Date.now() : prev?.coinTs || 0, coin: c, callouts, notPump: !c && !callouts.length && needCoin, fees: prev?.fees ?? null };
        syncPumpEvents(); refreshCallerFollowers();
        if (c?.bondingCurve && !s.loading.fees && (!s.pump.fees || Date.now() - s.pump.fees.ts > 600000)) refreshFeeSharing(c);
      } finally { s.loading.pump = false; scheduleRender(); }
    }
    /** pump.fun fee sharing: the bonding curve's creator field points to a sharing config whose shareholders receive the
     *  creator fees. Claims show up on-chain as ClaimSocialFeePda (payout) and DistributeCreatorFees (fees received). */
    async function refreshFeeSharing(c) {
      const key = curKey(); s.loading.fees = true;
      try {
        const acc = await solRPC('getAccountInfo', [c.bondingCurve, { encoding: 'base64' }]);
        const raw = acc?.value?.data?.[0] ? Uint8Array.from(atob(acc.value.data[0]), ch => ch.charCodeAt(0)) : null;
        const feeOwner = raw && raw.length >= 81 ? b58encode(raw.subarray(49, 81)) : '';
        let cfg = null;
        if (feeOwner && feeOwner !== c.creator) cfg = await requestJson('https://fun-block.pump.fun/sharing-config/' + feeOwner).catch(() => null);
        const shareholders = [];
        for (const sh of (Array.isArray(cfg?.shareholders) ? cfg.shareholders : []).slice(0, 4)) {
          if (key !== curKey()) return;
          const r = { address: isValidMint(sh.address || '') ? sh.address : '', bps: Number(sh.shareBps) || 0, kind: String(sh.kind || '').slice(0, 20),
            platform: String(sh.social?.platform || '').slice(0, 20), username: String(sh.social?.username || '').slice(0, 40), received: 0, claimed: 0, claims: 0, lastClaim: null, checked: 0, more: false };
          if (r.address) {
            const sigs = await solRPC('getSignaturesForAddress', [r.address, { limit: 30 }]).catch(() => []);
            r.more = Array.isArray(sigs) && sigs.length >= 30;
            for (const sig of (Array.isArray(sigs) ? sigs : []).filter(x => !x.err).slice(0, 30)) {
              const tx = await solRPC('getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
              const keys = (tx?.transaction?.message?.accountKeys || []).map(k => k?.pubkey || k), i = keys.indexOf(r.address);
              if (i < 0) continue;
              r.checked++;
              const delta = ((tx.meta?.postBalances?.[i] ?? 0) - (tx.meta?.preBalances?.[i] ?? 0)) / 1e9, logs = (tx.meta?.logMessages || []).join(' ');
              if (/ClaimSocialFee/.test(logs) && delta < 0) { r.claims++; r.claimed += -delta; r.lastClaim = Math.max(r.lastClaim || 0, (sig.blockTime || 0) * 1000); }
              else if (/DistributeCreatorFees/.test(logs) && delta > 0) r.received += delta;
            }
          }
          shareholders.push(r);
        }
        if (key === curKey() && s.pump?.key === key) s.pump.fees = { ts: Date.now(), feeOwner, shared: !!cfg, admin: String(cfg?.admin || ''), adminRevoked: cfg?.adminRevoked === true, shareholders };
      } catch (e) { if (key === curKey() && s.pump?.key === key) s.pump.fees = { ts: Date.now(), error: e.message, shareholders: [] }; }
      finally { s.loading.fees = false; scheduleRender(); }
    }
    /** GMGN's copy of the pump.fun callouts goes further back than pump.fun's own API (50): merge both by callout id. */
    function mergeGmgnCallouts(key, list) {
      const clean = list.filter(c => c && typeof c.id === 'string' && Number.isFinite(c.ts) && typeof c.text === 'string').slice(0, 250);
      s.gmgnCallouts = { key, ts: Date.now(), items: clean };
      if (s.pump?.key === key) { s.pump.callouts = mergeCallouts(s.pump.callouts, clean); syncPumpEvents(); }
      refreshCallerFollowers();
    }
    function mergeCallouts(a, b) {
      const m = new Map(); for (const c of [...(b || []), ...(a || [])]) m.set(c.id, { ...m.get(c.id), ...c, x: c.x || m.get(c.id)?.x || '', wallet: c.wallet || m.get(c.id)?.wallet || '' });
      return [...m.values()].sort((x, y) => y.ts - x.ts);
    }
    function syncPumpEvents() {
      if (!s.pump || s.pump.key !== curKey()) return;
      s.pumpEvents = s.pump.callouts.map(co => ({ source: 'pump', chain: 'solana', ca: s.coin.ca, id: 'pump:' + co.id, timestamp: co.ts, author: co.author, text: co.text, url: co.url }));
      pullEvents();
    }
    /** Followers of the callers: pump.fun followers for all (one batch request), X followers for those with a linked X account. */
    async function refreshCallerFollowers() {
      const pf = s.pump?.key === curKey() ? s.pump : null; if (!pf?.callouts.length || s.loading.followers) return;
      const key = curKey(), have = s.callerFollowers?.key === key ? s.callerFollowers : { key, ts: 0, byWallet: {}, x: {} };
      const wallets = [...new Set(pf.callouts.map(c => c.wallet).filter(Boolean))], missing = wallets.filter(w => !(w in have.byWallet));
      if (!missing.length && Date.now() - have.ts < 10 * 60e3) return;
      s.loading.followers = true;
      try {
        const todo = missing.length ? missing : wallets;
        for (let i = 0; i < todo.length && i < 300; i += 100) {
          const users = await requestJson(PUMP_API + '/users/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, data: JSON.stringify({ addresses: todo.slice(i, i + 100) }) }).catch(() => []);
          for (const u of Array.isArray(users) ? users : []) if (isValidMint(u?.address || '')) have.byWallet[u.address] = { followers: safeNum(u.followers), x: /^\w{1,15}$/.test(u.x_username || '') ? u.x_username : '', username: String(u.username || '').slice(0, 40) };
        }
        // X followers (FxTwitter) for up to 10 linked X accounts, cached 30 min
        const handles = [...new Set(pf.callouts.map(c => c.x || have.byWallet[c.wallet]?.x).filter(Boolean))].filter(h => !(h.toLowerCase() in have.x)).slice(0, 10);
        for (const h of handles) {
          try { const u = await cached('fx:' + h.toLowerCase(), 1800e3, async () => normalizeFx(await requestJson('https://api.fxtwitter.com/' + encodeURIComponent(h)))); have.x[h.toLowerCase()] = u?.followers ?? null; }
          catch { have.x[h.toLowerCase()] = null; }
        }
        have.ts = Date.now();
        if (key === curKey()) s.callerFollowers = have;
      } finally { s.loading.followers = false; scheduleRender(); }
    }
    /** One row per caller: calls, best multiple, first call, pump.fun and X followers. */
    function pumpCallers() {
      const pf = s.pump?.key === curKey() ? s.pump : null, f = s.callerFollowers?.key === curKey() ? s.callerFollowers : null, by = new Map();
      for (const c of pf?.callouts || []) {
        const k = c.wallet || c.author, u = f?.byWallet[c.wallet], x = c.x || u?.x || '';
        const r = by.get(k) || { author: c.author, wallet: c.wallet, x, calls: 0, first: c.ts, firstMc: c.mc, best: 0, holding: c.holding, pumpFollowers: u?.followers ?? null, xFollowers: x && f ? f.x[x.toLowerCase()] ?? null : null };
        r.calls++; r.best = Math.max(r.best, c.maxMultiple || 0); if (c.ts < r.first) { r.first = c.ts; r.firstMc = c.mc; }
        by.set(k, r);
      }
      const reach = r => (r.xFollowers || 0) + (r.pumpFollowers || 0);
      return [...by.values()].sort((a, b) => reach(b) - reach(a) || b.calls - a.calls);
    }
    function renderPumpFees(parent) {
      const f = s.pump?.key === curKey() ? s.pump.fees : null;
      if (!f) return;
      const box = section(parent, 'Fee sharing (pump.fun)');
      if (f.error) { el('div', { class: 'note warn', text: f.error }, box); return; }
      if (!f.shared) { el('div', { class: 'sub', text: 'No fee sharing — creator fees go to the creator wallet.' }, box); return; }
      for (const r of f.shareholders) {
        const who = r.platform ? `${r.platform} @${r.username}` : short(r.address), url = r.platform === 'GitHub' ? 'https://github.com/' + r.username : r.platform === 'X' || r.platform === 'Twitter' ? 'https://x.com/' + r.username : CHAINS.solana.explorer + r.address;
        infoRow(box, who, url, `${r.bps / 100}% · received ${r.received.toFixed(2)} SOL · claimed ${r.claims}× ${r.claimed.toFixed(2)} SOL${r.more ? ' (last 30 tx)' : ''}`, r.lastClaim ? 'claimed ' + age(r.lastClaim) + ' ago' : r.claims ? '' : 'never claimed', r.claims ? 'good' : 'warn');
      }
      el('div', { class: 'sub', text: f.adminRevoked ? 'Admin rights revoked — the split cannot be changed.' : 'Admin can still change the split.' }, box);
    }
    function renderPumpCallouts(parent) {
      const pf = s.pump?.key === curKey() ? s.pump : null;
      if (!pf || (!pf.callouts.length && pf.notPump)) return;
      const box = section(parent, 'pump.fun callouts', String(pf.callouts.length));
      if (!pf.callouts.length) { el('div', { class: 'sub', text: 'No callouts yet.' }, box); return; }
      const callers = pumpCallers(), ranked = callers.filter(c => c.pumpFollowers != null || c.xFollowers != null).slice(0, 10);
      if (ranked.length) {
        el('div', { class: 'sub', text: `Top 10 callers by followers (${callers.length} callers${s.gmgnCallouts?.key === curKey() ? ' · incl. GMGN' : ''})` }, box);
        for (const r of ranked) {
          const parts = [r.xFollowers != null ? '𝕏 ' + number(r.xFollowers) : '', r.pumpFollowers != null ? number(r.pumpFollowers) + ' on pump.fun' : '', r.calls + (r.calls === 1 ? ' call' : ' calls'), r.firstMc ? 'first at ' + money(r.firstMc) : ''].filter(Boolean);
          const row = infoRow(box, '@' + r.author, pumpProfile(r.wallet) || '', parts.join(' · '), r.best >= 1.05 ? 'max ' + r.best.toFixed(1) + '×' : r.holding ? '' : 'sold', r.best >= 2 ? 'good' : r.holding ? '' : 'warn');
          if (r.x) row.querySelector?.('.idetail')?.append?.(' · ', link('𝕏 @' + r.x, 'https://x.com/' + r.x));
        }
        el('div', { class: 'sub', text: 'Latest callouts' }, box);
      } else if (s.loading.followers) el('div', { class: 'sub', text: 'Loading follower counts…' }, box);
      const fol = s.callerFollowers?.key === curKey() ? s.callerFollowers : null;
      for (const c of pf.callouts.slice(0, 12)) {
        const it = el('div', { class: 'thesis' }, box), top = el('div', { class: 'sub' }, it);
        top.append(link('@' + c.author, pumpProfile(c.wallet) || c.url)); if (c.x) { top.append(' · '); top.append(link('𝕏 @' + c.x, 'https://x.com/' + c.x)); }
        top.append(' · '); top.append(link(age(c.ts * 1000) + ' ago', c.url));
        const u = fol?.byWallet[c.wallet], xf = (c.x || u?.x) && fol ? fol.x[(c.x || u.x).toLowerCase()] : null;
        if (u?.followers != null || xf != null) top.append(` · ${[xf != null ? '𝕏 ' + number(xf) : '', u?.followers != null ? number(u.followers) + ' pf followers' : ''].filter(Boolean).join(' / ')}`);
        top.append(`${c.mc ? ' · at ' + money(c.mc) : ''}${c.maxMultiple ? ' · max ' + c.maxMultiple.toFixed(2) + '×' : ''}${c.likes ? ' · ♥ ' + c.likes : ''}${c.views ? ' · 👁 ' + number(c.views) : ''}${c.holding ? '' : ' · sold'}`);
        textWithLinks(it, c.text);
      }
    }
    async function refreshSimilar(force = false) {
      if (!s.coin || s.loading.similar) return;
      const coin = { ...s.coin }, key = curKey(), { symbol, name } = tokenNames();
      if (!symbol && !name) return;
      if (!force && s.similar?.key === key && Date.now() - s.similar.ts < 600000) return;
      s.loading.similar = true;
      try {
        const queries = [...new Set([symbol, name].map(v => String(v).trim()).filter(v => v.length >= 2))].slice(0, 2);
        const results = await Promise.all(queries.map(q => requestJson('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q)).catch(() => null)));
        const target = { symbol, name }, byToken = new Map();
        for (const res of results) for (const pr of Array.isArray(res?.pairs) ? res.pairs : []) {
          const t = pr?.baseToken; if (!t?.address || sameAddr(t.address, coin.ca)) continue;
          const reason = similarReason(target, t); if (!reason) continue;
          const id = pr.chainId + ':' + String(t.address).toLowerCase(), liq = Number(pr.liquidity?.usd) || 0, prev = byToken.get(id);
          if (prev && prev.liquidity >= liq) continue;
          byToken.set(id, { chainId: String(pr.chainId || '').slice(0, 30), chain: Object.keys(CHAINS).find(k => CHAINS[k].dex === pr.chainId) || '', ca: String(t.address).slice(0, 64),
            name: String(t.name || '').slice(0, 60), symbol: String(t.symbol || '').slice(0, 24), marketCap: safeNum(pr.marketCap) ?? safeNum(pr.fdv), liquidity: liq,
            createdAt: safeNum(pr.pairCreatedAt), pair: /^[\w-]{10,100}$/.test(pr.pairAddress || '') ? pr.pairAddress : '', url: /^https:\/\/dexscreener\.com\//.test(pr.url || '') ? pr.url : '', reason });
        }
        const list = [...byToken.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 25);
        if (key === curKey()) { s.similar = { key, ts: Date.now(), list }; delete s.errors.similar; }
      } catch (e) { if (key === curKey()) s.errors.similar = e.message; }
      finally { s.loading.similar = false; scheduleRender(); }
    }
    const recentSimilar = () => (s.similar?.key === curKey() ? s.similar.list : []).filter(x => x.createdAt && Date.now() - x.createdAt < 14 * 86400000);

    // ---- GMGN (via the gmgn.ai worker tab; the site blocks direct API calls) ------------------
    const gmgnWorkerOnline = () => { const hb = load(K.gmgnWorker, {}); return !!hb.ts && Date.now() - hb.ts < 90000; };
    let gmgnOpenedAt = 0;
    function maybeOpenGmgnTab(userAction) {
      if (gmgnWorkerOnline() || (!userAction && (!prefs.gmgnAutoOpen || Date.now() - gmgnOpenedAt < 120000))) return;
      gmgnOpenedAt = Date.now();
      GM_openInTab('https://gmgn.ai/?' + WORKER_PARAM + '=1', { active: false, insert: true });
    }
    function openGmgnWorker(userAction = false) { maybeOpenGmgnTab(userAction); refreshGmgn(true); }
    function refreshGmgn(force = false) {
      if (!s.coin || !prefs.gmgn || !GMGN_CHAIN[s.coin.chain]) return;
      if (s.gmgnTabOnly && Date.now() - s.gmgnTabOnly > 10 * 60e3) s.gmgnTabOnly = 0;   // try without a tab again every 10 min
      const key = curKey();
      if (!force && (s.loading.gmgn || s.gmgn?.key === key && Date.now() - s.gmgn.ts < LIVE.gmgn || s.gmgnAskedKey === key && Date.now() - s.gmgnAskedAt < LIVE.gmgn)) return; // GMGN shows a Cloudflare check when asked too often
      s.gmgnAskedKey = key; s.gmgnAskedAt = Date.now();
      const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      s.gmgnNonce = nonce; s.loading.gmgn = true; delete s.errors.gmgn;
      const req = { nonce, key, chain: GMGN_CHAIN[s.coin.chain], ca: s.coin.ca, ts: Date.now() };
      if (extHost?.gmgn && !s.gmgnTabOnly) {
        // Background request with the browser's GMGN cookies (Cloudflare clearance) — no tab needed when it works.
        extHost.gmgn({ chain: req.chain, ca: req.ca }).then(r => {
          if (s.gmgnNonce !== nonce) return;
          if (r?.ok) {
            try { onGmgnResult({ nonce, key, ts: Date.now(), ok: true, data: { ...normalizeGmgn(r.stat, r.holderStat, r.fee), extra: normalizeGmgnExtra(r.info, r.dist, r.fee) }, callouts: r.callouts ? normalizeGmgnCallouts(r.callouts, req.ca) : [] }); s.statuses.gmgn = 'OK · without a tab'; return; }
            catch (e) { r = { ok: false, error: e.message }; }
          }
          s.gmgnTabOnly = Date.now();   // Cloudflare check or other error: use the GMGN tab for a while
          put(K.gmgnRequest, req); maybeOpenGmgnTab(false);
        });
      } else { put(K.gmgnRequest, req); maybeOpenGmgnTab(false); }
      setTimeout(() => {
        if (s.gmgnNonce !== nonce || !s.loading.gmgn) return;
        s.loading.gmgn = false; s.errors.gmgn = gmgnWorkerOnline() ? 'no answer from the GMGN tab' : 'not connected'; scheduleRender();
      }, 25000);
    }
    function sanitizeGmgnExtra(x) {
      if (!x || typeof x !== 'object') return null;
      const num = v => Number.isFinite(v) ? v : null, str = (v, n = 60) => typeof v === 'string' ? v.slice(0, n) : '', addr = v => isValidAddress(v) ? v : '';
      const d = x.dev || {};
      return { dev: { address: addr(d.address), status: str(d.status, 30), migrated: num(d.migrated), fundedBy: addr(d.fundedBy), xRenames: num(d.xRenames), xDeletedPosts: num(d.xDeletedPosts), xHistory: (Array.isArray(d.xHistory) ? d.xHistory : []).slice(0, 5).map(v => str(v, 40)).filter(Boolean) },
        imageDup: num(x.imageDup), feesPaid: num(x.feesPaid), tradeFees: num(x.tradeFees), launchpad: str(x.launchpad, 30), bonding: num(x.bonding), creatorFeePct: num(x.creatorFeePct), feeSplitLocked: x.feeSplitLocked === true,
        recipients: (Array.isArray(x.recipients) ? x.recipients : []).slice(0, 8).map(r => ({ wallet: addr(r?.wallet), sharePct: num(r?.sharePct), xUser: /^[A-Za-z0-9_]{1,15}$/.test(r?.xUser || '') ? r.xUser : '', claimed: r?.claimed === true, creator: r?.creator === true, charity: str(r?.charity, 60) })) };
    }
    function onGmgnResult(n) {
      if (!n?.nonce || n.key !== curKey()) return;
      s.loading.gmgn = false;   // any answer for the current token settles the request (requests can overlap)
      if (n.ok && n.data && typeof n.data === 'object') {
        const data = {};
        for (const [k, v] of Object.entries(n.data)) if (k !== 'extra') data[k] = typeof v === 'boolean' ? v : Number.isFinite(v) ? v : null;
        data.extra = sanitizeGmgnExtra(n.data.extra);
        if (Array.isArray(n.callouts) && n.callouts.length) mergeGmgnCallouts(n.key, n.callouts);
        s.gmgn = { key: n.key, ts: Number(n.ts) || Date.now(), data }; s.statuses.gmgn = 'OK'; delete s.errors.gmgn;
      } else s.errors.gmgn = String(n.error || 'request failed').slice(0, 120);
      scheduleRender();
    }

    // ---- Solana RPC, candles, caller statistics, watchlist polling ----------------------------
    // Free public Solana RPCs (no key, no sign-up). Solana Vibe Station serves getTokenLargestAccounts; the official
    // endpoint answers 403 to requests from extensions, so it is only a last resort. A custom RPC from Settings is always tried first.
    const PUBLIC_RPCS = ['https://public.rpc.solanavibestation.com/', 'https://api.mainnet-beta.solana.com/'];
    // Refresh intervals (ms) per source, chosen below each provider's free rate limit.
    const LIVE = { tick: 2500, market: 5000, jupiter: 10000, gmgn: 20000, security: 60000, pump: 15000, watch: 15000, rpcGap: 1100, rpcRetry: 2500 };
    let rpcPreferred = '', rpcGate = Promise.resolve();
    /** The free public RPC allows about one call per second per method: run them one at a time, 1.1 s apart. */
    function rpcSlot() { const p = rpcGate.then(() => sleep(LIVE.rpcGap)); rpcGate = p; return rpcGate; }
    const customRpc = () => /^https:\/\/[^\s"'<>]+$/.test(prefs.rpcUrl || '') ? prefs.rpcUrl : '';
    async function solRPC(method, params) {
      const custom = customRpc(), list = [...new Set([custom, rpcPreferred, ...PUBLIC_RPCS].filter(Boolean))];
      const errors = [];
      for (const url of list) {
        // Public RPCs rate-limit bursts (HTTP 429): wait and retry the same endpoint before falling back.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (url !== custom) await rpcSlot();
            const d = await requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), customRpc: url === custom, timeout: 12000 });
            if (d?.error) throw Error(String(d.error.message || d.error.code));
            if (url !== custom) rpcPreferred = url;
            s.statuses.rpc = 'OK · ' + new URL(url).hostname; delete s.errors.rpc;
            return d.result;
          } catch (e) {
            if (/429|rate limit|too many/i.test(e.message) && attempt < 2) { await sleep(LIVE.rpcRetry * (attempt + 1)); continue; }
            errors.push(new URL(url).hostname + ': ' + e.message); break;
          }
        }
      }
      s.errors.rpc = errors.join(' · ');
      throw Error(`Solana RPC failed (${method}) — ` + errors.join(' · '));
    }
    async function loadOhlcv(force = false) {
      if (!s.coin || !s.market?.pair || !/^[\w-]{10,100}$/.test(s.market.pair)) return alertLine('No valid DEX pool');
      const coin = { ...s.coin }, key = curKey(), geo = CHAINS[coin.chain].gecko; if (!geo) return alertLine('GeckoTerminal does not cover this chain');
      if (!force && s.lastOhlcAt && Date.now() - s.lastOhlcAt < 600000) return;
      s.loading.ohlc = true; s.ohlcError = '';
      const url = `https://api.geckoterminal.com/api/v2/networks/${geo}/pools/${encodeURIComponent(s.market.pair)}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${s.market.tokenPosition}`;
      try {
        const rows = (await requestJson(url))?.data?.attributes?.ohlcv_list; if (!Array.isArray(rows)) throw Error('OHLCV fields missing');
        if (key === curKey()) {
          s.ohlc = rows.filter(r => Array.isArray(r) && r.length >= 5 && Number.isFinite(Number(r[0]))).map(r => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) || 0 })).sort((a, b) => a.t - b.t);
          s.lastOhlcAt = Date.now(); s.statuses.ohlc = s.ohlc.length + ' candles';
        }
      } catch (e) { if (key === curKey()) { s.ohlcError = e.message; s.errors.ohlc = e.message; } }
      finally { s.loading.ohlc = false; scheduleRender(); }
    }
    /** Watchlist prices: one DexScreener request per chain for up to 30 tokens; every 15 s while the Watchlist tab is open, else every minute. */
    let watchAt = 0;
    async function backgroundWatches(visible = false) {
      if (!prefs.dex || !watches.length || s.loading.watch || Date.now() - watchAt < (visible ? LIVE.watch : 60000) - 500) return;
      s.loading.watch = true; watchAt = Date.now();
      try {
        const byChain = new Map(); for (const w of watches) byChain.set(w.chain, [...(byChain.get(w.chain) || []), w]);
        for (const [chain, ws] of byChain) {
          const dex = CHAINS[chain]?.dex; if (!dex) continue;
          const pairs = await requestJson(`https://api.dexscreener.com/tokens/v1/${dex}/${ws.slice(0, 30).map(w => encodeURIComponent(w.ca)).join(',')}`).catch(e => { s.errors.watch = e.message; return []; });
          for (const w of ws) {
            const pair = bestPair(pairs, w.ca, chain); if (!pair) continue;
            const key = tokenKey(chain, w.ca), m = { ...marketFromPair(pair, w.ca, chain), ts: Date.now() }, prior = load('aps:lastmarket:' + key, null);
            put('aps:lastmarket:' + key, m); marketAlerts(key, m, prior);
          }
        }
        s.statuses.watch = 'OK · ' + new Date().toLocaleTimeString('en-GB'); if (visible) scheduleRender();
      } finally { s.loading.watch = false; }
    }

    // ---- Chart snapshot from the page-world bridge (JPEG + OHLCV of the visible fomo chart) --------
    function requestChartSnapshot(timeout = 8000) {
      return new Promise(resolve => {
        const id = Math.random().toString(36).slice(2);
        const done = v => { window.removeEventListener('message', onMsg); clearTimeout(timer); resolve(v); };
        const onMsg = ev => {
          if (ev.source !== window || ev.origin !== location.origin || ev.data?.type !== MSG.snapshot || ev.data.id !== id) return;
          const d = ev.data, bars = (Array.isArray(d.bars) ? d.bars : []).filter(b => b && ['t', 'o', 'h', 'l', 'c'].every(k => Number.isFinite(b[k]))).slice(-800).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: Number.isFinite(b.v) ? b.v : 0 }));
          done({ bars, image: typeof d.image === 'string' && /^data:image\/(jpeg|png);base64,/.test(d.image) && d.image.length < 4e6 ? d.image : '', imageError: String(d.imageError || '').slice(0, 160), error: String(d.error || '').slice(0, 160) });
        };
        const timer = setTimeout(() => done({ bars: [], image: '', error: 'The chart is not reachable — is it visible?' }), timeout);
        window.addEventListener('message', onMsg);
        window.postMessage({ type: MSG.snapshotRequest, id }, location.origin);
      });
    }

    // ---- Prompt builder (one combined prompt; parts selected in the AI tab) ---------------------
    async function waitForProjectData() {
      await refreshProject(); for (let i = 0; i < 40 && s.loading.project; i++) await sleep(250);
      await refreshGithub(); await refreshSimilar(); refreshGmgn(); refreshIntel();
      for (let i = 0; i < 60 && (s.loading.github || s.loading.similar || s.loading.gmgn || s.loading.intel); i++) await sleep(250);
    }
    function tokenHeader(L) {
      const { symbol, name } = tokenNames();
      L.push('=== TOKEN ===', `Name: ${name || '?'} ($${symbol || '?'})`, `Chain: ${CHAINS[s.coin.chain].name}`, `Contract address (CA): ${s.coin.ca}`);
      for (const q of quickLinks()) L.push(`${q.label}: ${q.url}`);
    }
    function marketLines(L) {
      const m = s.market;
      if (!m) { L.push('', '=== MARKET ===', 'no DexScreener data'); return; }
      L.push('', '=== MARKET (DexScreener, as of ' + isoUtc(m.ts) + ') ===',
        `Market cap: ${money(m.marketCap)} · FDV: ${money(m.fdv)} · Liquidity: ${money(m.liquidity)} (liq/MC ${pctTxt(m.liqMcapPct)})`,
        `Volume 5m / 1h / 24h: ${money(m.volume5m)} / ${money(m.volume1h)} / ${money(m.volume24h)} · volume velocity ${m.volVelocity == null ? '—' : m.volVelocity.toFixed(2) + '×'}`,
        `Buys / sells 5m: ${m.buys5m ?? '—'} / ${m.sells5m ?? '—'} · avg trade 5m: ${money(m.avgTrade5m)}${m.suspectedBumpBot ? ' · BUMP-BOT PATTERN' : ''}`,
        `Price change 5m: ${m.change5m == null ? '—' : m.change5m + '%'} · pool created: ${isoUtc(m.createdAt)} (age ${age(m.createdAt)}) · DEX: ${m.dex}`,
        `DexScreener paid: ${yn(m.dexPaid)} · CTO: ${yn(m.ctoActive)} · ads: ${yn(m.adsActive)} · boosts: ${m.boosts ?? 0}`);
    }
    function checksLines(L) {
      const checks = buildChecks().filter(c => c.level !== 'info' && c.src !== 'AI');
      L.push('', '=== AUTOMATED CHECKS (ApeScope) ===');
      if (!checks.length) L.push('none');
      for (const c of checks) L.push(`- [${c.level === 'bad' ? 'RED' : c.level === 'warn' ? 'WARN' : 'OK'}] ${c.label}${c.value ? ': ' + c.value : ''} (${c.src})`);
    }
    function projectLines(L) {
      const p = s.project?.key === curKey() ? s.project : {}, sec = s.sec, rc = s.rugcheck, g = s.gmgn?.key === curKey() ? s.gmgn.data : null;
      L.push('', '=== PROJECT LINKS ===');
      const links = projectLinks();
      if (links.length) for (const l of links) L.push(`- ${l.kind}: ${l.url} (source: ${l.src})`); else L.push('- no website or socials listed on DexScreener, GeckoTerminal or Jupiter');
      if (p.gt?.description) L.push('', '=== DESCRIPTION ===', p.gt.description);
      L.push('', '=== SECURITY ===');
      if (sec) L.push(`GoPlus flags: ${s.secFlags.map(f => f.title + ' (' + f.detail + ')').join('; ') || 'none positive'}`, `Holders: ${sec.holder_count ?? '—'} · top 10: ${pctTxt(sec.top10Pct)} · creator: ${sec.creator || '—'} · creator share: ${pctTxt(sec.creatorPct)} · LP locked/burned: ${pctTxt(sec.lpLockedPct)}`);
      else L.push('GoPlus: no data');
      if (s.hp) L.push(`Honeypot.is: honeypot ${yn(s.hp.isHoneypot)} · buy tax ${s.hp.buyTax ?? '—'}% · sell tax ${s.hp.sellTax ?? '—'}%`);
      if (rc) L.push(`RugCheck: score ${rc.score ?? '—'} (lower is better) · LP locked ${pctTxt(rc.lpLockedPct)} · risks: ${rc.risks.map(r => r.name + ' [' + r.level + ']').join('; ') || 'none'}`);
      if (p.jup) {
        const j = p.jup;
        L.push('', '=== JUPITER ===', `Organic score: ${j.organicScore == null ? '—' : Math.round(j.organicScore)} (${j.organicLabel || '—'}) · verified: ${yn(j.verified)} · suspicious (isSus): ${yn(j.isSus)} · holders: ${j.holders ?? '—'}`,
          `Launchpad: ${j.launchpad || '—'} · dev: ${j.dev || '—'} · tokens created by dev: ${j.devMints ?? '—'} · of which migrated/bonded: ${j.devMigrations ?? '—'} · top holders: ${pctTxt(j.topHoldersPct)}`,
          `Mint authority revoked: ${yn(j.mintDisabled)} · freeze authority revoked: ${yn(j.freezeDisabled)} · tags: ${j.tags.join(', ') || '—'}`,
          `Last hour: traders ${j.traders1h ?? '—'} · organic buyers ${j.organicBuyers1h ?? '—'} · buy volume ${money(j.buyVol1h)} (organic ${money(j.organicBuyVol1h)}) · sell volume ${money(j.sellVol1h)}`);
      }
      if (g) L.push('', '=== GMGN ===', `Holders ${g.holders ?? '—'} · top 10 ${pctTxt(g.top10Pct)} · bundlers ${pctTxt(g.bundlerPct)} · phishing/entrapment ${pctTxt(g.phishingPct)} · insiders ${pctTxt(g.insiderPct)} · bots ${pctTxt(g.botPct)} · fresh wallets ${pctTxt(g.freshPct)}`,
        `Dev team holds ${pctTxt(g.devHoldPct)} · snipers hold ${pctTxt(g.sniperHoldPct)} · tokens created by dev ${g.devCreated ?? '—'} · smart money ${capped(g.smartMoney)} · KOLs ${capped(g.kols)} · LP burned ${pctTxt(g.burnPct, 0)}`);
      const gx = g?.extra;
      if (gx) L.push('', '=== DEVELOPER & FEES (GMGN) ===', `Dev wallet: ${gx.dev.address || '—'} · status: ${gx.dev.status || '—'} · migrated tokens: ${gx.dev.migrated ?? '—'} · funded by: ${gx.dev.fundedBy || '—'} · X renamed: ${gx.dev.xRenames ?? 0}× ${gx.dev.xHistory.join(', ')} · deleted X posts: ${gx.dev.xDeletedPosts ?? 0}`,
        `Logo reused by ${gx.imageDup ?? 0} other tokens · launchpad: ${gx.launchpad || '—'} · creator fee: ${gx.creatorFeePct ?? '—'}% · fees paid by traders: ${gx.feesPaid ?? '—'} SOL`,
        ...gx.recipients.map(r => `Fee recipient ${r.wallet} ${r.xUser ? '@' + r.xUser : ''} ${r.charity ? '(charity ' + r.charity + ')' : ''} · share ${r.sharePct ?? '—'}% · claimed: ${yn(r.claimed)}`));
      if (p.gt) L.push('', '=== GECKOTERMINAL ===', `GT score: ${p.gt.gtScore == null ? '—' : p.gt.gtScore.toFixed(1)} · holders: ${p.gt.holders ?? '—'} · top 10 share: ${p.gt.top10Pct == null ? '—' : p.gt.top10Pct + '%'}`);
      const intel = s.intel?.key === curKey() ? s.intel : null;
      L.push('', '=== WEBSITE (checked by ApeScope: static HTML + RDAP domain data) ===');
      if (!intel?.web.length) L.push(prefs.webChecks ? 'no website listed' : 'website checks disabled');
      for (const w of intel?.web || []) {
        const r = w.rdap, p = w.page;
        L.push(`${w.url}: domain ${w.domain} registered ${r?.registered ? isoUtc(r.registered) + ' (' + age(r.registered) + ' ago)' : 'unknown'}${r?.expires ? ', expires ' + isoUtc(r.expires) : ''}${r?.registrar ? ', registrar ' + r.registrar : ''}`);
        if (p) L.push(`  HTTP ${p.status}${p.finalUrl ? ' · final URL ' + p.finalUrl : ''} · title "${p.title || '—'}" · built with ${p.builder || '—'} · CA in static HTML: ${yn(p.hasCA)}`, ...(p.description ? ['  Description: ' + p.description] : []), ...(p.socials.length ? ['  Links on page: ' + p.socials.join(' ')] : []));
        else L.push('  not reachable: ' + (w.error || 'unknown'));
      }
      L.push('', '=== X ACCOUNT (FxTwitter) ===');
      if (!intel?.x.length) L.push('no X account listed');
      for (const x of intel?.x || []) {
        const u = x.user;
        if (!u) { L.push(`@${x.handle}: profile unavailable (${x.error || 'unknown'})`); continue; }
        L.push(`@${u.handle} (${u.name}): joined ${u.joined ? isoUtc(u.joined) + ' (' + age(u.joined) + ' ago)' : 'unknown'} · followers ${u.followers ?? '—'} · following ${u.following ?? '—'} · posts ${u.tweets ?? '—'} · verified ${yn(u.verified)}`, ...(u.description ? ['  Bio: ' + u.description] : []));
      }
      L.push('', '=== GITHUB (public GitHub API) ===');
      const gh = s.github?.key === curKey() ? s.github : null;
      if (!gh?.items.length) L.push(gh?.errors.length ? gh.errors.join('; ') : 'no GitHub link found');
      for (const r of gh?.items || []) {
        if (r.type === 'repo') L.push(`Repo ${r.url}: created ${isoUtc(r.createdAt)} (${age(r.createdAt)}), last push ${isoUtc(r.pushedAt)}, commits ${r.commits ?? '—'}, contributors ${r.contributors ?? '—'}, stars ${r.stars ?? '—'}, forks ${r.forks ?? '—'}, fork: ${r.isFork ? 'yes, of ' + r.parent : 'no'}, language ${r.language || '—'}, size ${r.sizeKb ?? '—'} KB, license ${r.license || '—'}${r.archived ? ', ARCHIVED' : ''}`,
          `  Description: ${r.description || '—'}`, ...r.recentCommits.map(c => `  Commit ${isoUtc(c.date)} ${c.author}: ${c.msg}`));
        else L.push(`GitHub account ${r.url}: ${r.kind}, created ${isoUtc(r.createdAt)}, ${r.publicRepos ?? '—'} public repos, ${r.followers ?? '—'} followers`, ...r.repos.map(x => `  Repo ${x.name}: pushed ${isoUtc(x.pushedAt)}, stars ${x.stars ?? 0}${x.fork ? ', fork' : ''} – ${x.description}`));
      }
      L.push('', '=== LOOK-ALIKE TOKENS / POSSIBLE VAMPS (DexScreener, all chains) ===');
      const sim = s.similar?.key === curKey() ? s.similar.list : [];
      if (!sim.length) L.push('none found');
      for (const x of sim.slice(0, 12)) L.push(`- $${x.symbol} "${x.name}" · ${CHAINS[x.chain]?.name || x.chainId} · CA ${x.ca} · MC ${money(x.marketCap)} · liq ${money(x.liquidity)} · age ${age(x.createdAt)} · ${x.reason}`);
    }
    async function chartLines(L, snap) {
      const m = s.market;
      let bars = [], src = '';
      if (snap?.bars?.length >= 10) { bars = snap.bars; src = 'fomo chart (visible TradingView chart)'; }
      else { if (!s.ohlc.length && CHAINS[s.coin.chain].gecko && m?.pair) await loadOhlcv(true); if (s.ohlc.length) { bars = s.ohlc; src = 'GeckoTerminal 1m'; } }
      // Express candles in market cap. fomo can show price or MC; decide by comparing the last close.
      let unit = 'USD (unit unclear)', factor = 1;
      const last = bars.at(-1)?.c, supply = m?.marketCap && m?.priceUsd ? m.marketCap / m.priceUsd : null;
      if (last && m?.marketCap && Math.abs(last / m.marketCap - 1) < 0.6) unit = 'market cap USD';
      else if (last && m?.priceUsd && Math.abs(last / m.priceUsd - 1) < 0.6) { if (supply) { factor = supply; unit = 'market cap USD (converted from price)'; } else unit = 'price USD'; }
      const conv = bars.map(b => ({ t: b.t, o: b.o * factor, h: b.h * factor, l: b.l * factor, c: b.c * factor, v: b.v || 0 }));
      const diffs = conv.slice(1).map((b, i) => b.t - conv[i].t).filter(d => d > 0).sort((a, b) => a - b), res = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
      const rows = resampleBars(conv, 150), f = v => Number(Number(v).toPrecision(4));
      if (rows.length) {
        const hi = conv.reduce((a, b) => b.h > a.h ? b : a, conv[0]), lowAfter = Math.min(...conv.filter(b => b.t >= hi.t).map(b => b.l)), cur = conv.at(-1).c;
        L.push('', '=== CANDLES ===', `Source: ${src} · original resolution ${res ? res + 's' : '—'} · ${conv.length} candles from ${isoUtc(conv[0].t * 1000)} to ${isoUtc(conv.at(-1).t * 1000)} · unit: ${unit}`,
          `High in range: ${money(hi.h)} at ${isoUtc(hi.t * 1000)} · low since high: ${money(lowAfter)} · current: ${money(cur)} (${((cur / hi.h - 1) * 100).toFixed(1)}% from high)`,
          'CSV (time UTC, open, high, low, close, volume), aggregated to max. 150 rows:', 'time,o,h,l,c,v',
          ...rows.map(b => `${new Date(b.t * 1000).toISOString().slice(5, 16).replace('T', ' ')},${f(b.o)},${f(b.h)},${f(b.l)},${f(b.c)},${f(b.v)}`));
      } else L.push('', '=== CANDLES ===', 'no candle data available' + (snap?.error ? ' (' + snap.error + ')' : '') + ' — use the screenshot and market data only.');
    }
    /** Candles of the open pool (GeckoTerminal 1m) in market cap: 1m / 5m / 15m tables, volume zones, swing levels, VWAP. */
    async function tradeDataLines(L) {
      const m = s.market;
      if (CHAINS[s.coin.chain].gecko && m?.pair) await loadOhlcv(true).catch(() => {});   // always fresh candles for a trade setup
      const supply = m?.marketCap && m?.priceUsd ? m.marketCap / m.priceUsd : null, f = v => Number(Number(v).toPrecision(4));
      const toMc = b => supply ? { t: b.t, o: b.o * supply, h: b.h * supply, l: b.l * supply, c: b.c * supply, v: b.v || 0 } : null;
      const one = s.ohlc.map(toMc).filter(Boolean).sort((a, b) => a.t - b.t);
      if (supply) L.push('', '=== PRICE ↔ MARKET CAP ===', `Supply used for conversion: ${number(supply)} tokens · price = market cap / supply · current price ${m.priceUsd} USD = MC ${money(m.marketCap)}`);
      if (!one.length) { L.push('', '=== CANDLES ===', 'no candle data available — use the screenshot and the market data.'); return; }
      const agg = sec => { const out = []; for (const b of one) { const t = Math.floor(b.t / sec) * sec, l = out.at(-1); if (l && l.t === t) { l.h = Math.max(l.h, b.h); l.l = Math.min(l.l, b.l); l.c = b.c; l.v += b.v; } else out.push({ ...b, t }); } return out; };
      const table = (title, rows) => { L.push('', `=== ${title} (market cap USD) ===`, 'time UTC,open,high,low,close,volume USD'); for (const b of rows) L.push(`${new Date(b.t * 1000).toISOString().slice(5, 16).replace('T', ' ')},${f(b.o)},${f(b.h)},${f(b.l)},${f(b.c)},${f(b.v)}`); };
      const m5 = agg(300), m15 = agg(900), hi = one.reduce((a, b) => b.h > a.h ? b : a, one[0]), lo = one.reduce((a, b) => b.l < a.l ? b : a, one[0]), cur = one.at(-1).c;
      const vwap = mins => { const r = one.filter(b => b.t >= one.at(-1).t - mins * 60), v = r.reduce((n, b) => n + b.v, 0); return v ? r.reduce((n, b) => n + (b.h + b.l + b.c) / 3 * b.v, 0) / v : null; };
      L.push('', '=== CHART SUMMARY ===', `Range covered: ${isoUtc(one[0].t * 1000)} → ${isoUtc(one.at(-1).t * 1000)} (${one.length} one-minute candles)`,
        `High ${money(hi.h)} at ${isoUtc(hi.t * 1000)} · low ${money(lo.l)} at ${isoUtc(lo.t * 1000)} · current ${money(cur)} (${((cur / hi.h - 1) * 100).toFixed(1)}% from high)`,
        `VWAP 1h ${money(vwap(60))} · VWAP 4h ${money(vwap(240))} · VWAP all ${money(vwap(1e9))}`);
      const ath = s.pump?.key === curKey() ? s.pump.coin?.athMc : null; if (ath) L.push(`All-time high market cap (pump.fun): ${money(ath)}`);
      // Volume profile: where most volume traded (log-spaced market-cap buckets).
      const lmin = Math.log(lo.l || 1), lmax = Math.log(hi.h || 2), n = 24, buckets = Array.from({ length: n }, () => 0);
      for (const b of one) { const i = Math.min(n - 1, Math.max(0, Math.floor((Math.log((b.h + b.l) / 2 || 1) - lmin) / ((lmax - lmin) || 1) * n))); buckets[i] += b.v; }
      const zones = buckets.map((v, i) => ({ v, from: Math.exp(lmin + (lmax - lmin) * i / n), to: Math.exp(lmin + (lmax - lmin) * (i + 1) / n) })).sort((a, b) => b.v - a.v).slice(0, 6);
      L.push('High-volume market-cap zones (most traded first): ' + zones.map(z => `${money(z.from)}–${money(z.to)} (${money(z.v)})`).join(' · '));
      const swings = [];
      for (let i = 2; i < m5.length - 2; i++) {
        const w = m5.slice(i - 2, i + 3);
        if (m5[i].h === Math.max(...w.map(b => b.h))) swings.push(`high ${money(m5[i].h)} @${new Date(m5[i].t * 1000).toISOString().slice(11, 16)}`);
        if (m5[i].l === Math.min(...w.map(b => b.l))) swings.push(`low ${money(m5[i].l)} @${new Date(m5[i].t * 1000).toISOString().slice(11, 16)}`);
      }
      if (swings.length) L.push('Recent 5m swing points: ' + swings.slice(-14).join(' · '));
      table('15-MINUTE CANDLES (last 64)', m15.slice(-64)); table('5-MINUTE CANDLES (last 72)', m5.slice(-72)); table('1-MINUTE CANDLES (last 90)', one.slice(-90));
    }
    function tradeContextLines(L) {
      L.push('', '=== BUY / SELL PRESSURE ===', 'window: buy share (by volume where available) · buys/sells · holder change');
      for (const r of flowWindows()) L.push(`${r.label}: ${r.share == null ? '—' : r.share.toFixed(0) + '% buys'} · ${r.buys ?? '—'} buys / ${r.sells ?? '—'} sells${r.buyVol != null ? ` · buy ${money(r.buyVol)} / sell ${money(r.sellVol)}` : ''} · holders ${r.holderChange == null ? '—' : changeTxt(r.holderChange)}`);
      const g = s.gmgn?.key === curKey() ? s.gmgn.data : null, x = gmgnExtra(), c = s.clusters?.key === curKey() ? s.clusters : null, j = s.project?.key === curKey() ? s.project.jup : null;
      L.push('', '=== HOLDERS & SUPPLY THAT CAN BE SOLD INTO YOU ===',
        `Holders: ${number(g?.holders ?? j?.holders ?? s.sec?.holder_count)} · top 10 (without pools): ${pctTxt(top10Pct())} · liquidity ${money(s.market?.liquidity)} (${pctTxt(s.market?.liqMcapPct)} of MC) · LP locked/burned: ${pctTxt(s.sec?.lpLockedPct)}`);
      if (g) L.push(`GMGN: bundlers ${pctTxt(g.bundlerPct)} · snipers still hold ${pctTxt(g.sniperHoldPct)} · insiders ${pctTxt(g.insiderPct)} · phishing/entrapment ${pctTxt(g.phishingPct)} · bots ${pctTxt(g.botPct)} · fresh wallets ${pctTxt(g.freshPct)} · dev holds ${pctTxt(g.devHoldPct)} · smart money ${g.smartMoney ?? '—'} · KOLs ${g.kols ?? '—'}`);
      if (c) L.push(`Top wallets checked: ${c.checked} · fresh (first activity < ${FRESH_DAYS} days): ${c.fresh?.count ?? '—'} holding ${pctTxt(c.fresh?.pct)} · wallet clusters: ${c.clusters.map(k => `${k.holders.length} wallets ${pctTxt(k.pct)}`).join(', ') || 'none'}`);
      const dev = x?.dev, status = { creator_close: 'sold everything', creator_hold: 'still holds', creator_add: 'bought more', creator_sell: 'sold part' }[dev?.status] || dev?.status;
      L.push(`Developer: ${dev?.address || j?.dev || s.sec?.creator || 'unknown'} · ${status || 'position unknown'} · tokens launched ${j?.devMints ?? '—'} (migrated ${j?.devMigrations ?? '—'})`);
      const hist = s.history.filter(h => h.marketCap).slice(-24);
      if (hist.length > 2) L.push('', '=== MARKET CAP SNAPSHOTS WHILE THE TAB WAS OPEN ===', hist.map(h => `${new Date(h.ts).toISOString().slice(11, 16)} ${money(h.marketCap)}${h.holders ? ' / ' + number(h.holders) + ' holders' : ''}`).join(' · '));
    }
    async function buildTradePrompt(snap, hasImage = false) {
      if (!s.coin) throw Error('No token selected');
      const L = [];
      L.push('You are a professional memecoin trader (Solana launchpads, pump.fun / PumpSwap, Raydium, fomo, also EVM). Your only job here: concrete ENTRY and EXIT scenarios for this token from the chart and trading data below' + (hasImage ? ' and the attached chart screenshot' : '') + '. Do not review the website or team. All levels in MARKET CAP and in PRICE (price = market cap / supply, see below). Data is seconds to minutes old.',
        '', 'TASKS:',
        '1. Structure & phase on 1m / 5m / 15m: trend, higher highs / lower lows, consolidation, distribution, breakout, retest, capitulation, dead. Momentum and volume trend.',
        '2. Key levels: supports and resistances from swing points, high-volume zones, VWAPs, the all-time high, round numbers and the market caps where callers entered.',
        '3. Dump risk: how much supply sits with dev, bundlers, snipers, insiders, fresh wallets, clusters and the top 10 compared to the liquidity — roughly how far could a full exit of these groups push the market cap down?',
        '4. Scenarios (at least: aggressive entry now, pullback / retest entry, breakout entry): trigger, entry (MC + price), stop / invalidation (MC + price), take-profit ladder (MC + price + % of the position to sell at each), risk:reward, rough probability, expected time frame.',
        '5. When NOT to trade (conditions that cancel every setup) and what to watch live in the next 15–60 minutes (volume, buy share, holders, callers, big wallets).',
        '6. Position size suggestion as % of a trading budget given the risk. Be concrete with numbers; say clearly when there is no good trade.',
        'Answer in English, compact. Never invent data. End with exactly one JSON code block (```json … ```):',
        '{"trade":{"bias":"bullish|neutral|bearish|avoid","phase":"…","action":"enter now|wait|don\'t enter|scalp only","entries":[{"mcap":0,"price":0,"type":"limit|breakout|retest|market","condition":"…"}],"invalidation":{"mcap":0,"price":0,"reason":"…"},"targets":[{"mcap":0,"price":0,"sellPct":0,"note":"…"}],"scenarios":[{"name":"…","trigger":"…","entryMcap":0,"stopMcap":0,"targetsMcap":[0],"rr":0,"probability":0}],"supports":[0],"resistances":[0],"dumpRisk":"low|medium|high","noTradeIf":["…"],"positionSizePct":0,"timeframe":"…","confidence":0,"summary":"max. 3 sentences"}}',
        '');
      tokenHeader(L); marketLines(L); tradeContextLines(L);
      await tradeDataLines(L);
      if (snap?.bars?.length >= 10 && !s.ohlc.length) await chartLines(L, snap);   // no GeckoTerminal candles → use the visible fomo chart
      calloutLines(L);
      checksLines(L);
      return L.join('\n').slice(0, 45000);
    }
    function calloutLines(L) {
      const callers = fomoCallers().filter(c => c.followers != null).sort((a, b) => b.followers - a.followers).slice(0, 10), th = fomoTheses().slice(0, 12), f = fomoData();
      if (f) {
        L.push('', `=== FOMO THESES (${f.total ?? th.length} total, fomo holders: ${f.totalHolders ?? '—'}) ===`);
        for (const c of callers) L.push(`- caller @${c.author}: ${c.followers} followers, ${c.calls} theses${c.firstMc ? ', first at MC ' + money(c.firstMc) : ''}${c.pnl != null ? ', PnL ' + money(c.pnl) : ''}${c.isDev ? ', DEV' : ''}`);
        for (const t of th) L.push(`- ${isoUtc(t.ts * 1000)} @${t.author}${t.mc ? ' at MC ' + money(t.mc) : ''}: ${t.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      const pf = s.pump?.key === curKey() ? s.pump : null;
      if (pf?.callouts.length) {
        L.push('', `=== PUMP.FUN CALLOUTS (${pf.callouts.length}) ===`);
        for (const r of pumpCallers().filter(c => c.xFollowers != null || c.pumpFollowers != null).slice(0, 10)) L.push(`- caller @${r.author}${r.x ? ' (X @' + r.x + ')' : ''}: X followers ${r.xFollowers ?? '—'}, pump.fun followers ${r.pumpFollowers ?? '—'}, ${r.calls} calls, first at MC ${money(r.firstMc)}, best ${r.best ? r.best.toFixed(2) + '×' : '—'}${r.holding ? '' : ', sold'}`);
        for (const c of pf.callouts.slice(0, 12)) L.push(`- ${isoUtc(c.ts * 1000)} @${c.author}${c.x ? ' (X @' + c.x + ')' : ''} at MC ${money(c.mc)}, max ${c.maxMultiple?.toFixed(2) ?? '—'}×, ${c.likes} likes, ${c.views} views${c.holding ? '' : ', sold'}: ${c.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      const fees = pf?.fees;
      if (fees?.shareholders?.length) L.push('', '=== CREATOR FEE SHARING ===', ...fees.shareholders.map(r => `- ${r.platform ? r.platform + ' @' + r.username : r.address} ${r.bps / 100}%: received ${r.received.toFixed(2)} SOL, claimed ${r.claims}× ${r.claimed.toFixed(2)} SOL`));
    }
    function signalLines(L, n) {
      const ev = s.events.slice(0, n);
      L.push('', '=== SOCIAL SIGNALS (' + s.events.length + ' collected by ApeScope) ===');
      if (!ev.length) L.push('none');
      for (const e of ev) L.push(`- ${isoUtc(e.timestamp * 1000)} · ${e.source} · ${e.author}: ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    async function buildPrompt(snap, hasImage = false, parts = aiPrefs) {
      if (!s.coin) throw Error('No token selected');
      const project = parts.project !== false, chart = !!parts.chart, L = [];
      if (project) await waitForProjectData();
      L.push('You are an experienced, risk-aware memecoin trader on Solana/EVM launchpads and a sceptical due-diligence analyst. Most of these coins are memes: their value comes from attention, narrative and timing, not from software. Judge the meme as seriously as the fundamentals. Use web browsing (X, news, Google Trends, DexScreener trending) and open the links yourself.', '', 'TASKS:');
      if (project) L.push(
        '1. Website(s): open and check content, real function/use case, team/imprint, roadmap, template or copy?, does the app work?, domain age (whois), is this exact CA shown?',
        '2. GitHub (if any): skim only, do not read all code — age, number and time span of commits, contributors, real functionality vs. empty/copied/forked repo, README quality, does it match the use case?',
        '3. X / Twitter: account age, followers, activity, genuine engagement vs. bots, renames/rebrands, link to the project, known people behind it.',
        '4. Meme & meta: what is the meme/story? Is it tied to something people talk about RIGHT NOW (news, a viral post, a celebrity, an AI/tech launch, a trending animal/character)? Search X and the web for the name and ticker from the last 24–72 h. Does it fit the current meta (which themes are pumping on pump.fun/fomo today)? Rate name, ticker, image, how easy it is to share, community/KOL interest, and whether the moment is early, peak or over.',
        '4b. Utility vs. meme: real utility or pure meme? Is it a vamp/copycat of a known coin (see look-alikes below)? Which token is the original? Without real utility, the meme strength and timing decide.',
        '5. Rate the on-chain and market data below: holder concentration, dev share and history, bundlers/insiders, LP, liquidity vs. market cap, bots, security flags.',
        '6. Callers: what do the fomo theses and pump.fun callouts below say, who are the biggest callers, are they in profit?',
        '7. List red flags and green flags.');
      if (chart) L.push(
        (project ? '8' : '1') + '. Chart' + (hasImage ? ' (screenshot attached)' : '') + ' and candles below: trend/structure, phase (early pump, consolidation, distribution, retest, dead cat, dead), supports/resistances as MARKET CAP, volume & momentum, impact of social signals.',
        (project ? '9' : '2') + '. Fast meme-trading plan in MARKET CAP (not price), for minutes to hours: enter now / wait until MC X / breakout above Y / retest of Z / do not enter; invalidation; take-profit targets; risk and time frame. Be concrete with numbers and say clearly when the setup is bad. Data may be seconds to minutes old.');
      L.push('Answer in English and keep it compact. Clearly mark anything you could not check — never invent facts.', 'ALWAYS end with exactly one JSON code block (```json … ```) in this format:');
      const trade = '"trade":{"bias":"bullish|neutral|bearish|avoid","phase":"…","action":"enter now|wait|don\'t enter|scalp only","entries":[{"mcap":0,"type":"limit|breakout|retest","condition":"…"}],"invalidation":{"mcap":0,"reason":"…"},"targets":[{"mcap":0,"note":"…"}],"supports":[0],"resistances":[0],"timeframe":"…","confidence":0,"summary":"max. 3 sentences"}';
      const proj = '"verdict":"legit|unclear|risky|likely scam","score":0,"summary":"max. 3 sentences","greenFlags":["…"],"redFlags":["…"],"website":"short finding or none","github":"short finding or none","twitter":"short finding or none","useCase":"…","meme":"the meme/story in one sentence","memeScore":0,"metaFit":"hot|rising|neutral|fading|none","narrativeTiming":"early|peak|late|unknown","catalysts":["…"],"vampRisk":"low|medium|high","original":"CA/name of the original if this is a vamp, else empty"';
      L.push('{' + [project ? proj : '', chart ? trade : ''].filter(Boolean).join(',') + '}');
      if (project) L.push('(score: 0 = certainly a scam, 100 = very trustworthy; memeScore: 0 = no meme power, 100 = viral, fits the moment perfectly)');
      L.push('');
      tokenHeader(L); marketLines(L); checksLines(L);
      if (project) projectLines(L);
      if (chart) await chartLines(L, snap);
      calloutLines(L);
      signalLines(L, chart ? 15 : 10);
      return L.join('\n').slice(0, 30000);
    }

    // ---- ChatGPT hand-off (sends automatically by default; untick "Send automatically" to review the prompt first) ----
    const DEFAULT_AI = { project: true, chart: true, screenshot: true, autoSend: true, newChat: true, temporary: false };
    let aiPrefs = { ...DEFAULT_AI }; // loaded from storage in start()
    const aiWorkerOnline = () => { const hb = load(K.aiWorker, {}); return !!hb.ts && Date.now() - hb.ts < 90000; };
    const aiChatUrl = () => aiPrefs.temporary ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';
    async function startAi(mode = 'full') {
      if (!s.coin) return alertLine('No token selected');
      const trade = mode === 'trade';
      if (s.aiBuilding || (!trade && !aiPrefs.project && !aiPrefs.chart)) return;
      s.aiBuilding = true; render();
      try {
        const coin = { ...s.coin }, key = curKey();
        let snap = null, image = '', note = '';
        if (aiPrefs.chart || trade) {
          snap = await requestChartSnapshot(); if (snap.error) note = snap.error;
          if (aiPrefs.screenshot) { if (snap.image) image = snap.image; else note = [note, snap.imageError || 'no screenshot'].filter(Boolean).join(' · '); }
        }
        const prompt = trade ? await buildTradePrompt(snap, !!image) : await buildPrompt(snap, !!image);
        if (key !== curKey()) return alertLine('Token changed — cancelled');
        const req = { nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), kind: 'analysis', key, coin, symbol: s.market?.symbol || '', prompt, image,
          autoSend: aiPrefs.autoSend, newChat: aiPrefs.newChat, temporary: aiPrefs.temporary, ts: Date.now() };
        s.aiPrompt = { text: prompt, note, hasImage: !!image }; s.aiJob = { nonce: req.nonce, key, status: 'requested', ts: Date.now() };
        const online = aiWorkerOnline();
        put(K.aiRequest, req);
        if (!online) GM_openInTab(aiChatUrl(), { active: true, insert: true });
        else { GM_openInTab('https://chatgpt.com/', { active: true, reuse: true });   // show the tab where the analysis runs
          setTimeout(() => { if (s.aiJob?.nonce === req.nonce && s.aiJob.status === 'requested') GM_openInTab(aiChatUrl(), { active: true, insert: true }); }, 5000); } // stale tab → open a new one
        alertLine(online ? 'Sent to ChatGPT' : 'Opening ChatGPT…');
      } catch (e) { alertLine('AI: ' + e.message); }
      finally { s.aiBuilding = false; scheduleRender(); }
    }
    function onAiResult(n) {
      if (!n?.nonce || n.kind !== 'analysis') return;
      if (!s.aiJob || s.aiJob.nonce === n.nonce || n.ts > (s.aiJob.ts || 0)) s.aiJob = { nonce: n.nonce, key: n.key, status: String(n.status || ''), error: String(n.error || '').slice(0, 200), ts: n.ts, url: /^https:\/\/chatgpt\.com\//.test(n.url || '') ? String(n.url) : '' };
      if (n.status === 'done' && typeof n.key === 'string') {
        const k = 'aps:ai:' + n.key, all = load(k, {});
        all.analysis = { ts: n.ts, text: String(n.text || '').slice(0, 40000), json: n.json && typeof n.json === 'object' && !Array.isArray(n.json) ? n.json : null, url: /^https:\/\/chatgpt\.com\//.test(n.url || '') ? String(n.url) : '' };
        put(k, all); if (n.key === curKey()) s.aiResults = all;
      }
      scheduleRender();
    }

    // ---- Start -----------------------------------------------------------------------------------
    function start() {
      aiPrefs = { ...DEFAULT_AI, ...load(K.aiPrefs, {}) };
      makeUI(); detectCoin(true);
      GM_addValueChangeListener(K.pumpCache, () => pullEvents());
      for (const k of [K.chartDiag, K.pumpHealth, K.xHealth]) GM_addValueChangeListener(k, () => scheduleRender());
      // Chart bridge health → shown in the Socials tab.
      window.addEventListener('message', ev => {
        if (ev.source !== window || ev.origin !== location.origin || ev.data?.type !== MSG.chartHealth) return;
        const d = ev.data;
        put(K.chartDiag, { markers: Number(d.markers) || 0, bars: Number(d.bars) || 0, error: String(d.error || '').slice(0, 120), caMatch: d.caMatch !== false, version: String(d.version || '').slice(0, 12), ts: Date.now() });
      });
      GM_addValueChangeListener(K.aiResult, (_, __, next) => onAiResult(next));
      GM_addValueChangeListener(K.gmgnResult, (_, __, next) => onGmgnResult(next));
      let aiOnline = aiWorkerOnline(), gmOnline = gmgnWorkerOnline();
      GM_addValueChangeListener(K.aiWorker, () => { const on = aiWorkerOnline(); if (on !== aiOnline) { aiOnline = on; scheduleRender(); } });
      GM_addValueChangeListener(K.gmgnWorker, () => { const on = gmgnWorkerOnline(); if (on !== gmOnline) { gmOnline = on; if (on && !s.gmgn) refreshGmgn(true); scheduleRender(); } });
      let lastObservedXKey = '';
      setInterval(() => {
        detectCoin(); if (!s.coin) return;
        const key = curKey();
        if (lastObservedXKey !== key) { lastObservedXKey = key; GM_addValueChangeListener(K.xFeedPrefix + key, () => pullEvents()); if (s.coin.chain === 'solana') GM_addValueChangeListener(K.xFeedPrefix + s.coin.ca, () => pullEvents()); }
        pullEvents();
      }, 3500);
      // Live refresh while a token is open. Each source runs as often as its rate limit allows (see LIVE);
      // fomo theses, holders and trade counts arrive by themselves whenever fomo refreshes them (~10 s).
      setInterval(() => {
        if (!s.coin) return;
        refreshMarket(); refreshJupiter(); refreshGmgn(); refreshPump(); pollXApi(); autoSearchX();
        if (Date.now() - (s.lastSecAt || 0) > LIVE.security) refreshSecurity();
        refreshProject(); refreshSimilar();
      }, LIVE.tick);
      setInterval(() => scheduleRender(), 5000);   // keeps ages ("12 s ago") current
      window.addEventListener('message', ev => { if (ev.source === window && ev.origin === location.origin && ev.data?.type === MSG.fomoFeed) onFomoFeed(ev.data); });
      const installed = GM_getValue('aps:update-installed', null);
      if (installed?.to) { GM_deleteValue('aps:update-installed'); setTimeout(() => alertLine(installed.to === VERSION ? `Updated to ${VERSION}` : `Update to ${installed.to} did not load — still ${VERSION}`), 1500); }
      if (Date.now() - (GM_getValue('aps:update-checked', 0) || 0) > 12 * 3600e3) setTimeout(() => checkForUpdate(false), 5000);
      setInterval(() => { if (s.coin) publishChart(); }, 4500);
      setInterval(() => backgroundWatches(uiSettings.tab === 'watchlist'), 5000);
      setInterval(() => { if (lastNotify.size > 300) lastNotify.clear(); }, 600000);
      setInterval(adaptPage, 3000);   // single-page apps re-render; keep newly mounted elements inside the free area
      addEventListener('resize', () => applyLayout());
      document.addEventListener('apescope:toggle', () => setCollapsed(!uiSettings.collapsed));   // toolbar button of the browser extension
      GM_registerMenuCommand(APP + ': reset layout', () => { uiSettings = { ...DEFAULT_UI }; applyLayout(); persistLayout(); render(); });
      GM_registerMenuCommand(APP + ': copy diagnostics', copyDiagnostics);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }

  function searchUrl(ca) {
    return 'https://x.com/search?q=' + encodeURIComponent('"' + ca + '"') + '&src=typed_query&f=live&' + WORKER_PARAM + '=1';
  }

  // ============================================================================================
  // pump.fun worker: reads the site's own callout responses (only in a tab opened by the panel)
  // ============================================================================================
  function runPump() {
    if (!activateWorker()) return;
    let lastRequest = null, lastAuto = 0, processing = false, pageBridgeAt = 0;
    const w = unsafeWindow || window;
    function logDiag(data) { GM_setValue(K.pumpDiag, [...GM_getValue(K.pumpDiag, []), { ts: new Date().toISOString(), ...data }].slice(-18)); }
    function parseResponse(raw, source, url, status, contentType = '') {
      if (raw.length > 5_000_000) { logDiag({ source, path: safePath(url), status, contentType, size: raw.length, result: 'too-large' }); return; }
      const tele = {};
      let incoming = [];
      try { incoming = extractPumpPayload(raw, tele); } catch (err) { tele.error = trim(err.message, 100); }
      const hint = /^\s*</.test(raw) ? 'HTML' : /^\s*(?:\d+:|[A-Za-z0-9_]+:)/.test(raw) ? 'possibly-RSC' : 'data';
      logDiag({ source, path: safePath(url), status, contentType: trim(contentType, 65), size: raw.length, hint, parsed: incoming.length, ...tele });
      if (!incoming.length) { setStatus(K.pumpHealth, status >= 200 && status < 300, `${source}: 0 callouts · ${hint} / ${tele.candidates || 0} candidates; copy diagnostics`); return; }
      const old = GM_getValue(K.pumpCache, []), merged = mergeEvents(old, incoming, 1500);
      if (merged.length !== old.length || incoming.some(e => !old.some(x => x.id === e.id))) GM_setValue(K.pumpCache, merged);
      GM_setValue(K.pumpError, '');
      setStatus(K.pumpHealth, true, `${incoming.length} callouts found; ${merged.length} cached`);
    }
    function observedGet(url, headers) {
      if (!isCalloutUrl(url)) return;
      // Authentication is never captured or logged; headers stay in this tab's memory only.
      // A page route with _rsc is not a validated data endpoint; do not poll it blindly.
      if (new URL(url).searchParams.has('_rsc')) return;
      const h = {}; try { for (const [k, v] of new Headers(headers || {})) h[k] = v; } catch {}
      lastRequest = { url, headers: h };
    }
    function readNetworkResponse(res, url, source) {
      if (!res || !isCalloutUrl(url)) return;
      const type = res.headers?.get?.('content-type') || '';
      try { res.clone().text().then(body => parseResponse(body, source, url, res.status, type)).catch(err => logDiag({ source, path: safePath(url), error: trim(err.message, 100) })); } catch {}
    }
    function captureFetch() {
      try {
        const native = w.fetch;
        if (typeof native !== 'function' || native.__apescope) return;
        w.fetch = function (...args) {
          let url = '', method = 'GET', headers = {};
          try {
            const input = args[0], opts = args[1] || {};
            url = new URL(typeof input === 'string' ? input : input.url, location.href).href;
            method = String(opts.method || input?.method || 'GET').toUpperCase();
            headers = new Headers(input?.headers || {}); for (const [k, v] of new Headers(opts.headers || {})) headers.set(k, v);
            if (method === 'GET') observedGet(url, headers);
          } catch {}
          const p = native.apply(this, args);
          if (method === 'GET' && isCalloutUrl(url)) Promise.resolve(p).then(res => readNetworkResponse(res, url, 'fetch')).catch(err => logDiag({ source: 'fetch', path: safePath(url), error: trim(err.message, 90) }));
          return p;
        };
        Object.defineProperty(w.fetch, '__apescope', { value: true });
      } catch (e) { logDiag({ source: 'hook', target: 'fetch', error: trim(e.message, 100) }); }
    }
    function captureXHR() {
      try {
        const proto = w.XMLHttpRequest?.prototype;
        if (!proto || proto.open.__apescope) return;
        const open = proto.open, send = proto.send, setHeader = proto.setRequestHeader;
        proto.open = function (method, url, ...args) { try { this.__apsReq = { url: new URL(url, location.href).href, method: String(method).toUpperCase(), headers: {} }; } catch {} return open.call(this, method, url, ...args); };
        Object.defineProperty(proto.open, '__apescope', { value: true });
        proto.setRequestHeader = function (name, value) { if (this.__apsReq && isCalloutUrl(this.__apsReq.url)) this.__apsReq.headers[name] = value; return setHeader.call(this, name, value); };
        proto.send = function (...args) {
          const request = this.__apsReq;
          if (request?.method === 'GET' && isCalloutUrl(request.url)) {
            observedGet(request.url, request.headers);
            this.addEventListener('loadend', () => {
              try {
                const type = this.getResponseHeader('content-type') || '';
                if (this.responseType === '' || this.responseType === 'text') parseResponse(this.responseText, 'xhr', request.url, this.status, type);
                else logDiag({ source: 'xhr', path: safePath(request.url), status: this.status, contentType: trim(type, 65), responseType: this.responseType });
              } catch (e) { logDiag({ source: 'xhr', path: safePath(request.url), error: trim(e.message, 100) }); }
            }, { once: true });
          }
          return send.apply(this, args);
        };
      } catch (e) { logDiag({ source: 'hook', target: 'xhr', error: trim(e.message, 100) }); }
    }
    captureFetch(); captureXHR();
    window.addEventListener('message', ev => {
      if (ev.source !== window || ev.origin !== location.origin || ev.data?.type !== MSG.pumpNetwork) return;
      pageBridgeAt = now();
      const d = ev.data;
      if (d.source === 'page-start' || d.source === 'page-heartbeat') {
        if (!GM_getValue(K.pumpCache, []).length) setStatus(K.pumpHealth, true, `page bridge active; ${Number(d.seen || 0)} responses, ${d.hasPollTarget ? 'polling ready' : 'open the callouts'}`);
      } else if (typeof d.body === 'string') {
        const path = typeof d.path === 'string' && /^\/callouts?(?:\/|$)/.test(d.path) ? d.path : '/callouts';
        parseResponse(d.body, d.source, 'https://pump.fun' + path, Number(d.status) || 0, d.contentType || '');
      } else {
        logDiag({ source: String(d.source || 'page'), path: trim(d.path || '', 120), status: Number(d.status) || 0, tooLarge: !!d.tooLarge, unsupportedResponseType: trim(d.unsupportedResponseType || '', 40), error: trim(d.error || '', 100) });
      }
    });
    async function fetchCallouts(force = false) {
      if (!lastRequest || processing || now() - pageBridgeAt < 30_000) return;
      if (!force && now() - lastAuto < options.pumpPollMs) return;
      processing = true; lastAuto = now();
      try {
        const res = await w.fetch(lastRequest.url, { method: 'GET', credentials: 'include', headers: lastRequest.headers, cache: 'no-store' });
        if (!res.ok) { const message = `${res.status} at ${safePath(lastRequest.url)}; check login/API`; GM_setValue(K.pumpError, message); setStatus(K.pumpHealth, false, message); }
        // The response is already parsed by the fetch wrapper; do not consume the body again.
      } catch (err) {
        const message = `pump.fun request failed (${trim(err.message, 100)})`;
        GM_setValue(K.pumpError, message); setStatus(K.pumpHealth, false, message); logDiag({ source: 'poll', path: safePath(lastRequest.url), error: trim(err.message, 90) });
      } finally { processing = false; }
    }
    function miniBadge() {
      if (!document.body || document.querySelector('#apescope-pump-helper')) return;
      const box = document.createElement('div'); box.id = 'apescope-pump-helper';
      Object.assign(box.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647', background: '#0b0f17', color: '#e6edf6', border: '1px solid #19e07a', padding: '10px', borderRadius: '8px', font: '12px system-ui', maxWidth: '380px' });
      const label = document.createElement('span'); label.textContent = 'ApeScope pump.fun worker: please open the pump.fun callouts. '; box.append(label);
      const btn = document.createElement('button'); btn.textContent = 'Repeat last callout request'; btn.style.cursor = 'pointer'; btn.onclick = () => fetchCallouts(true); box.append(btn);
      document.body.append(box);
    }
    setStatus(K.pumpHealth, true, 'worker active; waiting for a real callout request'); GM_setValue(K.pumpError, '');
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', miniBadge, { once: true }); else miniBadge();
    setInterval(() => {
      miniBadge(); fetchCallouts();
      const h = GM_getValue(K.pumpHealth);
      if (!h || now() - h.ts > 65_000) setStatus(K.pumpHealth, true, lastRequest ? 'worker active; polling the observed request' : 'worker active; no callout request seen yet');
    }, 10000);
    GM_registerMenuCommand('ApeScope pump.fun worker: repeat last callout request', () => fetchCallouts(true));
  }

  // ============================================================================================
  // X worker: live search for the selected CA (only in a tab opened by the panel)
  // ============================================================================================
  function runX() {
    if (!activateWorker()) return;
    let activeCA = '', activeChain = 'solana', lastScan = 0, lastPageScroll = 0;
    let autoPages = new URL(location.href).searchParams.has('aps_t') ? 3 : 0;   // poll reloads only need the newest posts
    let lastNav = Number(sessionStorage.getItem('aps:x-last-nav')) || now();
    const desiredQuery = () => GM_getValue(K.query, {}) || {};
    const desiredCA = () => desiredQuery().ca || '';
    const queryKey = () => { const q = desiredQuery(); return q.chain + ':' + (q.chain === 'solana' ? q.ca : String(q.ca).toLowerCase()); };
    const isCurrentSearch = ca => { try { return decodeURIComponent(location.search).toLowerCase().includes(ca.toLowerCase()); } catch { return false; } };
    function onRequestedCA() {
      const ca = desiredCA();
      if (!isValidAddress(ca, desiredQuery().chain)) return;
      if (ca !== activeCA || activeChain !== desiredQuery().chain) {
        activeCA = ca; activeChain = desiredQuery().chain; autoPages = 0;
        if (!isCurrentSearch(ca)) { location.replace(searchUrl(ca)); return; }
      }
    }
    function scrape() {
      onRequestedCA();
      const ca = activeCA || desiredCA();
      if (!isValidAddress(ca, activeChain) || !isCurrentSearch(ca)) return;
      const found = [];
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        const content = a.querySelector('[data-testid="tweetText"]'), text = content?.innerText || content?.textContent || '';
        if (!(isValidMint(ca) ? text.includes(ca) : text.toLowerCase().includes(ca.toLowerCase()))) continue;
        const timestamp = parseTime(a.querySelector('time[datetime]')?.getAttribute('datetime'));
        if (!timestamp) continue; // never invent post timestamps
        const statusLink = [...a.querySelectorAll('a[href*="/status/"]')].find(l => /\/status\/\d+/.test(l.getAttribute('href') || ''));
        if (!statusLink) continue;
        const url = safeUrl(statusLink.href, ['x.com', 'twitter.com']); if (!url) continue;
        const id = url.match(/\/status\/(\d+)/)?.[1]; if (!id) continue;
        found.push({ source: 'x', chain: activeChain, ca, timestamp, author: '@' + (new URL(url).pathname.split('/')[1] || 'unknown'), text: trim(text, 500), url, id: 'x:' + id });
      }
      const key = K.xFeedPrefix + queryKey(), previous = GM_getValue(key, []), merged = mergeEvents(previous, found, 400);
      if (merged.length !== previous.length || found.some(x => !previous.some(y => x.id === y.id))) GM_setValue(key, merged);
      setStatus(K.xHealth, true, `search loaded; ${merged.length} posts stored for this CA`, { ca });
      if (document.querySelector('[data-testid="loginButton"]') || /\/i\/flow\/login/.test(location.pathname)) GM_setValue(K.xError, 'X login required');
      else if (document.body?.innerText?.includes('Rate limit exceeded')) GM_setValue(K.xError, 'X rate limit detected');
      else GM_setValue(K.xError, '');
    }
    function heartbeat() {
      if (!document.body) return;
      onRequestedCA();
      if (now() - lastScan > 3_000) { lastScan = now(); scrape(); }
      if (activeCA && autoPages < 3 && now() - lastPageScroll > 12_000 && document.querySelector('article[data-testid="tweet"]')) {
        lastPageScroll = now(); autoPages++; window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      }
      if (activeCA && now() - lastNav > options.xPollMs) {
        // Search is not a persistent stream; reload sparingly to discover new posts.
        lastNav = now(); sessionStorage.setItem('aps:x-last-nav', String(lastNav));
        if (isCurrentSearch(activeCA)) { const url = new URL(searchUrl(activeCA)); url.searchParams.set('aps_t', String(now())); location.replace(url.toString()); }
      }
    }
    GM_addValueChangeListener(K.query, (_, __, next, remote) => { if (remote && next?.ca && (next.ca !== activeCA || next.chain !== activeChain)) { activeCA = ''; onRequestedCA(); } });
    activeCA = desiredCA(); activeChain = desiredQuery().chain || 'solana';
    if (activeCA && !isCurrentSearch(activeCA)) onRequestedCA();
    setInterval(heartbeat, 3000);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', heartbeat, { once: true }); else heartbeat();
  }

  // ============================================================================================
  // GMGN worker (gmgn.ai): answers token requests from the panel with same-origin, read-only API
  // calls. GMGN blocks these endpoints from other origins (Cloudflare), but serves them to its own pages.
  // ============================================================================================
  function runGmgn() {
    const me = 'g' + Math.random().toString(36).slice(2, 9);
    let busy = false, pending = null;
    const beat = () => GM_setValue(K.gmgnWorker, { ts: now(), id: me });
    async function getJson(path, body) {
      const res = await fetch(path, body ? { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      const text = await res.text();
      if (/^\s*</.test(text)) { const e = new Error('blocked'); e.status = 403; throw e; }   // Cloudflare challenge page instead of JSON
      if (text.length > 2_000_000) throw new Error('response too large');
      const j = JSON.parse(text);
      if (j && j.code !== undefined && Number(j.code) !== 0) throw new Error('GMGN: ' + trim(String(j.msg || j.message || j.code), 80));
      return j;
    }
    async function handle(req) {
      if (!req?.nonce || now() - Number(req.ts) > 60000) return;
      if (busy) { pending = req; return; }   // answer the latest request once the current one is done
      if (!Object.values(GMGN_CHAIN).includes(req.chain) || !isValidAddress(req.ca, req.chain === 'sol' ? 'solana' : 'ethereum')) return;
      busy = true;
      const reply = extra => GM_setValue(K.gmgnResult, { nonce: req.nonce, key: req.key, worker: me, ts: now(), ...extra });
      try {
        const ca = encodeURIComponent(req.ca), c = req.chain;
        let blocked = false;
        const soft = (p, body) => getJson(p, body).catch(e => { if (e.status === 403) blocked = true; return null; });
        const [stat, holderStat, fee, info, dist, calls] = await Promise.all([soft(`/api/v1/token_stat/${c}/${ca}`), soft(`/vas/api/v1/token_holder_stat/${c}/${ca}`), soft(`/api/v1/token_fee_info/${c}/${ca}`),
          soft('/api/v1/mutil_window_token_info', { chain: c, addresses: [req.ca] }), soft(`/api/v1/token_fee_distribution/${c}/${ca}`), c === 'sol' ? soft(`/pf/api/v1/pump/callout/token?chain=sol&token=${ca}`) : null]);
        if (blocked && !stat && !holderStat && !fee) throw new Error('GMGN asks for a security check — open the GMGN tab once');
        reply({ ok: true, data: { ...normalizeGmgn(stat, holderStat, fee), extra: normalizeGmgnExtra(info, dist, fee) }, callouts: calls ? normalizeGmgnCallouts(calls, req.ca) : [] });
      } catch (e) { reply({ ok: false, error: trim(String(e?.message || e), 120) }); }
      finally { busy = false; if (pending && pending.nonce !== req.nonce) { const next = pending; pending = null; handle(next); } else pending = null; }
    }
    GM_addValueChangeListener(K.gmgnRequest, (_, __, next) => { handle(next); });
    addEventListener('pagehide', () => { if ((GM_getValue(K.gmgnWorker, {}) || {}).id === me) GM_setValue(K.gmgnWorker, { ts: 0, id: me }); });
    beat(); setInterval(beat, 5000);
    handle(GM_getValue(K.gmgnRequest, null));
  }

  // ============================================================================================
  // ChatGPT worker (chatgpt.com). Acts only on a request created by a click in the panel: opens a fresh
  // chat, inserts the prompt (+ optional chart image), optionally sends, then reads the answer back.
  // Selectors are collected in SEL so a ChatGPT UI change needs one place to fix.
  // ============================================================================================
  function runChatGPT() {
    const SEL = {
      // Logged-in desktop used a ProseMirror div (#prompt-textarea); in Oct 2026 the composer was a plain
      // <textarea name="prompt"> and the send button was labelled "Send message" (verified in a browser).
      composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt"]', 'form textarea'],
      // The send button has no stable id; its aria-label is localised, so the list also covers common UI languages.
      send: ['button[data-testid="send-button"]', '#composer-submit-button', 'form button[type="submit"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="send" i]', 'button[aria-label*="senden" i]', 'button[aria-label*="envoyer" i]', 'button[aria-label*="enviar" i]'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="stop" i]'],
      assistant: '[data-message-author-role="assistant"], [data-turn="assistant"]',
      fileInput: 'input[type="file"]',
    };
    // First matching element, preferring a visible one (ChatGPT keeps hidden duplicates of some controls).
    const first = list => {
      let hidden = null;
      for (const sel of list) for (const e of document.querySelectorAll(sel)) { if (e.offsetParent !== null || e.getClientRects?.().length) return e; hidden = hidden || e; }
      return hidden;
    };
    const assistants = () => document.querySelectorAll(SEL.assistant);
    let me = '';
    try { me = sessionStorage.getItem('aps:ai-worker-id') || ''; } catch {}
    if (!me) { me = 'w' + Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem('aps:ai-worker-id', me); } catch {} }
    let busy = false, hintBox = null;
    const beat = () => GM_setValue(K.aiWorker, { ts: now(), id: me });
    const report = (req, status, extra = {}) => GM_setValue(K.aiResult, { nonce: req.nonce, kind: req.kind, key: req.key, worker: me, status, ts: now(), url: location.href, ...extra });
    async function waitFor(fn, timeout, step = 400) {
      const end = now() + timeout;
      for (;;) { let v = null; try { v = fn(); } catch {} if (v) return v; if (now() > end) return null; await sleep(step); }
    }
    const composerText = c => String(c.tagName === 'TEXTAREA' ? c.value : (c.innerText || c.textContent || '')).trim();
    function hint(text) {
      if (!hintBox) {
        hintBox = document.createElement('div');
        hintBox.style.cssText = 'position:fixed;right:18px;bottom:96px;z-index:2147483647;max-width:340px;padding:10px 12px;border-radius:8px;background:#0b0f17;color:#e6edf6;border:1px solid #19e07a;font:12px system-ui;box-shadow:0 6px 24px #0008';
        document.documentElement.append(hintBox);
      }
      hintBox.textContent = text;
    }
    const hideHint = () => { hintBox?.remove(); hintBox = null; };
    async function insertText(c, text) {
      c.focus();
      if (c.tagName === 'TEXTAREA') { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(c, text); c.dispatchEvent(new Event('input', { bubbles: true })); return; }
      const ok = () => composerText(c).length >= Math.min(40, text.length * 0.5);
      // 1) execCommand is handled by ProseMirror like typing. 2) synthetic paste. 3) direct DOM as last resort.
      try { document.execCommand('insertText', false, text); } catch {}
      await sleep(300); if (ok()) return;
      try { const dt = new DataTransfer(); dt.setData('text/plain', text); c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } catch {}
      await sleep(300); if (ok()) return;
      c.replaceChildren(...text.split('\n').map(line => { const p = document.createElement('p'); p.textContent = line; return p; }));
      c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
    function attachImage(dataUrl) {
      const [meta, b64] = String(dataUrl).split(','), type = /image\/png/.test(meta) ? 'image/png' : 'image/jpeg';
      const bin = atob(b64 || ''), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'apescope-chart.' + (type === 'image/png' ? 'png' : 'jpg'), { type }));
      const inputs = [...document.querySelectorAll(SEL.fileInput)], input = inputs.find(i => /image/.test(i.accept || '')) || inputs.find(i => !i.accept) || inputs[0];
      if (input) { input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      const c = first(SEL.composer); if (!c) return false;
      c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true;
    }
    const sendButton = () => { const b = first(SEL.send); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null; };
    const generating = () => !!first(SEL.stop) || !!document.querySelector('.result-streaming');
    function readAnswer() {
      const all = assistants(), msg = all[all.length - 1];
      if (!msg) return { text: '', blocks: [] };
      const md = msg.querySelector('.markdown') || msg;
      return { text: String(md.innerText || md.textContent || '').trim(), blocks: [...md.querySelectorAll('pre code')].map(e => e.textContent || '') };
    }
    async function handle(req) {
      if (busy || !req?.nonce || typeof req.prompt !== 'string' || now() - Number(req.ts) > 5 * 60000) return;
      const cur = GM_getValue(K.aiResult, {}) || {};
      if (cur.nonce === req.nonce) {
        if (['done', 'error'].includes(cur.status)) return;
        const mine = cur.worker === me;
        if (mine && cur.status !== 'navigating') return;
        if (!mine && !(cur.status === 'claimed' && now() - cur.ts > 15000)) return;
      }
      if (document.hidden) await sleep(1500); // let a visible ChatGPT tab win the claim
      const again = GM_getValue(K.aiResult, {}) || {};
      if (again.nonce === req.nonce && again.worker !== me && again.status !== 'navigating') return;
      report(req, 'claimed'); await sleep(500);
      if ((GM_getValue(K.aiResult, {}) || {}).worker !== me) return;
      busy = true;
      try {
        let navFor = ''; try { navFor = sessionStorage.getItem('aps:ai-nav') || ''; } catch {}
        const fresh = location.pathname === '/' && !assistants().length && (!req.temporary || /temporary-chat=true/.test(location.search));
        if (req.newChat && !fresh && navFor !== req.nonce) {
          try { sessionStorage.setItem('aps:ai-nav', req.nonce); } catch {}
          report(req, 'navigating');
          location.assign(req.temporary ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/');
          return;
        }
        const c = await waitFor(() => first(SEL.composer), 30000);
        if (!c) throw Error('ChatGPT input field not found (logged in? UI changed?)');
        await sleep(600);
        const baseline = assistants().length;
        if (req.image) { if (!attachImage(req.image)) hint('ApeScope: the chart screenshot could not be attached.'); await sleep(1200); }
        await insertText(c, req.prompt);
        report(req, 'inserted');
        if (req.autoSend) {
          const b = await waitFor(sendButton, 90000, 500);
          if (!b) throw Error('send button not available (is an upload stuck?)');
          b.click(); report(req, 'sent');
        } else { hint('ApeScope: prompt inserted — press Enter to send it.'); report(req, 'waiting'); }
        // From here on nothing can fail: the prompt is in ChatGPT. Answers often take minutes, so the answer is
        // picked up in the background if it arrives within 30 minutes; otherwise the job simply stays "sent".
        const started = await waitFor(() => assistants().length > baseline, 30 * 60000, 1500);
        hideHint();
        if (!started) return;
        if (!req.autoSend) report(req, 'sent');
        let last = '', stableSince = now();
        const end = now() + 30 * 60000;
        for (;;) {
          await sleep(2000);
          const { text } = readAnswer();
          if (text !== last) { last = text; stableSince = now(); }
          if (!generating() && text && now() - stableSince > 6000) break;
          if (now() > end) return;
        }
        const { text, blocks } = readAnswer();
        if (text) report(req, 'done', { text: text.slice(0, 40000), json: extractAiJson(text, blocks) });
      } catch (e) { report(req, 'error', { error: trim(String(e?.message || e), 200) }); hint('ApeScope: ' + trim(String(e?.message || e), 200)); }
      finally { busy = false; }
    }
    GM_addValueChangeListener(K.aiRequest, (_, __, next) => { handle(next); });
    addEventListener('pagehide', () => { if ((GM_getValue(K.aiWorker, {}) || {}).id === me) GM_setValue(K.aiWorker, { ts: 0, id: me }); });
    const boot = () => { beat(); setInterval(beat, 5000); handle(GM_getValue(K.aiRequest, null)); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
  }

  try {
    if (isFomo) runPanel();
    else if (isPump) runPump();
    else if (isX) runX();
    else if (isGmgn) runGmgn();
    else if (isChatGPT) runChatGPT();
  } catch (err) { console.error('[ApeScope] initialization failed:', err); }
})();
