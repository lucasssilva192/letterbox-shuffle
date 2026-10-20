const $ = (id) => document.getElementById(id);

const form = $('form');
const userInput = $('user');
const genresEl = $('genres');
const submitBtn = $('submit');
const againBtn = $('again');

let selectedGenre = null;
let shown = []; // slugs já sorteados nesta sessão, para "Sortear outro"
let source = null;

try { userInput.value = localStorage.getItem('lb-user') || ''; } catch (_) {}

fetch('/api/genres')
  .then((r) => r.json())
  .then((genres) => {
    for (const g of genres) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = g.label;
      b.dataset.slug = g.slug;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', () => selectGenre(g.slug));
      genresEl.appendChild(b);
    }
  });

function selectGenre(slug) {
  if (selectedGenre !== slug) shown = [];
  selectedGenre = slug;
  for (const b of genresEl.children) b.setAttribute('aria-checked', String(b.dataset.slug === slug));
}

function show(section) {
  for (const id of ['status', 'error', 'result']) $(id).hidden = id !== section;
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  againBtn.disabled = busy;
}

function profileLinks(users) {
  return users.map((u) => `<a href="https://letterboxd.com/${u}/" target="_blank" rel="noopener">${u}</a>`).join(', ');
}

function renderResult({ film, watchlist, watched }) {
  $('poster').src = film.poster || '';
  $('poster').alt = `Pôster de ${film.title}`;
  $('poster-link').href = film.url;
  $('title').textContent = film.title;
  $('title').href = film.url;
  $('year').textContent = film.year ? `(${String(film.year).slice(0, 4)})` : '';
  $('director').textContent = film.directors && film.directors.length ? `Direção: ${film.directors.join(', ')}` : '';
  $('description').textContent = film.description || '';
  $('open').href = film.url;

  const tags = [...film.genreLabels];
  if (film.rating) tags.push(`★ ${Number(film.rating).toFixed(1)}`);
  $('tags').innerHTML = tags.map((t) => `<span>${t}</span>`).join('');

  let html = '';
  if (watchlist.length) html += `<p>Na watchlist de ${profileLinks(watchlist)}</p>`;
  if (watched.length) html += `<p>Visto recentemente por ${profileLinks(watched)}</p>`;
  $('sources').innerHTML = html;

  show('result');
}

function shuffle() {
  const user = userInput.value.trim();
  if (!user) return userInput.focus();
  if (!selectedGenre) {
    show('error');
    $('error').textContent = 'Escolha um gênero.';
    return;
  }
  try { localStorage.setItem('lb-user', user); } catch (_) {}

  if (source) source.close();
  setBusy(true);
  show('status');
  $('status-text').textContent = 'Começando...';
  $('bar-fill').style.width = '0';

  const params = new URLSearchParams({ user, genre: selectedGenre, exclude: shown.join(',') });
  source = new EventSource(`/api/shuffle?${params}`);

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

  source.addEventListener('error', (e) => {
    source.close();
    setBusy(false);
    show('error');
    let message = 'A conexão com o servidor caiu. Tente novamente.';
    try { if (e.data) message = JSON.parse(e.data).message; } catch (_) {}
    $('error').textContent = message;
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  shuffle();
});
againBtn.addEventListener('click', shuffle);
