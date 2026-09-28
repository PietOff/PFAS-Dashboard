/**
 * audit.js — is de dataset compleet en plausibel?
 *
 * Vergelijkt Firestore met de canonieke gemeentelijst en rapporteert elk gat.
 * Dit is de enige manier om te kúnnen zeggen dat alle gemeenten verwerkt zijn;
 * "de sweep is gedraaid zonder fouten" bewijst dat niet.
 *
 * Schrijft niets. Wordt gebruikt door de HTTP-endpoint `auditData` en door de
 * dagelijkse controle `dailyHealthCheck`, zodat beide exact dezelfde cijfers
 * geven.
 */

const { toDocId } = require('./docId');
const { haalGemeenteLijst } = require('./gemeentelijst');
const pfasNormen = require('./pfas_normen.json');

const STOFFEN = ['pfos', 'pfoa', 'genx'];
const KLASSEN = ['wonen', 'industrie', 'landbouwNatuur'];
const CURATIE = new Map(Object.entries(pfasNormen.afwijkend || {}).map(([n, d]) => [toDocId(n), d]));

/**
 * Klopt wat het dashboard toont met wat de herkomst belooft?
 *
 * De bestaande controles kijken of een waarde tussen 0 en 50 ligt. Dat ving
 * niet dat Rotterdam "PFOS industrie 3,0" toonde met de tekst "PFOS Industrie
 * is 7.0" eronder, of dat het landelijk kader zelf verkeerd stond.
 *
 * @returns {string[]} - problemen voor deze gemeente, leeg als het klopt
 */
function controleerNormen(docId, data) {
  if (data.handmatigeOverschrijving === true) return [];
  const problemen = [];
  const vergelijk = (verwacht, wat) => {
    for (const stof of STOFFEN) {
      for (const klasse of KLASSEN) {
        const v = data[stof]?.[klasse];
        const e = verwacht[stof]?.[klasse];
        if ((typeof e === 'number' || e === null) && v !== e) {
          problemen.push(`${stof}.${klasse} = ${v}, verwacht ${e} (${wat})`);
        }
      }
    }
  };

  const curatie = CURATIE.get(docId);
  if (curatie) {
    if (data.herkomst !== 'curatie') {
      problemen.push(`staat in pfas_normen.json als afwijkend, maar herkomst is '${data.herkomst}'`);
    } else {
      vergelijk(curatie, 'curatie');
    }
  } else if (data.herkomst === 'landelijk-kader-aanname' || data.herkomst === 'mogelijk-afwijkend') {
    vergelijk(pfasNormen.landelijk_kader, 'landelijk kader');
  }
  return problemen;
}

async function verzamelAudit(db, { maxDagenOud = 90 } = {}) {
  const lijst = await haalGemeenteLijst();
  const canoniek = new Map(lijst.gemeenten.map(n => [toDocId(n), n]));

  const snapshot = await db.collection('pfasData').get();

  const inDb = new Map();
  const dubbeleIds = [];
  const verdachteWaarden = [];
  const zwakkeBronnen = [];
  const verouderd = [];
  const inconsistenteNormen = [];
  const herkomst = {};
  let afwijkendBeleid = 0;
  let teReviewen = 0;

  const vandaag = new Date();

  snapshot.forEach(doc => {
    const data = doc.data();
    const naam = data.gemeente || doc.id;
    const id = toDocId(naam);

    if (doc.id !== id) dubbeleIds.push({ docId: doc.id, zouMoetenZijn: id });
    inDb.set(id, data);

    if (data.heeftAfwijkendBeleid === true) afwijkendBeleid++;
    if (data.tereviewen === true) teReviewen++;
    herkomst[data.herkomst || 'onbekend'] = (herkomst[data.herkomst || 'onbekend'] || 0) + 1;

    for (const probleem of controleerNormen(doc.id, data)) {
      inconsistenteNormen.push({ gemeente: naam, probleem });
    }

    for (const stof of ['pfos', 'pfoa', 'genx']) {
      const w = data[stof];
      if (!w) {
        verdachteWaarden.push({ gemeente: naam, probleem: `${stof} ontbreekt volledig` });
        continue;
      }
      for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
        const v = w[klasse];
        // "Per zone" is een bewuste lege waarde: één getal zou verzonnen zijn.
        if (v === null && Array.isArray(data.perZone) && data.perZone.includes(`${stof}.${klasse}`)) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          verdachteWaarden.push({ gemeente: naam, probleem: `${stof}.${klasse} is geen getal (${v})` });
        } else if (v <= 0 || v > 50) {
          verdachteWaarden.push({ gemeente: naam, probleem: `${stof}.${klasse} = ${v} (buiten 0-50)` });
        }
      }
    }

    const link = data.bronLink;
    if (!link) {
      zwakkeBronnen.push({ gemeente: naam, probleem: 'geen bronLink' });
    } else if (link.includes('google.com/search')) {
      zwakkeBronnen.push({ gemeente: naam, probleem: 'bronLink is een Google-zoekopdracht' });
    } else {
      try {
        const pad = new URL(link).pathname;
        if (pad === '' || pad === '/') {
          zwakkeBronnen.push({ gemeente: naam, probleem: 'bronLink is alleen een homepage' });
        }
      } catch {
        zwakkeBronnen.push({ gemeente: naam, probleem: `bronLink is geen geldige URL (${link})` });
      }
    }

    if (data.laatstGeupdate || data.laatstGecontroleerd) {
      const datum = data.laatstGecontroleerd || data.laatstGeupdate;
      const dagen = Math.floor((vandaag - new Date(datum)) / 86400000);
      if (Number.isFinite(dagen) && dagen > maxDagenOud) {
        verouderd.push({ gemeente: naam, laatstGecontroleerd: datum, dagenOud: dagen });
      }
    } else {
      verouderd.push({ gemeente: naam, laatstGecontroleerd: null, dagenOud: null });
    }
  });

  const ontbrekend = [...canoniek.entries()]
    .filter(([id]) => !inDb.has(id))
    .map(([, naam]) => naam);

  const verweesd = [...inDb.keys()]
    .filter(id => !canoniek.has(id))
    .map(id => (inDb.get(id).gemeente || id));

  const dekking = canoniek.size > 0
    ? Math.round(((canoniek.size - ontbrekend.length) / canoniek.size) * 1000) / 10
    : 0;

  // Wanneer draaide de sweep voor het laatst?
  let sweep = null;
  try {
    const cfg = await db.collection('config').doc('bekendmakingenSweep').get();
    if (cfg.exists) sweep = cfg.data();
  } catch { /* niet kritiek */ }

  const sweepDagenGeleden = sweep && sweep.laatsteRunOp
    ? Math.floor((vandaag - new Date(sweep.laatsteRunOp)) / 86400000)
    : null;

  // Het watermerk schuift alleen op na een volledige run. Blijft het achter
  // terwijl de sweep wel draait, dan loopt er een achterstand of faalt er elke
  // week iets — dat ziet sweepDagenGeleden niet.
  const watermerkDagenOud = sweep && sweep.laatsteGeslaagdeRun
    ? Math.floor((vandaag - new Date(sweep.laatsteGeslaagdeRun)) / 86400000)
    : null;

  return {
    tijdstip: new Date().toISOString(),
    samenvatting: {
      gemeentenVolgensBron: canoniek.size,
      documentenInFirestore: snapshot.size,
      dekkingProcent: dekking,
      ontbrekend: ontbrekend.length,
      verweesd: verweesd.length,
      dubbeleIds: dubbeleIds.length,
      verdachteWaarden: verdachteWaarden.length,
      inconsistenteNormen: inconsistenteNormen.length,
      zwakkeBronlinks: zwakkeBronnen.length,
      verouderd: verouderd.length,
      metAfwijkendBeleid: afwijkendBeleid,
      teReviewen,
      sweepDagenGeleden,
      watermerkDagenOud,
      sweepVolledig: sweep && sweep.laatsteResultaat ? sweep.laatsteResultaat.volledig !== false : null
    },
    bron: lijst.bron,
    bronWaarschuwingen: lijst.waarschuwingen,
    herkomst,
    ontbrekendeGemeenten: ontbrekend,
    verweesdeDocumenten: verweesd,
    dubbeleIds,
    verdachteWaarden,
    inconsistenteNormen: inconsistenteNormen.slice(0, 100),
    zwakkeBronlinks: zwakkeBronnen,
    verouderdeDocumenten: verouderd.sort((a, b) => (b.dagenOud || 1e9) - (a.dagenOud || 1e9)).slice(0, 50)
  };
}

