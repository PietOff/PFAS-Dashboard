const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { runWeeklyScraper } = require('./scraper');
const { toDocId } = require('./docId');
const { haalGemeenteLijst } = require('./gemeentelijst');

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));

// Tijdelijke fallback data (totdat Firestore is gevuld door de AI scraper)
const fallbackData = [
  {
    id: "1",
    gemeente: "Rotterdam",
    omgevingsdienst: "DCMR Milieudienst Rijnmond",
    provincie: "Zuid-Holland",
    pfoa: { wonen: 7.0, industrie: 7.0, landbouwNatuur: 1.9 },
    pfos: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 1.4 },
    genx: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 0.8 },
    laatstGeupdate: "2024-01-15",
    opmerkingen: "Volgt landelijk Handelingskader voor grondverzet. Kaarten en details via DCMR bodemloket.",
    bronLink: "https://www.dcmr.nl/bodem/pfas"
  },
  {
    id: "2",
    gemeente: "Amsterdam",
    omgevingsdienst: "ODNZKG",
    provincie: "Noord-Holland",
    pfoa: { wonen: 7.0, industrie: 7.0, landbouwNatuur: 1.9 },
    pfos: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 1.4 },
    genx: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 0.8 },
    laatstGeupdate: "2025-01-01",
    opmerkingen: "Nieuwe Bodemkwaliteitskaart in 2025 vastgesteld. Let op: alle PFAS gelden als ZZS.",
    bronLink: "https://odnzkg.nl/themas/bodem/pfas/"
  },
  {
    id: "3",
    gemeente: "'s-Hertogenbosch",
    omgevingsdienst: "ODBN",
    provincie: "Noord-Brabant",
    pfoa: { wonen: 7.0, industrie: 7.0, landbouwNatuur: 1.9 },
    pfos: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 1.4 },
    genx: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 0.8 },
    laatstGeupdate: "2024-05-12",
    opmerkingen: "Volgt landelijk handelingskader (update dec 2023).",
    bronLink: "https://odbn.nl/pfas/"
  }
];

app.get(['/v1/gemeenten', '/api/v1/gemeenten'], async (req, res) => {
  try {
    const snapshot = await db.collection('pfasData').get();
    let data = [];
    snapshot.forEach(doc => {
      data.push({ id: doc.id, ...doc.data() });
    });
    
    // Als de database leeg is, retourneer tijdelijke test data
    if (data.length === 0) {
      data = [
        {
          "id": "1",
          "gemeente": "Rotterdam",
          "omgevingsdienst": "DCMR",
          "provincie": "Zuid-Holland",
          "pfoa": { "wonen": 7, "industrie": 7, "landbouwNatuur": 1.9 },
          "pfos": { "wonen": 3, "industrie": 3, "landbouwNatuur": 1.4 },
          "genx": { "wonen": 3, "industrie": 3, "landbouwNatuur": 0.8 },
          "laatstGeupdate": "2024-01-15",
          "opmerkingen": "Volgt landelijk Handelingskader voor grondverzet.",
          "bronLink": "https://www.dcmr.nl/bodem/pfas"
        },
        {
          "id": "2",
          "gemeente": "Amsterdam",
          "omgevingsdienst": "ODNZKG",
          "provincie": "Noord-Holland",
          "pfoa": { "wonen": 7, "industrie": 7, "landbouwNatuur": 1.9 },
          "pfos": { "wonen": 3, "industrie": 3, "landbouwNatuur": 1.4 },
          "genx": { "wonen": 3, "industrie": 3, "landbouwNatuur": 0.8 },
          "laatstGeupdate": "2025-10-06",
          "opmerkingen": "Bodemkwaliteitskaart Amsterdam (ACN) 2025 vastgesteld.",
          "bronLink": "https://odnzkg.nl/themas/bodem/pfas/"
        },
        {
          "id": "3",
          "gemeente": "'s-Hertogenbosch",
          "omgevingsdienst": "ODBN",
          "provincie": "Noord-Brabant",
          "pfoa": { "wonen": 7, "industrie": 7, "landbouwNatuur": 1.9 },
          "pfos": { "wonen": 3, "industrie": 3, "landbouwNatuur": 1.4 },
          "genx": { "wonen": 3, "industrie": 3, "landbouwNatuur": 0.8 },
          "laatstGeupdate": "2024-05-12",
          "opmerkingen": "Volgt landelijk handelingskader.",
          "bronLink": "https://odbn.nl/pfas/"
        }
      ];
    }
    
    res.json(data);
  } catch (error) {
    console.error('Error getting documents', error);
    // Return fallback data if firestore is not enabled yet
    res.status(200).json(fallbackData);
  }
});

