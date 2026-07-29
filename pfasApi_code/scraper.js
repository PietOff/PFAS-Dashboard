const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const { getAdapterData } = require('./adapters/index');
const gemeenteMapping = require('./gemeente_mapping.json');
const pfasNormen = require('./pfas_normen.json');
const { toDocId } = require('./docId');
const { haalGemeenteLijst } = require('./gemeentelijst');

// ============================================================
// PRIMAIRE DATABRON: Hardcoded, geverifieerde PFAS normen
// ============================================================

/**
 * Geeft de correcte PFAS waarden terug voor een gemeente.
 * 
 * Volgorde:
 * 1. Check of de gemeente een bekende afwijkende gemeente is → gebruik die waarden
 * 2. Anders → gebruik het landelijke kader (geldt voor 95%+ van alle gemeenten)
 * 
 * De AI scraper wordt NOOIT als databron gebruikt. Alleen als verificatie-scanner.
 */
function getHardcodedData(gemeenteNaam) {
  // Check of deze gemeente afwijkende waarden heeft
  const afwijkend = pfasNormen.afwijkend || {};
  const gemeenteKey = Object.keys(afwijkend).find(k =>
    gemeenteNaam && gemeenteNaam.toLowerCase().trim() === k.toLowerCase().trim()
  );

  if (gemeenteKey) {
    const data = afwijkend[gemeenteKey];
    return {
      gemeente: gemeenteNaam,
      omgevingsdienst: data.omgevingsdienst || 'Onbekend',
      pfos: data.pfos,
      pfoa: data.pfoa,
      genx: data.genx,
      heeftAfwijkendBeleid: true,
      opmerkingen: data.opmerkingen || 'Specifiek lokaal beleid (geverifieerd).',
      confidenceScore: 100
    };
  }

  // Standaard: landelijk kader
  const lk = pfasNormen.landelijk_kader;
  return {
    gemeente: gemeenteNaam,
    omgevingsdienst: 'Volgens landelijk kader',
    pfos: { ...lk.pfos },
    pfoa: { ...lk.pfoa },
    genx: { ...lk.genx },
    heeftAfwijkendBeleid: false,
    opmerkingen: lk.opmerkingen,
    confidenceScore: 100
  };
}


// ============================================================
// AI VERIFICATIE-SCANNER (optioneel, logt alleen waarschuwingen)
// ============================================================

/**
 * Vraagt de AI om te controleren of er nieuw lokaal beleid is verschenen.
 * Retourneert ALLEEN een waarschuwing als de AI denkt dat er afwijkend beleid is.
 * Overschrijft NOOIT zelf data in de database.
 */
async function scanForNewPolicy(gemeenteNaam) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
  Je bent een expert in de Nederlandse Omgevingswet. Controleer via Google Search of de gemeente ${gemeenteNaam} 
  een EIGEN, AFWIJKEND PFAS bodembeleid heeft (bijv. een lokale bodemkwaliteitskaart met andere PFAS-waarden 
  dan het landelijke Tijdelijk Handelingskader).
  
  Het landelijke kader is:
  - PFOS: Wonen/Industrie 3.0 µg/kg, Landbouw/Natuur 1.4 µg/kg
  - PFOA: Wonen/Industrie 7.0 µg/kg, Landbouw/Natuur 1.9 µg/kg
  - GenX: Wonen/Industrie 3.0 µg/kg, Landbouw/Natuur 0.8 µg/kg
  
  Antwoord UITSLUITEND met een geldig JSON object (GEEN markdown!):
  {
    "gemeente": "${gemeenteNaam}",
    "heeftAfwijkendBeleid": true of false,
    "toelichting": "Korte uitleg waarom je denkt dat er wel/geen afwijkend beleid is",
    "gevondenWaarden": {
      "pfos": { "wonen": getal_of_null, "industrie": getal_of_null, "landbouwNatuur": getal_of_null },
      "pfoa": { "wonen": getal_of_null, "industrie": getal_of_null, "landbouwNatuur": getal_of_null },
      "genx": { "wonen": getal_of_null, "industrie": getal_of_null, "landbouwNatuur": getal_of_null }
    },
    "bronLink": "URL van de bron (alleen als je echt iets gevonden hebt)"
  }
  
  BELANGRIJKE REGELS:
  1. Wees CONSERVATIEF. Bij twijfel: stel heeftAfwijkendBeleid op false.
  2. Alleen als je een OFFICIEEL DOCUMENT vindt met ANDERE waarden dan hierboven, stel je het op true.
  3. Alle waarden moeten in µg/kg d.s. zijn. Als je ng/kg ziet, deel door 1000.
  4. Waarden boven de 50 µg/kg zijn ALTIJD fout (verwarring met andere stof of eenheid). Negeer ze.
  5. Als de gevonden waarden GELIJK zijn aan het landelijke kader, is er GEEN afwijkend beleid.
  `;

  const retries = 3;
  let delay = 2000;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }]
        }
      });

      let raw = response.text;
      raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(raw);
    } catch (err) {
      const isTransient = err.message && (
        err.message.includes('503') || 
        err.message.includes('429') || 
        err.message.includes('demand') || 
        err.message.includes('UNAVAILABLE') || 
        err.message.includes('RESOURCE_EXHAUSTED')
      );
      if (isTransient && i < retries - 1) {
        console.warn(`⚠️ Tijdelijke Gemini API fout (503/429) voor ${gemeenteNaam}. Retry in ${delay}ms... (Poging ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        console.error(`AI scan gefaald voor ${gemeenteNaam}:`, err.message);
        return null;
      }
    }
  }
}


// ============================================================
// HOOFD SCRAPER FUNCTIE
// ============================================================

