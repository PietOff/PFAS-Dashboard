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
const { toDocId } = require('./docId');

const SRU_BASE = 'https://zoek.officielebekendmakingen.nl/sru/Search';

// De SRU-connectie heet 'oep'. In de oude code stond hier 'officielepublicaties',
// maar dat is de waarde van c.product-area BINNEN de query — niet de naam van de
// connectie. Met een onbekende x-connection levert de API geen resultaten op.
const SRU_CONNECTION = 'oep';

// Maximaal aantal records per pagina dat we opvragen.
const PAGINA_GROOTTE = 100;

const PFAS_TERMEN = ['PFAS', 'PFOS', 'PFOA', 'GenX', 'perfluoralkylstoffen', 'polyfluoralkylstoffen'];
const BODEM_TERMEN = ['bodemkwaliteitskaart', 'nota bodembeheer', 'bodembeheer', 'bodembeleid', 'achtergrondwaarde'];

/**
 * Bouwt een CQL-query voor de SRU API.
 *
 * De oude query was een kale booleaanse tekst ("PFAS AND bodembeheer"). De API
 * verwacht CQL met indexnamen, en filterde dus niet zoals bedoeld. Het datum-
 * filter zat bovendien alleen aan de clientkant: er werden 50 records opgehaald
 * en die werden daarna pas op datum gefilterd, waardoor recente publicaties
 * buiten die eerste 50 onzichtbaar bleven.
 */
function bouwCqlQuery({ vanaf, tot } = {}) {
  const of = (index, termen) => '(' + termen.map(t => `${index}="${t}"`).join(' or ') + ')';

  const delen = [
    'c.product-area=="officielepublicaties"',
    '(w.publicatienaam=="Gemeenteblad" or w.publicatienaam=="Provinciaal blad")',
    of('cql.textAndIndexes', PFAS_TERMEN),
    of('cql.textAndIndexes', BODEM_TERMEN)
  ];

  // Serverside datumfilter, zodat paginering ook echt over de juiste set loopt.
  if (vanaf) delen.push(`dt.modified>="${vanaf}"`);
  if (tot) delen.push(`dt.modified<="${tot}"`);

  return delen.join(' and ');
}

/**
 * Haalt één pagina op en parseert de records.
 */
async function haalPagina(query, startRecord) {
  const url = `${SRU_BASE}?version=1.2&operation=searchRetrieve` +
    `&x-connection=${SRU_CONNECTION}` +
    `&startRecord=${startRecord}&maximumRecords=${PAGINA_GROOTTE}` +
    `&query=${encodeURIComponent(query)}`;

  const response = await axios.get(url, {
    timeout: 30000,
    headers: { 'User-Agent': 'PFASDashboard/1.0 (overheid-monitoring)' }
  });
  const xml = response.data;

  // SRU meldt fouten via <diagnostic>, met HTTP 200. Zonder deze check ziet een
  // kapotte query er precies zo uit als "geen resultaten" — de failure mode die
  // deze check moet voorkomen.
  const diagnostic = xml.match(/<(?:\w+:)?message>([^<]+)</i);
  if (diagnostic) {
    throw new Error(`SRU-fout: ${diagnostic[1]}`);
  }

  const records = [];
  const recordRegex = /<(?:\w+:)?recordData>([\s\S]*?)<\/(?:\w+:)?recordData>/g;
  let match;

  while ((match = recordRegex.exec(xml)) !== null) {
    const data = match[1];
    const extract = (field) => {
      const re = new RegExp(`<(?:\\w+:)?${field}[^>]*>([^<]+)<\\/`, 'i');
      const m = data.match(re);
      return m ? m[1].trim() : null;
    };

    const identifier = extract('identifier');
    const docUrl = extract('url');

    records.push({
      title: extract('title'),
      gemeente: extract('creator'),
      date: extract('modified') || extract('date'),
      identifier,
      url: docUrl || (identifier ? `https://zoek.officielebekendmakingen.nl/${identifier}.html` : null)
    });
  }

  const countMatch = xml.match(/<(?:\w+:)?numberOfRecords>(\d+)/);
  const totaal = countMatch ? parseInt(countMatch[1]) : null;

  return { records, totaal };
}

/**
 * Zoekt bekendmakingen over PFAS-bodembeleid, met paginering.
 *
 * @param {Object} opties
 * @param {string} [opties.vanaf] - ISO-datum (YYYY-MM-DD), ondergrens
 * @param {string} [opties.tot] - ISO-datum, bovengrens
 * @param {number} [opties.maxRecords] - harde bovengrens op het aantal records
 * @returns {Promise<{records: Array, totaal: number|null}>}
 */
