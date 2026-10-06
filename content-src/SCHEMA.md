# OurSpace content packs — schema, roster & style guide

Everything in `content-src/` is **source**. `node tools/content.mjs build` validates it and
compiles it into `content-pack.js`, which the site loads after `ourspace.js`.
One JSON file per item. **Validate every file you write**: `node tools/content.mjs check <file> [<file>...]`
and fix every ERROR before you report back (WARNs are judgement calls).

```
content-src/base/residents/<id>.json     the 38 ORIGINAL residents (full profiles; loosely validated — they predate the schema)
content-src/base/dialogues/<id>_original.json  the 6 original conversation trees (the quality bar)
content-src/base/storylines.json         the 8 drama arcs (multi-beat, play out over time)
content-src/base/banks.json              shared line banks
content-src/residents/<id>.json     the 54 newer residents (full profile, strict schema below)
content-src/depth/<id>.json         extra depth for the 38 ORIGINAL residents
content-src/dialogues/<treeId>.json scripted inbox conversations (branching)
content-src/assets-manifest.json    written by the asset agents (avatars / decor / post gifs)
content-src/reference/existing-residents.md   one-line table of the 38 originals
```
Everything in `base/` used to be JavaScript literals inside `ourspace.js`; it is ordinary content now.

## The world (read this first)

OurSpace ("a place for friends") is a fake 2006-era social network living inside a Windows-98
desktop website. Residents are the NPCs. The comedy is affectionate: specific, character-driven,
a little absurd, never cruel.

**Who the player is (changed Oct 2026):** the player is **the visitor** — whoever opened the site.
They pick their own screen name, build their own page, and every DM, wall post, bulletin and
conversation is addressed to *them*. In data, the player is written as the token **`{you}`**
(exactly that, lowercase, braces), which the site swaps for the visitor's screen name when it
renders. Never write a name for the player, never `you` as an id. Examples:
`"hey {you}!! welcome to my page"` · `"{you}. cease all activity."` · `"{you}-kun!!"`.
Rules that follow from it:
- **Never assume facts about the player.** They are not an Aries, do not play Melee, did not
  build the desktop, have no Spotify server, are not "marc". They are simply *new here*. Lines
  that need a personal detail should ask for it or guess and be wrong (that is funnier anyway).
- **malten is a resident now** (id `malten`): the guy who built this desktop and runs the real
  blog and guestbook. Residents may talk *about* malten in the third person ("malten's site",
  "malten is such an aries") — that stays as "malten". Only lines that talk *to* the player use
  `{you}`. The validator warns on every player-facing field that still says "malten".
- The player's own lines (dialogue `say` choices) are a visitor's, not malten's: no "my site",
  "my desktop", "my spotify server".

**Voice rules (hard):**
- It is spiritually 2006. Reference the era's stuff (AIM, away messages, MSN, burned CDs, LimeWire,
  flip phones, mall food courts, Blockbuster, dial-up, top 8s, bulletins, pc4pc, surveys, layouts).
  **Never state the year**, never say "2006", never acknowledge that timestamps say 2026.
- **No modern slang or tech**: no vibe/vibes, slay, bestie, main character, lowkey/highkey, sus,
  yeet, simp, no cap, rizz, ghosted, cringe, iykyk, selfie, influencer, emoji, hashtag, tiktok,
  instagram, snapchat, twitter/tweet, iphone, smartphone, app. The validator fails on these.
- **No "hater" theming at all** (no hater/h8r/haterz) — the owner had it removed site-wide.
- **PG.** Many residents are teenagers. No sexual content, no innuendo, no drugs/alcohol, no
  slurs, no body-shaming, no real cruelty. Crushes and flirting are goofy and innocent. Adults
  (mom, aunt, grandpa, teacher…) relate to teens only in family / wholesome / comically-clueless ways.
- **No real private people**, no impersonating real celebrities. Naming real bands, games, shows,
  films, products is fine. **Never quote song lyrics** (titles only) or long passages of any real work.
- Emoticons over emoji: `=]  xD  ;)  <3  =^.^=  ^_^  T_T  >:(  o.O` and symbols `♥ ★ ☆ ♪ ~*~`.
  At most a couple of real emoji per resident (existing data uses them very sparingly).
