# Privacy policy

ApeScope is a browser extension that shows information about memecoins next to the chart on fomo.family. It is open source; every request it makes can be read in this repository.

## What ApeScope does not do

- It has no account and no server of its own. Nothing is sent to the ApeScope developers.
- It does not collect, sell or share personal data, browsing history, analytics or usage statistics.
- It never connects to a crypto wallet, never asks for approvals or signatures and never trades.
- It does not read or store passwords, seed phrases or payment data.

## Data that leaves your browser

To show information about the token you are looking at, ApeScope sends the token's contract address (and, for some lookups, addresses of its holders, its developer or its liquidity pool) to public data services: DexScreener, GoPlus, Honeypot.is, RugCheck, Jupiter, GeckoTerminal, pump.fun, a public Solana RPC (or the RPC you enter), GitHub, FxTwitter and RDAP. Website addresses found in the token's metadata are opened without cookies to look for the contract address, but only after you allow website checks (*Allow website checks* in the Project tab or on the extension's options page); you can remove that access there at any time.

These requests are made without your cookies, with two exceptions that only read data for you in sites where you are already logged in:

- **gmgn.ai:** holder statistics are requested with your browser's gmgn.ai session (needed to pass gmgn.ai's security check).
- **x.com:** only if you switch on *Search X without a tab* in the settings, the search for the contract address runs with your x.com session.

On fomo.family, x.com, pump.fun, gmgn.ai and chatgpt.com, ApeScope reads data in your own tabs (for example theses, posts and callouts about the token) and, only after you click *Analyze with ChatGPT*, puts the prepared prompt into your ChatGPT tab.

## Data stored on your device

Settings, the watchlist and cached lookups are stored in your browser's extension storage on your device only. Uninstalling the extension removes them.

## Contact

Questions and reports: open an issue at https://github.com/openclaw204/ApeScope/issues
