const $ = (id) => document.getElementById(id);
const API = window.API_BASE || '';

const IDLE_TIMEOUT_MS = 45 * 1000; // o servidor manda um ping a cada 10 s
const WAKE_NOTICE_MS = 3000;

const form = $('form');
const userInput = $('user');
const submitBtn = $('submit');
const againBtn = $('again');

const state = {
  genre: '',
  period: 'any',
  results: [], // filmes da última busca, ordenados por nota
  featured: null,
  shown: new Set(), // já sorteados nesta busca, para "Sortear outro" não repetir
  controller: null,
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
};

// --- Opções do formulário ------------------------------------------------------

userInput.value = storage.get('lb-user') || '';

// No plano gratuito do Render o servidor dorme quando fica parado; esta
// primeira chamada já o acorda enquanto a pessoa preenche os filtros.
fetch(`${API}/api/options`)
  .then((r) => r.json())
  .then(({ genres, countries, decades, regions }) => {
    addChip('', 'Qualquer');
    for (const g of genres) addChip(g.slug, g.label);
    selectGenre('');
    for (const d of decades) $('decade').add(new Option(`Anos ${String(d).slice(2)} (${d}–${d + 9})`, d));
    for (const c of countries) $('country').add(new Option(c.label, c.slug));
    for (const r of regions) $('region').add(new Option(r.label, r.code));
    $('region').value = storage.get('lb-region') || 'BR';
  })
  .catch(() => showError('Não foi possível carregar as opções. O servidor pode estar ligando: aguarde alguns segundos e recarregue a página.'));

function addChip(slug, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.slug = slug;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => selectGenre(slug));
  $('genres').appendChild(b);
}

function selectGenre(slug) {
  state.genre = slug;
  for (const b of $('genres').children) b.setAttribute('aria-checked', String(b.dataset.slug === slug));
}

// Período: década OU intervalo de anos; trocar de modo limpa o outro
function selectPeriod(period) {
  state.period = period;
  for (const b of document.querySelectorAll('[data-period]')) {
    b.setAttribute('aria-checked', String(b.dataset.period === period));
  }
  $('period-decade').hidden = period !== 'decade';
  $('period-range').hidden = period !== 'range';
  if (period !== 'range') $('yearFrom').value = $('yearTo').value = '';
}
for (const b of document.querySelectorAll('[data-period]')) {
  b.addEventListener('click', () => selectPeriod(b.dataset.period));
}

function syncUserRequirements() {
  const hasUser = Boolean(userInput.value.trim());
  const network = $('src-network').checked;
  $('user-hint').textContent = network ? '(obrigatório para buscar na sua rede)' : '(opcional)';
  $('hideWatched').disabled = !hasUser;
  $('hideWatched').closest('.check').classList.toggle('disabled', !hasUser);
}
userInput.addEventListener('input', syncUserRequirements);
$('src-network').addEventListener('change', syncUserRequirements);
syncUserRequirements();

$('region').addEventListener('change', () => {
  storage.set('lb-region', $('region').value);
  if (state.featured) loadWatch(state.featured);
});

$('clear').addEventListener('click', () => {
  for (const id of ['minRating', 'country']) $(id).value = '';
  selectPeriod('any');
  selectGenre('');
});

// --- Telas --------------------------------------------------------------------

function show(section) {
  for (const id of ['status', 'error', 'results']) $(id).hidden = id !== section;
}

function showError(message) {
  show('error');
  $('error').textContent = message;
}

function setStatus(message, progress) {
  $('status-text').textContent = message;
  if (progress && progress.total) $('bar-fill').style.width = `${(progress.current / progress.total) * 100}%`;
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  againBtn.disabled = busy;
}

// --- Busca --------------------------------------------------------------------

function buildParams() {
  const sources = ['src-lists', 'src-network'].filter((id) => $(id).checked).map((id) => $(id).value);
  const user = userInput.value.trim();
  const params = new URLSearchParams({ sources: sources.join(','), genre: state.genre });
  if (user) params.set('user', user);
  if (user && !$('hideWatched').checked) params.set('hideWatched', '0');
  for (const id of ['minRating', 'country']) if ($(id).value) params.set(id, $(id).value);
  if (state.period === 'decade') params.set('decade', $('decade').value);
  if (state.period === 'range') {
    if ($('yearFrom').value) params.set('yearFrom', $('yearFrom').value);
    if ($('yearTo').value) params.set('yearTo', $('yearTo').value);
  }
  return { params, sources, user };
}

