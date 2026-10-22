# X search without a tab — how it works and what can go wrong

Status: **prototype, off by default** (Settings → Socials → *Search X without a tab — uses your X login*).
The X tab worker (`runX`) stays as it is and is used automatically when this path fails.

## How it works

The extension's background (service worker in Chrome, event page in Firefox) sends the same request that
x.com's web app sends when you search *Latest* for `"<CA>"`:

```
GET https://x.com/i/api/graphql/<queryId>/SearchTimeline?variables=…&features=…&fieldToggles=…
authorization:            Bearer <public bearer token of the x.com web app>
x-csrf-token:             <value of the ct0 cookie>
x-twitter-auth-type:      OAuth2Session
x-client-transaction-id:  <derived per request, see below>
credentials: include      (the browser adds the x.com session cookies itself)
```

Everything that changes with X's deploys is read from X's own public files and cached for 6 hours
(in `storage.session`, so a restarted service worker does not download it again):

| What | Where it comes from |
|---|---|
| `queryId`, feature switches, field toggles | main bundle `abs.twimg.com/responsive-web/client-web/main.<hash>.js`, linked from the app shell |
| Feature switch values | `featureSwitch.defaultConfig` in the app shell (unknown → `false`) |
| Transaction-id inputs | `twitter-site-verification` meta tag + the four `loading-x-anim-*` SVG frames in the app shell, key-byte indices in the `ondemand.s.<hash>a.js` chunk |

The app shell is `https://x.com/i/jf/`. Since early October 2026 the logged-out home page is a different app
that no longer links these files. These files are fetched **without** cookies.

`x-client-transaction-id` became mandatory for `SearchTimeline` in 2025 (without it X answers 404). The
generator is a port of the MIT-licensed [x-client-transaction-id](https://github.com/Lqm1/x-client-transaction-id)
(the same approach twitter-cli / Agent Reach use). It runs without a DOM (service workers have no `DOMParser`) and
uses `crypto.subtle` for SHA-256.

The results become exactly the events the tab worker stores (`aps:x:<chain>:<ca>`, `{source:'x', chain, ca,
timestamp, author:'@handle', text, url, id:'x:<id>'}`), so chart markers, the Socials list, alerts and the
ChatGPT prompt work unchanged. t.co links are expanded first, because the CA is often only inside a link.

## Pacing

- At most **one X call every 15 s** from the whole browser (all fomo tabs together); repeats within 25 s get the cached answer.
- Per token: newest page, one older page, then the newest page every 30 s (`options.xPollMs`, minimum 30 s).
- HTTP 429 or `x-rate-limit-remaining ≤ 1` → no calls until X's `x-rate-limit-reset`. The last search of a
  window is left to the user's own browsing.
- 404/400 → X's files are reloaded once (new deploy); still failing → fallback to the X tab for this token.
- 401/403 or no `ct0` cookie → "not logged in" → fallback to the X tab.

## Permissions

- New: `cookies` (Chrome and Firefox). It is needed only to read `ct0`, because the CSRF header must repeat
  its value and extensions cannot read it any other way. Chrome shows no extra install warning for it
  (host access is already granted via `<all_urls>`). Firefox doesn't prompt for it either.
- Host access to `x.com` already exists (`<all_urls>`). With host access, Chrome treats requests from the
  service worker as same-site, so the `SameSite=Lax` `ct0` cookie and the `auth_token` cookie are sent.

## What was verified and what was not

Verified:
- Unit and integration tests (`test/xsearch.test.js`, mocked x.com): file parsing, the transaction-id
  byte layout (checked independently with Node's SHA-256), request headers and URL, timeline parsing
  (visibility wrappers, modules, long posts, cursors), pacing, 404 reload, rate limit, login errors, panel events and the
  fallback to the tab.
- Against the **live** x.com files (18 Oct 2026): the shell, main bundle and ondemand chunk are found, and
  `SearchTimeline` (queryId `irezafrnzav4Ulf1vDkEBg`, 40 feature switches) and a transaction id are derived.

Not verified (needs a logged-in browser, so nobody's account was used):
- A real logged-in search. Guest requests from Node get 403 for every endpoint, so they say nothing.
- That the generated transaction id is accepted. The port follows the reference line by line, but it was not
  compared run-for-run with the reference library: running the downloaded library was not allowed here.
- **Firefox**: whether the background page sends x.com's cookies. Possible blockers are Total Cookie Protection,
  Enhanced Tracking Protection "strict" (X is on the social-tracker list), and container tabs, whose cookies
  live in another cookie store. If the cookies are not sent, X answers 401/403 and ApeScope falls back to the tab.
- **Chrome**: whether X rejects requests whose `Origin` is `chrome-extension://…`. If it does, the fix is a
  `declarativeNetRequest` rule that rewrites `Origin`/`Referer` to `https://x.com` for these calls (one more permission).

Test plan for the first real run (Chrome, logged in on x.com): switch on the setting, open a token on fomo.family,
then check Socials ("𝕏 search running (no tab)", "… searches left") and Settings → Developer → X worker.

## Risks

- **X's terms of service** forbid automated access outside the official API without permission. This is the
  user's own session, used at roughly the rate a person would search, but X can still treat it as automation.
  Possible consequences are captchas, a temporary lock or, rarely, a suspension. Recommendation: use an account
  you can afford to lose, as Agent Reach also recommends.
- **Rate limit:** about 50 `SearchTimeline` calls per 15 minutes per account, shared with your own X browsing.
  ApeScope uses at most about 30 per 15 minutes for one token (one call every 30 s) and fewer when X reports a low limit.
- **Fragility:** queryIds rotate with X's deploys (every few weeks; handled automatically). Changes to the
  transaction-id scheme, the app shell (happened in Oct 2026) or the response shape break this path until
  ApeScope is updated. The tab worker then takes over.
- **Privacy:** the `ct0` value never leaves the background and is sent only to x.com. The X session cookies are
  used only for `x.com/i/api/graphql/…/SearchTimeline`. All other requests stay cookie-free.
