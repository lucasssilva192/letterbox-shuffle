const $ = (id) => document.getElementById(id);
const API = window.API_BASE || '';

const form = $('form');
const userInput = $('user');
const genresEl = $('genres');
const submitBtn = $('submit');
const againBtn = $('again');

const HELP = {
  network: 'Sorteamos um filme que você ainda não viu entre as watchlists e os filmes vistos de quem você segue e de quem te segue.',
  top: 'Buscamos os filmes mais bem avaliados no Letterboxd que aparecem em listas públicas (oficiais e populares) e batem com os filtros.',
};

let mode = 'network';
let selectedGenre = '';
let shown = []; // slugs já sorteados com os filtros atuais, para "Sortear outro"
let source = null;

try { userInput.value = localStorage.getItem('lb-user') || ''; } catch (_) {}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// No plano gratuito do Render o servidor dorme quando fica parado; esta
// primeira chamada já o acorda enquanto a pessoa preenche os filtros.
fetch(`${API}/api/options`)
  .then((r) => r.json())
  .then(({ genres, countries, decades }) => {
    addGenre('', 'Qualquer');
    for (const g of genres) addGenre(g.slug, g.label);
    selectGenre('');
    for (const d of decades) $('decade').add(new Option(`Anos ${String(d).slice(2)} (${d})`, d));
    for (const c of countries) $('country').add(new Option(c.label, c.slug));
  })
  .catch(() => showError('Não foi possível conectar ao servidor. Se ele estava parado, aguarde alguns segundos e recarregue a página.'));

function addGenre(slug, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.slug = slug;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => selectGenre(slug));
  genresEl.appendChild(b);
}

function selectGenre(slug) {
  selectedGenre = slug;
  shown = [];
  for (const b of genresEl.children) b.setAttribute('aria-checked', String(b.dataset.slug === slug));
}

function setMode(next) {
  mode = next;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  }
  $('mode-help').textContent = HELP[mode];
  $('user-optional').hidden = mode !== 'top';
  $('hide-watched-row').hidden = mode !== 'top';
  submitBtn.textContent = mode === 'top' ? 'Buscar os melhores' : 'Sortear filme';
  show(null);
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
}
setMode('network');

for (const id of ['yearFrom', 'yearTo', 'decade', 'minRating', 'country']) {
  $(id).addEventListener('change', () => (shown = []));
}

$('clear').addEventListener('click', () => {
  for (const id of ['yearFrom', 'yearTo', 'decade', 'minRating', 'country']) $(id).value = '';
  $('hideWatched').checked = false;
  selectGenre('');
});

function show(section) {
  for (const id of ['status', 'error', 'result', 'top']) $(id).hidden = id !== section;
}

function showError(message) {
  show('error');
  $('error').textContent = message;
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  againBtn.disabled = busy;
}

function filterParams() {
  const params = { genre: selectedGenre };
  for (const id of ['yearFrom', 'yearTo', 'decade', 'minRating', 'country']) params[id] = $(id).value;
  return params;
}

function profileLinks(users) {
  return users
    .map((u) => `<a href="https://letterboxd.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener">${escapeHtml(u)}</a>`)
    .join(', ');
}

function tagsFor(film) {
  const tags = [...film.genreLabels, ...film.countryLabels];
  return tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('');
}

function ratingText(film) {
  return film.rating ? `★ ${Number(film.rating).toFixed(2).replace('.', ',')}` : 'sem nota';
}

function renderResult({ film, watchlist, watched }) {
  $('poster').src = film.poster || '';
  $('poster').alt = `Pôster de ${film.title}`;
  $('poster-link').href = film.url;
  $('title').textContent = film.title;
  $('title').href = film.url;
  $('year').textContent = film.year ? `(${film.year})` : '';
  $('director').textContent = [
    film.directors && film.directors.length ? `Direção: ${film.directors.join(', ')}` : '',
    ratingText(film),
  ].filter(Boolean).join(' · ');
  $('description').textContent = film.description || '';
  $('open').href = film.url;
  $('tags').innerHTML = tagsFor(film);

  let html = '';
  if (watchlist.length) html += `<p>Na watchlist de ${profileLinks(watchlist)}</p>`;
  if (watched.length) html += `<p>Visto recentemente por ${profileLinks(watched)}</p>`;
  $('sources').innerHTML = html;

  show('result');
}

function renderTop({ films, stats }) {
  $('top-summary').textContent =
    `${films.length} filmes mais bem avaliados, de ${stats.candidates} filmes em ${stats.lists} listas públicas.`;
  $('top-list').innerHTML = films
    .map(
      (film) => `
      <li class="top-item">
        <a href="${escapeHtml(film.url)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(film.poster || '')}" alt="Pôster de ${escapeHtml(film.title)}" loading="lazy">
        </a>
        <div>
          <a class="top-title" href="${escapeHtml(film.url)}" target="_blank" rel="noopener">${escapeHtml(film.title)}</a>
          <span class="muted">${film.year || ''}</span>
          <div class="top-rating">${ratingText(film)}</div>
          <div class="tags small">${tagsFor(film)}</div>
        </div>
      </li>`
    )
    .join('');
  show('top');
}

function run() {
  const user = userInput.value.trim();
  if (mode === 'network' && !user) {
    userInput.focus();
    return showError('Informe seu usuário do Letterboxd para sortear da sua rede.');
  }
  const hideWatched = mode === 'top' && $('hideWatched').checked;
  if (hideWatched && !user) {
    userInput.focus();
    return showError('Para ocultar os filmes que você já viu, informe seu usuário.');
  }
  try { if (user) localStorage.setItem('lb-user', user); } catch (_) {}

  if (source) source.close();
  setBusy(true);
  show('status');
  $('status-text').textContent = 'Começando...';
  $('bar-fill').style.width = '0';

  const params = new URLSearchParams(filterParams());
  if (user) params.set('user', user);
  if (mode === 'network') params.set('exclude', shown.join(','));
  if (hideWatched) params.set('hideWatched', '1');
  source = new EventSource(`${API}/api/${mode === 'top' ? 'top' : 'shuffle'}?${params}`);

  source.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    $('status-text').textContent = data.message;
    if (data.total) $('bar-fill').style.width = `${(data.current / data.total) * 100}%`;
  });

  source.addEventListener('result', (e) => {
    const data = JSON.parse(e.data);
    shown.push(data.film.slug);
    source.close();
    setBusy(false);
    renderResult(data);
  });

  source.addEventListener('top', (e) => {
    source.close();
    setBusy(false);
    renderTop(JSON.parse(e.data));
  });

  source.addEventListener('error', (e) => {
    source.close();
    setBusy(false);
    let message = 'A conexão com o servidor caiu. Tente novamente.';
    try { if (e.data) message = JSON.parse(e.data).message; } catch (_) {}
    showError(message);
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});
againBtn.addEventListener('click', run);