function validate({ sources, user }) {
  if (!sources.length) return 'Escolha onde buscar: listas públicas, sua rede ou as duas.';
  if (sources.includes('network') && !user) return 'Para buscar na sua rede, informe seu usuário do Letterboxd.';
  if (state.period === 'range') {
    const from = Number($('yearFrom').value);
    const to = Number($('yearTo').value);
    if (!from && !to) return 'Informe pelo menos um dos anos do intervalo, ou escolha outro tipo de período.';
    if (from && to && from > to) return 'O ano inicial deve ser menor ou igual ao ano final.';
  }
  return null;
}

// Lê o stream de Server-Sent Events com fetch. Diferente do EventSource, não
// reconecta sozinho (o que reiniciava a busca em loop) e permite detectar
// silêncio e cancelar.
async function streamEvents(url, signal, onEvent) {
  const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let idleTimer;
    const idle = new Promise((_, reject) => {
      idleTimer = setTimeout(() => reject(new Error('idle')), IDLE_TIMEOUT_MS);
    });
    const { value, done } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(idleTimer));
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data && onEvent(event, JSON.parse(data)) === false) {
        reader.cancel().catch(() => {});
        return;
      }
    }
  }
}

async function wakeServer(signal) {
  const notice = setTimeout(
    () => setStatus('O servidor estava em repouso e está ligando. Isso pode levar até 1 minuto...'),
    WAKE_NOTICE_MS
  );
  try {
    await fetch(`${API}/healthz`, { signal, cache: 'no-store' });
  } finally {
    clearTimeout(notice);
  }
}

async function search() {
  const request = buildParams();
  const invalid = validate(request);
  if (invalid) return showError(invalid);
  if (request.user) storage.set('lb-user', request.user);

  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;

  setBusy(true);
  show('status');
  setStatus('Conectando ao servidor...');
  $('bar-fill').style.width = '0';

  let finished = false;
  try {
    await wakeServer(controller.signal);
    setStatus('Começando a busca...');
    await streamEvents(`${API}/api/search?${request.params}`, controller.signal, (event, data) => {
      if (event === 'progress') setStatus(data.message, data);
      else if (event === 'done') {
        finished = true;
        renderResults(data);
        return false;
      } else if (event === 'error') {
        finished = true;
        showError(data.message);
        return false;
      }
    });
    if (!finished) showError('A conexão com o servidor terminou antes do resultado. Tente buscar de novo.');
  } catch (err) {
    if (controller.signal.aborted) return; // cancelada pela pessoa ou por uma nova busca
    showError(
      err.message === 'idle'
        ? 'O servidor parou de responder. Tente de novo em alguns segundos.'
        : 'Não foi possível falar com o servidor. Confira sua conexão e tente de novo.'
    );
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      setBusy(false);
    }
  }
}

$('cancel').addEventListener('click', () => {
  if (state.controller) state.controller.abort();
  show(state.results.length ? 'results' : null);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  search();
});

// --- Resultado ----------------------------------------------------------------

function ratingText(film) {
  return film.rating ? `★ ${Number(film.rating).toFixed(2).replace('.', ',')}` : 'sem nota';
}

function profileLinks(users) {
  return users
    .map((u) => `<a href="https://letterboxd.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener">${escapeHtml(u)}</a>`)
    .join(', ');
}

function why(film) {
  const parts = [];
  const friends = new Set([...film.watchlist, ...film.watched]).size;
  if (friends) parts.push(`${friends} ${friends === 1 ? 'pessoa' : 'pessoas'} da sua rede`);
  if (film.lists) parts.push(`${film.lists} ${film.lists === 1 ? 'lista pública' : 'listas públicas'}`);
  return parts.join(' · ');
}

function renderResults({ films, stats }) {
  state.results = films;
  state.shown = new Set();
  $('ranking-summary').textContent =
    `${films.length} de ${stats.candidates} filmes encontrados, por nota no Letterboxd` +
    (stats.partial ? ' (busca encerrada pelo tempo limite)' : '');
  $('ranking').innerHTML = films
    .map(
      (film, i) => `
      <li>
        <button type="button" class="rank-card" data-index="${i}">
          <img src="${escapeHtml(film.poster || '')}" alt="" loading="lazy">
          <span class="rank-info">
            <span class="rank-title">${escapeHtml(film.title)}</span>
            <span class="rank-meta"><span class="rank-rating">${ratingText(film)}</span> · ${film.year || '—'}</span>
            <span class="rank-meta">${escapeHtml(film.genreLabels.slice(0, 3).join(', '))}</span>
            <span class="rank-why">${escapeHtml(why(film))}</span>
          </span>
        </button>
      </li>`
    )
    .join('');
  show('results');
  feature(pickRandom());
}

