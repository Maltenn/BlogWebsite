# App Review notes

What goes in **App Store Connect → App Review Information → Notes** and in **Play Console → App content → App
access**. Copy the block below; it is written for a reviewer who will give the app about ninety seconds.

Two rules for this file: nothing in it may describe behaviour the build does not have (a feature list with one
invented item in it turns one rejection into two — it is how `store.md` claimed a biometric unlock that was never
built), and every line must be reachable by the taps it names, from a cold launch, on the account below.

Every `REPLACE_…` below is checked by `npm run check:release`, so a store build cannot be cut while one is still
here, with one exception: **`REPLACE_DEMO_PASSWORD` stays in this file for good.** This repository is public, so the real
password is never committed. Paste it into App Store Connect and Play Console yourself, in place of the placeholder, when you
fill their forms. `check:release` instead needs the password in the `REVIEW_DEMO_PASSWORD` environment variable (a secret of
the GitHub `release` environment; it is only compared, never printed), and fails if that value, or any other password, turns
up in this file.

---

## The demo account

A reviewer must never have to sign up, confirm an email or wait for a moderator. Make this account on the deployed
origin before the first submission:

1. Sign up on the site itself (not in the app) with an address you control.
2. Confirm the email. **An unconfirmed account cannot post, comment or message** (`src/shared/gate.js`), and a
   reviewer who hits that will read it as a broken app.
3. In the moderation queue, clear the hold on it (a brand-new account is held for a look; `users.held`).
4. Give it something to look at: a picture, two or three status posts, one board thread, one friend, and one
   conversation with a second account so Messages is not empty. `node tools/demo.mjs` makes exactly this shape
   locally and is the fastest way to see what "not empty" should look like.
5. The account must stay signed in across the whole review, so do not sign out of it anywhere else: the session is a
   90-day token and signing out elsewhere does not end it, but deleting the account does.

```
Screen name:  REPLACE_DEMO_ACCOUNT
Password:     REPLACE_DEMO_PASSWORD
```

Sign-in is **email or screen name + password** on the app's own Log in screen. Google and Discord also work, but a
reviewer should use the password: the provider sheet needs an account they do not have.

No other credential, hardware, or configuration is needed. The app has no paid content, no subscription, and nothing
behind a code.

---

## The notes (paste this)

> OurSpace is a social network with a deliberately retro look. Everything below is native and happens outside the web
> layer; the numbers are taps from a cold launch.
>
> 1. **Tab bar (0 taps).** The bar along the bottom is native — a scroll view of native buttons drawn by the app, not
>    HTML. Flick it sideways: it has the system's own scrolling and overscroll. The pink counters on Notifications
>    and Messages are drawn natively and change as those counts change. Tapping one gives selection haptic feedback.
> 2. **Camera and photo library (2 taps).** Tap **Join!** in the tab bar, then **"use a photo of my own"** at the top
>    of the sign-up card: the system camera / photo-library sheet opens. (Signed in as the demo account, the same
>    sheet is behind every picture button on the app — a post, a message, Settings → picture.)
> 3. **Haptics.** Tapping a tab, a button or a reaction gives real haptic feedback; a success or error toast has its
>    own pattern.
> 4. **Share sheet.** Open any blog post (**Blog** in the tab bar) and tap **copy link**: the system share sheet
>    opens with the real https address, not the app's internal one.
> 5. **Links leave the app properly.** Any link to another site opens in Safari View Controller / a Custom Tab, never
>    inside the app.
> 6. **It works offline.** Turn on Airplane Mode and relaunch: the app still opens, still draws its chrome, and says
>    which parts need a connection.
> 7. **The session is in the Keychain**, never in web storage.
> 8. **Deleting the account** is the Settings button in the header → "Delete my account", and it really deletes.
>
> Reporting, blocking and the house rules are all in the app: a report is the "report" link on any post, profile or
> message; blocking is on any profile; the rules are linked from the footer of every page.
>
> Demo account: REPLACE_DEMO_ACCOUNT / REPLACE_DEMO_PASSWORD

---

## What is deliberately NOT in that list

Because none of it is built, and claiming it is how a rejection becomes two:

- **No biometric unlock.** The session token is in the Keychain / Keystore with
  `whenUnlockedThisDeviceOnly`; there is no Face ID or Touch ID gate. (`deviations.md`, and the row `store.md` used
  to have.)
- **No widget, no Siri / App Intents, no Live Activity, no Handoff, no Apple Watch app.**
- **Push notifications are not listed, deliberately.** The code is there and tested, but no build can receive one
  until an APNs auth key and an FCM project exist (`store.md`, "Push: what is built and what cannot work yet"). The
  app does ask for notification permission on first sign-in; a reviewer who allows it and waits will get nothing. Add
  push back to the list above — as item 3, where it is the strongest point after the tab bar — on the first build
  that can actually deliver one, and not before.
- **No dark mode** — the site has one look, and the app is pinned to light (`D10`).
- **No iPad-specific layout.** It runs on iPad at the site's wide layout. If iPad is in the submission, expect this
  to be asked about; submitting iPhone-only until an iPad layout exists is the cheaper answer.
- **Connecting Google / Discord / Spotify from Settings does not work in the app** (`D15`); signing *in* with Google
  or Discord does.
- **Universal links / App Links do not work** until the team id and the Play signing fingerprint are real
  (`D18`, `D19`). Links from outside open in the browser. A reviewer is unlikely to try this; say nothing about it
  unless asked.

## If the app is rejected under Guideline 4.2

The argument, in one paragraph, is: the navigation itself is native (point 1), it is not a web control styled to look
native — the app measures the page's own tab bar and redraws it as real native views, which is why it scrolls and
feels like the system does; the camera, photo library, share sheet, push, haptics and Keychain are all system
services; and the app works with no network at all. Offer a screen recording of the tab bar being flicked and of the
camera sheet opening — the scroll physics are the thing a reviewer can see in two seconds and a web view cannot fake.

What would actually be worth building next, if 4.2 is still refused: a share extension (post to OurSpace from
another app's share sheet), and a home-screen widget showing unread counts. Both are real native surfaces a web page
cannot have at all. Neither exists today.

## Play Console

The same account goes in **App access → All functionality is restricted**, with the instructions in one field:

> Sign in on the first screen with screen name REPLACE_DEMO_ACCOUNT and password REPLACE_DEMO_PASSWORD. No other
> steps are needed.

Play has no 4.2; its equivalents are the **Data safety** form and the **account deletion** URL, both of which are
`store.md`'s problem, not this file's.
