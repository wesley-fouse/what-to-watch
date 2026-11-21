// Daily sync: Letterboxd watchlist -> TMDB details + where-to-watch -> data/watchlist.json
// Runs in GitHub Actions (Node 20+, no dependencies).
//
// Env:
//   LETTERBOXD_USERNAME  your Letterboxd username (watchlist must be public)
//   TMDB_API_KEY         TMDB "API Key" (v3) or "API Read Access Token" (v4) — either works
//   WATCH_REGION         country for streaming info, default US

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const USER = (process.env.LETTERBOXD_USERNAME || '').trim().toLowerCase();
const KEY = (process.env.TMDB_API_KEY || '').trim();
const REGION = (process.env.WATCH_REGION || 'US').trim().toUpperCase();
const OUT = 'data/watchlist.json';

if (!USER) fail('LETTERBOXD_USERNAME is not set (Settings → Secrets and variables → Actions → Variables).');
if (!KEY) fail('TMDB_API_KEY is not set (Settings → Secrets and variables → Actions → Secrets).');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

function decode(s = '') {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

async function lb(path, tries = 3) {
  const url = 'https://letterboxd.com' + path;
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en' } });
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    console.warn(`  Letterboxd ${res.status} on ${path} (try ${i}/${tries})`);
    await sleep(2000 * i);
  }
  throw new Error(`Letterboxd kept refusing ${url}`);
}

// ---- 1. Read the watchlist, page by page -------------------------------------------------
function parsePosters(html) {
  const films = new Map();
  // Each poster is one tag carrying data-* attributes. Grab every tag that names a film slug.
  const tagRe = /<[^>]+data-(?:item|film)-slug="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const slug = m[1];
    const attr = (name) => (tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
    const display =
      attr('data-item-full-display-name') || attr('data-item-name') || attr('data-film-name') || '';
    if (!films.has(slug)) films.set(slug, decode(display));
  }
  // Older markup fallback: data-target-link="/film/slug/"
  if (!films.size) {
    for (const [, slug] of html.matchAll(/data-target-link="\/film\/([^/"]+)\/"/g)) films.set(slug, '');
  }
  return films;
}

async function readWatchlist() {
  const all = new Map();
  for (let page = 1; page <= 200; page++) {
    const html = await lb(`/${USER}/watchlist/${page > 1 ? `page/${page}/` : ''}`);
    if (html === null) fail(`No Letterboxd user "${USER}" (404). Check the username.`);
    if (page === 1 && /keeps? (this|their) (page|watchlist) private|is private/i.test(html) && !/data-(item|film)-slug/.test(html))
      fail('That watchlist is private. On Letterboxd: Settings → Privacy → make your watchlist public.');
    const found = parsePosters(html);
    let added = 0;
    for (const [slug, name] of found) if (!all.has(slug)) (all.set(slug, name), added++);
    console.log(`  page ${page}: ${found.size} posters`);
    if (!added) break;
    await sleep(800);
  }
  return all;
}

// ---- 2. Map each Letterboxd film to a TMDB id ---------------------------------------------
function splitDisplay(display) {
  const m = display.match(/^(.*)\s\((\d{4})\)$/);
  return m ? { title: m[1], year: +m[2] } : { title: display, year: null };
}

async function tmdbIdFromFilmPage(slug) {
  const html = await lb(`/film/${slug}/`);
  if (!html) return null;
  const id = html.match(/data-tmdb-id="(\d+)"/)?.[1] || html.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/)?.[1];
  const type = html.match(/data-tmdb-type="(movie|tv)"/)?.[1] || html.match(/themoviedb\.org\/(movie|tv)\//)?.[1] || 'movie';
  return id ? { tmdbId: +id, tmdbType: type } : null;
}

