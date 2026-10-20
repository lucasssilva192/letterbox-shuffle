const express = require('express');
const path = require('path');
const lb = require('./src/letterboxd');

const PORT = process.env.PORT || 3000;
const MAX_FILM_CHECKS = 200;
const CHECK_BATCH = 4;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/genres', (req, res) => {
  res.json(Object.entries(lb.GENRES).map(([slug, label]) => ({ slug, label })));
});

// Ordenação aleatória ponderada: filmes presentes nas listas de mais amigos
// tendem a aparecer antes (Efraimidis–Spirakis).
function weightedShuffle(items, weightOf) {
  return items
    .map((item) => ({ item, key: Math.pow(Math.random(), 1 / weightOf(item)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

// Server-Sent Events: o processo leva alguns segundos, então enviamos o progresso
app.get('/api/shuffle', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  let closed = false;
  req.on('close', () => (closed = true));
  const send = (event, data) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const progress = (message, extra = {}) => send('progress', { message, ...extra });

  try {
    const user = lb.normalizeUsername(req.query.user);
    const genre = String(req.query.genre || '');
    const exclude = new Set(String(req.query.exclude || '').split(',').filter(Boolean));

    if (!user) throw new lb.LetterboxdError('Informe um usuário válido do Letterboxd.', 400);
    if (!lb.GENRES[genre]) throw new lb.LetterboxdError('Gênero inválido.', 400);

    progress(`Conectando ao perfil de ${user}...`);
    const ownRecent = await lb.getRecentFilms(user);
    const ownSeen = new Set(ownRecent.map((f) => f.slug));

    progress('Buscando quem você segue e quem te segue...');
    const friends = await lb.getNetwork(user);
    if (!friends.length) {
      throw new lb.LetterboxdError('Não encontramos pessoas que você segue ou que te seguem neste perfil.', 404);
    }

    const candidates = new Map();
    const add = (film, friend, kind) => {
      if (ownSeen.has(film.slug) || exclude.has(film.slug)) return;
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
        if (closed) return;
        watchlist.forEach((f) => add(f, friend, 'watchlist'));
        watched.forEach((f) => add(f, friend, 'watched'));
        done++;
        progress(`Lendo as listas de ${friends.length} pessoas...`, { current: done, total: friends.length });
      })
    );
    if (closed) return;

    const ordered = weightedShuffle([...candidates.values()], (c) => c.watchlist.length + c.watched.length);
    const genreLabel = lb.GENRES[genre];
    progress(`${ordered.length} filmes encontrados. Procurando um de ${genreLabel} que você não viu...`);

    let checked = 0;
    for (let i = 0; i < ordered.length && checked < MAX_FILM_CHECKS && !closed; i += CHECK_BATCH) {
      const batch = ordered.slice(i, i + CHECK_BATCH);
      checked += batch.length;
      const films = await Promise.all(batch.map((c) => lb.getFilm(c.slug).catch(() => null)));

      for (let j = 0; j < batch.length; j++) {
        const film = films[j];
        if (!film || !film.genres.includes(genre)) continue;
        if ((await lb.hasWatched(user, film.slug)) !== false) continue;

        send('result', {
          film: { ...film, genreLabels: film.genres.map((g) => lb.GENRES[g]).filter(Boolean) },
          watchlist: batch[j].watchlist,
          watched: batch[j].watched,
          stats: { friends: friends.length, candidates: ordered.length, checked },
        });
        return res.end();
      }
      progress(`Verificando filmes... (${checked} de ${Math.min(ordered.length, MAX_FILM_CHECKS)})`);
    }

    throw new lb.LetterboxdError(
      `Não encontramos um filme de ${genreLabel} que você ainda não viu nas listas da sua rede. Tente outro gênero.`,
      404
    );
  } catch (err) {
    console.error(err);
    send('error', { message: err instanceof lb.LetterboxdError ? err.message : 'Erro inesperado ao consultar o Letterboxd.' });
    res.end();
  }
});

app.listen(PORT, () => console.log(`Letterbox Shuffle rodando em http://localhost:${PORT}`));
