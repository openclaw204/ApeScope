#!/usr/bin/env node
'use strict';
// Runs every test/*.test.js in its own Node process and fails if any of them fails.
const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const files = readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`FAIL ${f}`); }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nAll ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
