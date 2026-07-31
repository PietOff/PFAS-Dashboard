/**
 * Canonieke lijst van Nederlandse gemeenten.
 *
 * De scraper haalde deze lijst uit `gemeenten.geojson` op de eigen hosting.
 * Dat bestand staat niet onder versiebeheer, wordt door niemand gevalideerd en
 * loopt achter zodra er een herindeling is. Daarmee valt niet te bewijzen dat
 * alle gemeenten verwerkt zijn — je weet alleen dat alles in dát bestand is
 * verwerkt.
 *
 * Deze module haalt de lijst bij het Kadaster (PDOK Bestuurlijke Gebieden) en
 * valt terug op de geojson als dat niet lukt. Elke bron wordt gevalideerd op
 * een plausibel aantal gemeenten, zodat een gewijzigd API-formaat niet stilletjes
 * een lege of halve lijst oplevert.
 *
 * Nederland heeft 342 gemeenten (sinds de vorming van Voorne aan Zee, 2023).
 */

const axios = require('axios');

// Onder-/bovengrens waarbinnen een lijst geloofwaardig is. Buiten deze marge
// wordt de bron afgekeurd in plaats van gebruikt.
const MIN_GEMEENTEN = 320;
const MAX_GEMEENTEN = 400;

const PDOK_URL =
  'https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/gemeentegebied/items' +
  '?f=json&limit=500';

const GEOJSON_FALLBACK_URL = 'https://pfas-dashboard-nl-a808d.web.app/gemeenten.geojson';

const BRONNEN = [
  {
    naam: 'PDOK Bestuurlijke Gebieden (Kadaster)',
    url: PDOK_URL,
    parse: (data) => (data.features || [])
      .map(f => f.properties && (f.properties.naam || f.properties.identificatie))
      .filter(Boolean)
  },
  {
    naam: 'gemeenten.geojson (eigen hosting)',
    url: GEOJSON_FALLBACK_URL,
    parse: (data) => (data.features || [])
      .map(f => f.properties && (f.properties.statnaam || f.properties.naam))
      .filter(Boolean)
  }
];

let cache = null;
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 uur

/**
 * @returns {Promise<{bron: string, gemeenten: string[], opgehaaldOp: string, waarschuwingen: string[]}>}
 * @throws als geen enkele bron een geloofwaardige lijst oplevert
 */
async function haalGemeenteLijst({ forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() - cache.tijd < CACHE_MS) {
    return cache.resultaat;
  }

  const waarschuwingen = [];

  for (const bron of BRONNEN) {
    try {
      const response = await axios.get(bron.url, {
        timeout: 20000,
        headers: { 'User-Agent': 'PFASDashboard/1.0 (overheid-monitoring)' }
      });

      const namen = bron.parse(response.data);
      const uniek = [...new Set(namen.map(n => String(n).trim()).filter(Boolean))].sort();

      if (uniek.length < MIN_GEMEENTEN || uniek.length > MAX_GEMEENTEN) {
        waarschuwingen.push(
          `${bron.naam}: ${uniek.length} gemeenten gevonden, buiten de verwachte marge ` +
          `${MIN_GEMEENTEN}-${MAX_GEMEENTEN}. Bron afgekeurd.`
        );
        continue;
      }

      const resultaat = {
        bron: bron.naam,
        gemeenten: uniek,
        opgehaaldOp: new Date().toISOString(),
        waarschuwingen
      };
      cache = { tijd: Date.now(), resultaat };
      return resultaat;

    } catch (err) {
      waarschuwingen.push(`${bron.naam}: niet bereikbaar (${err.message}).`);
    }
  }

  const fout = new Error(
    'Geen enkele bron leverde een geloofwaardige gemeentelijst: ' + waarschuwingen.join(' | ')
  );
  fout.waarschuwingen = waarschuwingen;
  throw fout;
}

module.exports = { haalGemeenteLijst, MIN_GEMEENTEN, MAX_GEMEENTEN };