- Every resident has ONE comic engine (an obsession, a flaw, a verbal tic) plus ONE humanising
  detail that makes them likeable. Lines should be specific: a named object, a number, a place.
  Avoid repeating the same joke in every line — the owner complained that one resident mentions
  his CRT televisions in nearly every sentence. Give each character 4-5 distinct subjects.
- Typing style is characterisation: all-lowercase kid, ALL CAPS mom, l33t, perfect grammar adult…
  keep it consistent within a character and different between characters.
- Residents talk to **each other**, not only to the player. Cross-reference other residents by what
  they're known for (see roster + existing-residents.md).
- Timestamps: format `Sep 14 2026 11:42 PM`, anywhere from `Jul 5 2026` to `Oct 4 2026`.

## Existing residents (38) — ids you may reference

See `reference/existing-residents.md` (id, display name, age, tagline, friends) and the full
profiles in `base/residents/<id>.json`. One-line reminders:
todd (founder/admin, everyone's first friend, runs the site off a laptop) · darkangel (emo poet,
"crimson tears" series, glitter-ghost chain letters) · sk8rboi (skater, lost shoe at the mall gap) ·
vinyl_witch (record-store witch, first pressings) · wes (competitive Melee player, fox main, hosts
friendlies) · herp (says "herp.") · banana (BANANA_PHONE, all caps, RING RING) · patrick (sweet,
dim, has a pet rock) · starxgazer (does your chart without asking) · zorp (alien pretending to be a
normal human) · tony (goofy flirt, 0-for-53, a gentleman) · brittany (popular girl, top-8 politics,
secretly kind) · randy (lol, PIE) · lucas (Linkin Park devotee) · chad (baseball jock, can't work
the site) · sephiroth (FF7 lorekeeper) · nikki (nightcore, 1.5x speed) · riley (rawr xD scene kid) ·
usagi (anime club president, subs only) · kevin (DDR at the Tilt arcade) · dave ("hacker" who hacks
nothing) · tina (vampire-romance superfan) · derek (intense skater) · meg (glitter + ponies) ·
greg (fronts garage band STATIC PROPHECY) · epic (meme kid, "lol ur mom") · raven (actual goth,
24, dry) · smoove (wannabe rapper/DJ) · liz (makes profile layouts, credit her) · josh (youth
group, pizza, never takes sides) · paige (tilted-angle photographer) · kayla + bryan (THE couple;
bryan drums for greg's band) · kittyxcore, misery, lexi (the scene trio) · nate (scene boy, lexi's
on/off) · mika (deviantART OC artist, DO NOT TRACE).

## New-resident roster (54) — the ids are FIXED, do not rename

Each batch is one clique written by one writer; cross-batch references are encouraged
(use any id from this roster or the existing 38).

### G1 — the gamers
| id | display name | age | concept | natural links |
|---|---|---|---|---|
| ryan | rs_ryan_pk | 14 | RuneScape lifer. sells lobsters, "buying gf 10k", terrified of the Wilderness, got scammed by "free armor trimming" twice | dave, min, kyle, devon |
| nat | neopets_nat | 14 | Neopets guild leader and pet-page HTML coder, restocks at 4am, treats Neopoints like the stock market | liz, meg, tim, angela |
| hunter | xX_NoScope_Xx | 15 | Halo 2 "MLG" wannabe, makes montage videos, "1v1 me on lockout", secretly bad at it | josh, wes, andy, kyle, dmitri |
| rick | raidleader_rick | 19 | WoW guild leader with DKP spreadsheets, runs 40-man raids like a shift manager (he is also an actual night-shift stocker) | sephiroth, dave, min, tim |
| min | maple_min | 15 | MapleStory grinder, sells tips for mesos, falls asleep at the keyboard in Henesys | usagi, ryan, rick, penny |
| dmitri | de_dust_dmitri | 17 | Counter-Strike 1.6 LAN-cafe regular, "rush B", energy-drink scholar, clan tag [pwn] | dave, hunter, lars, rick |
| gus | guitarhero_gus | 15 | Guitar Hero II expert-mode kid who sincerely believes he is now a real guitarist; wants in greg's band on plastic guitar | greg, bryan, kevin, skip |
| sara | simz_sara | 16 | The Sims 2 storyteller/architect, posts multi-part Sim family sagas, removes pool ladders "for the plot" | tina, mika, paige, faye |
| gary | gamefaqs_gary | 18 | writes 300KB ASCII-art walkthroughs nobody asked for, version numbers on everything (v1.07), corrects people citing section [4.2b] | wes, sephiroth, ryan, marcus |

