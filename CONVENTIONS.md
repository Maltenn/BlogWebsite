# Conventions

Rules for changing this repo. Setup and architecture are in [README.md](README.md) and [docs/](docs/architecture.md).

## Route

- One line in the route table at the top of `src/index.js`: method, path, handler, and `OPEN`, `AUTH` or `ADMIN`.
- Handlers take the request context `c`, return `json()` and report errors with `fail()`. Name write handlers verbNoun (`postComment`, `followUser`); read handlers may be plain nouns (`profile`, `feed`).
- A member's write (`AUTH`, not `GET`) passes the gate (`src/shared/gate.js`: email confirmed, not held; `gate: 'post'` adds no posting timeout) unless the table marks it `free` with the reason. Public posting and commenting routes are `gate: 'post'`. `test/api.test.mjs` tries every gated route.
- Every new route gets an end-to-end test in `test/api.test.mjs`. (Three older routes have none yet: `POST /api/me/spotify/refresh`, `POST /api/admin/content`, `GET /api/admin/log`.)

## Feature

- A feature is a folder, `src/<feature>/`. It imports only from `shared/` and `catalog/`.
- Cross-feature imports are allowed only from this list:
  - `accounts/oauth` → `music/spotify`
  - `profiles` → `music/spotify`
  - `accounts/auth` → `profiles` (`defaultProfile`, `isAvatar`, `DEFAULT_AVATAR`)
  - `boards/boards` → `social/items` (the item, `hydrate`, `writePost`: board threads and comments are posts)
  - `browse/browse` → `social/items` (the item and `hydrate`: discovery shows posts and threads as every list does)
  - `accounts/auth`, `accounts/oauth` → `trust/signup` (`screenSignup`, `recordSignup`: every sign-up passes the human checks), and `accounts/auth` → `trust/turnstile` (`checkTurnstile` on log in and password reset)
  - `social/items` → `trust/duplicates` (`screenPost`, `fingerprintStatement`, `holdCopies`) and `ai/scan` (`scanLater`): `writePost` is the one door every public post goes through
  - `chats/chats` → `push/push` (`pushReady`, `pushChat`): a chat message is pushed to the phones straight from `sendChatMessage`, a minute is too slow for the outbox
- `shared/` never imports a feature.
- A feature that switches on with secrets exposes `xReady(env)` (like `spotifyReady`, `mailReady`). Its secrets go in [docs/deploy.md](docs/deploy.md) and in the comment at the top of `wrangler.jsonc`.

## Page

- `public/js/pages/<page>.js` exports `renderX(root, arg)` and is registered in the `ROUTES` table in `public/app.js`.
- Code used by two or more pages, or a self-contained piece of one page big enough for its own file, goes in `public/js/widgets/` (pages stay thin).
- `public/js/core/` imports nothing above it.
- A new static folder under `public/` must be added to the router's `STATIC_PREFIXES`.

## Migration

- `migrations/NNNN_snake_case.sql`, in sequence.
- Never edit one that has been applied.
- A table with an `expires` column gets a line in the cron in `src/index.js`.

## Asset

- `public/assets/<prefix>_name.ext` (or `avatars/`, `tiles/`), referenced from `src/catalog/` or the pages, with a line in [public/assets/CREDITS.md](public/assets/CREDITS.md) (served at `/assets/CREDITS.md`, linked from every page footer, because CC BY images need reachable attribution). `test/static.test.mjs` fails otherwise.
- A new external origin needs `public/_headers` (the CSP) and [docs/security.md](docs/security.md) updated.

## Tests

- `npm test` runs `test/*.test.mjs`.
- A migration that changes existing rows gets a case in `test/migrations.test.mjs`: build the database as the earlier files left it, apply the new one, check the result.
- Helpers live in `test/helpers/`.

## Invariants

- User text reaches the page only through `textContent`.
- Profile looks only accept values from `src/catalog/options.js`.

## Where roadmap items go

See [docs/roadmap.md](docs/roadmap.md) for the placement of each unbuilt feature.

- Spotify alternatives (paste a link, Last.fm): `src/music/` (`links.js`, `lastfm.js`).
- Changing screen names: `src/accounts/names.js`.
- Photos (built): `src/media/` (uploads, `/media/*`, the byte-level sniffer and stripper), with what the other features share in `src/shared/media.js`. A new kind of post that carries photos gets a line in `MEDIA_LIMITS` there and passes `media` to `writePost`; anything that deletes posts or `media` rows deletes their files with `dropObjects`, and leaves photos held as evidence (hidden by a moderator, or on a post a moderator hid) to a moderator's remove (`releaseMedia`).
- Real-time chat and presence (built, phase 5): `src/live/room.js` (the Durable Object `Room`, which carries events and owns no data), `src/chats/` (#ourspace, group chats, DMs: the data and the routes), and what other features need from them in `src/shared/` (`live.js` to reach a room, `chat.js` for the chat SQL, `affinity.js` for the interaction score that every interaction writes); on the page, `public/js/core/live.js`, replacing polling. A new kind of live event gets its line in the comment at the top of `src/live/room.js`.
- Email verification (built): `src/accounts/verify.js`. Verifying humans (built, phase 7): `src/trust/` (the sign-up checks, the risk score, duplicates, clusters, the moderators' queues), and the write gate in `src/shared/gate.js`. AI-writing detection and strikes (built): `src/ai/`; a new detector is a provider in `src/ai/detect.js` and must pass `tools/eval-detector.mjs` before enforcement.
- Terms of service: `public/legal/` (static) and `src/accounts/terms.js`.
- Invite codes: `src/accounts/invites.js`. Ban-evasion signals: `src/safety/`.
- Unread threads on the boards (`thread_reads`): `src/boards/reads.js`.
- The mobile apps (built): their way in (bearer tokens in `currentUser`, `session` in the sign-in answers, CORS for the three app origins, the chat socket's one-room ticket, which the subprotocol carries instead of the session token) is `src/shared/app.js` with `src/accounts/auth.js` and `src/shared/live.js`; their devices and push notifications are `src/push/` (`devices.js` the routes, `push.js` the outbox cron and direct chat push, `apns.js`/`fcm.js` the services). Everything about it is in [docs/mobile/server.md](docs/mobile/server.md), built to [docs/mobile/contract.md](docs/mobile/contract.md).
