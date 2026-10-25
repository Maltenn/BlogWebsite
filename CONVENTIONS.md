# Conventions

Rules for changing this repo. Setup and architecture are in [README.md](README.md) and [docs/](docs/architecture.md).

## Route

- One line in the route table at the top of `src/index.js`: method, path, handler, and `OPEN`, `AUTH` or `ADMIN`.
- Handlers take the request context `c`, return `json()` and report errors with `fail()`. Name write handlers verbNoun (`postWall`, `addFriend`); read handlers may be plain nouns (`profile`, `feed`).
- Every new route gets an end-to-end test in `test/api.test.mjs`. (Five older routes have none yet: `POST /api/me/spotify/refresh`, `GET /api/users/:name/friends`, `GET /api/users/:name/statuses`, `POST /api/admin/content`, `GET /api/admin/log`.)

## Feature

- A feature is a folder, `src/<feature>/`. It imports only from `shared/` and `catalog/`.
- Cross-feature imports are allowed only from this list:
  - `accounts/oauth` → `music/spotify`
  - `profiles` → `music/spotify`
  - `accounts/auth` → `profiles` (`defaultProfile`, `isAvatar`, `DEFAULT_AVATAR`)
- `shared/` never imports a feature.
- A feature that switches on with secrets exposes `xReady(env)` (like `spotifyReady`, `mailReady`). Its secrets go in [docs/deploy.md](docs/deploy.md) and in the comment at the top of `wrangler.jsonc`.

## Page

- `public/js/pages/<page>.js` exports `renderX(root, arg)` and is registered in the `ROUTES` table in `public/app.js`.
- Code used by two or more pages goes in `public/js/widgets/`.
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
- Helpers live in `test/helpers/`.

## Invariants

- User text reaches the page only through `textContent`.
- Profile looks only accept values from `src/catalog/options.js`.

## Where roadmap items go

See [docs/roadmap.md](docs/roadmap.md) for the placement of each unbuilt feature.

- Spotify alternatives (paste a link, Last.fm): `src/music/` (`links.js`, `lastfm.js`).
- Changing screen names: `src/accounts/names.js`.
- Uploading pictures: `src/uploads/` (R2 binding, and `/media/*` in `run_worker_first`), with image reports in `src/safety/`.
- Real-time chat and presence: `src/live/` (a Durable Object that carries events and owns no data) and `public/js/core/live.js`, replacing polling.
- Email verification: `src/accounts/verify.js`.
- Terms of service: `public/legal/` (static) and `src/accounts/terms.js`.
- Invite codes: `src/accounts/invites.js`. Ban-evasion signals: `src/safety/`.
