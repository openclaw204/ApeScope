# Building ApeScope from source

Step-by-step instructions to build an exact copy of the extension packages (for add-on reviewers and anyone who wants to verify a release).

## Requirements

- **Operating system:** Linux or macOS (any current version). Tested on Ubuntu 24.04 LTS and macOS 15. On Windows use WSL.
- **Node.js 18 or newer.** Tested with Node.js 22.23. Install from https://nodejs.org/ or on Ubuntu with `sudo apt install nodejs`.
- **zip** (Info-ZIP 3.0, preinstalled on macOS; on Ubuntu: `sudo apt install zip`).
- **No npm packages.** ApeScope has no dependencies; `npm install` is not needed.

## Build

```bash
cd apescope-source        # the unpacked source folder
node scripts/build.js
```

The script runs entirely offline and does the following:

1. Checks that the version in `package.json` matches `src/apescope.js` and `src/bridge.js`.
2. Writes `dist/firefox/` and `dist/chrome/`:
   - `apescope.js` = `src/apescope.js` wrapped in one function (`globalThis.__apescopeRun = function () { … };`) with a one-line comment header. This wrapper is the only generated code.
   - `bridge.js`, `compat.js`, `background.js`, `options.html`, `options.js`, `LICENSE`, `NOTICE` and `icons/` are copied unchanged from `src/`, the repository root and `assets/brand/`.
   - `manifest.json` is generated from the `manifest()` function in `scripts/build.js`.
3. Zips each folder to `dist/apescope-firefox-v<version>.zip` and `dist/apescope-chrome-v<version>.zip`.

## Result

`dist/firefox/` contains exactly the files of the submitted Firefox package. To compare:

```bash
mkdir submitted && cd submitted && unzip ../apescope-firefox-v<version>.zip && cd ..
diff -r submitted dist/firefox      # no output = identical
```

`npm test` runs the test suite (also without dependencies).
