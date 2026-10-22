# Store listing texts

Texts and answers for the Chrome Web Store and Firefox Add-ons (addons.mozilla.org). Images: `assets/store/`.

## Name

ApeScope

## Summary (Chrome max. 132, Firefox max. 250 characters)

Memecoin due diligence next to the fomo chart: risk checks, holder analysis, look-alike tokens and one-click ChatGPT analysis.

## Description

ApeScope sits next to the chart on fomo.family and shows you what matters before you buy a memecoin. The page moves aside, nothing gets covered.

ApeScope currently works on fomo.family token pages only.

WHAT YOU GET
• Risk checks sorted into red flags, warnings and good signs: liquidity against market cap, bump bots, contract flags, LP lock, sell simulation, rug report, organic trading score.
• Real holders: top 10 without pools and bonding curves, bundlers, insiders, snipers, fresh wallets and wallets funded by the same source.
• Developer history: tokens launched and migrated, whether the dev sold, who funded the wallet, renamed X accounts, reused logos.
• Callers: fomo theses and pump.fun callouts with the biggest callers by followers, the market cap they called at and their best multiple.
• Project check: the contract address is searched on the website and on GitHub; a different address is a red flag.
• Creator fees: who receives them, how much came in and how often it was claimed, read from the blockchain.
• Copycat detection across chains, sorted by market cap, with the likely original marked.
• Live data every few seconds: market cap, liquidity, buy and sell pressure, holder growth, activity from X, pump.fun and fomo.
• ChatGPT: a full due diligence prompt or a trade setup with entries, stop and take profit levels, sent to your own ChatGPT tab.
• Watchlist with alerts, chart markers for X posts and pump.fun calls.

PRIVACY
No account, no ApeScope server, no tracking. ApeScope never connects to your wallet and never trades. Public data services only see the contract address you look up.

Open source (MIT): https://github.com/openclaw204/ApeScope

Not financial advice. The checks are signals, not guarantees.

## Links

- Homepage / support: https://github.com/openclaw204/ApeScope
- Support (issues): https://github.com/openclaw204/ApeScope/issues
- Privacy policy: https://github.com/openclaw204/ApeScope/blob/main/PRIVACY.md
- License: MIT

## Category

- Chrome: Productivity → Tools (or Tools)
- Firefox: Search Tools, plus Other

## Chrome: single purpose

ApeScope helps users evaluate a memecoin while they view it on fomo.family by showing risk checks, holder, developer and social data for that token in a sidebar next to the chart.

## Chrome: permission justifications

- **storage, unlimitedStorage:** settings, watchlist and cached token data are kept on the user's device; cached market and holder data for many tokens can exceed the default quota.
- **downloads:** used only when the user drops a new release file into Settings → Updates; the files of an unpacked install are written into its own folder in Downloads.
- **cookies:** reads only the x.com `ct0` cookie, and only when the user switches on "Search X without a tab", to send the x.com search with the user's own session.
- **scripting:** used only when the user clicks "Check the CA in a browser tab" to read the visible text of a project's website and look for the contract address.
- **Host permission `<all_urls>`:** ApeScope requests data from many public APIs (DexScreener, GoPlus, Jupiter, GeckoTerminal, pump.fun, RugCheck, Honeypot.is, Solana RPC, GitHub, FxTwitter, RDAP), checks project websites that can be on any domain for the contract address, and supports a user-defined Solana RPC URL. Content scripts only run on fomo.family, pump.fun, x.com, gmgn.ai and chatgpt.com.
- **Remote code:** No. All code is in the package; nothing is downloaded and executed.

## Chrome: data usage (privacy practices)

- Collected data types: none of the listed categories are collected by the developer.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.

## Firefox: notes to the reviewer

ApeScope is plain, readable JavaScript (no bundler, no minification). apescope.js is src/apescope.js wrapped in one function; the source is https://github.com/openclaw204/ApeScope (`npm run build` builds the package).

- On chatgpt.com the content script fills the prompt into the user's own ChatGPT tab and sends it only after the user clicked "Analyze with ChatGPT".
- On gmgn.ai and (opt-in) x.com, requests use the user's existing session to read data for the token the user is viewing.
- Project websites are fetched without cookies and only parsed as text; nothing from them is executed.
- No data is sent to the developer; there is no ApeScope server.

Test: open any token page on https://fomo.family/ (for example https://fomo.family/tokens/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263); the sidebar opens on the right.
