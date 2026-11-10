# Trying the app on your own iPhone

For when there is no Mac and no paid Apple account yet. Two routes, cheapest first. Neither replaces a real test on a Mac and
TestFlight: see [shells.md](shells.md) for what still needs one.

**Expo Go will not work.** It is the app most people remember for testing on a phone over Wi-Fi, but it only runs Expo's own
React Native bundles, and this app has custom Swift and Capacitor plugins. The other well-known one, Ionic DevApp, was retired
in 2020. Nothing currently loads an arbitrary native iOS app over Wi-Fi without a Mac.

## 1. Safari over Wi-Fi (free, about 5 minutes)

This shows the real site in the iPhone's real browser engine. It is the same WebKit the app uses, so it tests the CSS, the fonts
and the layout. It does not test the native parts: the tab bar, Keychain, camera sheet or push.

On the PC, from the repo root:

```bash
node tools/demo.mjs --lan
```

It prints an `on this Wi-Fi:` address. Windows may ask whether to allow Node through the firewall: allow it on **Private**
networks only. Open that address in Safari on the iPhone, on the same Wi-Fi, and log in with a demo account.

**`--lan` opens the demo to everyone on that network**, and the demo runs with test switches on. Use it at home, not on shared
or public Wi-Fi, and stop it with Ctrl+C when you're done.

The real risk, so you can judge it. The demo's accounts all share one published password, so anyone who can reach the address can
log in as any of them, including the moderator (`malten`). The test switches (`TEST_SIGNALS` and the pretend sign-up checks) are
on, so a request can claim its own address and network. The data is fake and nothing leaves the PC. Wrangler also has a Local
Explorer (raw SQL on the database, and the photo store), and its only guard is the `Host` header, which anyone on the network can
forge. `--lan` therefore starts the demo with `X_LOCAL_EXPLORER=false`, which turns the explorer off (checked on Wrangler 4.152.0:
with it off, `/cdn-cgi/explorer/` and its API answer with the site's own page; without it, they answer with the data). A
`--lan` demo starts without the cluster alerts that the seeding creates through the explorer; the three held sign-ups are
still there. Without `--lan` the demo listens on `127.0.0.1` only and keeps the explorer, which only your own PC can reach.

**Signing up will not work here.** The proof of work needs `crypto.subtle`, which browsers only offer on https or localhost, so the
sign-up page shows "the browser check failed". The seeded accounts can log in. That is a limit of testing over plain http, not a
bug in the site.

**Chat may not connect in Safari.** The site's CSP relies on `'self'` to allow the chat socket on a LAN address, and older WebKit
didn't match `ws:` against `'self'`. If chat stays on "reconnecting", that is why. It says nothing about the deployed site.

Checked on 2026-11-07 in Chromium, on a non-secure hostname mapped to loopback: the site loads, a seeded account logs in and chat
connects. The server accepts a LAN address as its host and still refuses a foreign origin. Not yet tried from a real iPhone.

## 2. Sideloading a test build (free, needs a separate Apple ID)

This runs the real app: the Swift shell, the native tab bar, the Keychain and the camera sheet. It has to be installed by a
sideloading tool, which signs it with a free Apple ID.

**Before you start:**

- **Use a separate Apple ID, never your main one.** These tools ask for the password. Sideloadly and AltStore say it only goes to
  Apple, but neither is audited. Make a new Apple ID with two-factor on and no payment card.
- **Check the tool still works.** Apple changed its sign-in rules in October 2026, and reports say that broke several of these
  tools. Look at the tool's own release notes first.
- We could not find Apple's own position on sideloading with a free account, so we can't say what risk it carries for that ID.

**Limits of a free account:** a build expires after 7 days, you get 3 apps at a time, and there is no push or universal links. The
first install needs a USB cable.

**Steps:**

1. Set the build's server address, then let CI build it (see below).
2. Download the `ourspace-ios-sideload-ipa` artifact from the Actions run on GitHub. It is kept for 7 days.
3. On the iPhone, turn on Developer Mode: Settings > Privacy & Security > Developer Mode.
4. Install it with the sideloading tool, using the separate Apple ID.
5. On the iPhone, trust the certificate: Settings > General > VPN & Device Management.
6. On the PC, run `node tools/demo.mjs --lan`, then open the app and allow Local Network when iOS asks.

**The server address is baked in when the app is built**, so it needs a rebuild if the PC's address changes. Set it as a repository
variable; while it is unset, the `ios-sideload` job does not run at all:

```bash
gh variable set IOS_SIDELOAD_ORIGIN --repo Maltenn/BlogWebsite --body http://192.168.1.189:8787
```

Use the address `--lan` prints. Once the site is deployed, point this at the real https address instead, and it no longer needs
the PC or `--lan`.

**How the build differs from a release.** It uses the Debug configuration, which is the only one that allows a dev server on the
local network, and it leaves the entitlements out because a free Apple ID refuses Push and Associated Domains. It cannot reach a
store: the release jobs build their own.

**Not yet proven:** no sideload build has been installed on a phone. Whether iOS allows a plain `http://` address from the app, and
whether the tool accepts this IPA, is what the first attempt will show.

## 3. After that

| You want | You need |
|---|---|
| Push, universal links, TestFlight | The paid Apple Developer Program |
| Xcode, the simulator, the layout checked properly | A Mac, or a rented cloud Mac |
