# OurSpace

A social network for real people, in the spirit of early-2000s MySpace: decorated pages, a Top 8, Friends' Comments, topic boards, photos, live chat, and no bots. One Cloudflare Worker serves the pages and the API, the data lives in one D1 database, the photos in one R2 bucket, and live chat runs through Durable Objects. This repo used to hold a Windows 98 desktop site as well; see [docs/history.md](docs/history.md).

- **Real people only.** There are no bot accounts, and nothing posts on anyone's behalf. Requests and Messages only ever hold things from people.
- **Verifying humans.** Sign-up, log in and password resets show Cloudflare's "verify you are human" check; every sign-up does a second or two of proof of work in the browser and fills in a form with a hidden trap for bots; throwaway email addresses are refused and every new account confirms its email before it can post, comment, message or follow. Sign-ups that look like bots wait for a moderator; accounts that came together, and the same text pushed by several new accounts, raise alerts for the moderators. Nothing bans anybody automatically.
- **AI-written posts** can be scored by a detector (off until the owner picks one and it passes the evaluation in `tools/eval-detector.mjs`); in enforce mode the strikes go warning, a day, a week, a month without posting, then a moderator, each appealable and gone after 90 clean days.
- **Sign up with an email and a password** (the default tab), or under **Other options** with Google, Apple, Microsoft, Discord or GitHub. Every way in asks for a screen name and a **birthday**.
- **Birthdays keep it 13+** and give everyone their **star sign**. The birthday itself stays private. People choose whether their page shows their age and their sign.
- **Profiles** at `/u/<name>` that anyone can view, with statuses (up to 500 characters), a blog (titles, subtitles, a page for each post), Friends' Comments, a Top 8, Spotify and private messages.
- **Follow people.** Following is one-way; two people who follow each other are **friends**, and only friends write in each other's Friends' Comments. Profiles are open by default, or **private**: then new followers need approving, and only followers see the statuses, blog and comments.
- **A feed** of statuses, blog posts, quotes and reposts from the people you follow, newest first, or **pick up where you left off**: oldest unseen first, remembering how far you read. Logged out, it shows the latest from every open profile. Board threads stay on their boards.
- **Replies, likes, reposts, quotes and bookmarks** on statuses and blog posts, the way Twitter does them (likes only, no dislikes). Every post opens as a conversation; a deleted post with replies stays as "this post was deleted" so the conversation keeps its shape. Posts from private profiles can be liked by their followers but not reposted or quoted. Bookmarks are private.
- **Boards**, like a forum: Music, Movies & TV, Games, Art & Layouts, Cooking, Pets, Sports, Tech & Computers, Fashion, Books & Writing, Astrology, School, Advice and Random (where the old bulletins went). Scroll a board's threads by Hot, New, Top or Best, open one to read the whole post and its comments, nested as deep as people reply. Every thread and comment takes a like and a dislike, and both counts show. Moderators pin and lock threads and add boards; members can ask for new ones. Boards are public: a private profile's threads and comments are seen by everyone there.
- **Photos** on statuses, replies, quotes and board threads (up to 4), board comments (1) and blog posts (a cover), and **your own profile picture** instead of a preset. The browser shrinks each photo, and the server checks it is really a JPEG, PNG, GIF or WebP and takes out its location and other metadata before storing it. A private profile's photos are only for its followers. No video.
- **@mentions and #tags.** `@name` in a post, a thread, a comment or a Friends' Comment links to that person (and tells them, if they may see the post); every `#tag` has a page of its posts.
- **Live chat.** **#ourspace** is one room every member can talk in, like a Discord channel (the last 500 messages or 24 hours, slow mode, moderators delete and mute). **DMs** between two people (who respect each other's "friends only" setting and blocks) and **group chats** of up to 50: friends join at once, anybody else gets an invite to accept, and the suggestions put the friends you talk to most first. Messages, "is typing…" and who's online arrive live over WebSockets; a page that can't keep its socket polls instead.
- **Browse, with a very small algorithm.** **For you** shows recent posts and threads from people you don't follow and boards you don't post in, a little ahead when people you follow replied, your friends follow the writer, or the board matches your interests. **Mutuals** lists friends of your friends with who you have in common ("Friends with kat, pete and 2 others"), **Boards for you** reads the interests on your page ("Because you listed \"my chemical romance\" under Music"), and the feed's sidebar has **Who to follow**. Every suggestion says why it's there, any of them can be hidden with "not interested", and nothing about what you look at, how long or how far you scroll is recorded. The feed itself stays newest first.
- **Notifications** for likes, replies (on the boards too), reposts, quotes, mentions, Friends' Comments on your page, follows, answers to board requests, group chat invites and mentions in #ourspace, in the app only (no email, no push), with an unread count.
- **Everyone can connect their own Spotify.** Their page then shows their top songs, with previews (see the Spotify limit in [docs/deploy.md](docs/deploy.md) before relying on it).
- **Daily horoscopes, written from the real sky.** There's a reading of today's sky for everybody, a horoscope for each sign, and a personal reading for each member that also compares today's planets with the sky on the day they were born.
- **Pages are decorated** with the Edit My Page choices: 231 preset pictures, 10 color themes, 14 background tiles (or a plain color), fonts, decor gifs and 88x31 buttons.
- **Block and Report** sit on every profile, post, comment and message. Admins get a moderation queue.
- **malten's essays** are published verbatim under `/blog/`.
- **Forgot my password** sends a one-hour reset link by email.

