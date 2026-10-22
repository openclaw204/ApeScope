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

- Firefox Add-ons and the Chrome Web Store. Both review the extension; prepare short justifications for `<all_urls>` (project websites, domain registries, custom RPC) and for automating the ChatGPT tab.
- Listing: screenshots (`assets/screenshots/`), short description, privacy statement ("no data collected; contract addresses are sent to public APIs to look them up").
- Until then: the release zip (Chrome, Edge, Brave) and the signed `.xpi` (Firefox) on GitHub, see README → Signing.

## Smaller items

- ChatGPT: an "Import answer" button that reads the latest reply from the ChatGPT tab on demand.
- Optional light theme.
- Padre links for chains other than Solana once their URL format is confirmed.
- More launchpads for the creator fee check (Bags, letsbonk.fun).