module.exports = {
  getHardcodedData,
  scanForNewPolicy,
  runWeeklyScraper: async (db, batchIndex = null, specificGemeenteNaam = null) => {
    console.log(`Starting scraper. Mode: ${batchIndex !== null ? batchIndex : (specificGemeenteNaam || 'ALL')}`);

    let targets = [];
    if (specificGemeenteNaam) {
      targets = [specificGemeenteNaam];
    } else if (batchIndex === 'daily') {
      // Dagelijkse modus: haal de 10 gemeenten op die het langst niet zijn geüpdatet
      console.log("Fetching 10 oldest updated municipalities...");
      const snapshot = await db.collection('pfasData')
        .orderBy('laatstGeupdate', 'asc')
        .limit(10)
        .get();

      targets = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data && data.gemeente) {
          targets.push(data.gemeente);
        }
      });

      // Fallback als er onvoldoende data is
      if (targets.length === 0) {
        console.log("Geen gemeenten gevonden via orderBy laatstGeupdate. Val terug op lijst.");
        const lijst = await haalGemeenteLijst();
        targets = lijst.gemeenten.slice(0, 10);
      }
    } else {
      // Alle gemeenten ophalen uit de canonieke lijst (Kadaster), niet uit een
      // geojson op de eigen hosting — anders mist elke herindeling.
      const lijst = await haalGemeenteLijst();
      console.log(`Gemeentelijst via: ${lijst.bron} (${lijst.gemeenten.length} gemeenten)`);
      for (const w of lijst.waarschuwingen) console.warn(`   ⚠️ ${w}`);

      const gemeenten = lijst.gemeenten;
      targets = gemeenten;
      if (batchIndex !== null && typeof batchIndex === 'number') {
        const batchSize = Math.ceil(gemeenten.length / 7);
        const startIndex = batchIndex * batchSize;
        targets = gemeenten.slice(startIndex, startIndex + batchSize);
      }
    }

    console.log(`Verwerken van ${targets.length} gemeenten...`);
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    for (const gemeenteNaam of targets) {
      console.log("Verwerken:", gemeenteNaam);

      try {
        const docId = toDocId(gemeenteNaam);

        // 1. Controleer of de gemeente handmatig is overschreven (via Google Sheets)
        const existingDoc = await db.collection('pfasData').doc(docId).get();
        if (existingDoc.exists && existingDoc.data().handmatigeOverschrijving === true) {
          console.log(`⏭️ ${gemeenteNaam} is handmatig overschreven. Overslaan.`);
          continue;
        }

        // 2. PRIMAIR: Haal de hardcoded, geverifieerde PFAS waarden op
        let pfasResult = getHardcodedData(gemeenteNaam);

        // 3. Check of we een API adapter hebben (bijv. voor specifieke Omgevingsdiensten)
        const adapterData = await getAdapterData(gemeenteNaam);
        if (adapterData) {
          // Adapter data is betrouwbaar, maar we valideren de waarden
          let adapterOk = true;
          ['pfoa', 'pfos', 'genx'].forEach(stof => {
            if (adapterData[stof]) {
              ['wonen', 'industrie', 'landbouwNatuur'].forEach(klasse => {
                if (adapterData[stof][klasse] > 50) adapterOk = false;
              });
            }
          });

          if (adapterOk) {
            pfasResult = { ...pfasResult, ...adapterData };
          } else {
            console.warn(`⚠️ API Adapter retourneerde onwaarschijnlijke waarden voor ${gemeenteNaam}. Genegeerd.`);
          }
        }

        // 4. OPTIONEEL: AI verificatie-scan (logt alleen, overschrijft nooit)
        try {
          const aiScan = await scanForNewPolicy(gemeenteNaam);
          if (aiScan && aiScan.heeftAfwijkendBeleid === true) {
            // Log de waarschuwing, maar overschrijf de data NIET
            console.log(`🔍 AI SIGNAAL voor ${gemeenteNaam}: Mogelijk afwijkend beleid gevonden.`);
            console.log(`   Toelichting: ${aiScan.toelichting}`);
            console.log(`   Bron: ${aiScan.bronLink || 'onbekend'}`);

            // Sla het signaal op in een aparte collectie voor handmatige review
            await db.collection('pfasSignalen').doc(docId).set({
              gemeente: gemeenteNaam,
              signaal: aiScan.toelichting,
              gevondenWaarden: aiScan.gevondenWaarden || null,
              bronLink: aiScan.bronLink || null,
              datum: new Date().toISOString().split('T')[0],
              status: 'open' // 'open', 'bevestigd', 'afgewezen'
            }, { merge: true });
          } else {
            console.log(`✅ AI bevestigt: ${gemeenteNaam} volgt het landelijke kader.`);
          }
        } catch (aiErr) {
          // AI falen is niet kritiek - de hardcoded data is al correct
          console.log(`ℹ️ AI scan overgeslagen voor ${gemeenteNaam}: ${aiErr.message}`);
        }

        // 5. Bronlink toevoegen vanuit gemeente_mapping
        const gemeenteKey = Object.keys(gemeenteMapping).find(k =>
          gemeenteNaam && gemeenteNaam.toLowerCase().trim() === k.toLowerCase().trim()
        );
        if (gemeenteKey) {
          pfasResult.bronLink = gemeenteMapping[gemeenteKey];
        }

        // 6. Opslaan
        pfasResult.laatstGeupdate = new Date().toISOString().split('T')[0];
        await db.collection('pfasData').doc(docId).set(pfasResult, { merge: true });
        console.log("✅ Data succesvol geüpdatet voor", gemeenteNaam);

      } catch (err) {
        console.error("❌ Verwerking gefaald voor", gemeenteNaam, err.message);
      }

      // Wacht 4,5 seconden om de gratis Gemini API limiet te respecteren
      await delay(4500);
    }
  }
};
