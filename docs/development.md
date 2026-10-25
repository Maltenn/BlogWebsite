# Development

You need [Node.js](https://nodejs.org) 22 or newer and [git](https://git-scm.com). There is no build step: what's in `public/` and `src/` is what runs.

## Run it locally

```bash
npm install
npm run db:local       # create the tables in wrangler's local database (once)
npm run dev            # http://127.0.0.1:8787
npm test               # all tests (they start their own Worker on a fresh database, plus the stand-in providers)
npm run demo           # the whole site with sample people and posts (see below)
```

Locally you don't need any secrets to sign up with email. **Forgot my password** prints the reset link in the `npm run dev` terminal instead of sending an email. Secrets for trying real provider keys locally go in `.dev.vars`, which is git-ignored. Apple only accepts https addresses, so it can't be tried on `127.0.0.1`.

To start `npm run dev` over with an empty database, delete `.wrangler/state` and run `npm run db:local` again. (`rm -rf .wrangler/state` in a Unix shell, `Remove-Item -Recurse -Force .wrangler/state` in PowerShell.) The tests and the demo have their own databases and never touch it.

## How the demo works

`npm run demo` runs `tools/demo.mjs`, which:

1. applies the migrations to a local database in `.demo/state`;
2. starts the stand-in providers from `test/helpers/mock-providers.mjs` in "pretend" mode, where "Continue with Google" and "connect Spotify" show a labeled page that asks for a name instead of approving at once;
3. starts `wrangler dev` with `TEST_PROVIDER_BASE` pointing at the stand-ins, made-up client IDs for every provider (so every sign-in button appears), and a `TOKEN_KEY` it generates once and keeps in `.demo/token-key`;
4. on the first run, fills the site with sample people, friendships, posts, messages and one report by calling the real API, then makes `malten` a moderator. It writes `.demo/seeded` when it's done;
5. prints password-reset emails in its own window.

The sample people are the `PEOPLE` list in `tools/demo.mjs`; change them there and start over with `npm run demo -- --fresh`. Set the `PORT` environment variable to start the search for a free port somewhere other than 8787.

### TEST_PROVIDER_BASE

`TEST_PROVIDER_BASE` makes the Worker send every sign-in and Spotify request to the server it names instead of to Google, Apple, Spotify and the rest. The tests and the demo use it. **Never set it on a real deployment.** It sends every sign-in to whatever server it names. It is not in `wrangler.jsonc`, and `wrangler secret put` should never be used for it.

## Migrations locally

- `npm run db:local` applies every file in `migrations/` that hasn't been applied to the local database. Run it again after adding a file.
- `npm run db:remote` does the same on the real database (see [deploy.md](deploy.md)).
- Files are `migrations/NNNN_snake_case.sql`, in sequence. Never edit one that has been applied, anywhere: add a new file instead. The rest of the rules are in [CONVENTIONS.md](../CONVENTIONS.md).
- A table with an `expires` column needs a line in the cron in `src/index.js`.

## Windows

The tests and the demo run wrangler through node (`node_modules/wrangler/bin/wrangler.js`), because `node_modules/.bin/wrangler` is a shell script that Windows can't spawn. So `npm test` and `npm run demo` work in PowerShell, cmd and Git Bash alike. A few things to know:

- When a test run ends, it stops wrangler's whole process tree (`taskkill`), because workerd would otherwise keep holding the database files. Windows lets go of them a moment later, so the temp folder is removed with a few retries.
- The deploy commands use `openssl rand` to make secrets. Run those in Git Bash, which includes it.

## Add a blog post

The blog under `public/blog/` is plain static HTML, maintained by hand.

1. Copy one of the existing posts, for example `public/blog/why-do-i-create.html`, to `public/blog/<short-name>.html`.
2. Keep the chrome: the `<head>` (the stylesheet link and icon), the `os-top` header with the tabs, the `article.post` structure with `post-head`, `post-body` and `post-foot`, and the `os-foot` footer. Change the title, description, post number and date, and the text.
3. List it in `public/blog/index.html`: add a `.blog-preview` block at the top (the list is newest first) linking to `/blog/<short-name>`, with the post number, the date and a one-line description.
4. Any image the post uses must be in `public/assets/` and have a line in [public/assets/CREDITS.md](../public/assets/CREDITS.md). `npm test` fails otherwise.

Link to a post as `/blog/<short-name>` (no `.html`). The in-app router leaves `/blog/` to the server, so these pages load as normal pages.