$('ranking').addEventListener('click', (e) => {
  const card = e.target.closest('.rank-card');
  if (!card) return;
  feature(state.results[Number(card.dataset.index)]);
  $('featured').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Sorteio ponderado pela nota: os mais bem avaliados saem com mais frequência
function pickRandom() {
  let pool = state.results.filter((f) => !state.shown.has(f.slug));
  if (!pool.length) {
    state.shown.clear();
    pool = state.results;
  }
  const weights = pool.map((f) => Math.pow(f.rating || 2, 3));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

againBtn.addEventListener('click', () => feature(pickRandom()));

function feature(film) {
  state.featured = film;
  state.shown.add(film.slug);

  $('poster').src = film.poster || '';
  $('poster').alt = `Pôster de ${film.title}`;
  $('poster-link').href = film.url;
  $('title').textContent = film.title;
  $('title').href = film.url;
  $('year').textContent = film.year ? `(${film.year})` : '';
  $('meta').textContent = [
    film.directors && film.directors.length ? `Direção: ${film.directors.join(', ')}` : '',
    ratingText(film),
  ].filter(Boolean).join(' · ');
  $('description').textContent = film.description || '';
  $('open').href = film.url;
  $('tags').innerHTML = [...film.genreLabels, ...film.countryLabels].map((t) => `<span>${escapeHtml(t)}</span>`).join('');

  const lines = [];
  if (film.watchlist.length) lines.push(`<p>Na watchlist de ${profileLinks(film.watchlist)}</p>`);
  if (film.watched.length) lines.push(`<p>Visto recentemente por ${profileLinks(film.watched)}</p>`);
  if (film.lists) lines.push(`<p>Em ${film.lists} ${film.lists === 1 ? 'lista pública' : 'listas públicas'} do Letterboxd</p>`);
  $('provenance').innerHTML = lines.join('');

  for (const card of document.querySelectorAll('.rank-card')) {
    card.setAttribute('aria-current', String(state.results[Number(card.dataset.index)] === film));
  }
  loadWatch(film);
}

// --- Onde assistir --------------------------------------------------------------

const WATCH_KINDS = [
  ['stream', 'Assinatura'],
  ['free', 'Grátis'],
  ['rent', 'Aluguel'],
  ['buy', 'Compra'],
];

async function loadWatch(film) {
  const region = $('region').value || 'BR';
  const regionLabel = $('region').selectedOptions[0] ? $('region').selectedOptions[0].text : region;
  const body = $('watch-body');
  body.innerHTML = '<p class="muted">Consultando serviços de streaming...</p>';

  try {
    const res = await fetch(`${API}/api/watch?${new URLSearchParams({ slug: film.slug, region })}`);
    const data = await res.json();
    if (state.featured !== film) return; // a pessoa já trocou de filme
    if (!res.ok) throw new Error(data.message);

    const av = data.availability;
    const rows = av
      ? WATCH_KINDS.filter(([kind]) => av.offers[kind].length).map(
          ([kind, label]) => `
          <div class="watch-row">
            <span class="watch-kind">${label}</span>
            ${av.offers[kind]
              .map(
                (o) => `<a class="provider" href="${escapeHtml(o.url)}" target="_blank" rel="noopener">
                  ${o.icon ? `<img src="${escapeHtml(o.icon)}" alt="" loading="lazy">` : ''}${escapeHtml(o.name)}</a>`
              )
              .join('')}
          </div>`
        )
      : [];

    body.innerHTML =
      (rows.length ? rows.join('') : `<p class="muted">Não encontramos este filme em serviços de streaming em ${escapeHtml(regionLabel)}.</p>`) +
      `<p class="watch-credit">Disponibilidade em ${escapeHtml(regionLabel)} segundo o ` +
      (av ? `<a href="${escapeHtml(av.url)}" target="_blank" rel="noopener">JustWatch</a>` : 'JustWatch') +
      '.</p>';
  } catch (err) {
    if (state.featured !== film) return;
    body.innerHTML = '<p class="muted">Não foi possível consultar onde assistir agora.</p>';
  }
}
