const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { runWeeklyScraper } = require('./scraper');
const { toDocId } = require('./docId');
const { haalGemeenteLijst } = require('./gemeentelijst');
const { verzamelAudit, beoordeelAudit } = require('./audit');

// Landelijk kader bij het Informatiepunt Leefomgeving (opvolger van bodemplus.nl).
const LANDELIJK_KADER_LINK =
  'https://iplo.nl/thema/bodem/regelgeving/hergebruik-bouwstoffen-grond-of-baggerspecie/' +
  'kwaliteitseisen-toepassen-grond-baggerspecie/handelingskader-pfas/';

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
    bronLink: "https://www.dcmr.nl/pfas-in-de-bodem"
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
    bronLink: "https://odnzkg.nl/kaarten/pfas-bodemkwaliteitskaart/"
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
    bronLink: "https://odbn.nl/expertises/bodem/pfas"
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
          "bronLink": "https://www.dcmr.nl/pfas-in-de-bodem"
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
          "bronLink": "https://odnzkg.nl/kaarten/pfas-bodemkwaliteitskaart/"
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
          "bronLink": "https://odbn.nl/expertises/bodem/pfas"
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

// Gemeenten waar een mogelijke afwijking is gevonden die nog niet geverifieerd
// is. Deze tonen in het dashboard het landelijk kader, maar het besluit dat de
// twijfel veroorzaakte staat erbij. Dit is de werkvoorraad voor handmatige
// review — laat hem niet vollopen.
app.get(['/v1/te-reviewen', '/api/v1/te-reviewen'], async (req, res) => {
  try {
    const snapshot = await db.collection('pfasData').where('tereviewen', '==', true).get();
    const data = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      data.push({
        id: doc.id,
        gemeente: d.gemeente,
        herkomst: d.herkomst,
        bronLink: d.bronLink,
        bronDocument: d.bronDocument,
        bronDocumentTitel: d.bronDocumentTitel,
        bronDocumentDatum: d.bronDocumentDatum,
        mogelijkeWaarden: d.mogelijkeWaarden || null
      });
    });
    res.json(data);
  } catch (error) {
    console.error('Error getting te-reviewen', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

exports.pfasApi = functions.https.onRequest(app);

const { checkOfficieleBekendmakingen, sweepBekendmakingen, herbouwAfwijkingen } = require('./checkBekendmakingen');

// ============================================================
// WEKELIJKSE SWEEP: alle PFAS-bekendmakingen
// ============================================================
// Draait elke maandag om 03:00. Haalt alle gemeentebladen op die sinds de
// vorige geslaagde run zijn gepubliceerd, verwerkt nieuwe documenten met de AI
// en herberekent daarna per gemeente of er afwijkend beleid geldt.
//
// Elk document wordt maar één keer door de AI gehaald, dus een wekelijkse run
// kost alleen API-calls voor wat er nieuw bij is gekomen.
exports.weeklyBekendmakingenSweep = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: ["GEMINI_API_KEY"] })
  .pubsub
  .schedule('0 3 * * 1')
  .timeZone('Europe/Amsterdam')
  .onRun(async () => {
    const resultaat = await sweepBekendmakingen(db);
    console.log('Wekelijkse sweep afgerond:', JSON.stringify(resultaat));
    return null;
  });

// Handmatige sweep / backfill.
//   ?vanaf=2019-01-01   ondergrens (standaard: watermerk van de vorige run)
//   ?max=200            rem op het aantal nieuwe AI-extracties in deze run
//   ?forceer=true       alle documenten opnieuw analyseren
//
// De eerste keer draai je dit met een vroege vanaf-datum om het corpus op te
// bouwen. Omdat verwerkte documenten worden onthouden, kun je de functie
// gewoon opnieuw aanroepen tot alles binnen is — hij pakt op waar hij bleef.
exports.sweepBekendmakingenNow = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB', secrets: ["GEMINI_API_KEY"] })
  .https.onRequest(async (req, res) => {
    try {
      const resultaat = await sweepBekendmakingen(db, {
        vanaf: req.query.vanaf,
        forceer: req.query.forceer === 'true',
        maxDocumenten: parseInt(req.query.max) || 200
      });
      res.json({ succes: true, resultaat });
    } catch (error) {
      console.error('Sweep gefaald:', error);
      res.status(500).json({ error: error.message });
    }
  });