// ---- 3. TMDB ------------------------------------------------------------------------------
const isBearer = KEY.length > 40; // v4 read tokens are long JWTs; v3 keys are 32 chars
async function tmdb(path, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  if (!isBearer) u.searchParams.set('api_key', KEY);
  for (let i = 1; i <= 4; i++) {
    const res = await fetch(u, { headers: isBearer ? { Authorization: `Bearer ${KEY}` } : {} });
    if (res.ok) return res.json();
    if (res.status === 401) fail('TMDB rejected the API key (401). Re-copy it into the TMDB_API_KEY secret.');
    if (res.status === 404) return null;
    await sleep(1000 * i); // 429 / 5xx
  }
  return null;
}

async function tmdbSearch(title, year) {
  const r = await tmdb('/search/movie', { query: title, year: year || undefined });
  const hit = r?.results?.[0];
  return hit ? { tmdbId: hit.id, tmdbType: 'movie' } : null;
}

const provs = (list = []) =>
  list
    .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
    .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));

async function tmdbDetails({ tmdbId, tmdbType }) {
  const d = await tmdb(`/${tmdbType}/${tmdbId}`, { append_to_response: 'watch/providers', language: 'en-US' });
  if (!d) return null;
  const w = d['watch/providers']?.results?.[REGION] || {};
  const date = d.release_date || d.first_air_date || '';
  return {
    title: d.title || d.name,
    year: date ? +date.slice(0, 4) : null,
    runtime: d.runtime || d.episode_run_time?.[0] || null,
    genres: (d.genres || []).map((g) => g.name),
    overview: d.overview || '',
    poster: d.poster_path || null,
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    watchLink: w.link || null,
    providers: {
      stream: provs(w.flatrate),
      free: provs([...(w.free || []), ...(w.ads || [])]),
      rent: provs(w.rent),
      buy: provs(w.buy),
    },
  };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// ---- main ---------------------------------------------------------------------------------
console.log(`Syncing @${USER}'s watchlist (region ${REGION})`);

let previous = {};
try {
  const old = JSON.parse(await readFile(OUT, 'utf8'));
  for (const f of old.films || []) previous[f.slug] = f;
} catch {}

const watchlist = await readWatchlist();
if (!watchlist.size) fail('Found 0 films. The watchlist may be empty, private, or Letterboxd changed its page layout.');
console.log(`Watchlist: ${watchlist.size} films`);

// Resolve TMDB ids — cached from earlier runs, so only new films hit Letterboxd film pages.
const entries = [];
for (const [slug, display] of watchlist) {
  const prev = previous[slug];
  let ids = prev?.tmdbId ? { tmdbId: prev.tmdbId, tmdbType: prev.tmdbType || 'movie' } : null;
  if (!ids) {
    try {
      ids = await tmdbIdFromFilmPage(slug);
    } catch (e) {
      console.warn(`  film page failed for ${slug}: ${e.message}`);
    }
    if (!ids) {
      const { title, year } = splitDisplay(display || slug.replace(/-/g, ' '));
      ids = await tmdbSearch(title, year);
    }
    console.log(`  new: ${display || slug} → ${ids ? `${ids.tmdbType}/${ids.tmdbId}` : 'not on TMDB'}`);
    await sleep(600);
  }
  entries.push({ slug, display, ids });
}

// Refresh details + streaming for every film each run (providers change constantly).
const films = await pool(entries, 6, async ({ slug, display, ids }) => {
  const base = splitDisplay(display);
  const details = ids ? await tmdbDetails(ids) : null;
  return {
    slug,
    url: `https://letterboxd.com/film/${slug}/`,
    tmdbId: ids?.tmdbId ?? null,
    tmdbType: ids?.tmdbType ?? null,
    title: details?.title || base.title || slug,
    year: details?.year ?? base.year,
    ...(details || { providers: { stream: [], free: [], rent: [], buy: [] } }),
  };
});

const data = { user: USER, region: REGION, updated: new Date().toISOString(), count: films.length, films };
await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(data, null, 1) + '\n');

const streamable = films.filter((f) => f.providers.stream.length || f.providers.free.length).length;
console.log(`✔ Wrote ${films.length} films (${streamable} streaming somewhere in ${REGION})`);
