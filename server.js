const express = require('express');
const path = require('path');
const lb = require('./src/letterboxd');
const filters = require('./src/filters');

const PORT = process.env.PORT || 3000;
const MAX_FILM_CHECKS = 200;
const CHECK_BATCH = 4;
const TOP_MAX_FILM_CHECKS = 400;
const TOP_RESULTS = 24;

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

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/options', (req, res) => {
  res.json({
    genres: Object.entries(lb.GENRES).map(([slug, label]) => ({ slug, label })),
    countries: Object.entries(lb.COUNTRIES)
      .map(([slug, label]) => ({ slug, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    decades: filters.DECADES,
  });
});

// Ordenação aleatória ponderada: filmes presentes nas listas de mais amigos
// tendem a aparecer antes (Efraimidis–Spirakis).
function weightedShuffle(items, weightOf) {
  return items
    .map((item) => ({ item, key: Math.pow(Math.random(), 1 / weightOf(item)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

// Server-Sent Events: as buscas levam alguns segundos, então enviamos o progresso
function openStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const stream = { closed: false };
  req.on('close', () => (stream.closed = true));
  stream.send = (event, data) => !stream.closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  stream.progress = (message, extra = {}) => stream.send('progress', { message, ...extra });
  stream.fail = (err) => {
    console.error(err);
    stream.send('error', {
      message: err instanceof lb.LetterboxdError ? err.message : 'Erro inesperado ao consultar o Letterboxd.',
    });
    res.end();
  };
  return stream;
}

// --- Aba "Da minha rede" -------------------------------------------------------

app.get('/api/shuffle', async (req, res) => {
  const stream = openStream(req, res);
  const { progress, send } = stream;

  try {
    const user = lb.normalizeUsername(req.query.user);
    const f = filters.parseFilters(req.query);
    const exclude = new Set(String(req.query.exclude || '').split(',').filter(Boolean));
    if (!user) throw new lb.LetterboxdError('Informe um usuário válido do Letterboxd.', 400);

    progress(`Conectando ao perfil de ${user}...`);
    const ownRecent = await lb.getRecentFilms(user);
    const ownSeen = new Set(ownRecent.map((film) => film.slug));

    progress('Buscando quem você segue e quem te segue...');
    const friends = await lb.getNetwork(user);
    if (!friends.length) {
      throw new lb.LetterboxdError('Não encontramos pessoas que você segue ou que te seguem neste perfil.', 404);
    }

    const candidates = new Map();
    const add = (film, friend, kind) => {
      if (ownSeen.has(film.slug) || exclude.has(film.slug) || !filters.yearMatches(film.year, f)) return;
      let c = candidates.get(film.slug);
      if (!c) candidates.set(film.slug, (c = { slug: film.slug, name: film.name, watchlist: [], watched: [] }));
      if (!c[kind].includes(friend)) c[kind].push(friend);
    };

    let done = 0;
    progress(`Lendo as listas de ${friends.length} pessoas...`, { current: 0, total: friends.length });
    await Promise.all(
      friends.map(async (friend) => {
        const [watchlist, watched] = await Promise.all([
          lb.getWatchlist(friend).catch(() => []),
          lb.getRecentFilms(friend).catch(() => []),
        ]);
        if (stream.closed) return;
        watchlist.forEach((film) => add(film, friend, 'watchlist'));
        watched.forEach((film) => add(film, friend, 'watched'));
        done++;
        progress(`Lendo as listas de ${friends.length} pessoas...`, { current: done, total: friends.length });
      })
    );
    if (stream.closed) return;

    const ordered = weightedShuffle([...candidates.values()], (c) => c.watchlist.length + c.watched.length);
    const label = filters.describe(f);
    progress(`${ordered.length} filmes encontrados. Procurando ${label} que você não viu...`);

    let checked = 0;
    for (let i = 0; i < ordered.length && checked < MAX_FILM_CHECKS && !stream.closed; i += CHECK_BATCH) {
      const batch = ordered.slice(i, i + CHECK_BATCH);
      checked += batch.length;
      const films = await Promise.all(batch.map((c) => lb.getFilm(c.slug).catch(() => null)));

      for (let j = 0; j < batch.length; j++) {
        const film = films[j];
        if (!filters.filmMatches(film, f)) continue;
        if ((await lb.hasWatched(user, film.slug)) !== false) continue;

        send('result', {
          film: filters.enrich(film),
          watchlist: batch[j].watchlist,
          watched: batch[j].watched,
          stats: { friends: friends.length, candidates: ordered.length, checked },
        });
        return res.end();
      }
      progress(`Verificando filmes... (${checked} de ${Math.min(ordered.length, MAX_FILM_CHECKS)})`);
    }

    throw new lb.LetterboxdError(
      `Não encontramos um filme (${label}) que você ainda não viu nas listas da sua rede. Tente afrouxar os filtros.`,
      404
    );
  } catch (err) {
    stream.fail(err);
  }
});

// --- Aba "Top geral" -----------------------------------------------------------

function listRelevance(list, f) {
  let score = 0;
  if (list.genre) score += list.genre === f.genre ? 3 : -10;
  if (list.decade) {
    const overlaps = (f.from === null || list.decade + 9 >= f.from) && (f.to === null || list.decade <= f.to);
    score += overlaps && (f.from !== null || f.to !== null) ? 3 : overlaps ? -1 : -10;
  }
  if (list.countries) score += list.countries.includes(f.country) ? 3 : -10;
  return score;
}

app.get('/api/top', async (req, res) => {
  const stream = openStream(req, res);
  const { progress, send } = stream;

  try {
    const f = filters.parseFilters(req.query);
    const user = req.query.user ? lb.normalizeUsername(req.query.user) : null;
    const hideWatched = req.query.hideWatched === '1';
    if (req.query.user && !user) throw new lb.LetterboxdError('Informe um usuário válido do Letterboxd.', 400);
    if (hideWatched && !user) throw new lb.LetterboxdError('Para ocultar os filmes que você já viu, informe seu usuário.', 400);

    let ownSeen = new Set();
    if (user) {
      progress(`Conectando ao perfil de ${user}...`);
      ownSeen = new Set((await lb.getRecentFilms(user)).map((film) => film.slug));
    }

    progress('Procurando listas públicas...');
    const discovered = await lb.discoverLists();
    const known = new Set(RANKED_LISTS.map((l) => l.path));
    const sources = [
      ...RANKED_LISTS.map((l) => ({ ...l, ranked: true, score: listRelevance(l, f) })).filter((l) => l.score >= 0),
      ...discovered.official.filter((p) => !known.has(p)).map((p) => ({ path: p, ranked: true, score: 0 })),
      ...discovered.popular.filter((p) => !known.has(p)).map((p) => ({ path: p, ranked: false, score: -1 })),
    ].sort((a, b) => b.score - a.score);

    // Prioridade de cada filme: aparecer em várias listas e no topo de listas
    // ordenadas por nota faz com que ele seja verificado antes.
    const candidates = new Map();
    let done = 0;
    progress(`Lendo ${sources.length} listas públicas...`, { current: 0, total: sources.length });
    await Promise.all(
      sources.map(async (source) => {
        const films = await lb.getList(source.path, source.ranked ? 5 : 2).catch(() => []);
        if (stream.closed) return;
        films.forEach((film, idx) => {
          if (!filters.yearMatches(film.year, f)) return;
          let c = candidates.get(film.slug);
          if (!c) candidates.set(film.slug, (c = { slug: film.slug, priority: 0, lists: 0 }));
          c.lists++;
          c.priority += 1 + Math.max(source.score, 0) + (source.ranked ? 2 * (1 - idx / films.length) : 0);
        });
        done++;
        progress(`Lendo ${sources.length} listas públicas...`, { current: done, total: sources.length });
      })
    );
    if (stream.closed) return;

    const ordered = [...candidates.values()].sort((a, b) => b.priority - a.priority);
    const total = Math.min(ordered.length, TOP_MAX_FILM_CHECKS);
    const label = filters.describe(f);
    progress(`${ordered.length} filmes nas listas. Verificando ${label}...`, { current: 0, total });

    const matches = [];
    for (let i = 0; i < total && !stream.closed; i += CHECK_BATCH * 2) {
      const batch = ordered.slice(i, Math.min(i + CHECK_BATCH * 2, total));
      const films = await Promise.all(batch.map((c) => lb.getFilm(c.slug).catch(() => null)));
      films.forEach((film, j) => {
        if (filters.filmMatches(film, f) && !ownSeen.has(film.slug)) matches.push({ film, lists: batch[j].lists });
      });
      progress(`Verificando filmes... ${matches.length} encontrados`, { current: i + batch.length, total });
    }
    if (stream.closed) return;

    matches.sort((a, b) => (b.film.rating || 0) - (a.film.rating || 0));

    const results = [];
    for (const m of matches) {
      if (results.length >= TOP_RESULTS || stream.closed) break;
      if (hideWatched && (await lb.hasWatched(user, m.film.slug)) !== false) continue;
      results.push({ ...filters.enrich(m.film), lists: m.lists });
    }

    if (!results.length) {
      throw new lb.LetterboxdError(`Nenhum filme encontrado nas listas públicas para: ${label}. Tente afrouxar os filtros.`, 404);
    }
    send('top', { films: results, stats: { lists: sources.length, candidates: ordered.length, checked: total } });
    res.end();
  } catch (err) {
    stream.fail(err);
  }
});

app.listen(PORT, () => console.log(`Letterbox Shuffle rodando em http://localhost:${PORT}`));
