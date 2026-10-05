/**
 * Documenten ophalen voor de review, met herkansing en terugval.
 *
 * zoek.officielebekendmakingen.nl blokkeert een runner na veel verzoeken soms
 * een tijd met HTTP 403 (28-9-2026: elk brondocument). Dezelfde publicatie staat
 * ook op repository.overheid.nl; die vindplaats levert de SRU als itemUrl mee.
 * Daarom: eerst de gevraagde URL, na een pauze nog eens, en dan de vindplaats
 * uit de SRU. Lukt niets, dan zegt het resultaat dat eerlijk (tekst null), zodat
 * het bewijs niet stil leeg raakt.
 */

const { haalDocumentTekst } = require('./checkBekendmakingen');

const zoekUrl = (id) => `https://zoek.officielebekendmakingen.nl/${id}.html`;
const pauze = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * @param {string} id        identifier, bijv. gmb-2024-428959
 * @param {object} opties
 * @param {string} [opties.url]        voorkeurs-URL (anders zoek.officielebekendmakingen.nl)
 * @param {Map}    [opties.vindplaats] identifier → URL uit de SRU (repository.overheid.nl)
 * @param {Function} [opties._haal]    voor tests
 * @param {number} [opties.wachtMs]    pauze vóór de herkansing
 * @returns {Promise<{tekst: string|null, url: string|null, pogingen: string[]}>}
 */
async function haalMetTerugval(id, { url, vindplaats, _haal = haalDocumentTekst, wachtMs = 5000 } = {}) {
  const kandidaten = [];
  const eerste = url || (id ? zoekUrl(id) : null);
  if (eerste) kandidaten.push(eerste, eerste);
  const alt = id && vindplaats && vindplaats.get(id);
  if (alt && alt !== eerste) kandidaten.push(alt);

  const pogingen = [];
  for (let i = 0; i < kandidaten.length; i++) {
    if (i === 1) await pauze(wachtMs);
    const tekst = await _haal(kandidaten[i]);
    pogingen.push(kandidaten[i]);
    if (tekst) return { tekst, url: kandidaten[i], pogingen };
  }
  return { tekst: null, url: null, pogingen };
}

// identifier → vindplaats, uit de records van zoekBekendmakingen.
function vindplaatsen(records) {
  const m = new Map();
  for (const r of records || []) {
    if (r.identifier && r.url && !/zoek\.officielebekendmakingen\.nl/.test(r.url)) m.set(r.identifier, r.url);
  }
  return m;
}

module.exports = { haalMetTerugval, vindplaatsen };
