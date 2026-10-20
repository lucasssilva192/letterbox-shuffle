const express = require('express');
const path = require('path');
const lb = require('./src/letterboxd');
const filters = require('./src/filters');
const justwatch = require('./src/justwatch');

const PORT = process.env.PORT || 3000;
const CHECK_WORKERS = 10;
const MAX_FILM_CHECKS = 400;
const ENOUGH_MATCHES = 80; // para de verificar filmes quando já tem o bastante
const MAX_RESULTS = 30;
const SEARCH_BUDGET_MS = 90 * 1000; // passado isso, responde com o que já achou
const HEARTBEAT_MS = 10 * 1000;

// Listas oficiais do Letterboxd com o recorte que cada uma cobre, para
// priorizar as que combinam com os filtros. As listas descobertas em
// /official/lists/ e /lists/popular/ entram como fontes gerais.
const RANKED_LISTS = [
  { path: '/official/list/letterboxds-top-500-films/' },
  { path: '/official/list/top-250-horror-films/', genre: 'horror' },
  { path: '/official/list/top-250-animated-films/', genre: 'animation' },
  { path: '/official/list/top-250-documentary-films/', genre: 'documentary' },
  { path: '/official/list/top-250-science-fiction-films/', genre: 'science-fiction' },
  { path: '/official/list/top-50-underseen-science-fiction-films/', genre: 'science-fiction' },
  { path: '/official/list/top-250-war-films/', genre: 'war' },
  { path: '/official/list/top-250-films-of-the-1980s/', decade: 1980 },
  { path: '/official/list/top-250-films-of-the-1990s/', decade: 1990 },
  { path: '/official/list/top-250-films-of-the-2010s/', decade: 2010 },
  { path: '/official/list/top-250-films-of-the-2020s/', decade: 2020 },
  { path: '/official/list/top-250-brazilian-films/', countries: ['brazil'] },
  { path: '/official/list/top-50-finnish-films/', countries: ['finland'] },
  {
    path: '/official/list/top-250-latin-american-films/',
    countries: ['argentina', 'brazil', 'chile', 'colombia', 'mexico'],
  },
];

// Origens que podem chamar a API de outro domínio (o site no GitHub Pages)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lucasssilva192.github.io')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/options', (req, res) => {
  res.json({
    genres: Object.entries(lb.GENRES).map(([slug, label]) => ({ slug, label })),
    countries: Object.entries(lb.COUNTRIES)
      .map(([slug, label]) => ({ slug, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    decades: filters.DECADES,
    regions: Object.entries(justwatch.REGIONS).map(([code, label]) => ({ code, label })),
  });
});

app.get('/api/watch', async (req, res) => {
  const region = String(req.query.region || 'BR').toUpperCase();
  if (!justwatch.REGIONS[region]) return res.status(400).json({ message: 'Região inválida.' });
  try {
    const film = await lb.getFilm(String(req.query.slug || ''));
    if (!film) return res.status(404).json({ message: 'Filme não encontrado.' });
    res.json({ region, availability: await justwatch.getAvailability(film, region) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ message: 'Não foi possível consultar onde assistir agora.' });
  }
});

// Server-Sent Events: a busca leva alguns segundos, então enviamos o progresso.
// O heartbeat mantém a conexão viva em proxies e deixa o cliente saber que o
// servidor continua trabalhando.
function openStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const stream = { closed: false, started: Date.now() };
  const heartbeat = setInterval(() => !stream.closed && res.write(': ping\n\n'), HEARTBEAT_MS);
  res.on('close', () => {
    stream.closed = true;
    clearInterval(heartbeat);
  });
  stream.overBudget = () => Date.now() - stream.started > SEARCH_BUDGET_MS;
  stream.send = (event, data) => !stream.closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  stream.progress = (message, extra = {}) => stream.send('progress', { message, ...extra });
  stream.end = (event, data) => {
    stream.send(event, data);
    res.end();
  };
  stream.fail = (err) => {
    if (!(err instanceof lb.LetterboxdError)) console.error(err);
    stream.end('error', {
      message: err instanceof lb.LetterboxdError ? err.message : 'Erro inesperado ao consultar o Letterboxd.',
    });
  };
  return stream;
}

function listRelevance(list, f) {
  let score = 0;
  if (list.genre) score += list.genre === f.genre ? 3 : -10;
  if (list.decade) {
    const filtered = f.from !== null || f.to !== null;
    const overlaps = (f.from === null || list.decade + 9 >= f.from) && (f.to === null || list.decade <= f.to);
    score += overlaps && filtered ? 3 : -10;
  }
  if (list.countries) score += list.countries.includes(f.country) ? 3 : -10;
  return score;
}