async function zoekBekendmakingen({ vanaf, tot, maxRecords = 2000 } = {}) {
  const query = bouwCqlQuery({ vanaf, tot });
  console.log(`🔍 SRU-query: ${query}`);

  const alle = [];
  let totaal = null;
  let startRecord = 1;

  while (alle.length < maxRecords) {
    const pagina = await haalPagina(query, startRecord);
    if (totaal === null) totaal = pagina.totaal;

    if (pagina.records.length === 0) break;
    alle.push(...pagina.records);

    console.log(`   ${alle.length}${totaal !== null ? ` van ${totaal}` : ''} records opgehaald...`);

    if (totaal !== null && alle.length >= totaal) break;
    startRecord += PAGINA_GROOTTE;
  }

  return { records: alle.slice(0, maxRecords), totaal };
}

/**
 * Achterwaarts compatibele wrapper: zoek de afgelopen N dagen.
 */
async function zoekRecenteBekendmakingen(dagenTerug = 7) {
  const startDatum = new Date();
  startDatum.setDate(startDatum.getDate() - dagenTerug);
  const { records } = await zoekBekendmakingen({ vanaf: startDatum.toISOString().split('T')[0] });
  return records;
}

// Landelijk kader referentiewaarden
const LANDELIJK = pfasNormen.landelijk_kader;

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
 * Voeg de gevonden waarden voor één stof samen met een basis (het landelijk
 * kader of de al opgeslagen waarden).
 *
 * De AI vult vaak maar één of twee van de drie klassen in en zet de rest op
 * null. Die nulls mogen niet naar Firestore geschreven worden, want dan
 * verdwijnen geldige waarden uit het dashboard.
 *
 * @returns {Object|null} - Samengevoegde waarden, of null als er niets bruikbaars in zat.
 */
function mergeStofWaarden(gevonden, basis) {
  if (!gevonden) return null;

  const samengevoegd = { ...basis };
  let heeftWaarde = false;

  for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
    const val = gevonden[klasse];
    if (typeof val === 'number' && Number.isFinite(val)) {
      samengevoegd[klasse] = val;
      heeftWaarde = true;
    }
  }

  return heeftWaarde ? samengevoegd : null;
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
      // De SRU-feed levert niet altijd een creator (gemeentenaam) of url mee.
      // Zonder die twee kunnen we niets zinnigs opslaan, dus sla over in plaats
      // van verderop te crashen op pub.gemeente.toLowerCase().
      const docId = toDocId(pub.gemeente);
      if (!docId || !pub.url) {
        console.log('   ⚠️ Publicatie mist gemeentenaam of URL, overslaan.');
        resultaten.fouten++;
        continue;
      }

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
        
        // Voeg de gevonden waarden toe. Ontbrekende klassen vallen terug op de
        // waarden die al in Firestore staan, anders op het landelijk kader —
        // nooit op null.
        const bestaand = (await db.collection('pfasData').doc(docId).get()).data() || {};
        const gevonden = analyse.gevondenWaarden || {};

        for (const stof of ['pfos', 'pfoa', 'genx']) {
          const samengevoegd = mergeStofWaarden(gevonden[stof], bestaand[stof] || LANDELIJK[stof]);
          if (samengevoegd) updateData[stof] = samengevoegd;
        }

        await db.collection('pfasData').doc(docId).set(updateData, { merge: true });
        
        signaalData.status = 'automatisch-verwerkt';
        resultaten.autoUpdates++;
        
        console.log(`   ✅ Database bijgewerkt voor ${pub.gemeente}`);
      } else {
        console.log('   📝 Opgeslagen als signaal voor handmatige review.');
        signaalData.status = waardenValide ? 'open' : 'twijfelachtig';
        resultaten.signalen++;
      }
      
      // Sla het signaal altijd op (voor audit trail).
      // Zonder identifier zou het id op "-null" eindigen en elke volgende
      // publicatie van dezelfde gemeente overschrijven.
      const signaalId = pub.identifier
        ? `${docId}-${toDocId(pub.identifier)}`
        : `${docId}-${pub.date || 'onbekend'}`;
      await db.collection('pfasSignalen').doc(signaalId).set(signaalData, { merge: true });
      
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