### G2 — extremely online
| id | display name | age | concept | natural links |
|---|---|---|---|---|
| larry | limewire_larry | 16 | downloads everything; PC has 400 viruses and 11 toolbars; every mp3 is mislabeled; calls it "sharing" | dave, vinyl_witch, todd, lars |
| nick | newgroundz_nick | 15 | Flash animator of a stick-figure fight series, lives and dies by his portal score | mika, epic, andy, miles |
| marcus | mod_marcus | 19 | power-tripping forum moderator: "thread locked. read the rules." treats other people's walls as his jurisdiction; wants todd to make him admin | todd, dave, gary, angela |
| lars | linux_lars | 18 | Linux evangelist, compiles his own kernel, "have you tried Ubuntu", it took him 3 days to get wifi working and he calls that freedom | dave, miles, todd, larry |
| miles | mac_guy_miles | 17 | smug white-MacBook + iPod owner, makes iMovie trailers and GarageBand loops, "it just works" | lars, greg, paige, nick |
| doug | dialup_doug | 16 | still on 56k. every glitter gif and autoplay song costs him 9 minutes. gets disconnected mid-sentence when his mom picks up the phone | liz, meg, nikki, angela |
| angela | angelfire_angela | 17 | webmistress of an Angelfire shrine site, perpetual UNDER CONSTRUCTION, runs a webring, hands out "Angela's Cool Site Award", SIGN MY GUESTBOOK | liz, todd, doug, marcus |
| trevor | thefacebook_trevor | 18 | college freshman, smug that his other site is "college only", says OurSpace is for kids, logs in daily anyway | brittany, chad, fred, tyler |
| fred | friendster_fred | 25 | Friendster refugee, nostalgic for how things were three years ago ("we had testimonials"), already planning to leave, never leaves | todd, trevor, vinyl_witch, raven |

### G3 — the fandoms
| id | display name | age | concept | natural links |
|---|---|---|---|---|
| faye | fanfic_faye | 15 | author of a 94-chapter fanfic; author's notes longer than the chapters; "R&R pls, no flames" | maddie, tina, usagi, sara, luna |
| maddie | mugglenet_maddie | 14 | Harry Potter theorist, has sorted every resident into a house, writes essays about one character's true loyalties | faye, tina, sephiroth, leo |
| ben | believe_it_ben | 14 | wears a ninja headband to school, runs with his arms back, trains at the park, dubs only (usagi is appalled) | usagi, tj, kevin, devon |
| devon | duelist_devon | 14 | trading-card-game locals champion at the card shop, believes in the heart of the cards, shady trader | ben, ryan, wes, tim |
| andy | amv_andy | 16 | makes anime music videos in Windows Movie Maker with a screen-recorder watermark on everything | lucas, usagi, nikki, nick, hunter |
| leo | hatch_theory_leo | 17 | obsessive TV-mystery theorist (the island show): corkboard, string, "the numbers"; applies it to everything | zorp, starxgazer, bill, brad |
| hailey | wildcat_hailey | 14 | High School Musical superfan, choreographs the lunch table, "what team?" | thad, brittany, ashley, becca |
| tj | ninja_tj | 15 | the pirates-vs-ninjas debate guy; polls everyone, keeps a tally, owns a "katana" (letter opener) | ben, derek, sk8rboi, randy |
| luna | moonwolf_luna | 15 | forum wolf-pack roleplayer, narrates her actions in asterisks, alpha of a pack of four | faye, mika, raven, whiskers |