// Busca unificada: as fontes (rede e/ou listas públicas) entram como filtro
app.get('/api/search', async (req, res) => {
  const stream = openStream(req, res);
  const { progress } = stream;

  try {
    const f = filters.parseFilters(req.query);
    const sources = new Set(String(req.query.sources || 'lists').split(',').filter((s) => s === 'lists' || s === 'network'));
    const user = req.query.user ? lb.normalizeUsername(req.query.user) : null;
    const hideWatched = Boolean(user) && req.query.hideWatched !== '0';

    if (!sources.size) throw new lb.LetterboxdError('Escolha onde buscar: listas públicas, sua rede ou as duas.', 400);
    if (req.query.user && !user) throw new lb.LetterboxdError('Informe um usuário válido do Letterboxd.', 400);
    if (sources.has('network') && !user) {
      throw new lb.LetterboxdError('Para buscar na sua rede, informe seu usuário do Letterboxd.', 400);
    }

    let ownSeen = new Set();
    if (user) {
      progress(`Conectando ao perfil de ${user}...`);
      ownSeen = new Set((await lb.getRecentFilms(user)).map((film) => film.slug));
    }

    const candidates = new Map();
    const candidate = (film) => {
      let c = candidates.get(film.slug);
      if (!c) candidates.set(film.slug, (c = { slug: film.slug, priority: 0, lists: 0, watchlist: [], watched: [] }));
      return c;
    };
    const skip = (film) => (hideWatched && ownSeen.has(film.slug)) || !filters.yearMatches(film.year, f);

    const tasks = [];
    if (sources.has('network')) {
      progress('Buscando quem você segue e quem te segue...');
      const friends = await lb.getNetwork(user);
      if (!friends.length && sources.size === 1) {
        throw new lb.LetterboxdError('Não encontramos pessoas que você segue ou que te seguem neste perfil.', 404);
      }
      for (const friend of friends) {
        tasks.push(async () => {
          const [watchlist, watched] = await Promise.all([
            lb.getWatchlist(friend).catch(() => []),
            lb.getRecentFilms(friend).catch(() => []),
          ]);
          const add = (film, kind) => {
            if (skip(film)) return;
            const c = candidate(film);
            if (c[kind].includes(friend)) return;
            c[kind].push(friend);
            c.priority += 2 + Math.random(); // o acaso varia os resultados entre buscas
          };
          watchlist.forEach((film) => add(film, 'watchlist'));
          watched.forEach((film) => add(film, 'watched'));
        });
      }
    }

    if (sources.has('lists')) {
      progress('Procurando listas públicas...');
      const discovered = await lb.discoverLists();
      const known = new Set(RANKED_LISTS.map((l) => l.path));
      const lists = [
        ...RANKED_LISTS.map((l) => ({ ...l, ranked: true, score: listRelevance(l, f) })).filter((l) => l.score >= 0),
        ...discovered.official.filter((p) => !known.has(p)).map((p) => ({ path: p, ranked: true, score: 0 })),
        ...discovered.popular.filter((p) => !known.has(p)).map((p) => ({ path: p, ranked: false, score: 0 })),
      ];
      for (const list of lists) {
        tasks.push(async () => {
          const films = await lb.getList(list.path, list.ranked ? 5 : 2).catch(() => []);
          films.forEach((film, idx) => {
            if (skip(film)) return;
            const c = candidate(film);
            c.lists++;
            c.priority += 1 + list.score + (list.ranked ? 2 * (1 - idx / films.length) : 0);
          });
        });
      }
    }

    let done = 0;
    const label = sources.size === 2 ? 'sua rede e listas públicas' : sources.has('network') ? 'sua rede' : 'listas públicas';
    progress(`Lendo ${label}...`, { current: 0, total: tasks.length });
    await Promise.all(
      tasks.map((task) =>
        task().finally(() => {
          done++;
          progress(`Lendo ${label}...`, { current: done, total: tasks.length });
        })
      )
    );
    if (stream.closed) return;

    const ordered = [...candidates.values()].sort((a, b) => b.priority - a.priority);
    const total = Math.min(ordered.length, MAX_FILM_CHECKS);
    const wanted = filters.describe(f);
    progress(`${ordered.length} filmes encontrados. Verificando ${wanted}...`, { current: 0, total });

    // Pool de workers: cada um pega o próximo filme assim que termina o
    // anterior, sem esperar o mais lento de um lote
    const matches = [];
    let next = 0;
    let checked = 0;
    const keepGoing = () =>
      next < total && matches.length < ENOUGH_MATCHES && !stream.closed && !stream.overBudget();
    await Promise.all(
      Array.from({ length: CHECK_WORKERS }, async () => {
        while (keepGoing()) {
          const c = ordered[next++];
          const film = await lb.getFilm(c.slug).catch(() => null);
          if (filters.filmMatches(film, f)) matches.push({ film, source: c });
          checked++;
          if (checked % 10 === 0) {
            progress(`Verificando filmes... ${matches.length} combinam com os filtros`, { current: checked, total });
          }
        }
      })
    );
    if (stream.closed) return;
    const partial = stream.overBudget();

    matches.sort((a, b) => (b.film.rating || 0) - (a.film.rating || 0));

    // A 1ª página de filmes vistos só cobre os recentes: confirma cada filme,
    // em paralelo, na ordem da nota, até ter resultados suficientes
    let unwatched = matches;
    if (hideWatched && matches.length) {
      progress('Conferindo quais você já viu...');
      unwatched = [];
      for (let i = 0; i < matches.length && unwatched.length < MAX_RESULTS && !stream.closed; i += CHECK_WORKERS) {
        const slice = matches.slice(i, i + CHECK_WORKERS);
        const seen = await Promise.all(slice.map((m) => lb.hasWatched(user, m.film.slug).catch(() => null)));
        slice.forEach((m, j) => seen[j] !== true && unwatched.push(m));
      }
    }
    if (stream.closed) return;

    const results = unwatched.slice(0, MAX_RESULTS).map((m) => ({
      ...filters.enrich(m.film),
      lists: m.source.lists,
      watchlist: m.source.watchlist,
      watched: m.source.watched,
    }));

    if (!results.length) {
      throw new lb.LetterboxdError(`Nenhum filme encontrado (${wanted}) em ${label}. Tente afrouxar os filtros.`, 404);
    }
    stream.end('done', {
      films: results,
      stats: { candidates: ordered.length, checked, partial },
    });
  } catch (err) {
    stream.fail(err);
  }
});

app.listen(PORT, () => console.log(`Letterbox Shuffle rodando em http://localhost:${PORT}`));