// ============================================================
// VOLLEDIGE SWEEP: alle documenten, met dedupe
// ============================================================
// De losse check hierboven kijkt alleen naar een tijdvenster en onthoudt niets.
// Daardoor kan hij nooit antwoord geven op "welke gemeenten wijken af?" — hij
// ziet alleen wat er die week toevallig gepubliceerd is.
//
// De sweep bouwt wél een corpus op:
//   pfasDocumenten/<identifier>  = elk verwerkt gemeenteblad + de AI-analyse
//   pfasData/<gemeente>          = de afgeleide toestand per gemeente
//
// Elk document wordt precies één keer door de AI gehaald. Een wekelijkse
// volledige sweep is daardoor betaalbaar: alleen nieuwe publicaties kosten
// API-calls, de rest komt uit de opslag.

const CONFIG_DOC = 'bekendmakingenSweep';

/**
 * Verwerkt één publicatie: ophalen, AI-extractie, opslaan in pfasDocumenten.
 * Slaat over als het document al verwerkt is (tenzij forceer=true).
 *
 * @returns {'overgeslagen'|'verwerkt'|'mislukt'}
 */
async function verwerkPublicatie(db, pub, { forceer = false } = {}) {
  if (!pub.identifier) return 'mislukt';

  const docRef = db.collection('pfasDocumenten').doc(toDocId(pub.identifier));

  if (!forceer) {
    const bestaand = await docRef.get();
    if (bestaand.exists && bestaand.data().verwerktOp) return 'overgeslagen';
  }

  const gemeenteId = toDocId(pub.gemeente);
  if (!gemeenteId || !pub.url) return 'mislukt';

  const tekst = await haalDocumentTekst(pub.url);
  if (!tekst) return 'mislukt';

  const analyse = await extractWaardenUitDocument(pub.gemeente, tekst);
  if (!analyse) return 'mislukt';

  const waardenValide = valideerWaarden(analyse.gevondenWaarden);
  const wijktAf = wijktAfVanLandelijkKader(analyse.gevondenWaarden);

  await docRef.set({
    identifier: pub.identifier,
    gemeente: pub.gemeente,
    gemeenteId,
    titel: pub.title,
    publicatieDatum: pub.date,
    url: pub.url,
    verwerktOp: new Date().toISOString(),
    heeftAfwijkendeWaarden: Boolean(analyse.heeftAfwijkendeWaarden && wijktAf && waardenValide),
    gevondenWaarden: analyse.gevondenWaarden || null,
    toelichting: analyse.toelichting || null,
    aiZekerheid: analyse.zekerheid || null,
    waardenValide,
    wijktAf
  }, { merge: true });

  return 'verwerkt';
}

/**
 * Leidt de toestand per gemeente af uit het volledige documentcorpus.
 *
 * Dit is de stap die "welke gemeenten wijken af" beantwoordt. Hij kijkt niet
 * naar losse updates maar herberekent alles uit pfasDocumenten, zodat het
 * resultaat reproduceerbaar is en niet afhangt van de volgorde waarin
 * documenten ooit binnenkwamen.
 *
 * Elke gemeente krijgt een expliciete herkomst:
 *   'officiele-bekendmaking'  - waarden komen uit een gemeenteblad
 *   'landelijk-kader-aanname' - geen document gevonden; landelijk kader aangenomen
 *   'handmatig'               - handmatig overschreven via de Google Sheet
 */
