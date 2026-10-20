// Onde assistir: consulta a API GraphQL pública do JustWatch, a mesma fonte
// da seção "Where to watch" do Letterboxd (que é bloqueada para acesso
// automatizado). O filme é identificado pelo ID do TMDB que o Letterboxd expõe.

const https = require('https');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;

const REGIONS = {
  BR: 'Brasil',
  PT: 'Portugal',
  US: 'Estados Unidos',
  GB: 'Reino Unido',
  CA: 'Canadá',
  ES: 'Espanha',
  MX: 'México',
  AR: 'Argentina',
};

const MONETIZATION = {
  FLATRATE: 'stream',
  FREE: 'free',
  ADS: 'free',
  RENT: 'rent',
  BUY: 'buy',
};

const QUERY = `query Search($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, filter: $filter) {
    edges { node {
      objectType
      content(country: $country, language: $language) {
        title fullPath originalReleaseYear externalIds { tmdbId }
      }
      offers(country: $country, platform: WEB) {
        monetizationType standardWebURL
        package { clearName technicalName icon }
      }
    } }
  }
}`;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      'https://apis.justwatch.com/graphql',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 10000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`JustWatch HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

const cache = new Map();

// film: { title, year, tmdbId } -> { url, offers: { stream, free, rent, buy } } ou null
async function getAvailability(film, region) {
  const key = `${region}:${film.tmdbId || film.title}:${film.year}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const res = await post({
    operationName: 'Search',
    query: QUERY,
    variables: { country: region, language: 'pt', first: 5, filter: { searchQuery: film.title } },
  });
  const nodes = ((res.data && res.data.popularTitles && res.data.popularTitles.edges) || [])
    .map((e) => e.node)
    .filter((n) => n.objectType === 'MOVIE' && n.content);

  const node =
    (film.tmdbId && nodes.find((n) => n.content.externalIds && n.content.externalIds.tmdbId === String(film.tmdbId))) ||
    nodes.find((n) => film.year && n.content.originalReleaseYear === film.year) ||
    null;

  let value = null;
  if (node) {
    const offers = { stream: [], free: [], rent: [], buy: [] };
    const seen = new Set();
    for (const o of node.offers || []) {
      const kind = MONETIZATION[o.monetizationType];
      const id = `${kind}:${o.package.technicalName}`;
      if (!kind || seen.has(id)) continue;
      seen.add(id);
      offers[kind].push({
        name: o.package.clearName,
        url: o.standardWebURL,
        icon: o.package.icon ? `https://images.justwatch.com${o.package.icon.replace('{profile}', 's100').replace('{format}', 'png')}` : null,
      });
    }
    value = { url: `https://www.justwatch.com${node.content.fullPath}`, offers };
  }

  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

module.exports = { REGIONS, getAvailability };
