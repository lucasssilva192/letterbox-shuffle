// Filtros compartilhados pelas duas abas: gênero, ano, década, nota mínima e país.

const { GENRES, COUNTRIES, LetterboxdError } = require('./letterboxd');

const DECADES = [];
for (let d = 2020; d >= 1920; d -= 10) DECADES.push(d);

function intOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFilters(query) {
  const f = {
    genre: query.genre || null,
    country: query.country || null,
    decade: intOrNull(query.decade),
    yearFrom: intOrNull(query.yearFrom),
    yearTo: intOrNull(query.yearTo),
    minRating: query.minRating ? Number(query.minRating) : null,
  };

  if (f.genre && !GENRES[f.genre]) throw new LetterboxdError('Gênero inválido.', 400);
  if (f.country && !COUNTRIES[f.country]) throw new LetterboxdError('País inválido.', 400);
  if (f.decade !== null && !DECADES.includes(f.decade)) throw new LetterboxdError('Década inválida.', 400);
  if (f.minRating !== null && !(f.minRating >= 0 && f.minRating <= 5)) {
    throw new LetterboxdError('A nota mínima deve estar entre 0 e 5.', 400);
  }

  // O período é por década ou por intervalo de anos, nunca os dois
  if (f.decade !== null && (f.yearFrom !== null || f.yearTo !== null)) {
    throw new LetterboxdError('Use década ou intervalo de anos, não os dois ao mesmo tempo.', 400);
  }
  if (f.yearFrom !== null && f.yearTo !== null && f.yearFrom > f.yearTo) {
    throw new LetterboxdError('O ano inicial deve ser menor ou igual ao ano final.', 400);
  }
  f.from = f.decade !== null ? f.decade : f.yearFrom;
  f.to = f.decade !== null ? f.decade + 9 : f.yearTo;
  return f;
}

// Pré-filtro barato com o ano que vem na grade de pôsteres
function yearMatches(year, f) {
  if (f.from === null && f.to === null) return true;
  if (!year) return false;
  return (f.from === null || year >= f.from) && (f.to === null || year <= f.to);
}

// Filtro completo, com os dados da página do filme
function filmMatches(film, f) {
  if (!film) return false;
  if (f.genre && !film.genres.includes(f.genre)) return false;
  if (f.country && !film.countries.includes(f.country)) return false;
  if (!yearMatches(film.year, f)) return false;
  if (f.minRating !== null && !(film.rating >= f.minRating)) return false;
  return true;
}

function describe(f) {
  const parts = [];
  if (f.genre) parts.push(GENRES[f.genre]);
  if (f.country) parts.push(COUNTRIES[f.country]);
  if (f.decade !== null) parts.push(`anos ${String(f.decade).slice(2)}`);
  else if (f.from !== null || f.to !== null) {
    if (f.from === f.to) parts.push(String(f.from));
    else if (f.from !== null && f.to !== null) parts.push(`${f.from}–${f.to}`);
    else if (f.from !== null) parts.push(`a partir de ${f.from}`);
    else parts.push(`até ${f.to}`);
  }
  if (f.minRating !== null) parts.push(`nota ≥ ${f.minRating}`);
  return parts.length ? parts.join(', ') : 'qualquer filme';
}

// Países fora da lista traduzida: "saudi-arabia" -> "Saudi Arabia"
const titleCase = (slug) => slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function enrich(film) {
  return {
    ...film,
    genreLabels: film.genres.map((g) => GENRES[g]).filter(Boolean),
    countryLabels: film.countries.map((c) => COUNTRIES[c] || titleCase(c)),
  };
}

module.exports = { DECADES, parseFilters, yearMatches, filmMatches, describe, enrich };