## Try it on your computer (the demo)

One command starts the whole site on your own computer, already filled with sample people, follows, posts (some with photos), board threads, DMs, a group chat and #ourspace chatter. Nothing in it is real or online.

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
| you | `you@example.com` | `ourspace-demo` | `the_reviewer`, a regular member with friends, two new followers, a follow request waiting on a private profile (`emo_drew`), unread DMs, a group chat (`top 8 crew ♥`), an invite waiting to a group (`mixtape club`, from someone who isn't a friend yet), a bookmark, and a few unread notifications (a like, replies on a post and on a board, a repost, a quote, a mention and Friends' Comments) |
| the moderator | `malten@example.com` | `ourspace-demo` | `malten`, sees the **Moderation** tab with a sample report, and pinned the house rules in Random |
| anyone else | `kat@`, `jules@`, `drew@`, `pete@`, `mia@` or `banana@example.com` | `ourspace-demo` | the sample members, to see the site from their side |

How the demo differs from the real site:

- **Sign-in and Spotify go to pretend pages.** "Continue with Google" (or Apple, Microsoft, Discord, GitHub) and "connect Spotify" open a page labeled *local demo: not the real Google*. Type any name to continue; the same name brings back the same pretend account. Cancel works too. On Spotify's pretend page you can tick a box to see what people outside the 5-person allowlist are told.
- **Pretend Spotify has no album covers** (grey squares). The 30-second previews are real ones from Apple when your computer can reach the iTunes Search API.
- **"Forgot my password" and "confirm your email" emails** appear in the terminal window running the demo. Copy the link from there. The sample people are already confirmed.
- **The human checks use Cloudflare's test keys**: the "verify you are human" box always passes, and the email check asks a pretend DNS. The proof of work is the real one. As `malten`, the Moderation tab shows three held bot sign-ups, the alerts they raised and two posts the pretend AI detector scored.
- **Your changes stick** between runs: the data (and any photos you upload) lives in `.demo/`. `npm run demo -- --fresh` starts over with just the sample content. (A demo made before the boards keeps its data, with its bulletins moved into Random, and one made before chat keeps its messages as DMs; `--fresh` brings the sample threads, group chats and #ourspace.)
- **Editing works live.** Change a file in `public/` or `src/` and refresh the browser.

Stop it with **Ctrl+C**. If port 8787 is already taken, it picks the next free one and prints the address.

## Tests

```bash
npm test      # all of test/*.test.mjs
```

The API tests start their own Worker on a fresh throwaway database, plus stand-ins for every sign-in provider, Spotify, iTunes, Turnstile's siteverify and DNS-over-HTTPS, so nothing reaches the internet. They try every member write route as an unverified, a held and a timed-out member, and run the bot simulator (`tools/bot-sim.mjs`) against the server. The astronomy tests check the horoscope numbers against known ephemeris dates. The photo tests feed the server's file checks and metadata stripper photos built byte by byte, with GPS positions and comments hidden in them. A static test fails if an image is missing, unreferenced or uncredited, or if an import doesn't resolve. No secrets or setup are needed.

## Docs

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it works, the file map, the life of a request, the front-end modules, how horoscopes are computed |
| [docs/development.md](docs/development.md) | Running locally, how the demo works, migrations, Windows notes, adding a blog post |
| [docs/deploy.md](docs/deploy.md) | First deploy, email, sign-in providers, Spotify, custom domain, vars and secrets, **cutover from the desktop site** |
| [docs/operations.md](docs/operations.md) | Making a moderator, photos (removing one, CSAM and Take It Down duties, storage), logs, finding an account, backups, rotating keys, rate limits |
| [docs/security.md](docs/security.md) | What's protected, and how accounts and providers fit together |
| [docs/roadmap.md](docs/roadmap.md) | What isn't done yet, and where each piece of code will go |
| [docs/history.md](docs/history.md) | The desktop site this repo began as, and how to recover it |
| [public/assets/CREDITS.md](public/assets/CREDITS.md) | Where every image comes from (served at `/assets/CREDITS.md`) |
| [CONVENTIONS.md](CONVENTIONS.md) | The rules for adding a route, feature, page, migration or asset |
