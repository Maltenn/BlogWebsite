# Killer items

Borrowed from aviation. A checklist is not a list of everything that could go wrong — it is the
short list of things that have killed before, run mechanically on every build, never from memory.
Each item is a command or a tap sequence with one unambiguous outcome. "Looks fine" is not an
outcome.

Run the whole list before any build leaves the machine. One failure stops the build; you do not
get to judge whether it matters.

## Auth

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 1 | Session survives app restart | Force-quit, reopen | Still signed in, no flash of the login page |
| 2 | Session survives REINSTALL as a clean sign-in | Delete app, reinstall, open | Shows login, does not crash, does not show a stale feed |
| 3 | Token is NOT in localStorage | `document.cookie` + `localStorage` dumped from the WebView inspector | Both empty of anything session-shaped |
| 4 | Revoking a device from Settings kills it | Revoke on device A from device B | A gets 401 on its next request and returns to login |
| 5 | Google / Discord sign-in returns to the app | Tap, complete, return | Signed in; the provider page never saw the session token |
| 6 | Turnstile loads inside the WebView | Open sign-up | The widget renders and can be solved |

## Push and deep links

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 7 | Push arrives on a real device | Real APNs + FCM send | Notification shown |
| 8 | Tapping a notification opens the EXACT thread, warm | App backgrounded, tap | Lands on that post, not the feed |
| 9 | Same, COLD | Force-quit, tap | Lands on that post. This is the one that is always broken |
| 10 | A universal / app link cold-starts | Open an `https://<origin>/u/<name>/post/<id>` link from another app | Opens in the app on that post |
| 11 | Push is silent with no credentials | Secrets unset | No errors, no crash, no empty notifications |

## Store compliance

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 12 | Account deletion reachable in ≤3 taps | Count taps from launch | `DELETE /api/me` reachable. Apple 5.1.1(v) |
| 13 | Block and report reachable from any post and any profile | Tap through | Both work. Apple 1.2 for user-generated content |
| 14 | Age gate present | Sign up with a birthday under `MIN_AGE` (13) | Refused, and the rating declared matches |
| 15 | Not a bare webview | Inventory of native capability | Push, camera, share, haptics, deep links, offline shell all live. Apple 4.2 |

## Resilience

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 16 | Airplane mode | Toggle, navigate | Offline shell renders, a clear message, no white screen |
| 17 | Network drops mid-request | Throttle to offline during a post | Post fails visibly and is not silently lost |
| 18 | Chat WebSocket reconnects | Background 2 min, return | Reconnects, no duplicate messages |
| 19 | Memory holds with GIF avatars | 20 route transitions on a GIF-heavy profile | No monotonic growth; survives on a 2019 mid-range Android |
| 20 | Back button (Android) | Hardware back through 5 routes | Follows the SPA router, does not exit the app |

## The aesthetic

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 21 | Pixel parity | `npm run plates:check` against the app capture | ≤0.1% differing pixels on 100% of routes |
| 22 | The deviation register matches reality | Read `deviations.md` against the diff output | Every non-zero diff has a register row, and every row has a reason |
| 23 | Safe areas on a notched phone | Open on a device with a notch and a home bar | No content under either; the register says what inset was added |
| 23a | **The native tab bar, against the web one** | On a device: launch, screenshot the bar. Then open the same page in the phone's own browser at the same width, screenshot `.ms-tabs`, and compare the two crops | Identical: same height, same tab widths and x positions, same label and badge positions, same colours. `npm run tabbar:check` has already proved the SPEC describes the web bar at 0 pixels in both engines; this is the only check of whether Core Text / `Canvas.drawText` draw it the same way the web view does (deviations.md D3) |
| 23b | **The tab bar's dynamic set** | Signed out, then signed in, then as a moderator; then open Messages so a badge clears | The items change with the chrome, the pink counters match the web bar's, a 99+ badge is the right width, and the active tab is the white one. Flick the bar: it scrolls with the system's own physics and the active tab is brought into view |
| 23c | **The page under the native bar** | Scroll to the bottom of a long page; open a composer; rotate | Nothing is hidden behind the bar; `.ms-fab` and `.ms-resumebar` sit on top of it, not behind it; the keyboard covers it (iOS) or hides it (Android) and the composer is visible (deviations.md D22) |
| 24 | Keyboard does not cover the composer | Open the composer, focus the input | Composer visible above the keyboard |