app.get(['/v1/gemeenten/:gemeenteNaam', '/api/v1/gemeenten/:gemeenteNaam'], async (req, res) => {
  const gemeenteNaam = req.params.gemeenteNaam.toLowerCase();
  try {
    const snapshot = await db.collection('pfasData').get();
    let found = null;
    
    if (snapshot.empty) {
       found = fallbackData.find(d => d.gemeente.toLowerCase() === gemeenteNaam);
    } else {
       snapshot.forEach(doc => {
         const data = doc.data();
         if (data.gemeente && data.gemeente.toLowerCase() === gemeenteNaam) {
           found = { id: doc.id, ...data };
         }
       });
    }

    if (found) {
      res.status(200).json(found);
    } else {
      res.status(404).json({ error: 'Gemeente not found' });
    }
  } catch (error) {
    const found = fallbackData.find(d => d.gemeente.toLowerCase() === gemeenteNaam);
    if (found) {
      res.status(200).json(found);
    } else {
      res.status(404).json({ error: 'Gemeente not found' });
    }
  }
});

app.get(['/v1/signalen', '/api/v1/signalen'], async (req, res) => {
  try {
    const snapshot = await db.collection('pfasSignalen').where('status', '==', 'open').get();
    let data = [];
    snapshot.forEach(doc => {
      data.push({ id: doc.id, ...doc.data() });
    });
    res.json(data);
  } catch (error) {
    console.error('Error getting signalen', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

exports.pfasApi = functions.https.onRequest(app);

const { checkOfficieleBekendmakingen } = require('./checkBekendmakingen');

// ============================================================
// NACHTELIJKE CHECK: Officiële Bekendmakingen (overheid.nl)
// ============================================================
// Draait elke nacht om 03:00.
// Zoekt in de officiële Rijksoverheid API naar nieuwe gemeentebladen
// over PFAS bodembeleid. Alleen als een bron 100% officieel is EN de
// AI-extractie hoge zekerheid geeft, wordt de database automatisch
// bijgewerkt. Alles wat twijfelachtig is wordt als signaal opgeslagen.
exports.nightlyBekendmakingen = functions
  .runWith({ timeoutSeconds: 540, secrets: ["GEMINI_API_KEY"] })
  .pubsub
  .schedule('0 3 * * *')
  .timeZone('Europe/Amsterdam')
  .onRun(async (context) => {
    console.log('🌙 Nachtelijke check Officiële Bekendmakingen gestart...');
    const resultaten = await checkOfficieleBekendmakingen(db, 7);
    console.log('🌙 Nachtelijke check afgerond:', JSON.stringify(resultaten));
    return null;
  });

// HTTPS trigger om de bekendmakingen-check handmatig te starten
exports.checkBekendmakingenNow = functions
  .runWith({ timeoutSeconds: 540, secrets: ["GEMINI_API_KEY"] })
  .https.onRequest(async (req, res) => {
    try {
      const dagen = parseInt(req.query.dagen) || 30;
      const resultaten = await checkOfficieleBekendmakingen(db, dagen);
      res.json({
        succes: true,
        bericht: `Check afgerond voor de afgelopen ${dagen} dagen.`,
        resultaten
      });
    } catch (error) {
      console.error('Fout:', error);
      res.status(500).json({ error: error.message });
    }
  });

// Tijdelijke HTTPS trigger om een specifieke batch NU te starten.
exports.runScraperNow = functions.runWith({ timeoutSeconds: 540, secrets: ["GEMINI_API_KEY"] }).https.onRequest(async (req, res) => {
  try {
    const specificGemeente = req.query.gemeente;
    const batchStr = req.query.batch;
    
    if (specificGemeente) {
      await runWeeklyScraper(db, null, specificGemeente);
      return res.send(`Scraper has run successfully for ${specificGemeente}.`);
    } else {
      const batchIndex = parseInt(batchStr) || 0;
      await runWeeklyScraper(db, batchIndex);
      return res.send(`Scraper has run successfully for batch ${batchIndex}.`);
    }
  } catch (error) {
    console.error("Scraper failed:", error);
    res.status(500).send("Fout: " + error.message);
  }
});

// Tijdelijke HTTPS trigger om alle gemeenten te vullen met landelijk kader
exports.fillDefaultData = functions.runWith({ timeoutSeconds: 540 }).https.onRequest(async (req, res) => {
  try {
    const lijst = await haalGemeenteLijst();
    console.log(`Gemeentelijst via: ${lijst.bron} (${lijst.gemeenten.length} gemeenten)`);

    let count = 0;
    const batchArray = [];
    let currentBatch = db.batch();

    for (const naam of lijst.gemeenten) {
      if (!naam) continue;

      const defaultData = {
        gemeente: naam,
        provincie: "Nederland",
        omgevingsdienst: "Volgens landelijk kader",
        pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
        pfos: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 },
        genx: { wonen: 3, industrie: 3, landbouwNatuur: 0.8 },
        heeftAfwijkendBeleid: false,
        laatstGeupdate: new Date().toISOString().split('T')[0],
        opmerkingen: "Geen specifiek lokaal beleid geüploaded; toont Tijdelijk Handelingskader PFAS (RIVM). Raadpleeg de regionale Omgevingsdienst voor actuele lokale regels.",
        bronLink: "https://www.bodemplus.nl/onderwerpen/wet-regelgeving/rubrieken/pfas/handelingskader/"
      };

      const docRef = db.collection('pfasData').doc(toDocId(naam));
      currentBatch.set(docRef, defaultData, { merge: true });
      count++;
      
      if (count > 0 && count % 400 === 0) {
        batchArray.push(currentBatch);
        currentBatch = db.batch();
      }
    }
    
    if (count % 400 !== 0 && count > 0) {
      batchArray.push(currentBatch);
    }
    
    for (const batch of batchArray) {
      await batch.commit();
    }
    
    res.send(`Succes! ${count} gemeenten geüpdatet met landelijke data.`);
  } catch (error) {
    console.error("Fout bij vullen:", error);
    res.status(500).send("Fout: " + error.message);
  }
});

// Mapping van alle Omgevingsdiensten naar hun PFAS/bodem pagina
// Keys = exact zoals opgeslagen in Firestore (case-insensitive matching)
const OD_LINK_MAP = {
  // Zuid-Holland
  'DCMR': 'https://www.dcmr.nl/over-dcmr/thema-s/bodem/pfas.html',
  'DCMR Milieudienst Rijnmond': 'https://www.dcmr.nl/over-dcmr/thema-s/bodem/pfas.html',
  'Omgevingsdienst Midden-Holland': 'https://www.odmh.nl/themas/bodem/bodemkwaliteitskaart/',
  'ODMH': 'https://www.odmh.nl/themas/bodem/bodemkwaliteitskaart/',
  'OZHZ': 'https://www.ozhz.nl/themas/bodem/pfas/',
  'OZHZ (Omgevingsdienst Zuid-Holland Zuid)': 'https://www.ozhz.nl/themas/bodem/pfas/',
  'Omgevingsdienst Zuid-Holland Zuid': 'https://www.ozhz.nl/themas/bodem/pfas/',
  'Omgevingsdienst Haaglanden': 'https://www.odh.nl/themas/bodem',
  'ODH': 'https://www.odh.nl/themas/bodem',
  'ODWH': 'https://www.odwh.nl/themas/bodem',
  // Noord-Holland
  'ODNZKG': 'https://odnzkg.nl/themas/bodem/pfas/',
  'Omgevingsdienst Noordzeekanaalgebied': 'https://odnzkg.nl/themas/bodem/pfas/',
  'OD NZKG': 'https://odnzkg.nl/themas/bodem/pfas/',
  'Omgevingsdienst IJmond': 'https://www.odijmond.nl/themas/bodem',
  'ODIJ': 'https://www.odijmond.nl/themas/bodem',
  // Utrecht
  'ODRU': 'https://www.odru.nl/themas/bodem',
  'Omgevingsdienst Utrecht': 'https://www.odru.nl/themas/bodem',
  'Omgevingsdienst Utrecht (ODU)': 'https://www.odru.nl/themas/bodem',
  'Omgevingsdienst Utrecht (voorheen Omgevingsdienst Regio Utrecht - ODRU)': 'https://www.odru.nl/themas/bodem',
  'RUD Utrecht': 'https://www.odru.nl/themas/bodem',
  // Noord-Brabant
  'ODBN': 'https://www.odbn.nl/bodem-en-water/pfas',
  'Omgevingsdienst Brabant Noord': 'https://www.odbn.nl/bodem-en-water/pfas',
  'ODZOB': 'https://www.odzob.nl/themas/bodem',
  'Omgevingsdienst Brabant Zuidoost': 'https://www.odzob.nl/themas/bodem',
  'OMWB': 'https://www.omwb.nl/themas/bodem/pfas',
  'Omgevingsdienst Midden- en West-Brabant': 'https://www.omwb.nl/themas/bodem/pfas',
  // Gelderland
  'ODRN': 'https://www.odrn.nl/themas/bodem',
  'Omgevingsdienst Regio Nijmegen': 'https://www.odrn.nl/themas/bodem',
  'Omgevingsdienst Rivierenland': 'https://www.odrivierenland.nl/themas/bodem',
  'ODA': 'https://www.omgevingsdienstachterhoek.nl/themas/bodem',
  'Omgevingsdienst Achterhoek': 'https://www.omgevingsdienstachterhoek.nl/themas/bodem',
  'Omgevingsdienst Veluwe IJssel': 'https://www.odvij.nl/themas/bodem',
  // Overijssel
  'Omgevingsdienst IJsselland': 'https://www.odijsselland.nl/themas/bodem',
  'OT': 'https://www.omgevingsdiensttwente.nl/themas/bodem',
  'Omgevingsdienst Twente': 'https://www.omgevingsdiensttwente.nl/themas/bodem',
  // Friesland
  'FUMO': 'https://www.fumo.nl/themas/bodem',
  'Omgevingsdienst Fryske Utfieringstsjinst Miljeu en Omjouwing (FUMO)': 'https://www.fumo.nl/themas/bodem',
  'Fryske Utfieringstsjinst Miljeu en Omjouwing': 'https://www.fumo.nl/themas/bodem',
  // Groningen
  'Omgevingsdienst Groningen': 'https://www.omgevingsdienst.nl/themas/bodem',
  'ODG': 'https://www.omgevingsdienst.nl/themas/bodem',
  // Drenthe
  'RUD Drenthe': 'https://www.rudrenthe.nl/themas/bodem',
  'Omgevingsdienst Drenthe': 'https://www.rudrenthe.nl/themas/bodem',
  'Milieu Adviesbureau Drenthe': 'https://www.rudrenthe.nl/themas/bodem',
  // Flevoland
  'OFGV': 'https://www.ofgv.nl/themas/bodem',
  'Omgevingsdienst Flevoland & Gooi en Vechtstreek': 'https://www.ofgv.nl/themas/bodem',
  // Limburg
  'RUD Zuid-Limburg': 'https://www.rudzl.nl/themas/bodem',
  'Omgevingsdienst Noord- en Midden-Limburg': 'https://www.odnl.nl/themas/bodem',
  'ODNL': 'https://www.odnl.nl/themas/bodem',
  // Zeeland
  'RUD Zeeland': 'https://www.rudzeeland.nl/themas/bodem',
};

const gemeenteMapping = require('./gemeente_mapping.json');

exports.fixLinks = functions.runWith({ timeoutSeconds: 540 }).https.onRequest(async (req, res) => {
  const pfasNormen = require('./pfas_normen.json');
  
  try {
    const snapshot = await db.collection('pfasData').get();
    let fixedValues = 0;
    let fixedLinks = 0;

    // Firestore staat maximaal 500 schrijfacties per batch toe. Met ~342
    // gemeenten (en meer zodra er dubbele documenten in staan) liep één enkele
    // batch daar overheen en faalde de hele functie.
    const updates = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const gemeente = data.gemeente || doc.id;
      
      // Skip handmatig overschreven gemeenten
      if (data.handmatigeOverschrijving === true) return;
      
      // 1. Bepaal de correcte PFAS waarden
      const afwijkend = pfasNormen.afwijkend || {};
      const afwijkendKey = Object.keys(afwijkend).find(k =>
        gemeente && gemeente.toLowerCase().trim() === k.toLowerCase().trim()
      );
      
      let correcteWaarden;
      if (afwijkendKey) {
        const ad = afwijkend[afwijkendKey];
        correcteWaarden = {
          pfos: ad.pfos,
          pfoa: ad.pfoa,
          genx: ad.genx,
          heeftAfwijkendBeleid: true,
          omgevingsdienst: ad.omgevingsdienst || data.omgevingsdienst || 'Onbekend',
          opmerkingen: ad.opmerkingen || 'Specifiek lokaal beleid (geverifieerd).',
          confidenceScore: 100
        };
      } else {
        const lk = pfasNormen.landelijk_kader;
        correcteWaarden = {
          pfos: { ...lk.pfos },
          pfoa: { ...lk.pfoa },
          genx: { ...lk.genx },
          heeftAfwijkendBeleid: false,
          opmerkingen: lk.opmerkingen,
          confidenceScore: 100
        };
      }
      
      // 2. Bepaal de correcte bronlink
      if (afwijkendKey && afwijkend[afwijkendKey].bronLink) {
        correcteWaarden.bronLink = afwijkend[afwijkendKey].bronLink;
        fixedLinks++;
      } else {
        const gemeenteKey = Object.keys(gemeenteMapping).find(k =>
          gemeente && gemeente.toLowerCase().trim() === k.toLowerCase().trim()
        );
        
        if (gemeenteKey) {
          correcteWaarden.bronLink = gemeenteMapping[gemeenteKey];
          fixedLinks++;
        }
      }
      
      // 3. Update het document
      updates.push({ ref: doc.ref, data: correcteWaarden });
      fixedValues++;
    });

    const BATCH_LIMIET = 400;
    for (let i = 0; i < updates.length; i += BATCH_LIMIET) {
      const batch = db.batch();
      for (const u of updates.slice(i, i + BATCH_LIMIET)) {
        batch.update(u.ref, u.data);
      }
      await batch.commit();
    }
    res.send(`Succes! ${fixedValues} gemeenten gereset naar correcte hardcoded PFAS waarden. ${fixedLinks} bronlinks bijgewerkt. (${snapshot.size} totaal)`);
  } catch (error) {
    console.error("Fout bij fixen data:", error);
    res.status(500).send("Fout: " + error.message);
  }
});

// ============================================================
// AUDIT: is de dataset compleet en plausibel?
// ============================================================
// Vergelijkt Firestore met de canonieke gemeentelijst en rapporteert elk gat.
// Dit is de enige manier om te kúnnen zeggen dat alle gemeenten verwerkt zijn;
// "de scraper is gedraaid zonder fouten" bewijst dat niet.
//
// Schrijft niets. Bedoeld om na elke scraper-run te draaien en om in de gaten
// te houden of de dekking niet stilletjes wegzakt.
exports.auditData = functions.runWith({ timeoutSeconds: 300 }).https.onRequest(async (req, res) => {
  const maxDagenOud = parseInt(req.query.maxDagen) || 90;

  try {
    const lijst = await haalGemeenteLijst();
    const canoniek = new Map(lijst.gemeenten.map(n => [toDocId(n), n]));

    const snapshot = await db.collection('pfasData').get();

    const inDb = new Map();
    const dubbeleIds = [];
    const verdachteWaarden = [];
    const zwakkeBronnen = [];
    const verouderd = [];
    let afwijkendBeleid = 0;

    const vandaag = new Date();

    snapshot.forEach(doc => {
      const data = doc.data();
      const naam = data.gemeente || doc.id;
      const id = toDocId(naam);

      if (doc.id !== id) dubbeleIds.push({ docId: doc.id, zouMoetenZijn: id });
      inDb.set(id, data);

      if (data.heeftAfwijkendBeleid === true) afwijkendBeleid++;

      // Waarden plausibel?
      for (const stof of ['pfos', 'pfoa', 'genx']) {
        const w = data[stof];
        if (!w) {
          verdachteWaarden.push({ gemeente: naam, probleem: `${stof} ontbreekt volledig` });
          continue;
        }
        for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
          const v = w[klasse];
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            verdachteWaarden.push({ gemeente: naam, probleem: `${stof}.${klasse} is geen getal (${v})` });
          } else if (v <= 0 || v > 50) {
            verdachteWaarden.push({ gemeente: naam, probleem: `${stof}.${klasse} = ${v} (buiten 0-50)` });
          }
        }
      }

      // Bronlink bruikbaar?
      const link = data.bronLink;
      if (!link) {
        zwakkeBronnen.push({ gemeente: naam, probleem: 'geen bronLink' });
      } else if (link.includes('google.com/search')) {
        zwakkeBronnen.push({ gemeente: naam, probleem: 'bronLink is een Google-zoekopdracht' });
      } else {
        try {
          const pad = new URL(link).pathname;
          if (pad === '' || pad === '/') {
            zwakkeBronnen.push({ gemeente: naam, probleem: 'bronLink is alleen een homepage, geen PFAS-pagina' });
          }
        } catch {
          zwakkeBronnen.push({ gemeente: naam, probleem: `bronLink is geen geldige URL (${link})` });
        }
      }

      // Hoe oud is de laatste update?
      if (data.laatstGeupdate) {
        const dagen = Math.floor((vandaag - new Date(data.laatstGeupdate)) / 86400000);
        if (Number.isFinite(dagen) && dagen > maxDagenOud) {
          verouderd.push({ gemeente: naam, laatstGeupdate: data.laatstGeupdate, dagenOud: dagen });
        }
      } else {
        verouderd.push({ gemeente: naam, laatstGeupdate: null, dagenOud: null });
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

    res.json({
      samenvatting: {
        gemeentenVolgensBron: canoniek.size,
        documentenInFirestore: snapshot.size,
        dekkingProcent: dekking,
        ontbrekend: ontbrekend.length,
        verweesd: verweesd.length,
        dubbeleIds: dubbeleIds.length,
        verdachteWaarden: verdachteWaarden.length,
        zwakkeBronlinks: zwakkeBronnen.length,
        verouderd: verouderd.length,
        metAfwijkendBeleid: afwijkendBeleid
      },
      bron: lijst.bron,
      bronWaarschuwingen: lijst.waarschuwingen,
      // Gemeenten die de canonieke lijst wel kent maar Firestore niet
      ontbrekendeGemeenten: ontbrekend,
      // Documenten voor gemeenten die niet meer bestaan (bijv. na een herindeling)
      verweesdeDocumenten: verweesd,
      dubbeleIds,
      verdachteWaarden,
      zwakkeBronlinks: zwakkeBronnen,
      verouderdeDocumenten: verouderd.sort((a, b) => (b.dagenOud || 1e9) - (a.dagenOud || 1e9)).slice(0, 50)
    });

  } catch (error) {
    console.error('Audit gefaald:', error);
    res.status(500).json({ error: error.message, waarschuwingen: error.waarschuwingen });
  }
});


// ============================================================
// OPRUIMEN: dubbele documenten samenvoegen
// ============================================================
// fillDefaultData en syncSheet gebruikten `/\\s+/g` in plaats van `/\s+/g`.
// Die regex matcht een letterlijke backslash, geen spatie, dus kreeg elke
// gemeente met een spatie in de naam twee documenten:
//   "bergen op zoom"  (fillDefaultData / syncSheet)
//   "bergen-op-zoom"  (scraper / checkBekendmakingen)
//
// De code schrijft nu overal hetzelfde id, maar de dubbelen die al in
// Firestore staan blijven bestaan. Deze functie voegt ze samen.
//
// Standaard is dit een DROOGLOOP die alleen rapporteert wat er zou gebeuren.
// Pas met ?apply=true worden documenten daadwerkelijk samengevoegd en verwijderd.
exports.mergeDuplicateDocs = functions.runWith({ timeoutSeconds: 540 }).https.onRequest(async (req, res) => {
  const apply = req.query.apply === 'true';

  try {
    const snapshot = await db.collection('pfasData').get();

    // Groepeer alle documenten op hun canonieke id
    const perCanoniekId = new Map();
    snapshot.forEach(doc => {
      const data = doc.data();
      const canoniek = toDocId(data.gemeente || doc.id);
      if (!canoniek) return;
      if (!perCanoniekId.has(canoniek)) perCanoniekId.set(canoniek, []);
      perCanoniekId.get(canoniek).push({ id: doc.id, ref: doc.ref, data });
    });

    const acties = [];

    for (const [canoniek, docs] of perCanoniekId) {
      const strays = docs.filter(d => d.id !== canoniek);
      if (strays.length === 0) continue;

      const canoniekeDoc = docs.find(d => d.id === canoniek);

      // Handmatige overschrijvingen (via Google Sheets) winnen altijd, daarna
      // het canonieke document, daarna de rest.
      const prioriteit = [...docs].sort((a, b) => {
        if (a.data.handmatigeOverschrijving !== b.data.handmatigeOverschrijving) {
          return a.data.handmatigeOverschrijving ? -1 : 1;
        }
        if ((a.id === canoniek) !== (b.id === canoniek)) return a.id === canoniek ? -1 : 1;
        return String(b.data.laatstGeupdate || '').localeCompare(String(a.data.laatstGeupdate || ''));
      });

      // Minst belangrijke eerst samenvoegen, zodat de belangrijkste bovenop komt
      const samengevoegd = {};
      for (const d of [...prioriteit].reverse()) {
        Object.assign(samengevoegd, d.data);
      }
      samengevoegd.gemeente = samengevoegd.gemeente || canoniek;

      acties.push({
        canoniek,
        behoudt: canoniek,
        verwijdert: strays.map(s => s.id),
        canoniekBestondAl: Boolean(canoniekeDoc)
      });

      if (apply) {
        await db.collection('pfasData').doc(canoniek).set(samengevoegd, { merge: true });
        for (const stray of strays) {
          await stray.ref.delete();
        }
      }
    }

    res.json({
      modus: apply ? 'UITGEVOERD' : 'DROOGLOOP (voeg ?apply=true toe om door te voeren)',
      documentenTotaal: snapshot.size,
      gemeentenMetDubbelen: acties.length,
      documentenTeVerwijderen: acties.reduce((n, a) => n + a.verwijdert.length, 0),
      details: acties
    });
  } catch (error) {
    console.error('Fout bij samenvoegen dubbelen:', error);
    res.status(500).json({ error: error.message });
  }
});

const { syncGoogleSheetToFirestore } = require('./syncSheet');

exports.syncSheetNow = functions.runWith({ timeoutSeconds: 540 }).https.onRequest(async (req, res) => {
  try {
    const sheetId = req.query.sheetId;
    
    // Save to config if provided
    if (sheetId) {
      await db.collection('config').doc('settings').set({ sheetId }, { merge: true });
    }
    
    // Read from config if not provided in query
    let targetSheetId = sheetId;
    if (!targetSheetId) {
      const configDoc = await db.collection('config').doc('settings').get();
      if (configDoc.exists) {
        targetSheetId = configDoc.data().sheetId;
      }
    }
    
    if (!targetSheetId) {
      return res.status(400).send("Geen sheetId opgegeven en niet in database gevonden. Gebruik ?sheetId=xyz");
    }
    
    const count = await syncGoogleSheetToFirestore(db, targetSheetId);
    res.send(`Succes! Er zijn ${count} rijen gesynchroniseerd vanuit de Google Sheet.`);
  } catch (error) {
    console.error("Fout bij syncen sheet:", error);
    res.status(500).send("Fout: " + error.message);
  }
});

// Gericht link-zoeker: vindt echte bronlinks voor gemeenten die nu alleen een Google Search link hebben
exports.findRealLinks = functions.runWith({ timeoutSeconds: 540, secrets: ["GEMINI_API_KEY"] }).https.onRequest(async (req, res) => {
  const { GoogleGenAI } = require('@google/genai');
  const axios = require('axios');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).send("GEMINI_API_KEY niet geconfigureerd.");

  const ai = new GoogleGenAI({ apiKey });
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // Batchindex via query param (?batch=0 t/m 6)
  const batchIndex = parseInt(req.query.batch ?? '0');
  const batchSize = 50;

  // Haal gemeenten op die een Google Search link hebben
  const snapshot = await db.collection('pfasData').get();
  const needsLink = [];
  snapshot.forEach(doc => {
    const d = doc.data();
    if (d.bronLink && d.bronLink.includes('google.com/search')) {
      needsLink.push({ docId: doc.id, gemeente: d.gemeente, omgevingsdienst: d.omgevingsdienst });
    }
  });

  const start = batchIndex * batchSize;
  const batch = needsLink.slice(start, start + batchSize);

  if (batch.length === 0) {
    return res.send(`Geen gemeenten meer te verwerken in batch ${batchIndex}. Totaal nog ${needsLink.length} gemeenten met Google Search links.`);
  }

  res.write(`Start batch ${batchIndex}: ${batch.length} gemeenten te verwerken (${needsLink.length} totaal nog te doen)...\n`);

  let fixedCount = 0;

  for (const { docId, gemeente, omgevingsdienst } of batch) {
    try {
      const prompt = `
      Zoek de EXACTE, DIRECTE webpagina-URL waarop de gemeente ${gemeente} (of haar omgevingsdienst ${omgevingsdienst || 'onbekend'}) de actuele PFAS bodemkwaliteitskaart of nota bodembeheer publiceert.

      Regels:
      1. Geef ALLEEN een JSON object terug: { "bronLink": "https://..." }
      2. De URL moet een ECHTE, BESTAANDE pagina zijn op de website van de gemeente of omgevingsdienst — NIET van iplo.nl, NIET van rijksoverheid.nl, NIET van bodemplus.nl, NIET van google.com.
      3. Als je geen specifieke pagina kunt vinden, geef dan de HOOFDPAGINA van de omgevingsdienst: bijv. "https://www.dcmr.nl" of "https://odru.nl"
      4. NIMMER een verzonnen URL. Als je twijfelt, geef de homepagina van de meest waarschijnlijke omgevingsdienst.
      5. Geen markdown, alleen JSON.
      `;

      let response;
      const retries = 3;
      let delayMs = 2000;
      for (let i = 0; i < retries; i++) {
        try {
          response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { tools: [{ googleSearch: {} }] }
          });
          break;
        } catch (err) {
          const isTransient = err.message && (
            err.message.includes('503') || 
            err.message.includes('429') || 
            err.message.includes('demand') || 
            err.message.includes('UNAVAILABLE') || 
            err.message.includes('RESOURCE_EXHAUSTED')
          );
          if (isTransient && i < retries - 1) {
            console.warn(`⚠️ Tijdelijke Gemini API fout (503/429) voor ${gemeente} in findRealLinks. Retry in ${delayMs}ms... (Poging ${i + 1}/${retries})`);
            await delay(delayMs);
            delayMs *= 2;
          } else {
            throw err;
          }
        }
      }

      let raw = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(raw);
      const newLink = result.bronLink;

      // Valideer: niet generic, en begint met http
      const isGeneric = ['iplo.nl', 'bodemplus.nl', 'rijksoverheid.nl', 'google.com', 'vertexaisearch'].some(d => newLink.includes(d));
      const isValid = newLink && newLink.startsWith('http') && !isGeneric;

      if (isValid) {
        // Test of de URL reachable is
        try {
          await axios.head(newLink, { timeout: 4000 });
          await db.collection('pfasData').doc(docId).update({ bronLink: newLink });
          fixedCount++;
          res.write(`✅ ${gemeente}: ${newLink}\n`);
        } catch {
          res.write(`⚠️ ${gemeente}: Link onbereikbaar (${newLink}), overgeslagen.\n`);
        }
      } else {
        res.write(`⏭️ ${gemeente}: Geen betere link gevonden (${newLink}).\n`);
      }
    } catch (err) {
      res.write(`❌ ${gemeente}: Fout - ${err.message}\n`);
    }
    await delay(2000); // Respecteer API limieten
  }

  res.end(`\nKlaar! ${fixedCount} van de ${batch.length} gemeenten bijgewerkt met een echte link.`);
});

