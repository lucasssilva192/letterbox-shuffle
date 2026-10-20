// Coleta de dados do Letterboxd via HTML público (não há API pública).
// O Cloudflare do site bloqueia algumas rotas (perfil, paginação de /films/,
// filtros de catálogo), então usamos apenas as rotas que respondem:
//   /<user>/films/            -> 1ª página de filmes vistos
//   /<user>/watchlist/page/N/ -> watchlist completa
//   /<user>/following/        -> 1ª página de quem o usuário segue
//   /<user>/followers/        -> 1ª página de seguidores
//   /<user>/film/<slug>/      -> 200 se o usuário registrou o filme, 404 se não
//   /<user>/list/<slug>/page/N/ -> listas públicas
//   /official/lists/, /lists/popular/ -> descoberta de listas
//   /film/<slug>/             -> dados do filme (gêneros, países, nota, ano...)

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

// Identificadores usados pelo Letterboxd em /films/country/<slug>/
const COUNTRIES = {
  argentina: 'Argentina',
  australia: 'Austrália',
  belgium: 'Bélgica',
  brazil: 'Brasil',
  canada: 'Canadá',
  chile: 'Chile',
  china: 'China',
  colombia: 'Colômbia',
  'south-korea': 'Coreia do Sul',
  denmark: 'Dinamarca',
  spain: 'Espanha',
  usa: 'Estados Unidos',
  finland: 'Finlândia',
  france: 'França',
  'hong-kong': 'Hong Kong',
  india: 'Índia',
  iran: 'Irã',
  ireland: 'Irlanda',
  italy: 'Itália',
  japan: 'Japão',
  mexico: 'México',
  norway: 'Noruega',
  'new-zealand': 'Nova Zelândia',
  poland: 'Polônia',
  portugal: 'Portugal',
  uk: 'Reino Unido',
  germany: 'Alemanha',
  russia: 'Rússia',
  sweden: 'Suécia',
  taiwan: 'Taiwan',
  turkey: 'Turquia',
  ussr: 'União Soviética',
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

// O cache guarda só o resultado do parse: o HTML de cada página ocupa
// centenas de KB e estouraria a memória do plano gratuito do Render.
const MAX_CACHE_ENTRIES = 20000;
const cache = new Map();

// Retorna { status, data }, com data = parse(html) quando a página responde 200
async function get(path, parse = () => null) {
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now()) return hit.value;

  const res = await withSlot(async () => {
    let r = await rawGet(path);
    // 429/5xx costumam ser passageiros: uma nova tentativa após uma pausa
    if (r.status === 429 || r.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      r = await rawGet(path);
    }
    return r;
  });

  // A ida e volta pelo JSON copia as strings: trechos extraídos por regex
  // podem manter o HTML inteiro vivo na memória (sliced strings do V8).
  const data = res.status === 200 ? JSON.parse(JSON.stringify(parse(res.body)) ?? 'null') : null;
  const value = { status: res.status, data };
  if (value.status === 200 || value.status === 404) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
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

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

// Itens de grade de pôsteres (filmes vistos, watchlist, listas). O nome vem
// como "Título (2017)", o que permite filtrar por ano sem abrir o filme.
function parsePosterGrid(html) {
  const films = [];
  const seen = new Set();
  const re = /<[^>]*data-item-slug="[^"]+"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const slug = attr(tag, 'data-item-slug');
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = attr(tag, 'data-item-full-display-name') || attr(tag, 'data-item-name') || slug;
    const y = name.match(/\((\d{4})\)\s*$/);
    films.push({ slug, name, year: y ? Number(y[1]) : null });
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

function parseListLinks(html) {
  const lists = new Set();
  const re = /href="(\/[A-Za-z0-9_]+\/list\/[^"/]+\/)"/g;
  let m;
  while ((m = re.exec(html))) lists.add(m[1]);
  return [...lists];
}

function lastPage(html) {
  let max = 1;
  const re = /\/page\/(\d+)\/"/g;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return max;
}

function parseFilm(html, slug) {
  const film = { slug, url: `${BASE}/film/${slug}/`, genres: [], countries: [] };

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
      if (data.releasedEvent && data.releasedEvent[0]) film.year = Number(data.releasedEvent[0].startDate);
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
    if (!film.year && y) film.year = Number(y[1]);
  }
  if (!film.description) {
    const d = html.match(/<meta property="og:description" content="([^"]*)"/);
    if (d) film.description = decodeEntities(d[1]);
  }

  const collect = (kind) => {
    const set = new Set();
    const re = new RegExp(`href="/films/${kind}/([a-z-]+)/"`, 'g');
    let m;
    while ((m = re.exec(html))) set.add(m[1]);
    return [...set];
  };
  film.genres = collect('genre');
  film.countries = collect('country');
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
  const res = await get(`/${user}/films/`, parsePosterGrid);
  if (res.status === 404) throw new LetterboxdError(`Usuário "${user}" não encontrado no Letterboxd.`, 404);
  if (res.status !== 200) throw new LetterboxdError(`O Letterboxd recusou o acesso (HTTP ${res.status}). Tente novamente em instantes.`, 502);
  return res.data;
}

const parseGridPage = (html) => ({ films: parsePosterGrid(html), lastPage: lastPage(html) });

// Lê uma grade paginada (watchlist, lista) até maxPages
async function getPagedGrid(basePath, maxPages) {
  const first = await get(basePath, parseGridPage);
  if (first.status !== 200) return [];
  const films = [...first.data.films];
  const pages = Math.min(first.data.lastPage, maxPages);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => get(`${basePath}page/${i + 2}/`, parseGridPage))
  );
  for (const r of rest) if (r.status === 200) films.push(...r.data.films);
  return films;
}

function getWatchlist(user) {
  return getPagedGrid(`/${user}/watchlist/`, MAX_WATCHLIST_PAGES);
}

function getList(path, maxPages = 5) {
  return getPagedGrid(path, maxPages);
}

// Listas oficiais e populares disponíveis na 1ª página de cada índice
async function discoverLists() {
  const [official, popular] = await Promise.all([
    get('/official/lists/', parseListLinks),
    get('/lists/popular/', parseListLinks),
  ]);
  return {
    official: official.status === 200 ? official.data.filter((p) => p.startsWith('/official/')) : [],
    popular: popular.status === 200 ? popular.data : [],
  };
}

async function getNetwork(user) {
  const [following, followers] = await Promise.all([
    get(`/${user}/following/`, parseUserList),
    get(`/${user}/followers/`, parseUserList),
  ]);
  const set = new Set();
  if (following.status === 200) following.data.forEach((u) => set.add(u));
  if (followers.status === 200) followers.data.forEach((u) => set.add(u));
  set.delete(user);
  return [...set];
}

async function getFilm(slug) {
  const res = await get(`/film/${slug}/`, (html) => parseFilm(html, slug));
  return res.status === 200 ? res.data : null;
}

async function hasWatched(user, slug) {
  const res = await get(`/${user}/film/${slug}/`);
  if (res.status === 404) return false;
  if (res.status === 200) return true;
  return null; // indeterminado (bloqueio): tratamos como "não confirmar"
}

module.exports = {
  GENRES,
  COUNTRIES,
  LetterboxdError,
  normalizeUsername,
  getRecentFilms,
  getWatchlist,
  getList,
  discoverLists,
  getNetwork,
  getFilm,
  hasWatched,
};
