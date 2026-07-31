/**
 * Eén enkele bron van waarheid voor Firestore document-id's.
 *
 * Dit MOET overal identiek zijn. Toen fillDefaultData en syncSheet een andere
 * variant gebruikten (`/\\s+/g`, die een letterlijke backslash matcht in plaats
 * van witruimte), kreeg elke gemeente met een spatie in de naam twee
 * documenten: "bergen op zoom" naast "bergen-op-zoom".
 */
function toDocId(gemeenteNaam) {
  if (gemeenteNaam === null || gemeenteNaam === undefined) return null;
  const id = String(gemeenteNaam).toLowerCase().trim().replace(/\s+/g, '-');
  return id || null;
}

module.exports = { toDocId };