/**
 * Zet een auditrapport om in een lijst problemen.
 *
 * Bewust streng op de dingen die stil kapot gaan: onvolledige dekking, dubbele
 * documenten en een sweep die niet meer draait, merk je anders pas als iemand
 * een verkeerde norm gebruikt.
 *
 * @returns {{gezond: boolean, problemen: string[]}}
 */
function beoordeelAudit(rapport, { maxSweepDagen = 10, maxWatermerkDagen = 21 } = {}) {
  const s = rapport.samenvatting;
  const problemen = [];

  if (s.ontbrekend > 0) {
    problemen.push(`${s.ontbrekend} gemeenten ontbreken in Firestore (dekking ${s.dekkingProcent}%).`);
  }
  if (s.verweesd > 0) {
    problemen.push(`${s.verweesd} documenten horen bij een gemeente die niet meer bestaat.`);
  }
  if (s.dubbeleIds > 0) {
    problemen.push(`${s.dubbeleIds} documenten hebben een afwijkend document-id (dubbelen).`);
  }
  if (s.verdachteWaarden > 0) {
    problemen.push(`${s.verdachteWaarden} PFAS-waarden zijn onaannemelijk of ontbreken.`);
  }
  if (s.inconsistenteNormen > 0) {
    problemen.push(`${s.inconsistenteNormen} getoonde normen kloppen niet met hun herkomst (curatie of landelijk kader).`);
  }
  if (s.zwakkeBronlinks > 0) {
    problemen.push(`${s.zwakkeBronlinks} gemeenten hebben geen bruikbare bronlink.`);
  }
  if (s.sweepDagenGeleden === null) {
    problemen.push('De bekendmakingen-sweep heeft nog nooit gedraaid.');
  } else if (s.sweepDagenGeleden > maxSweepDagen) {
    problemen.push(`De sweep draaide ${s.sweepDagenGeleden} dagen geleden voor het laatst.`);
  }
  if (typeof s.watermerkDagenOud === 'number' && s.watermerkDagenOud > maxWatermerkDagen) {
    problemen.push(`De sweep loopt achter: het watermerk staat ${s.watermerkDagenOud} dagen terug. ` +
      'Er is een achterstand of er faalt elke run een publicatie (zie config/bekendmakingenSweep en sweepMislukt).');
  }
  if (rapport.bronWaarschuwingen && rapport.bronWaarschuwingen.length) {
    problemen.push(`Gemeentelijst: ${rapport.bronWaarschuwingen.join(' | ')}`);
  }

  return { gezond: problemen.length === 0, problemen };
}

module.exports = { verzamelAudit, beoordeelAudit, controleerNormen };
