#!/usr/bin/env bash
# Publishes the version in package.json as a GitHub release of this repository:
# tests, build (update check pointing at this repository), tag, release with apescope-chrome.zip and apescope-firefox.zip.
#
#   scripts/release.sh
#
# The release files are for manual installs and development. Store packages (Chrome Web Store, Firefox Add-ons) are
# built with a plain `node scripts/build.js` and uploaded to the stores separately.
# The release is created by the GitHub account the gh CLI uses (GH_TOKEN, if set).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git diff --quiet && git diff --cached --quiet || { echo "Commit your changes first." >&2; exit 1; }
version="$(node -p "require('./package.json').version")"; tag="v$version"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
git fetch -q --tags origin
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "$tag already exists, raise the version first." >&2; exit 1; fi
grep -q "^## $version" CHANGELOG.md || { echo "CHANGELOG.md has no section for $version." >&2; exit 1; }

npm test
node scripts/build.js --github "$repo"

node -e "const v=process.argv[1],c=require('fs').readFileSync('CHANGELOG.md','utf8');const m=c.split(/^## /m).find(s=>s.startsWith(v));process.stdout.write(m?m.split('\n').slice(1).join('\n').trim()+'\n':'')" "$version" > dist/release-notes.md
git tag -a "$tag" -m "ApeScope $version"
git push -q origin "$tag"
gh release create "$tag" dist/release/* --repo "$repo" --title "ApeScope $version" --notes-file dist/release-notes.md
echo "Released $tag: https://github.com/$repo/releases/tag/$tag"