### G4 — school & the mall
| id | display name | age | concept | natural links |
|---|---|---|---|---|
| becca | bandgeek_becca | 16 | marching-band clarinet section leader, band camp stories, at war with the football schedule | chad, bryan, skip, thad |
| thad | thespian_thad | 17 | drama club; every wall post is a monologue; lost the lead to a sophomore and is "fine" | hailey, darkangel, brittany, gina |
| ashley | cheer_capt_ashley | 17 | cheer captain, runs competition season like a general, colour-coded everything | brittany, chad, meg, hailey |
| tyler | lax_bro_tyler | 17 | lacrosse bro, two popped collars, "bro" as punctuation, quietly devoted to his elderly dog | chad, trevor, josh, sven |
| yvette | yearbook_yvette | 17 | yearbook editor AND class-president candidate; campaign bulletins; superlatives committee; deadline tyrant | paige, brittany, ashley, tim |
| tim | ti83_tim | 15 | programs games on his graphing calculator and sells them for $2, mathlete, keeps a ledger | dave, nat, wes, henderson |
| holly | hottopic_holly | 18 | works at the mall goth store, flexes the employee discount, gatekeeps band tees ("name 3 songs"), secretly loves pop | raven, riley, misery, kittyxcore |
| brad | blockbuster_brad | 19 | video-store clerk, unrequested movie recommendations, late-fee enforcer; patrick has had a tape out forever | tina, leo, patrick, sara |
| henry | heelys_henry | 13 | wheels-in-his-shoes kid, banned from three stores, ongoing feud with a mall security guard named Dennis | sk8rboi, derek, tj, holly |

### G5 — the music scenes
| id | display name | age | concept | natural links |
|---|---|---|---|---|
| skip | ska_skip | 17 | trombone in a nine-piece ska band, checkerboard everything, insists ska is not dead | becca, greg, derek, gus |
| evan | xEvanx | 17 | straight-edge hardcore kid, X's on his hands, two-steps in the garage, unfailingly polite to parents | derek, misery, josh, ember |
| penny | plur_penny | 16 | kandi kid: bracelets up to the elbow, glowstick tutorials, happy hardcore, powered entirely by blue-raspberry slushies | nikki, kevin, sven, min |
| aaron | acoustic_aaron | 17 | sensitive acoustic-guitar guy, coffee-shop open mic, every song is about "a girl (you know who you are)" | brittany, lexi, nate, greg, gwen |
| ember | xFadingEmberx | 19 | a screamo BAND's account (speaks as "we"; run by the vocalist): "thanks for the add!! check out our demo", flyers, lineup changes weekly | greg, misery, lucas, vince, evan |
| gwen | garden_state_gwen | 17 | indie snob, "you probably haven't heard of them", hand-lettered mix CDs, one film changed her life | vinyl_witch, aaron, paige, fred |
| sven | sven_from_sweden | 17 | Swedish exchange student, eurodance evangelist, sincerely baffled by pep rallies and ranch dressing; chad's family hosts him | nikki, penny, chad, kevin |
| vince | promoter_vince | 19 | "promoter": TEEN NITE at the roller rink, first 50 people free, everything is "gonna be HUGE", it is never huge | smoove, ember, penny, tony |
| harmony | hackysack_harmony | 17 | jam-band hippie kid, hacky-sack circle behind the gym, hemp necklaces, drum circle, 40-minute songs | gwen, skip, starxgazer, sk8rboi |

