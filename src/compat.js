/*
 * ApeScope — compatibility API for apescope.js (content script, isolated world). MIT License.
 *
 * apescope.js uses a small, synchronous API (GM_getValue, GM_setValue, GM_addValueChangeListener,
 * GM_xmlhttpRequest, GM_openInTab, GM_setClipboard). This file provides it on top of the WebExtension APIs:
 *   values    → chrome.storage.local, cached in memory; changes from other tabs fire the listeners
 *   requests  → background.js (host permissions, never with cookies)
 *   tabs      → background.js (can bring an existing tab to the front)
 *   X search  → background.js (APS_xSearch: opt-in search through x.com's web API with the user's X session)
 * apescope.js starts once the storage cache is loaded.
 */
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const cache = new Map(), listeners = new Map(), localWrites = new Map();
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

  globalThis.GM_getValue = (key, def) => cache.has(key) ? clone(cache.get(key)) : def;
  globalThis.GM_setValue = (key, value) => {
    const v = clone(value);
    cache.set(key, v);
    localWrites.set(key, (localWrites.get(key) || 0) + 1);
    api.storage.local.set({ [key]: v }).catch(() => localWrites.set(key, Math.max(0, (localWrites.get(key) || 1) - 1)));
  };
  globalThis.GM_deleteValue = key => { cache.delete(key); api.storage.local.remove(key); };
  globalThis.GM_addValueChangeListener = (key, cb) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(cb);
    return cb;
  };
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
      const own = (localWrites.get(key) || 0) > 0;
      if (own) localWrites.set(key, localWrites.get(key) - 1);
      if (newValue === undefined) cache.delete(key); else if (!own) cache.set(key, newValue);
      for (const cb of listeners.get(key) || []) { try { cb(key, oldValue, clone(newValue), !own); } catch (e) { console.error('[ApeScope]', e); } }
    }
  });

  globalThis.GM_xmlhttpRequest = opts => {
    api.runtime.sendMessage({ type: 'aps-xhr', method: opts.method || 'GET', url: opts.url, headers: opts.headers || {}, data: opts.data ?? null, timeout: opts.timeout || 15000 })
      .then(res => {
        if (!res?.ok) return res?.error === 'timeout' ? opts.ontimeout?.() : opts.onerror?.({ error: res?.error || 'network error' });
        opts.onload?.({ status: res.status, responseText: res.responseText, responseHeaders: res.responseHeaders, finalUrl: res.finalUrl });
      })
      .catch(e => opts.onerror?.({ error: String(e?.message || e) }));
  };
  globalThis.GM_openInTab = (url, options = {}) => {
    api.runtime.sendMessage({ type: 'aps-open', url: String(url), active: options.active !== false, reuse: !!options.reuse }).catch(() => {});
  };
  globalThis.GM_setClipboard = text => {
    navigator.clipboard?.writeText(String(text)).catch(() => {
      const ta = document.createElement('textarea'); ta.value = String(text); ta.style.cssText = 'position:fixed;left:-9999px';
      document.documentElement.append(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove();
    });
  };
  // X search through x.com's web API (opt-in setting; background.js uses the user's X session and paces the calls).
  globalThis.APS_xSearch = ({ query, cursor } = {}) => api.runtime.sendMessage({ type: 'aps-x-search', query: String(query || ''), cursor: String(cursor || '') })
    .then(r => r || { ok: false, code: 'http', error: 'no answer from the background script' })
    .catch(e => ({ ok: false, code: 'http', error: String(e?.message || e) }));
  globalThis.GM_registerMenuCommand = () => 0;   // the toolbar button replaces menu commands
  globalThis.unsafeWindow = window;              // page-world hooks live in bridge.js (world: MAIN)

  // Update check / install, used by the Settings tab.
  globalThis.apescopeHost = {
    checkUpdate: () => api.runtime.sendMessage({ type: 'aps-update-check' }),
    applyUpdate: () => api.runtime.sendMessage({ type: 'aps-update-apply' }),
    installFile: (data, folder) => api.runtime.sendMessage({ type: 'aps-update-file', data, folder }),
    renderText: url => api.runtime.sendMessage({ type: 'aps-render-text', url }),
    gmgn: req => api.runtime.sendMessage({ type: 'aps-gmgn', chain: req.chain, ca: req.ca }).then(r => r || { ok: false, error: 'no answer from the background script' }),
    installType: () => api.runtime.sendMessage({ type: 'aps-install-type' }),
    allSites: () => api.runtime.sendMessage({ type: 'aps-all-sites' }).then(Boolean, () => false),
    openOptions: () => api.runtime.sendMessage({ type: 'aps-open-options' }),
  };

  // Toolbar button → show / hide the sidebar on fomo.family.
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'aps-toggle') return;
    const handled = !!document.getElementById('apescope-root');
    if (handled) document.dispatchEvent(new CustomEvent('apescope:toggle'));
    sendResponse({ handled });
  });

  api.storage.local.get(null).then(all => {
    for (const [k, v] of Object.entries(all || {})) cache.set(k, v);
    if (typeof globalThis.__apescopeRun === 'function') globalThis.__apescopeRun();
  });
})();