## Honesty

| # | Item | Pass |
|---|---|---|
| 25 | Every "verified" claim names the instrument that verified it | No claim rests on a reading of the code alone |

## From the red team

Added after the adversarial pass (`redteam.md`). Each one exists because something was actually
broken, not because it sounded prudent. A fix without a checklist item is a fix that comes back.

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 26 | A forged sign-in link from another app does nothing | Fire `ourspace://auth?code=<anything>` at the app while no sign-in is pending | Ignored. No session change, no device registered. **R1(a): this overwrote the victim's session** |
| 27 | A co-installed app claiming `ourspace://` gains nothing usable | Register a second app for the scheme, complete a real sign-in, inspect what it receives | It receives at most a one-time code it cannot redeem without the verifier. **R1(b): this was full account takeover on Android** |
| 28 | No member-written text in any push payload | Send yourself a DM with a recognisable sentence; read the delivered payload | Sender and counts only. The sentence appears nowhere. Pinned by a test |
| 29 | A release build refuses placeholder values | Tag a release with `OURSPACE_ORIGIN` unset | Build **fails** and names the missing variable. **R3: this shipped an IPA pointing at `http://localhost:8787`** |
| 30 | WebView debugging is off in the shipped build | Read the synced platform config in the release artifact; try `chrome://inspect` on a release install | `webContentsDebuggingEnabled` false, nothing inspectable. Otherwise adb reads the session token and the Keychain argument is void |
| 31 | The iOS privacy manifest is in the App target | Inspect the archive | `PrivacyInfo.xcprivacy` present and accurate. **R4: ITMS-91053 rejects at upload, before any human sees it** |
| 32 | A session cannot slide forever | Use a device token repeatedly past the absolute cap | Refused; must sign in again. Sliding expiry alone made a stolen token valid indefinitely |
| 33 | A notification revoked before the drain is not pushed | Like a post, then have the author block you within the minute | No push arrives |
| 34 | The pixel harness gives the same answer under load | Run the full `plates:check` on an idle machine and again while the machine is deliberately busy | Identical results. A gate whose verdict depends on what else is running cannot gate anything |
| 35 | The plate baseline is actually fetched | Fresh clone, then `plates:check` without `git lfs pull` | Fails loudly as *missing LFS objects*, not as 464 corrupt plates |

## What the checklist still cannot see

Honest limits, so nobody reads a green list as more than it is:

- **`isApp` is false in every plate.** The app's own rendering path — D21's placeholder-then-blob
  photos, the iOS `maximum-scale=1` viewport, the safe-area bands — appears in **no** baseline. The
  pixel gate compares the website to the website. It cannot yet see the app at all.
- **Routes taller than the 4000 px cap** (`boards-thread`, `profile`, `ourspace`) are never compared
  below the fold.
- **`ourspace--in` is the least trustworthy plate**: Playwright's `context.route` does not intercept
  WebSockets, so a live socket really connects during capture and presence races the shot.
- **`join--out` hides the first screen a reviewer sees**: Turnstile is stubbed and the proof of work
  answers instantly, so the real Cloudflare widget is in no plate.
- **`join--out` does not show what a reviewer sees either.** The app adds a camera button to that card
  (`D24`), and `native.js` does not run in a plate, so the sign-up screen in the baseline is the
  website's, not the app's.
- **The native tab bar is in no plate at all**, by construction: it is drawn outside the web view.
  `npm run tabbar:check` covers the half of it that can be covered without a phone — that the spec
  the shells draw from describes the web bar exactly, 0 pixels, both engines — and items 23a-23c are
  the half that cannot.
- **Nothing in this file has run on a physical device**, because there is no Mac and no Android SDK
  here. Items 7-11, 16-20, 23, 23a-23c, 24, 26, 27, 30 and 31 are written but unexecuted.

## One more, added 2026-11-05

| # | Item | How it is checked | Pass |
|---|---|---|---|
| 36 | The pixel gate does not expire by itself | Run `plates:check` against a baseline more than a few days old | Passes. It failed 48/464 on day 5 once, from two server-clock dependencies the browser freeze could not reach (`docs/mobile/harness.md`). A gate that reddens on its own trains people to re-baseline, which hides the next real regression |