### G6 — the grown-ups & the oddballs
| id | display name | age | concept | natural links |
|---|---|---|---|---|
| debbie | kaylas_mom_debbie | 44 | kayla's mom, joined to keep an eye on things, signs every comment "Love, Mom", posts private things publicly, can't turn the music off | kayla, bryan, linda, walt |
| linda | aunt_linda_52 | 52 | debbie's sister. forwards every chain letter and angel gif, believes all of them, comments "Beautiful!" on everything | debbie, darkangel, meg, kayla |
| walt | grandpa_walt | 78 | thinks OurSpace is email; writes formal letters on walls ("Dear Patrick, … Regards, Walt"); accidentally profound | patrick, todd, debbie, whiskers |
| henderson | mr_henderson_sci | 41 | science teacher who made a page for homework reminders and science puns; nobody accepts the request; corrects grammar by reflex; wholesome | tim, dave, chad, yvette |
| kyle | kyles_lil_bro | 11 | an 11-year-old on his big brother Kyle's account ("im 14"), asks everyone for cheat codes, gets grounded mid-conversation | ryan, hunter, josh, henry |
| whiskers | mr_whiskers_official | 6 | a cat's profile, written from the cat's point of view (the owner denies involvement); at war with the vacuum | patrick, herp, meg, walt, luna |
| bill | bigfoot_bill | 46 | cryptid hunter, blurry photos, plaster footprint casts, calls late-night AM radio; zorp makes him suspicious and zorp is very nervous about it | zorp, leo, gina, walt |
| gina | ghosthunter_gina | 16 | amateur ghost hunter: EVP recordings (it's the fridge), "orbs" in every flash photo, investigating the school auditorium | raven, starxgazer, bill, thad, darkangel |
| adam | add_me_adam | 18 | friend collector with 10,000 friends who has met none of them; runs "add trains"; pc4pc; "thanks 4 the add" on autopilot; privately lonely | kittyxcore, brittany, todd, tony, vince |

---

## Schema 1 — new resident  `content-src/residents/<id>.json`

All fields required unless marked optional. Sizes are minimums; go a little over, not wildly over.

```jsonc
{
  "id": "ryan",                       // from the roster, = filename
  "name": "rs_ryan_pk",               // display name from the roster
  "tag": "…",                         // headline under the name, <= 90 chars
  "avatar": "assets/avatar_ryan.gif", // ALWAYS this pattern; the asset agents supply the file
  "gender": "Male", "age": 14,
  "hometown": "…", "loc": "…",        // loc = jokey current location
  "zodiac": "…", "status": "Single (…)", "hereFor": "Friends, …",
  "mood": "…", "lastLogin": "Oct 3 2026 4:02 AM",
  "theme": { "bg": "#101820", "fg": "#e8f0ff", "accent": "#ffcc00" },  // readable contrast!
  "bgTile": "assets/tiles/tile_checker.png",   // optional. one of: tile_bolts tile_checker
        // tile_checker_pink tile_flowers tile_hearts tile_leopard tile_leopard_tan tile_skulls
        // tile_skulls_pink tile_stars_neon tile_web tile_zebra tile_zebra_pink  (.png)
  "blogTitle": "…",
  "about": "…",                       // 350-700 chars, in voice
  "aboutMore": "…",                   // optional second paragraph, 200-500 chars
  "meet": "…",                        // "Who I'd like to meet"
  "interests": { "General": "…", "Music": "…", "Movies": "…", "Television": "…", "Books": "…", "Heroes": "…" },
  "song": { "name": "…", "artist": "…", "url": "", "pattern": [0,4,7,4,0,4,7,12], "bpm": 120 },
        // a real era-appropriate song. "url": a 30s iTunes preview if you can resolve one:
        //   curl -s "https://itunes.apple.com/search?term=ARTIST+TITLE&entity=song&limit=3"  -> previewUrl
        // leave "" if the lookup fails. pattern = 8 semitone offsets (chiptune fallback), bpm 80-180.
  "decor": ["assets/deco_smiley.gif"],  // 1-3 EXISTING files from assets/ (deco_*.gif or badge_*.gif). ls assets/ to pick.
  "friends": ["…"],                   // 5-9 resident ids (existing or roster)
  "wall": [ { "from": "<id>", "text": "…", "time": "Sep 30 2026 4:15 PM" } ],   // >= 4, from other residents, in THEIR voice
  "replies": ["…"],                   // >= 8 generic replies they'd give to anything said to them
  "thanksAdd": "…",                   // what they say when the player accepts their request
  "ambient": ["…"],                   // >= 4 standalone musings (used as bulletins / wall posts on the player's page)
  "saltyDm": "…",                     // what they DM if the player denies the request (funny, not mean)
  "keywords": { "runescape": "…" },   // >= 4. lowercase trigger word in the player's message -> their reply
  "banter": { "<otherId>": ["…", "…"] },  // >= 4 targets, >= 2 lines each: wall posts they write ON that resident's page
  "statuses": ["…"],                  // >= 6 status updates; start each with their short name ("ryan is…", "ryan just…")
  "bulletins": [ { "subject": "…", "body": "…" } ],   // >= 2 (surveys, chain letters, announcements…)
  "pcComments": ["…"],                // >= 4 comments they leave on other people's pics
  "dmSeed": [ { "text": "…" } ],      // 1-2 messages: their cold-open DM to the player
  "dms": ["…"],                       // >= 6 unsolicited one-off DMs they might send the player later (each stands alone)
  "blog": [ { "title": "…", "date": "Sep 21 2026 11:10 PM", "mood": "…", "body": "…" } ],  // >= 2 entries, body 350-900 chars
  "survey": { "title": "…", "qa": [["question", "answer"]] }   // >= 8 pairs, classic copy-paste survey
}
```

## Schema 2 — depth pack for an EXISTING resident  `content-src/depth/<id>.json`

Read `base/residents/<id>.json` first and write **new** material in the same voice — do not
repeat jokes that are already there; widen the character (new subjects, a little backstory, a soft spot).

```jsonc
{
  "id": "wes",
  "aboutMore": "…",                   // 250-600 chars, a second "About me" paragraph
  "blog": [ { "title", "date", "mood", "body" } ],   // >= 3 entries, body 400-1000 chars each
  "survey": { "title": "…", "qa": [["q","a"]] },     // >= 10 pairs
  "dms": ["…"],                       // >= 8 unsolicited one-off DMs to the player (each stands alone, all different subjects)
  "repliesExtra": ["…"],              // >= 8 more generic replies
  "statusesExtra": ["…"],             // >= 5
  "wallExtra": [ { "from": "<id>", "text": "…" } ],  // >= 4 comments other residents left on this page (their voice)
  "banterExtra": { "<newRosterId>": ["…","…"] },     // >= 2 targets from the NEW roster, >= 2 lines each
  "keywordsExtra": { "word": "reply" }               // optional
}
```

## Schema 3 — conversation tree  `content-src/dialogues/<treeId>.json`

Emily-is-Away style: the resident DMs the player, the player answers by picking one of 2-3 buttons,
the resident reacts, and where it ends changes what gets posted around the site. Read two of
`base/dialogues/*.json` before writing — that is the quality bar (note how choices have
personality, how branches rejoin, and how endings differ in tone).

```jsonc
{
  "id": "wes_bracket_nerves",        // unique, = filename, start with the resident id
  "with": "wes",                     // who is messaging the player
  "opener": ["…", "…", "…"],         // 2-4 messages that arrive first
  "nodes": {
    "start": { "choices": [ { "say": "…", "next": "a1" }, { "say": "…", "next": "b1" }, { "say": "…", "next": "c1" } ] },
    "a1":    { "them": ["…", "…"], "choices": [ … ], "effects": [ … ] },     // effects optional on middle nodes
    "end_good": { "them": ["…"], "end": true, "effects": [ … ] }           // end nodes: no choices
  }
}
```
Rules: 14-26 nodes · every non-end node has 2-3 choices · at least 3 different end nodes · at
least 4 choices deep before any ending · every `next` must exist and every node must be reachable ·
`them` is 1-3 messages · the player's `say` lines are short, have attitude, and are never just "ok".
One of the choices at most forks should be the playful/chaotic option.

**Effects** (the point of the system — conversations visibly change the site):
```jsonc
{ "type": "status",   "text": "wes is …" }                         // they post a status to the feed
{ "type": "wallpost", "to": "<residentId>", "text": "…" }          // they write on ANOTHER resident's wall (shows in feed)
{ "type": "wall",     "text": "…" }                                // they write on the player's wall
{ "type": "bulletin", "subject": "…", "text": "…" }                // they post a bulletin
{ "type": "dm",       "text": "…" }                                // a follow-up DM lands in the player's inbox later
{ "type": "friend" }                                               // they add the player
```
Any effect may add `"from": "<residentId>"` (default = the tree's `with`) so that OTHER residents
react — e.g. after the player talks tony into being sincere, brittany posts a status about a surprisingly
nice message. Any effect may add `"delay": <seconds, 5-600>`.
Requirements: every END node has >= 2 effects, at least one of them status/wallpost/bulletin/wall,
and at least one with a `from` that is a different resident reacting. At least 2 non-end nodes also
carry an effect (so the feed moves while the conversation is still going).

## Assets manifest (asset agents only)  `content-src/assets-manifest.json`
```jsonc
{ "ryan": { "avatar": "assets/avatar_ryan.gif", "avatarDesc": "pixel knight with sword",
            "decor": ["assets/deco2_sword.gif"], "post": "assets/posts/gif_ryan_lobster.gif",
            "postDesc": "a red lobster spinning", "sources": ["https://…"] } }
```
