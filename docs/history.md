# History

This repo began as MALTEN.EXE: a Windows 98 desktop personal site with a scripted bot social network in it. OurSpace, a real social network, replaced it on the branch `claude/intelligent-fermat-keh09f`.

The last commit that contains the desktop site is `747ecff`. Everything on `main` before this branch is merged is the desktop site too. Recover any old file with:

```bash
git show 747ecff:<path>                  # print it
git checkout 747ecff -- <path>           # put it back in your working copy
```

What was removed: the desktop shell, the bot residents engine and its `content-src/`, the old backends (`worker/`, `msgserver/`, `spotifyserver/`), `WEBSITE-STRUCTURE.md`, and the `CNAME` file. malten's two essays were kept, under `public/blog/`.

The deployed pieces of the old site (the `ourspace-api` Worker, the `ourspace-db` database and GitHub Pages) are dealt with in [Cutover from the desktop site](deploy.md#cutover-from-the-desktop-site).
