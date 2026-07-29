/**
 * checkBekendmakingen.js
 * 
 * Controleert de officiële overheids-API (KOOP / zoek.officielebekendmakingen.nl)
 * op nieuwe gemeentebladen die PFAS-bodembeleid bevatten.
 * 
 * Dit is een 100% betrouwbare bron — alles wat hier gepubliceerd wordt is
 * juridisch bindend overheidsbeleid.
 * 
 * Stroom:
 * 1. Zoek in de SRU API naar recente gemeentebladen met "PFAS" + "bodemkwaliteitskaart"
 * 2. Filter op publicaties van de afgelopen 7 dagen
 * 3. Voor elke hit: haal de volledige HTML tekst op
 * 4. Laat de AI de waarden extraheren (maar ALLEEN uit de officiële tekst)
 * 5. Als de AI waarden vindt die afwijken van het landelijk kader:
 *    a) bronLink = de officiële URL (zoek.officielebekendmakingen.nl/gmb-xxxx.html)
 *    b) Sla op als "signaal" met status 'officieel-gevonden'
 *    c) Als de waarden binnen redelijke grenzen vallen → update automatisch
 */

const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const pfasNormen = require('./pfas_normen.json');

const SRU_BASE = 'https://zoek.officielebekendmakingen.nl/sru/Search';

// Landelijk kader referentiewaarden
const LANDELIJK = pfasNormen.landelijk_kader;

/**
 * Zoek recente PFAS-gerelateerde gemeentebladen via de KOOP SRU API
 * @param {number} dagenTerug - Hoeveel dagen terug zoeken (standaard 7)
 * @returns {Array} - Array van gevonden publicaties
 */
async function zoekRecenteBekendmakingen(dagenTerug = 7) {
  const vandaag = new Date();
  const startDatum = new Date(vandaag);
  startDatum.setDate(startDatum.getDate() - dagenTerug);
  
  const formatDate = (d) => d.toISOString().split('T')[0];
  
  // Zoek op PFAS + bodem gerelateerde termen in gemeentebladen
  const query = `(PFAS OR pfas OR perfluoralkylstoffen OR polyfluoralkylstoffen OR fluorverbindingen) AND (bodemkwaliteitskaart OR bodembeheer OR bodembeleid OR achtergrondwaarden)`;
  
  const url = `${SRU_BASE}?version=1.2&operation=searchRetrieve&maximumRecords=50&x-connection=officielepublicaties&query=${encodeURIComponent(query)}`;
  
  console.log(`🔍 Zoeken in Officiële Bekendmakingen...`);
  console.log(`   Query: ${query}`);
  
  try {
    const response = await axios.get(url, { timeout: 30000 });
    const xml = response.data;
    
    // Parse XML (simpel, zonder externe dependency)
    const results = [];
    const recordRegex = /<(?:\w+:)?recordData>([\s\S]*?)<\/(?:\w+:)?recordData>/g;
    let match;
    
    while ((match = recordRegex.exec(xml)) !== null) {
      const data = match[1];
      
      const extract = (field) => {
        // Match both prefixed and unprefixed tags
        const re = new RegExp(`<(?:\\w+:)?${field}[^>]*>([^<]+)<\\/`, 'i');
        const m = data.match(re);
        return m ? m[1].trim() : null;
      };
      
      const title = extract('title');
      const creator = extract('creator');
      const date = extract('modified') || extract('date');
      const identifier = extract('identifier');
      const docUrl = extract('url');
      
      // Filter: alleen van de afgelopen X dagen
      if (date && new Date(date) >= startDatum) {
        results.push({
          title,
          gemeente: creator, // creator = gemeentenaam
          date,
          identifier,
          url: docUrl || (identifier ? `https://zoek.officielebekendmakingen.nl/${identifier}.html` : null)
        });
      }
    }
    
    // Also extract numberOfRecords
    const countMatch = xml.match(/<(?:\w+:)?numberOfRecords>(\d+)/);
    const totalCount = countMatch ? parseInt(countMatch[1]) : 0;
    
    console.log(`   Totaal in database: ${totalCount}, Recent (${dagenTerug} dagen): ${results.length}`);
    
    return results;
    
  } catch (err) {
    console.error('❌ Fout bij ophalen bekendmakingen:', err.message);
    return [];
  }
}


