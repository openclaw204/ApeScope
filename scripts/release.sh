#!/usr/bin/env bash
# Publishes the version in package.json as a GitHub release of this repository:
# tests, build (update check pointing at this repository), optional Firefox signing, tag, release with the files.
#
#   scripts/release.sh
#
# Firefox signing (optional): WEB_EXT_API_KEY and WEB_EXT_API_SECRET from addons.mozilla.org
# (Tools → Manage API Keys), as environment variables or in ~/.config/apescope/amo.env.
# The release is created by the GitHub account the gh CLI uses (GH_TOKEN, if set).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ -f "$HOME/.config/apescope/amo.env" ] && . "$HOME/.config/apescope/amo.env"
git diff --quiet && git diff --cached --quiet || { echo "Commit your changes first." >&2; exit 1; }
version="$(node -p "require('./package.json').version")"; tag="v$version"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
git fetch -q --tags origin
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "$tag already exists, raise the version first." >&2; exit 1; fi
grep -q "^## $version" CHANGELOG.md || { echo "CHANGELOG.md has no section for $version." >&2; exit 1; }

npm test
node scripts/build.js --github "$repo"

if [ -n "${WEB_EXT_API_KEY:-}" ] && [ -n "${WEB_EXT_API_SECRET:-}" ]; then
  rm -rf dist/signed
  npx --yes web-ext@8 sign --channel unlisted --source-dir dist/firefox --artifacts-dir dist/signed
  cp dist/signed/*.xpi dist/release/apescope-firefox.xpi
  node scripts/firefox-updates.js "$repo" dist/release/apescope-firefox.xpi > dist/release/updates.json
else
  echo "No Firefox signing keys, the release gets the unsigned Firefox zip only."
fi

node -e "const v=process.argv[1],c=require('fs').readFileSync('CHANGELOG.md','utf8');const m=c.split(/^## /m).find(s=>s.startsWith(v));process.stdout.write(m?m.split('\n').slice(1).join('\n').trim()+'\n':'')" "$version" > dist/release-notes.md
git tag -a "$tag" -m "ApeScope $version"
git push -q origin "$tag"
gh release create "$tag" dist/release/* --repo "$repo" --title "ApeScope $version" --notes-file dist/release-notes.md
echo "Released $tag: https://github.com/$repo/releases/tag/$tag"
