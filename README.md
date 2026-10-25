# OurSpace

A social network for real people, in the spirit of early-2000s MySpace: decorated pages, a Top 8, a wall, bulletins and private messages, and no bots. One Cloudflare Worker serves the pages and the API, and the data lives in one D1 database. This repo used to hold a Windows 98 desktop site as well; see [docs/history.md](docs/history.md).

- **Real people only.** There are no bot accounts, and nothing posts on anyone's behalf. Requests and Inbox only ever hold things from people.
- **Sign up with an email and a password** (the default tab), or under **Other options** with Google, Apple, Microsoft, Discord or GitHub. Every way in asks for a screen name and a **birthday**.
- **Birthdays keep it 13+** and give everyone their **star sign**. The birthday itself stays private. People choose whether their page shows their age and their sign.
- **Public profiles** at `/u/<name>` that anyone can view, with statuses, wall comments, bulletins, blog entries, friend requests, Top 8, private messages and a shared feed.
- **Everyone can connect their own Spotify.** Their page then shows their top songs, with previews (see the Spotify limit in [docs/deploy.md](docs/deploy.md) before relying on it).
- **Daily horoscopes, written from the real sky.** There's a reading of today's sky for everybody, a horoscope for each sign, and a personal reading for each member that also compares today's planets with the sky on the day they were born.
- **Pages are decorated** with the Edit My Page choices: 231 preset pictures, 10 color themes, 14 background tiles (or a plain color), fonts, decor gifs and 88x31 buttons.
- **Block and Report** sit on every profile, post, comment and message. Admins get a moderation queue.
- **malten's essays** are published verbatim under `/blog/`.
- **Forgot my password** sends a one-hour reset link by email.

## Try it on your computer (the demo)

One command starts the whole site on your own computer, already filled with sample people, posts, friend requests and messages. Nothing in it is real or online.

You need [Node.js](https://nodejs.org) 22 or newer and [git](https://git-scm.com). Then, in a terminal:

```bash
git clone https://github.com/Maltenn/BlogWebsite.git      # (skip if you already have it; then run git fetch origin)
cd BlogWebsite
git checkout claude/intelligent-fermat-keh09f             # until this branch is merged into main
npm install
npm run demo
```

When it says **ourspace demo is running**, open **http://127.0.0.1:8787** in your browser.

| Log in as | Email | Password | Who |
|---|---|---|---|
| you | `you@example.com` | `ourspace-demo` | `the_reviewer`, a regular member with friend requests and messages waiting |
| the moderator | `malten@example.com` | `ourspace-demo` | `malten`, sees the **Moderation** tab with a sample report |
| anyone else | `kat@`, `jules@`, `drew@`, `pete@`, `mia@` or `banana@example.com` | `ourspace-demo` | the sample members, to see the site from their side |

How the demo differs from the real site:

- **Sign-in and Spotify go to pretend pages.** "Continue with Google" (or Apple, Microsoft, Discord, GitHub) and "connect Spotify" open a page labeled *local demo: not the real Google*. Type any name to continue; the same name brings back the same pretend account. Cancel works too. On Spotify's pretend page you can tick a box to see what people outside the 5-person allowlist are told.
- **Pretend Spotify has no album covers** (grey squares). The 30-second previews are real ones from Apple when your computer can reach the iTunes Search API.
- **"Forgot my password" emails** appear in the terminal window running the demo. Copy the link from there.
- **Your changes stick** between runs: the data lives in `.demo/`. `npm run demo -- --fresh` starts over with just the sample content.
- **Editing works live.** Change a file in `public/` or `src/` and refresh the browser.

Stop it with **Ctrl+C**. If port 8787 is already taken, it picks the next free one and prints the address.

## Tests

```bash
npm test      # all of test/*.test.mjs
```

The API tests start their own Worker on a fresh throwaway database, plus stand-ins for every sign-in provider, Spotify and iTunes. The astronomy tests check the horoscope numbers against known ephemeris dates. A static test fails if an image is missing, unreferenced or uncredited, or if an import doesn't resolve. No secrets or setup are needed.

## Docs

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it works, the file map, the life of a request, the front-end modules, how horoscopes are computed |
| [docs/development.md](docs/development.md) | Running locally, how the demo works, migrations, Windows notes, adding a blog post |
| [docs/deploy.md](docs/deploy.md) | First deploy, email, sign-in providers, Spotify, custom domain, vars and secrets, **cutover from the desktop site** |
| [docs/operations.md](docs/operations.md) | Making a moderator, logs, finding an account, backups, rotating keys, rate limits |
| [docs/security.md](docs/security.md) | What's protected, and how accounts and providers fit together |
| [docs/roadmap.md](docs/roadmap.md) | What isn't done yet, and where each piece of code will go |
| [docs/history.md](docs/history.md) | The desktop site this repo began as, and how to recover it |
| [public/assets/CREDITS.md](public/assets/CREDITS.md) | Where every image comes from (served at `/assets/CREDITS.md`) |
| [CONVENTIONS.md](CONVENTIONS.md) | The rules for adding a route, feature, page, migration or asset |