/**
 * Haal de volledige tekst op van een officiële bekendmaking
 * @param {string} docUrl - URL van het document
 * @returns {string} - Tekst van het document
 */
async function haalDocumentTekst(docUrl) {
  try {
    // Haal de plain-text versie op (voeg ?format=text toe of parse HTML)
    const response = await axios.get(docUrl, { 
      timeout: 15000,
      headers: { 'User-Agent': 'PFASDashboard/1.0 (overheid-monitoring)' }
    });
    
    // Strip HTML tags voor pure tekst
    let text = response.data;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    
    // Limiteer tot 8000 tekens voor de AI (genoeg om waarden te vinden)
    return text.substring(0, 8000);
    
  } catch (err) {
    console.error(`Kon document niet ophalen: ${docUrl}:`, err.message);
    return null;
  }
}


/**
 * Laat de AI specifieke PFAS-waarden extraheren uit een officieel overheidsdocument.
 * De AI krijgt ALLEEN de tekst van het officiële document — geen Google Search.
 * 
 * @param {string} gemeenteNaam 
 * @param {string} documentTekst 
 * @returns {Object|null}
 */
async function extractWaardenUitDocument(gemeenteNaam, documentTekst) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !documentTekst) return null;
  
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
Je bent een expert in Nederlands bodembeleid. Je krijgt hieronder de tekst van een OFFICIEEL gemeenteblad 
(gepubliceerd op officielebekendmakingen.nl) voor de gemeente ${gemeenteNaam}.

Analyseer de tekst en bepaal of dit document SPECIFIEKE PFAS-achtergrondwaarden of toepassingsnormen 
bevat die AFWIJKEN van het landelijke Tijdelijk Handelingskader.

Het landelijke kader is:
- PFOS: Wonen/Industrie 3.0 µg/kg ds, Landbouw/Natuur 1.4 µg/kg ds
- PFOA: Wonen/Industrie 7.0 µg/kg ds, Landbouw/Natuur 1.9 µg/kg ds
- GenX: Wonen/Industrie 3.0 µg/kg ds, Landbouw/Natuur 0.8 µg/kg ds

DOCUMENT TEKST:
---
${documentTekst}
---

Antwoord UITSLUITEND met een geldig JSON object:
{
  "heeftAfwijkendeWaarden": true of false,
  "toelichting": "Korte uitleg wat je gevonden hebt",
  "gevondenWaarden": {
    "pfos": { "wonen": getal_of_null, "industrie": getal_of_null, "landbouwNatuur": getal_of_null },
    "pfoa": { "wonen": getal_of_null, "industrie": getal_of_null, "landbouwNatuur": getal_of_null },
    "genx": { "wonen": getal_of_null, "industrie": getal_of_null, "landbouwNatuur": getal_of_null }
  },
  "zekerheid": "hoog" of "laag"
}

