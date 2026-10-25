# Not done yet (on purpose, or next)

Each item says where its code will go. Anything that needs storage also adds a numbered file in `migrations/`, and anything that switches on with secrets follows the rules in [CONVENTIONS.md](../CONVENTIONS.md).

- **Spotify for more than 5 people.** This needs Spotify's extended quota (see [deploy.md](deploy.md)), which is out of reach for a small site. Alternatives would be letting people paste a song or playlist link (no sign-in needed), or Last.fm (or Apple Music). They go in `src/music/`, next to `spotify.js`: `links.js` for pasted links, `lastfm.js` for Last.fm.
- **Changing screen names.** `src/accounts/names.js`.
- **Uploading pictures.** Only the presets for now. Hosting people's images needs R2 storage plus image scanning (Cloudflare's CSAM Scanning Tool) before it's safe to turn on. The code goes in `src/uploads/`, with an R2 binding in `wrangler.jsonc` and `/media/*` added to `run_worker_first` so the Worker serves the files. Reporting an image goes in `src/safety/`, with the other reports.
- **Real-time chat and presence.** Everything polls now (the inbox every few seconds, badges every 30s). The replacement is `src/live/`, a Durable Object that carries events and owns no data, plus `public/js/core/live.js` on the page, replacing the polling.
- **Email verification at sign-up.** Addresses are only used for password resets for now. Sending a confirmation link first would stop people signing up with someone else's address. `src/accounts/verify.js`.
- **Terms of service.** `/rules` has plain-language rules and a privacy summary. Have them read by someone qualified before opening sign-ups widely, especially since the site stores birthdays and allows 13-year-olds. The terms are static pages in `public/legal/` (add `/legal/` to `STATIC_PREFIXES` in the router), and the server's part goes in `src/accounts/terms.js`.
- **Ban evasion.** A banned person can't log in, but can make a new account. The per-IP sign-up limit slows that down, and invite codes would stop it. Invite codes go in `src/accounts/invites.js`; other signals for spotting a returning banned person go in `src/safety/`.
