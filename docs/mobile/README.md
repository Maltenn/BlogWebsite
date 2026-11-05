# The mobile apps

iOS and Android, built around the existing `public/` bundle so the aesthetic is identical by
construction. The reasoning is in [decision 007](../decisions/007-mobile-apps.md).

| Document | What it is for |
|---|---|
| [contract.md](contract.md) | **Authoritative.** The one agreement the server and both shells are built against. Changed here first, then in code |
| [server.md](server.md) | What the Worker gained: bearer sessions, CORS, devices, push |
| [shells.md](shells.md) | Building and running each app, and what needs a Mac |
| [harness.md](harness.md) | The reference plates and the pixel-diff gate, and `tabbar:check` — the smaller harness that holds the native tab bar's spec to the web bar at **0** pixels |
| [deviations.md](deviations.md) | Every forced departure from the web CSS, with its reason. An empty register is a claim the diff has to back up |
| [checklist.md](checklist.md) | Killer items, run on every build, never from memory — and what a green list still cannot see |
| [redteam.md](redteam.md) | The adversarial pass. Findings ranked, each marked CONFIRMED or PLAUSIBLE |
| [store.md](store.md) | App Store and Play requirements, and what is still blocked on credentials |
| [review-notes.md](review-notes.md) | What goes in App Review Information → Notes: the demo account, and the native behaviour with the taps to reach it |

## The one thing to understand

The apps do not reimplement the site. They ship it. Same `app.css`, same 23 page modules, same 39
widgets, unmodified. Everything awkward in the contract — tokens instead of cookies, CORS, a
WebSocket subprotocol, OAuth in a system browser — exists because a locally-bundled page is
cross-origin to the Worker, and that one fact is the price of never re-deriving the aesthetic.
