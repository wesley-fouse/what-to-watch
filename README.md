# What to Watch

Picks a random movie from your Letterboxd watchlist and shows where it's streaming.
A GitHub Action re-reads your watchlist every morning, so new additions show up on their own.

## One-time setup (about 15 minutes, easiest on a computer)

1. **Check that your watchlist is public.** It is by default. Open `https://letterboxd.com/YOUR-USERNAME/watchlist/`
   in a private/incognito browser window. If you see your films, you're set.
2. **Get a free TMDB key.** Sign up at themoviedb.org → Settings → API → request a Developer key
   (personal use is fine). Copy the **API Key** (the short one); the long Read Access Token works too.
3. **Create a GitHub repo.** Sign in at github.com → New repository → name it `what-to-watch` → **Public** → Create.
4. **Upload these files.** In the new repo click "uploading an existing file", then drag in everything from this folder,
   including the hidden `.github` folder. (On a Mac, press Cmd+Shift+. in Finder to see it.) Commit.
   *If the `.github` folder won't upload:* click Add file → Create new file, type
   `.github/workflows/sync.yml` as the name, and paste in that file's contents.
5. **Add your settings.** Repo → Settings → Secrets and variables → Actions:
   - **Secrets** tab → New repository secret → name `TMDB_API_KEY`, value = your TMDB key.
   - **Variables** tab → New repository variable → name `LETTERBOXD_USERNAME`, value = your username.
   - (Optional) variable `WATCH_REGION` if you're not in the US, e.g. `CA`.
6. **Run the first sync.** Actions tab → (enable workflows if asked) → Sync watchlist → Run workflow.
   Takes a minute or two, longer for a big watchlist.
7. **Turn on the website.** Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.
   After a minute your picker is at `https://YOUR-GITHUB-NAME.github.io/what-to-watch/`.
8. **Put it on your phone's home screen.** Open that link in Safari → Share → Add to Home Screen.

## How it works

- `scripts/sync.mjs` reads your public watchlist pages, matches each film to TMDB, and pulls
  where-to-watch data (JustWatch, via TMDB) for your region into `data/watchlist.json`.
- `.github/workflows/sync.yml` runs that every day around 4 AM Eastern and commits the result.
  The Run workflow button syncs on demand.
- `index.html` is the picker. Filters: **Streaming** (subscription or free), **+ Rentals**, or **Anything**,
  plus **My services** to only count the services you pay for. It avoids repeating recent picks.

## If it breaks

- **Action fails with "private" or "0 films"**: check the watchlist is public and the username is right.
- **Action fails with Letterboxd 403s**: Letterboxd sometimes blocks automated requests. It'll retry
  the next day, and your last good list stays in place.
- **Parsing suddenly finds nothing**: Letterboxd probably changed its page layout. The parser is
  `parsePosters()` in `scripts/sync.mjs`.
- GitHub pauses scheduled runs if a repo has no activity for 60 days. The daily commits normally
  prevent that; if it happens, click "Enable workflow" in the Actions tab.
