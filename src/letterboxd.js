// Coleta de dados do Letterboxd via HTML público (não há API pública).
// O Cloudflare do site bloqueia algumas rotas (perfil, paginação de /films/,
// filtros por gênero), então usamos apenas as rotas que respondem:
//   /<user>/films/            -> 1ª página de filmes vistos
//   /<user>/watchlist/page/N/ -> watchlist completa
//   /<user>/following/        -> 1ª página de quem o usuário segue
//   /<user>/followers/        -> 1ª página de seguidores
//   /<user>/film/<slug>/      -> 200 se o usuário registrou o filme, 404 se não
//   /film/<slug>/             -> dados do filme (gêneros, pôster, ano...)

const https = require('https');

const BASE = 'https://letterboxd.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MAX_CONCURRENT = 4;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_WATCHLIST_PAGES = 6;

const GENRES = {
  action: 'Ação',
  adventure: 'Aventura',
  animation: 'Animação',
  comedy: 'Comédia',
  crime: 'Crime',
  documentary: 'Documentário',
  drama: 'Drama',
  family: 'Família',
  fantasy: 'Fantasia',
  history: 'História',
  horror: 'Terror',
  music: 'Música',
  mystery: 'Mistério',
  romance: 'Romance',
  'science-fiction': 'Ficção científica',
  thriller: 'Suspense',
  'tv-movie': 'Filme para TV',
  war: 'Guerra',
  western: 'Faroeste',
};

class LetterboxdError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// --- HTTP com limite de concorrência e cache ---------------------------------

let active = 0;
const queue = [];

function withSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          if (queue.length) queue.shift()();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      BASE + path,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const cache = new Map();

async function get(path) {
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await withSlot(async () => {
    let res = await rawGet(path);
    // 429/5xx costumam ser passageiros: uma nova tentativa após uma pausa
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await rawGet(path);
    }
    return res;
  });

  if (value.status === 200 || value.status === 404) {
    cache.set(path, { value, expires: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

// --- Parsing -----------------------------------------------------------------

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Itens de grade de pôsteres (filmes vistos, watchlist)
function parsePosterGrid(html) {
  const films = [];
  const re = /data-item-slug="([^"]+)"[^>]*?data-item-name="([^"]*)"|data-item-name="([^"]*)"[^>]*?data-item-slug="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1] || m[4];
    const name = decodeEntities(m[2] || m[3] || slug);
    films.push({ slug, name });
  }
  // Fallback caso a ordem/forma dos atributos mude
  if (!films.length) {
    const slugRe = /data-item-slug="([^"]+)"/g;
    while ((m = slugRe.exec(html))) films.push({ slug: m[1], name: m[1] });
  }
  return films;
}

function parseUserList(html) {
  const users = new Set();
  const re = /<a href="\/([A-Za-z0-9_]+)\/" class="name"/g;
  let m;
  while ((m = re.exec(html))) users.add(m[1]);
  return [...users];
}

function lastPage(html) {
  let max = 1;
  const re = /\/page\/(\d+)\/"/g;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return max;
}

function parseFilm(html, slug) {
  const film = { slug, url: `${BASE}/film/${slug}/`, genres: [] };

  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const data = JSON.parse(
        ld[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\//, '').trim()
      );
      film.title = data.name;
      film.poster = data.image;
      film.description = data.description;
      film.directors = (data.director || []).map((d) => d.name);
      if (data.releasedEvent && data.releasedEvent[0]) film.year = data.releasedEvent[0].startDate;
      if (data.aggregateRating) film.rating = data.aggregateRating.ratingValue;
    } catch (_) {
      /* segue com os metadados do og:title */
    }
  }

  const og = html.match(/<meta property="og:title" content="([^"]*)"/);
  if (og) {
    const t = decodeEntities(og[1]);
    const y = t.match(/\((\d{4})\)\s*$/);
    if (!film.title) film.title = t.replace(/\s*\(\d{4}\)\s*$/, '');
    if (!film.year && y) film.year = y[1];
  }
  if (!film.description) {
    const d = html.match(/<meta property="og:description" content="([^"]*)"/);
    if (d) film.description = decodeEntities(d[1]);
  }

  const genres = new Set();
  const re = /href="\/films\/genre\/([a-z-]+)\/"/g;
  let m;
  while ((m = re.exec(html))) genres.add(m[1]);
  film.genres = [...genres];
  return film;
}

// --- API de alto nível ---------------------------------------------------------

function normalizeUsername(input) {
  const s = String(input || '').trim();
  const fromUrl = s.match(/letterboxd\.com\/([A-Za-z0-9_]+)/i);
  const name = (fromUrl ? fromUrl[1] : s).replace(/^@/, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9_]+$/.test(name) ? name : null;
}

async function getRecentFilms(user) {
  const res = await get(`/${user}/films/`);
  if (res.status === 404) throw new LetterboxdError(`Usuário "${user}" não encontrado no Letterboxd.`, 404);
  if (res.status !== 200) throw new LetterboxdError(`O Letterboxd recusou o acesso (HTTP ${res.status}). Tente novamente em instantes.`, 502);
  return parsePosterGrid(res.body);
}

async function getWatchlist(user) {
  const first = await get(`/${user}/watchlist/`);
  if (first.status !== 200) return []; // watchlist privada ou bloqueada
  const films = parsePosterGrid(first.body);
  const pages = Math.min(lastPage(first.body), MAX_WATCHLIST_PAGES);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => get(`/${user}/watchlist/page/${i + 2}/`))
  );
  for (const r of rest) if (r.status === 200) films.push(...parsePosterGrid(r.body));
  return films;
}

async function getNetwork(user) {
  const [following, followers] = await Promise.all([get(`/${user}/following/`), get(`/${user}/followers/`)]);
  const set = new Set();
  if (following.status === 200) parseUserList(following.body).forEach((u) => set.add(u));
  if (followers.status === 200) parseUserList(followers.body).forEach((u) => set.add(u));
  set.delete(user);
  return [...set];
}

async function getFilm(slug) {
  const res = await get(`/film/${slug}/`);
  if (res.status !== 200) return null;
  return parseFilm(res.body, slug);
}

async function hasWatched(user, slug) {
  const res = await get(`/${user}/film/${slug}/`);
  if (res.status === 404) return false;
  if (res.status === 200) return true;
  return null; // indeterminado (bloqueio): tratamos como "não confirmar"
}

module.exports = {
  GENRES,
  LetterboxdError,
  normalizeUsername,
  getRecentFilms,
  getWatchlist,
  getNetwork,
  getFilm,
  hasWatched,
};
