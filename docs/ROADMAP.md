# Roadmap

ApeScope is made for fomo.family. Everything below depends on feedback and on how much ApeScope is used.

## Native side panel (Chrome) and sidebar (Firefox)

The extension injects the sidebar into fomo.family and moves the page aside. A native browser side panel is cleaner: the browser itself makes the page narrower, so no site can be cut off.

- Chrome: `chrome.sidePanel` (Chrome 114+), Firefox: `sidebar_action`.
- The panel UI moves into an extension page; the content script on fomo keeps detection (URL, CA on the page) and the chart bridge and talks to the panel via `runtime` messaging.
- Keep the in-page sidebar as a fallback.

## More trading sites

The checks themselves do not depend on fomo. Detecting the token from the page and drawing chart markers does, so every new site needs its own detection and chart bridge. Candidates: GMGN, Axiom, Padre, DexScreener, pump.fun token pages.

## Store listings

- Submitted to the Chrome Web Store and Firefox Add-ons, in review. When they are live, the README buttons link to the store pages.
- Development builds stay available as zips in the GitHub releases.

## Smaller items

- ChatGPT: an "Import answer" button that reads the latest reply from the ChatGPT tab on demand.
- Optional light theme.
- Padre links for chains other than Solana once their URL format is confirmed.
- More launchpads for the creator fee check (Bags, letsbonk.fun).
