/*
 * ApeScope — page-context script (world: MAIN). MIT License.
 * Runs in the page itself because the TradingView chart and the sites' own network responses are only
 * reachable from there: draws signal markers on the fomo chart, provides chart snapshots, passes fomo's
 * token feed and pump.fun callout responses to apescope.js. Talks to it via window.postMessage on the
 * same origin only; request headers are never passed on.
 */(() => {
  'use strict';
  if (location.hostname === 'pump.fun' || location.hostname === 'www.pump.fun') {
    if (window.__apescopePumpBridge) return;
    window.__apescopePumpBridge = true;
    // This script is page-world; capture actual website responses, not a guessed API.
    // No credentials/headers are sent via postMessage or persistent storage.
    try {
      if (new URLSearchParams(location.search).has('apescope_worker')) sessionStorage.setItem('aps:worker', '1');
    } catch {}
    if (sessionStorage.getItem('aps:worker') !== '1') return;
    let observed = null, lastPoll = 0, busy = false, count = 0;
    const relevant = value => {
      try {
        const u = new URL(value, location.href);
        return u.protocol === 'https:' && (u.hostname === 'pump.fun' || u.hostname.endsWith('.pump.fun')) &&
          /^\/callouts?(?:\/|$)/i.test(u.pathname);
      } catch { return false; }
    };
    const emit = data => window.postMessage({ type:'APESCOPE_PUMP_NETWORK', ...data }, location.origin);
    const pathname = value => {
      try { return new URL(value).pathname.replace(/\/[A-Za-z0-9_-]{24,}/g, '/{id}').slice(0,120); }
      catch { return ''; }
    };
    const accept = (url, headers) => {
      if (!relevant(url) || new URL(url).searchParams.has('_rsc')) return;
      const h = {};
      try { for (const [key, val] of new Headers(headers || {})) h[key] = val; } catch {}
      observed = { url, headers:h };
    };
    const tap = async (res, url, source) => {
      if (!relevant(url) || !res) return;
      try {
        const body = await res.clone().text();
        if (body.length > 2_000_000) {
          emit({ source, path:pathname(url), status:res.status, contentType:res.headers?.get?.('content-type') || '', tooLarge:true });
          return;
        }
        count++;
        emit({ source, path:pathname(url), status:res.status, contentType:res.headers?.get?.('content-type') || '', body });
      } catch (e) { emit({ source, path:pathname(url), error:String(e?.message || e).slice(0,100) }); }
    };
    try {
      const native = window.fetch;
      window.fetch = function (...args) {
        let url = '', method = 'GET', h = {};
        try {
          const input = args[0], options = args[1] || {};
          url = new URL(typeof input === 'string' ? input : input.url, location.href).href;
          method = String(options.method || input?.method || 'GET').toUpperCase();
          h = new Headers(input?.headers || {});
          for (const [k,v] of new Headers(options.headers || {})) h.set(k,v);
          if (method === 'GET') accept(url, h);
        } catch {}
        const result = native.apply(this, args);
        if (method === 'GET' && relevant(url)) Promise.resolve(result).then(r => tap(r, url, 'page-fetch')).catch(() => {});
        return result;
      };
      const proto = window.XMLHttpRequest?.prototype;
      if (proto) {
        const open = proto.open, send = proto.send, setHeader = proto.setRequestHeader;
        proto.open = function (method, url, ...args) {
          try { this.__apsCapture = { method:String(method).toUpperCase(), url:new URL(url, location.href).href, headers:{} }; } catch {}
          return open.call(this, method, url, ...args);
        };
        proto.setRequestHeader = function (k,v) {
          if (this.__apsCapture && relevant(this.__apsCapture.url)) this.__apsCapture.headers[k] = v;
          return setHeader.call(this,k,v);
        };
        proto.send = function (...args) {
          const q = this.__apsCapture;
          if (q && q.method === 'GET' && relevant(q.url)) {
            accept(q.url, q.headers);
            this.addEventListener('loadend', () => {
              if (this.responseType !== '' && this.responseType !== 'text') {
                emit({ source:'page-xhr', path:pathname(q.url), status:this.status, contentType:'', unsupportedResponseType:this.responseType });
                return;
              }
              try {
                const body = this.responseText;
                if (body.length < 2_000_000) {
                  count++; emit({ source:'page-xhr', path:pathname(q.url), status:this.status,
                    contentType:this.getResponseHeader('content-type') || '', body });
                }
              } catch {}
            }, { once:true });
          }
          return send.apply(this,args);
        };
      }
    } catch (e) { emit({ source:'page-hook', error:String(e?.message || e).slice(0,100) }); }
    setInterval(async () => {
      emit({ source:'page-heartbeat', seen:count, hasPollTarget:!!observed });
      if (busy || !observed || Date.now() - lastPoll < 45000) return;
      busy = true; lastPoll = Date.now();
      try {
        await window.fetch(observed.url, { method:'GET', credentials:'include', headers:observed.headers, cache:'no-store' });
      } catch (e) { emit({ source:'page-poll', path:pathname(observed.url), error:String(e?.message || e).slice(0,100) }); }
      finally { busy = false; }
    }, 10000);
    emit({ source:'page-start', seen:0 });
    return;
  }
  if (window.__apescopeChartBridge) return;
  // fomo polls theses, top holders and trade counts of the open token; hand those responses to ApeScope (body only).
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function' && !nativeFetch.__apescope) {
      window.fetch = function (...args) {
        const p = nativeFetch.apply(this, args);
        try {
          const u = new URL(typeof args[0] === 'string' ? args[0] : args[0]?.url || '', location.href);
          if (u.hostname === 'prod-api.fomo.family' && /^\/(feed\/token|hodlers\/top|proxy\/tokenDetails)/.test(u.pathname)) {
            // The token comes from the URL, the JSON request body or, last, the token page that is open.
            let token = u.searchParams.get('tokenAddress') || '';
            const reqBody = args[1]?.body;
            if (!token && typeof reqBody === 'string' && reqBody.length < 5000) try { const j = JSON.parse(reqBody); token = String(j.tokenAddress || j.address || j.token || '').slice(0, 64); } catch {}
            const pageToken = (location.pathname.match(/\/tokens\/[^/]+\/([A-Za-z0-9]{32,64})/) || [])[1] || '';
            Promise.resolve(p).then(r => r.clone().text()).then(body => { if (body.length < 3_000_000) window.postMessage({ type: 'APESCOPE_FOMO_FEED', path: u.pathname, token, pageToken, body }, location.origin); }).catch(() => {});
          }
        } catch {}
        return p;
      };
      Object.defineProperty(window.fetch, '__apescope', { value: true });
    }
  } catch {}
  window.__apescopeChartBridge = true;
  const VERSION = '1.0.4';
  const EVENT_INPUT = 'APESCOPE_CHART_EVENTS';
  const EVENT_HEALTH = 'APESCOPE_CHART_HEALTH';
  const ID = 'apescope-chart-layer';
  let state = { ca: '', events: [], received: 0 };
  let lastHealth = '', lastEmit = 0;
  const isNum = n => Number.isFinite(n);
  const fn = (obj, name) => obj && (typeof obj[name] === 'function' ? obj[name]() : obj[name]);
  const strip = (value, n = 80) => typeof value === 'string' ? value.slice(0, n) : '';
  const validCA = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[a-fA-F0-9]{40}$/.test(s));
  const sameCA = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'APESCOPE_CHART_SNAPSHOT_REQ') { handleSnapshotRequest(event); return; }
    if (event.data?.type !== EVENT_INPUT) return;
    const msg = event.data;
    if (msg.clear === true) { state = { ca:'', events:[], received:Date.now() }; return; }
    if (!validCA(msg.ca) || !Array.isArray(msg.events)) return;
    const events = [];
    for (const e of msg.events.slice(0, 160)) {
      if (!e || !sameCA(e.ca,msg.ca) || !['pump', 'x', 'manual', 'telegram','wallet'].includes(e.source)) continue;
      if (!Number.isSafeInteger(e.timestamp) || e.timestamp < 1577836800 || e.timestamp > Date.now() / 1000 + 86400) continue;
      if (typeof e.id !== 'string') continue;
      let link = '';
      try {
        const url = new URL(e.url);
        if (url.protocol === 'https:' && (e.source === 'pump' && url.hostname === 'pump.fun' || e.source === 'x' && ['x.com', 'twitter.com'].includes(url.hostname) || e.source === 'telegram' && url.hostname === 't.me' || e.source === 'wallet' && url.hostname === 'solscan.io')) link = url.href;
      } catch {}
      events.push({ ca: e.ca, id: e.id.slice(0, 100), timestamp: e.timestamp, source: e.source,
        author: strip(e.author, 70), text: strip(e.text, 260), url: link });
    }
    state = { ca: msg.ca, events, received: Date.now() };
  });

  function findMainCanvas(doc) {
    let best = null, area = 0;
    for (const canvas of doc.querySelectorAll('canvas')) {
      const r = canvas.getBoundingClientRect();
      if (r.width * r.height > area) { best = canvas; area = r.width * r.height; }
    }
    return { canvas: best, area };
  }
  function locateFrame() {
    let found = 0, reachable = 0, withCollection = 0, selected = null;
    for (const frame of document.querySelectorAll('iframe')) {
      const rect = frame.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) continue;
      found++;
      try {
        const style = getComputedStyle(frame);
        if (style.visibility === 'hidden' || style.display === 'none' || +style.opacity === 0) continue;
        const w = frame.contentWindow;
        const doc = w?.document;
        if (!doc) continue;
        reachable++;
        const collection = w.chartWidgetCollection;
        if (!collection) continue;
        withCollection++;
        const { canvas, area } = findMainCanvas(doc);
        if (canvas && area > 10000 && (!selected || area > selected.area)) selected = { frame, w, doc, collection, canvas, area };
      } catch { /* cross-origin frame */ }
    }
    return { selected, found, reachable, withCollection };
  }
  function getWidget(collection) {
    const list = typeof collection.getAll === 'function' ? collection.getAll() : [];
    return list?.[0] || fn(collection, 'activeChartWidget') || null;
  }
  function readBars(widget) {
    const model = fn(widget, 'model');
    const series = fn(model, 'mainSeries');
    const ts = fn(model, 'timeScale');
    const data = fn(series, 'data');
    const bars = fn(data, 'bars');
    if (!ts || typeof ts.indexToCoordinate !== 'function' || !bars || typeof bars.each !== 'function') return { ts, rows: [], error: 'timescale/bars API missing' };
    const rows = [];
    bars.each((index, row) => {
      const val = row && (row.value || row);
      if (!Array.isArray(val) || !isNum(index) || !isNum(val[0])) return false;
      const t = val[0] > 1e11 ? Math.floor(val[0] / 1000) : val[0];
      if (t > 1e9 && t < 1e11) rows.push({ t, index, o: isNum(val[1]) ? val[1] : null, c: isNum(val[4]) ? val[4] : null });
      return false;
    });
    rows.sort((a, b) => a.t - b.t);
    return { ts, rows, error: '' };
  }
  function nearestCandle(rows, timestamp) {
    if (!rows.length) return null;
    // For a timestamp inside a candle use its opening time, never interpolate from clock time
    // to arbitrary x pixels. Zoom/scroll follows TradingView's own time-scale index mapping.
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].t <= timestamp) lo = mid + 1;
      else hi = mid;
    }
    const index = Math.max(0, lo - 1);
    const current = rows[index];
    const d = [];
    for (let k = Math.max(1, index - 8); k <= Math.min(rows.length - 1, index + 8); k++) {
      const interval = rows[k].t - rows[k - 1].t;
      if (interval > 0) d.push(interval);
    }
    d.sort((a, b) => a - b);
    const resolution = d.length ? d[Math.floor(d.length / 2)] : 60;
    if (timestamp < rows[0].t || timestamp >= rows.at(-1).t + Math.max(60, resolution * 2)) return null;
    return current;
  }
  // Markers live in a short strip at the bottom of the chart (the volume area), never across the candles.
  const MARKER_STRIP = 54;
  const MARKER_STYLE = { x: ['X', '#38bdf8'], pump: ['PF', '#22c55e'], telegram: ['TG', '#a78bfa'], wallet: ['W', '#f59e0b'], manual: ['●', '#94a3b8'] };
  function createMarker(doc, event, x, width, height, nth, candle, lastClose) {
    // Performance since the signal candle (its close, fallback open) up to the latest close.
    const entry = candle?.c || candle?.o;
    const perf = entry > 0 && lastClose > 0 ? ` · ${(lastClose / entry).toFixed(2)}×` : '';
    const [label, color] = MARKER_STYLE[event.source] || ['?', '#94a3b8'];
    const b = doc.createElement('div');
    b.style.cssText = `position:absolute;left:${Math.round(x)}px;top:${Math.max(0, height - MARKER_STRIP)}px;height:${MARKER_STRIP}px;border-left:1px dashed ${color};pointer-events:none;opacity:.9;`;
    const a = doc.createElement(event.url ? 'a' : 'span');
    if (event.url) { a.href = event.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.textContent = label;
    a.title = `${event.source === 'pump' ? 'PUMP.FUN' : event.source.toUpperCase()} · ${event.author}${perf}\n${new Date(event.timestamp * 1000).toLocaleString('en-GB')}\n${event.text}`;
    a.style.cssText = `position:absolute;bottom:${2 + nth * 15}px;left:${x > width - 34 ? '-19px' : '2px'};min-width:14px;height:13px;padding:0 3px;text-align:center;line-height:13px;display:block;pointer-events:auto;cursor:pointer;border-radius:3px;color:#04121a;font:800 9px system-ui;background:${color};text-decoration:none;`;
    b.append(a);
    return b;
  }
  function tick() {
    const res = locateFrame();
    const base = { version: VERSION, frameCount: res.found, reachableFrames: res.reachable,
      collections: res.withCollection, caMatch: true, bars: 0, markers: 0, offscreen: 0, outOfHistory: 0, error: '' };
    const pick = res.selected;
    if (!pick) {
      base.error = res.found ? 'No visible same-origin TradingView collection' : 'No visible chart iframe';
      emit(base); return;
    }
    try {
      // Guard against old events being drawn on another token after SPA navigation.
      const pathname = decodeURIComponent(location.pathname).toLowerCase();
      if (state.ca && /\/tokens\//.test(pathname) && !pathname.includes(state.ca.toLowerCase())) {
        base.caMatch = false; base.error = 'CA differs from the current token URL';
        pick.doc.getElementById(ID)?.remove(); emit(base); return;
      }
      const widget = getWidget(pick.collection);
      if (!widget) { base.error = 'Collection found, chart widget missing'; emit(base); return; }
      const { ts, rows, error } = readBars(widget);
      base.bars = rows.length;
      if (error) { base.error = error; emit(base); return; }
      if (rows.length === 0) { base.error = 'No OHLC bars loaded yet'; emit(base); return; }
      const rect = pick.canvas.getBoundingClientRect();
      let layer = pick.doc.getElementById(ID);
      if (!layer) {
        layer = pick.doc.createElement('div'); layer.id = ID;
        layer.style.cssText = 'position:fixed;z-index:60;pointer-events:none;overflow:hidden;';
        pick.doc.body.append(layer);
      }
      layer.style.left = rect.left + 'px'; layer.style.top = rect.top + 'px';
      layer.style.width = rect.width + 'px'; layer.style.height = rect.height + 'px';
      layer.replaceChildren();
      const labelsPerPixel = new Map();
      for (const ev of state.events) {
        const candle = nearestCandle(rows, ev.timestamp);
        if (!candle) { base.outOfHistory++; continue; }
        const x = ts.indexToCoordinate(candle.index);
        if (!isNum(x) || x < 0 || x > rect.width) { base.offscreen++; continue; }
        const bucket = Math.floor(x / 20);
        const nth = (labelsPerPixel.get(bucket) || 0) % 3;
        labelsPerPixel.set(bucket, (labelsPerPixel.get(bucket) || 0) + 1);
        layer.append(createMarker(pick.doc, ev, x, rect.width, rect.height, nth, candle, rows.at(-1)?.c));
        base.markers++;
      }
      if (!state.received) base.error = 'Waiting for data from ApeScope';
    } catch (e) { base.error = strip(String(e?.message || e), 110); }
    emit(base);
  }
  function emit(msg) {
    const snapshot = JSON.stringify(msg);
    if (snapshot === lastHealth && Date.now() - lastEmit < 9000) return;
    lastHealth = snapshot; lastEmit = Date.now();
    window.postMessage({ type: EVENT_HEALTH, ...msg }, location.origin);
  }
  // v1.2: on request from the main script, return OHLCV of the visible chart plus a JPEG of it.
  // Only public chart pixels/bars are sent, and only to the same origin.
  const EVENT_SNAP_REQ = 'APESCOPE_CHART_SNAPSHOT_REQ';
  const EVENT_SNAP = 'APESCOPE_CHART_SNAPSHOT';
  function readOhlcv(widget, max = 800) {
    const series = fn(fn(widget, 'model'), 'mainSeries');
    const bars = fn(fn(series, 'data'), 'bars');
    const out = [];
    if (!bars || typeof bars.each !== 'function') return out;
    bars.each((index, row) => {
      const val = row && (row.value || row);
      if (!Array.isArray(val) || !isNum(val[0]) || ![1, 2, 3, 4].every(i => isNum(val[i]))) return false;
      const t = val[0] > 1e11 ? Math.floor(val[0] / 1000) : val[0];
      if (t > 1e9 && t < 1e11) out.push({ t, o: val[1], h: val[2], l: val[3], c: val[4], v: isNum(val[5]) ? val[5] : 0 });
      return false;
    });
    return out.sort((a, b) => a.t - b.t).slice(-max);
  }
  function compositeCanvases(doc, main) {
    // Fallback when tradingViewApi.takeClientScreenshot is unavailable: stitch all chart canvases.
    const container = doc.querySelector('.chart-container') || main.parentElement || main;
    const base = container.getBoundingClientRect();
    const dpr = main.width / (main.getBoundingClientRect().width || main.width) || 1;
    const out = doc.createElement('canvas');
    out.width = Math.max(1, Math.round(base.width * dpr)); out.height = Math.max(1, Math.round(base.height * dpr));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#0b0f17'; ctx.fillRect(0, 0, out.width, out.height);
    for (const c of doc.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= base.left || r.left >= base.right || r.bottom <= base.top || r.top >= base.bottom) continue;
      ctx.drawImage(c, (r.left - base.left) * dpr, (r.top - base.top) * dpr, r.width * dpr, r.height * dpr);
    }
    return out;
  }
  async function chartImage(pick) {
    let canvas = null;
    const api = pick.w && pick.w.tradingViewApi;
    if (api && typeof api.takeClientScreenshot === 'function') { try { canvas = await api.takeClientScreenshot(); } catch { canvas = null; } }
    if (!canvas || !canvas.width) canvas = compositeCanvases(pick.doc, pick.canvas);
    let out = canvas;
    const scale = Math.min(1, 1600 / canvas.width);
    if (scale < 1) {
      out = pick.doc.createElement('canvas');
      out.width = Math.round(canvas.width * scale); out.height = Math.round(canvas.height * scale);
      out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    }
    return out.toDataURL('image/jpeg', 0.85);
  }
  async function snapshot() {
    const res = locateFrame();
    const pick = res.selected;
    if (!pick) return { error: res.found ? 'No visible TradingView collection' : 'No visible chart iframe' };
    const widget = getWidget(pick.collection);
    if (!widget) return { error: 'Chart widget missing' };
    const bars = readOhlcv(widget);
    let image = '', imageError = '';
    try { image = await chartImage(pick); }
    catch (e) { imageError = e && e.name === 'SecurityError' ? 'Screenshot blocked by the browser (cross-origin images in the chart)' : strip(String(e && e.message || e), 120); }
    return { bars, image, imageError, ca: state.ca, error: '' };
  }
  function handleSnapshotRequest(event) {
    const id = strip(String(event.data.id || ''), 40);
    snapshot().then(
      res => window.postMessage({ type: EVENT_SNAP, id, ...res }, location.origin),
      e => window.postMessage({ type: EVENT_SNAP, id, error: strip(String(e && e.message || e), 140) }, location.origin));
  }

  tick();
  setInterval(tick, 1200);
})();
