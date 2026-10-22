#!/usr/bin/env node
'use strict';
// Prints updates.json for Firefox's automatic updates of the signed add-on (update_url of builds made with --github).
//   node scripts/firefox-updates.js <owner/repo> <signed.xpi>
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const [repo, xpi] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !xpi) { console.error('usage: node scripts/firefox-updates.js <owner/repo> <signed.xpi>'); process.exit(1); }
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(xpi)).digest('hex');
const update_link = `https://github.com/${repo}/releases/download/v${version}/apescope-firefox.xpi`;
process.stdout.write(JSON.stringify({ addons: { [require('./build').FIREFOX_ID]: { updates: [{ version, update_link, update_hash: hash }] } } }, null, 2) + '\n');