REGELS:
1. Alle waarden moeten in µg/kg d.s. zijn. Als je ng/kg ziet, deel door 1000.
2. Waarden boven 50 µg/kg zijn ALTIJD fout. Zet zekerheid op "laag".
3. Als je geen concrete getallen vindt, zet heeftAfwijkendeWaarden op false.
4. Wees STRIKT: alleen als er duidelijke, andere getallen staan dan het landelijk kader.
5. Als het document alleen verwijst naar het landelijk kader zonder eigen waarden: false.
`;

  const retries = 3;
  let delay = 2000;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
        // GEEN Google Search tool — alleen de documenttekst analyseren
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
        delay *= 2; // Exponential backoff
      } else {
        console.error(`AI extractie gefaald voor ${gemeenteNaam}:`, err.message);
        return null;
      }
    }
  }
}


/**
 * Valideer of gevonden waarden redelijk zijn (geen hallucinaties)
 */
function valideerWaarden(waarden) {
  if (!waarden) return false;
  
  const stoffen = ['pfos', 'pfoa', 'genx'];
  const klassen = ['wonen', 'industrie', 'landbouwNatuur'];
  
  for (const stof of stoffen) {
    if (!waarden[stof]) continue;
    for (const klasse of klassen) {
      const val = waarden[stof][klasse];
      if (val !== null && val !== undefined) {
        // Sanity checks:
        if (typeof val !== 'number') return false;
        if (val < 0) return false;       // Negatieve waarden zijn onmogelijk
        if (val > 50) return false;       // Waarden boven 50 µg/kg zijn vermoedelijk fout
        if (val === 0) return false;      // 0 is onwaarschijnlijk als norm
      }
    }
  }
  
  return true;
}


/**
 * Check of de gevonden waarden daadwerkelijk AFWIJKEN van het landelijk kader
 */
function wijktAfVanLandelijkKader(waarden) {
  if (!waarden) return false;
  
  const lk = LANDELIJK;
  const checks = [
    { stof: 'pfos', klasse: 'wonen', lkVal: lk.pfos.wonen },
    { stof: 'pfos', klasse: 'industrie', lkVal: lk.pfos.industrie },
    { stof: 'pfos', klasse: 'landbouwNatuur', lkVal: lk.pfos.landbouwNatuur },
    { stof: 'pfoa', klasse: 'wonen', lkVal: lk.pfoa.wonen },
    { stof: 'pfoa', klasse: 'industrie', lkVal: lk.pfoa.industrie },
    { stof: 'pfoa', klasse: 'landbouwNatuur', lkVal: lk.pfoa.landbouwNatuur },
    { stof: 'genx', klasse: 'wonen', lkVal: lk.genx.wonen },
    { stof: 'genx', klasse: 'industrie', lkVal: lk.genx.industrie },
    { stof: 'genx', klasse: 'landbouwNatuur', lkVal: lk.genx.landbouwNatuur },
  ];
  
  for (const { stof, klasse, lkVal } of checks) {
    const val = waarden[stof]?.[klasse];
    if (val !== null && val !== undefined && val !== lkVal) {
      return true; // Er is minstens één afwijking
    }
  }
  
  return false;
}


/**
 * HOOFDFUNCTIE: Check Officiële Bekendmakingen en verwerk resultaten
 * 
 * @param {FirebaseFirestore.Firestore} db - Firestore database
 * @param {number} dagenTerug - Hoeveel dagen terug zoeken
 * @returns {Object} - Samenvatting van resultaten
 */
async function checkOfficieleBekendmakingen(db, dagenTerug = 7) {
  const resultaten = {
    gecontroleerd: 0,
    signalen: 0,
    autoUpdates: 0,
    fouten: 0
  };
  
  // 1. Zoek recente publicaties
  const publicaties = await zoekRecenteBekendmakingen(dagenTerug);
  
  if (publicaties.length === 0) {
    console.log('✅ Geen nieuwe PFAS-gerelateerde bekendmakingen gevonden.');
    return resultaten;
  }
  
  console.log(`\n📋 ${publicaties.length} recente publicaties gevonden. Analyseren...\n`);
  
  const delay = (ms) => new Promise(res => setTimeout(res, ms));
  
  for (const pub of publicaties) {
    resultaten.gecontroleerd++;
    console.log(`\n📄 [${pub.date}] ${pub.gemeente}: ${pub.title}`);
    console.log(`   URL: ${pub.url}`);
    
    try {
      // 2. Haal documenttekst op
      const tekst = await haalDocumentTekst(pub.url);
      if (!tekst) {
        console.log('   ⚠️ Kon document niet ophalen, overslaan.');
        resultaten.fouten++;
        continue;
      }
      
      // 3. Laat AI de waarden extraheren
      const analyse = await extractWaardenUitDocument(pub.gemeente, tekst);
      
      if (!analyse || !analyse.heeftAfwijkendeWaarden) {
        console.log('   ✅ Geen afwijkende waarden gevonden (verwijst naar landelijk kader).');
        continue;
      }
      
      console.log(`   🔍 AI vindt mogelijk afwijkende waarden!`);
      console.log(`   Toelichting: ${analyse.toelichting}`);
      console.log(`   Zekerheid: ${analyse.zekerheid}`);
      
      // 4. Valideer de waarden
      const waardenValide = valideerWaarden(analyse.gevondenWaarden);
      const wijktAf = wijktAfVanLandelijkKader(analyse.gevondenWaarden);
      
      if (!waardenValide) {
        console.log('   ❌ Waarden buiten redelijke grenzen. Alleen als signaal opslaan.');
      }
      
      if (!wijktAf) {
        console.log('   ℹ️ Waarden zijn gelijk aan landelijk kader. Geen update nodig.');
        continue;
      }
      
      // 5. Sla op als signaal
      const docId = pub.gemeente.toLowerCase().replace(/\s+/g, '-');
      const signaalData = {
        gemeente: pub.gemeente,
        signaal: analyse.toelichting,
        gevondenWaarden: analyse.gevondenWaarden || null,
        bronLink: pub.url,
        bronType: 'officielebekendmakingen.nl',  // <-- DIT IS DE KEY
        documentTitel: pub.title,
        documentId: pub.identifier,
        datum: new Date().toISOString().split('T')[0],
        publicatieDatum: pub.date,
        aiZekerheid: analyse.zekerheid,
        status: 'open'
      };
      
      // 6. AUTOMATISCH UPDATEN als ALLE voorwaarden zijn voldaan:
      //    - Bron is officielebekendmakingen.nl ✅ (altijd waar hier)
      //    - Waarden zijn valide (tussen 0-50) ✅
      //    - AI zekerheid is "hoog" ✅
      //    - Waarden wijken echt af van landelijk kader ✅
      const magAutoUpdaten = waardenValide && 
                             analyse.zekerheid === 'hoog' && 
                             wijktAf;
      
      if (magAutoUpdaten) {
        console.log('   ✅✅ ALLE CRITERIA VOLDAAN → Automatisch updaten!');
        
        // Update de live database
        const updateData = {
          heeftAfwijkendBeleid: true,
          bronLink: pub.url,
          opmerkingen: `Afwijkend beleid vastgesteld per ${pub.date}. Bron: ${pub.title} (${pub.identifier}).`,
          laatstGeupdate: new Date().toISOString().split('T')[0],
          confidenceScore: 100,
          bronType: 'officielebekendmakingen.nl'
        };
        
        // Voeg de gevonden waarden toe
        if (analyse.gevondenWaarden.pfos) updateData.pfos = analyse.gevondenWaarden.pfos;
        if (analyse.gevondenWaarden.pfoa) updateData.pfoa = analyse.gevondenWaarden.pfoa;
        if (analyse.gevondenWaarden.genx) updateData.genx = analyse.gevondenWaarden.genx;
        
        await db.collection('pfasData').doc(docId).set(updateData, { merge: true });
        
        signaalData.status = 'automatisch-verwerkt';
        resultaten.autoUpdates++;
        
        console.log(`   ✅ Database bijgewerkt voor ${pub.gemeente}`);
      } else {
        console.log('   📝 Opgeslagen als signaal voor handmatige review.');
        signaalData.status = waardenValide ? 'open' : 'twijfelachtig';
        resultaten.signalen++;
      }
      
      // Sla het signaal altijd op (voor audit trail)
      await db.collection('pfasSignalen').doc(`${docId}-${pub.identifier}`).set(signaalData, { merge: true });
      
    } catch (err) {
      console.error(`   ❌ Fout bij verwerken: ${err.message}`);
      resultaten.fouten++;
    }
    
    // Respecteer rate limits
    await delay(2000);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SAMENVATTING:`);
  console.log(`  Gecontroleerd: ${resultaten.gecontroleerd}`);
  console.log(`  Auto-updates:  ${resultaten.autoUpdates}`);
  console.log(`  Signalen:      ${resultaten.signalen}`);
  console.log(`  Fouten:        ${resultaten.fouten}`);
  console.log(`${'='.repeat(60)}\n`);
  
  return resultaten;
}

module.exports = { checkOfficieleBekendmakingen, zoekRecenteBekendmakingen };
