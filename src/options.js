// ApeScope options page: grants or removes the optional access to all websites (website checks, custom RPC).
'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const ALL = { origins: ['<all_urls>'] };
const state = document.getElementById('state');
async function show() {
  const on = await api.permissions.contains(ALL);
  state.textContent = on ? 'Website checks are allowed.' : 'Website checks are off (no access to project websites).';
  state.className = 'state ' + (on ? 'on' : 'off');
}
document.getElementById('allow').addEventListener('click', async () => { try { await api.permissions.request(ALL); } catch {} show(); });
document.getElementById('remove').addEventListener('click', async () => { try { await api.permissions.remove(ALL); } catch {} show(); });
show();