async function herbouwAfwijkingen(db) {
  const docs = await db.collection('pfasDocumenten').get();

  // Nieuwste bruikbare document per gemeente wint
  const perGemeente = new Map();
  docs.forEach(d => {
    const data = d.data();
    if (!data.gemeenteId || !data.heeftAfwijkendeWaarden) return;
    if (data.aiZekerheid !== 'hoog') return;

    const huidig = perGemeente.get(data.gemeenteId);
    if (!huidig || String(data.publicatieDatum || '') > String(huidig.publicatieDatum || '')) {
      perGemeente.set(data.gemeenteId, data);
    }
  });

  const pfasData = await db.collection('pfasData').get();
  const updates = [];
  let afwijkend = 0;
  let aanname = 0;

  pfasData.forEach(doc => {
    const bestaand = doc.data();
    if (bestaand.handmatigeOverschrijving === true) return;

    const bron = perGemeente.get(doc.id);

    if (bron) {
      const update = {
        heeftAfwijkendBeleid: true,
        herkomst: 'officiele-bekendmaking',
        bronLink: bron.url,
        bronType: 'officielebekendmakingen.nl',
        bronDocument: bron.identifier,
        bronDocumentTitel: bron.titel,
        bronDocumentDatum: bron.publicatieDatum,
        opmerkingen: `Afwijkend beleid vastgesteld per ${bron.publicatieDatum}. Bron: ${bron.titel} (${bron.identifier}).`,
        confidenceScore: 100,
        laatstGecontroleerd: new Date().toISOString().split('T')[0]
      };
      for (const stof of ['pfos', 'pfoa', 'genx']) {
        const samengevoegd = mergeStofWaarden(bron.gevondenWaarden?.[stof], bestaand[stof] || LANDELIJK[stof]);
        if (samengevoegd) update[stof] = samengevoegd;
      }
      updates.push({ ref: doc.ref, data: update });
      afwijkend++;
    } else {
      // Geen officieel document gevonden. Dat is een AANNAME, geen vaststelling,
      // en moet als zodanig in het dashboard herkenbaar zijn.
      updates.push({
        ref: doc.ref,
        data: {
          heeftAfwijkendBeleid: false,
          herkomst: 'landelijk-kader-aanname',
          pfos: { ...LANDELIJK.pfos },
          pfoa: { ...LANDELIJK.pfoa },
          genx: { ...LANDELIJK.genx },
          laatstGecontroleerd: new Date().toISOString().split('T')[0]
        }
      });
      aanname++;
    }
  });

  const LIMIET = 400;
  for (let i = 0; i < updates.length; i += LIMIET) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + LIMIET)) batch.set(u.ref, u.data, { merge: true });
    await batch.commit();
  }

  return { afwijkend, aanname, documentenInCorpus: docs.size };
}

/**
 * HOOFDFUNCTIE voor de wekelijkse run.
 *
 * @param {Object} opties
 * @param {string} [opties.vanaf] - ondergrens; standaard het watermerk van de
 *   vorige geslaagde run. Bij een backfill zet je dit expliciet, bijv. '2019-01-01'.
 * @param {boolean} [opties.forceer] - alle documenten opnieuw door de AI halen
 * @param {number} [opties.maxDocumenten] - rem op het aantal AI-calls per run
 */
async function sweepBekendmakingen(db, { vanaf, forceer = false, maxDocumenten = 200 } = {}) {
  const configRef = db.collection('config').doc(CONFIG_DOC);

  if (!vanaf) {
    const cfg = await configRef.get();
    // Watermerk in plaats van een vast venster van 7 dagen: als een run faalt of
    // overgeslagen wordt, ontstaat er anders een gat dat nooit meer wordt gedicht.
    vanaf = cfg.exists && cfg.data().laatsteGeslaagdeRun
      ? cfg.data().laatsteGeslaagdeRun
      : '2019-01-01';
  }

  console.log(`🧹 Sweep bekendmakingen vanaf ${vanaf} (forceer=${forceer})`);

  const { records, totaal } = await zoekBekendmakingen({ vanaf });
  console.log(`   ${records.length} publicaties gevonden (API meldt ${totaal}).`);

  const resultaat = { gevonden: records.length, verwerkt: 0, overgeslagen: 0, mislukt: 0 };
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const pub of records) {
    if (resultaat.verwerkt >= maxDocumenten) {
      console.log(`   Limiet van ${maxDocumenten} nieuwe documenten bereikt; rest volgende run.`);
      break;
    }
    try {
      const uitkomst = await verwerkPublicatie(db, pub, { forceer });
      resultaat[uitkomst]++;
      if (uitkomst === 'verwerkt') await delay(2000); // rate limit Gemini
    } catch (err) {
      console.error(`   ❌ ${pub.identifier}: ${err.message}`);
      resultaat.mislukt++;
    }
  }

  const afgeleid = await herbouwAfwijkingen(db);

  // Watermerk pas bijwerken als alles gelukt is, met een dag overlap tegen
  // publicaties die net na de vorige run zijn toegevoegd.
  const gisteren = new Date();
  gisteren.setDate(gisteren.getDate() - 1);
  await configRef.set({
    laatsteGeslaagdeRun: gisteren.toISOString().split('T')[0],
    laatsteRunOp: new Date().toISOString(),
    laatsteResultaat: { ...resultaat, ...afgeleid }
  }, { merge: true });

  console.log(`🧹 Sweep klaar:`, JSON.stringify({ ...resultaat, ...afgeleid }));
  return { ...resultaat, ...afgeleid };
}

module.exports = {
  checkOfficieleBekendmakingen,
  zoekRecenteBekendmakingen,
  zoekBekendmakingen,
  bouwCqlQuery,
  sweepBekendmakingen,
  herbouwAfwijkingen
};