// Herberekent alleen de afgeleide toestand per gemeente uit het al opgebouwde
// documentcorpus. Geen AI-calls, geen netwerk — handig na het handmatig
// corrigeren van een document.
exports.herbouwAfwijkingenNow = functions
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    try {
      res.json({ succes: true, resultaat: await herbouwAfwijkingen(db) });
    } catch (error) {
      console.error('Herbouw gefaald:', error);
      res.status(500).json({ error: error.message });
    }
  });

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
        // Geen provincie-veld meer: hier stond letterlijk "Nederland", wat geen
        // provincie is en in de frontend als zodanig getoond werd. Liever geen
        // waarde dan een onjuiste.
        omgevingsdienst: "Volgens landelijk kader",
        pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
        pfos: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 },
        genx: { wonen: 3, industrie: 3, landbouwNatuur: 0.8 },
        heeftAfwijkendBeleid: false,
        laatstGeupdate: new Date().toISOString().split('T')[0],
        opmerkingen: "Geen specifiek lokaal beleid geüploaded; toont Tijdelijk Handelingskader PFAS (RIVM). Raadpleeg de regionale Omgevingsdienst voor actuele lokale regels.",
        // bodemplus.nl is opgevolgd door het Informatiepunt Leefomgeving.
        // migrate-links.js bestaat juist om die oude link weg te werken; hier
        // werd hij daarna telkens opnieuw ingezet.
        bronLink: LANDELIJK_KADER_LINK
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

// OD_LINK_MAP is hier verwijderd: die tabel werd nergens gebruikt en bevatte
// dezelfde ongeverifieerde URL's als gemeente_mapping.json (o.a. rudrenthe.nl
// terwijl het domein oddrenthe.nl is). Dode code met foute data leidt de
// volgende lezer alleen maar om de tuin. gemeente_mapping.json is de enige
// bron voor bronlinks.

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
// De logica staat in audit.js, zodat zowel deze HTTP-endpoint als de
// dagelijkse controle exact dezelfde cijfers gebruiken.
exports.auditData = functions.runWith({ timeoutSeconds: 300 }).https.onRequest(async (req, res) => {
  try {
    const rapport = await verzamelAudit(db, { maxDagenOud: parseInt(req.query.maxDagen) || 90 });
    res.json(rapport);
  } catch (error) {
    console.error('Audit gefaald:', error);
    res.status(500).json({ error: error.message, waarschuwingen: error.waarschuwingen });
  }
});


// ============================================================
// DAGELIJKSE CONTROLE
// ============================================================
// Draait elke ochtend om 07:00 en beoordeelt de dataset. Het resultaat gaat
// naar config/healthcheck en, bij problemen, als console.error naar Cloud
// Logging — daar kun je een log-based alert op zetten zonder dat er verder
// iets hoeft te draaien.
//
// Dit vervangt het handmatig langslopen: dekking die wegzakt, dubbele
// documenten of een sweep die stilstaat merk je anders pas als iemand een
// verkeerde norm gebruikt.
exports.dailyHealthCheck = functions
  .runWith({ timeoutSeconds: 300 })
  .pubsub
  .schedule('0 7 * * *')
  .timeZone('Europe/Amsterdam')
  .onRun(async () => {
    let rapport, oordeel;
    try {
      rapport = await verzamelAudit(db, { maxDagenOud: 90 });
      oordeel = beoordeelAudit(rapport);
    } catch (err) {
      console.error('❌ HEALTHCHECK MISLUKT:', err.message);
      await db.collection('config').doc('healthcheck').set({
        tijdstip: new Date().toISOString(), gezond: false, fout: err.message
      }, { merge: true });
      return null;
    }

    await db.collection('config').doc('healthcheck').set({
      tijdstip: rapport.tijdstip,
      gezond: oordeel.gezond,
      problemen: oordeel.problemen,
      samenvatting: rapport.samenvatting,
      herkomst: rapport.herkomst
    }, { merge: true });

    if (oordeel.gezond) {
      console.log('✅ Healthcheck in orde:', JSON.stringify(rapport.samenvatting));
    } else {
      // console.error is hier bewust: hierop kan een alert in Cloud Logging staan.
      console.error('❌ PFAS DASHBOARD HEALTHCHECK: ' + oordeel.problemen.length +
        ' probleem(en)\n - ' + oordeel.problemen.join('\n - '));
    }
    return null;
  });

// Zelfde controle, maar direct opvraagbaar. Geeft HTTP 200 als alles klopt en
// 503 als er iets mis is, zodat een externe uptime-monitor erop kan afgaan.
exports.healthCheck = functions.runWith({ timeoutSeconds: 300 }).https.onRequest(async (req, res) => {
  try {
    const rapport = await verzamelAudit(db, { maxDagenOud: parseInt(req.query.maxDagen) || 90 });
    const oordeel = beoordeelAudit(rapport);
    res.status(oordeel.gezond ? 200 : 503).json({
      gezond: oordeel.gezond,
      problemen: oordeel.problemen,
      samenvatting: rapport.samenvatting,
      herkomst: rapport.herkomst
    });
  } catch (error) {
    console.error('Healthcheck gefaald:', error);
    res.status(503).json({ gezond: false, fout: error.message });
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

