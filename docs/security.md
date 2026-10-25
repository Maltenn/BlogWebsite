# Security

## What's protected

- **Passwords:** PBKDF2-SHA256, 100k iterations, per-user salt. Unknown accounts and wrong passwords take the same time. A password can't be the screen name or the email, or one of the most common passwords.
- **Sessions:** a random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` on https), with only its hash stored. A password change logs out other devices, and a password reset logs out all of them. Banning logs the person out.
- **Provider sign-in:**
  - The state is single-use, expires in 10 minutes, is stored server-side and is tied to the browser by a cookie.
  - PKCE is used wherever the provider supports it.
  - Accounts are never merged by email (see below).
  - Apple's client secret is a short-lived ES256 token signed on the server.
- **Spotify tokens:** encrypted with AES-256-GCM before they reach the database. Only the `user-top-read` permission is asked for.
- **Reset links:** single-use, valid for 1 hour, and kept in the URL fragment so they never reach server logs. The forgot-password page gives the same answer whether or not the address has an account.
- **Birthdays:** never shown. Pages show age and sign only if the person allows it.
- **Writes:** refused from other sites (Origin and Sec-Fetch-Site checks), JSON only. The one exception is Apple's sign-in reply, which arrives as a form post and is checked against its single-use state. See [the life of a request](architecture.md#the-life-of-a-request).
- **Pages:** strict Content-Security-Policy (scripts and styles from the site only, images also from Spotify's CDN, audio previews from Apple), no framing. Nothing people type is ever inserted as HTML.
- **Profiles:** every look setting must come from the lists in `src/catalog/options.js`, so nobody can inject CSS or image URLs.
- **Text:** invisible and direction-flipping characters stripped, links removed, blocked words starred.
- **Blocks and reports:** a block hides both people from each other and stops all contact. Reports keep a snapshot, so the evidence survives a delete.

### External origins

The Content-Security-Policy in `public/_headers` allows exactly these outside origins, and nothing else:

| For | Origins |
|---|---|
| Images (besides the site's own and `data:`) | `i.scdn.co`, `*.spotifycdn.com` (Spotify album art) |
| Audio previews | `*.itunes.apple.com`, `*.apple.com`, `*.mzstatic.com` (Apple's 30-second previews) |

Scripts, styles, fonts and fetches are the site's own only. Adding a new outside origin means changing the CSP in `public/_headers` and this table together.

## How accounts and providers fit together

- **First time with a provider:** the person picks a screen name and enters their birthday (`/join/finish`), the same as an email sign-up.
- **Already a member:** they connect more ways in under **Settings → sign-in methods**, and can remove any of them as long as one is left (a password counts as one).
- **No automatic merging by email.** If a provider says the address already belongs to an account, the person is told to log in with that account and connect the provider from Settings. That stops anyone from taking over an account by registering its email address with another service. Microsoft addresses are never trusted for this, because Microsoft doesn't promise they were checked.
- **Accounts without a password:** they log in only through their providers. To delete the account, they type their screen name to confirm.

Setting the providers up is in [deploy.md](deploy.md).
