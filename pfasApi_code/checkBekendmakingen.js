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

// KOOP levert deze collectie via het repository-endpoint. Het oude adres
// (zoek.officielebekendmakingen.nl/sru/Search) geeft sinds enige tijd HTTP 500
// op élke query, ook op de simpelste — het is uitgefaseerd, niet overbelast.
//
// Dat was hier niet aan te zien. Een sweep die geen records ophaalt levert geen
// foutmelding op maar de mededeling "geen nieuwe bekendmakingen gevonden", en
// dat is precies hoe een rustige week er ook uitziet. De bron die als enige als
// juridisch vastgesteld beleid geldt, viel dus stil weg zonder dat iets afging.
// check-bronnen.js controleert daarom op records in plaats van op status 200.
const SRU_BASE = 'https://repository.overheid.nl/sru';

// De SRU-connectie heet 'oep'. In de oude code stond hier 'officielepublicaties',
// maar dat is de waarde van c.product-area BINNEN de query — niet de naam van de
// connectie. Met een onbekende x-connection levert de API geen resultaten op.
const SRU_CONNECTION = 'oep';

// Maximaal aantal records per pagina dat we opvragen.
const PAGINA_GROOTTE = 100;

const PFAS_TERMEN = [
  'PFAS', 'PFOS', 'PFOA', 'GenX', 'FRD-903',
  'perfluoralkylstoffen', 'polyfluoralkylstoffen', 'perfluoroctaanzuur', 'perfluoroctaansulfonaat'
];

// Ruim genomen: liever een paar irrelevante documenten analyseren dan een
// gemeente met afwijkend beleid missen.
const BODEM_TERMEN = [
  'bodemkwaliteitskaart', 'nota bodembeheer', 'bodembeheer', 'bodembeleid',
  'achtergrondwaarde', 'toepassingswaarde', 'grondverzet', 'bodemfunctieklassenkaart',
  'milieuverklaring bodemkwaliteit', 'hergebruik van grond', 'baggerspecie',
  'lokale maximale waarde', 'bodemkwaliteitszone'
];

// Omgevingsdiensten zijn gemeenschappelijke regelingen en publiceren hun
// bodembeleid in het Blad gemeenschappelijke regeling — niet in een
// Gemeenteblad. Door alleen op Gemeenteblad te filteren bleef juist de
// organisatie die het beleid maakt buiten beeld.
const PUBLICATIEBLADEN = ['Gemeenteblad', 'Provinciaal blad', 'Blad gemeenschappelijke regeling'];

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
    '(' + PUBLICATIEBLADEN.map(b => `w.publicatienaam=="${b}"`).join(' or ') + ')',
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
    // SRU levert XML. Axios probeert standaard JSON van het antwoord te maken en
    // geeft dan geen string terug, waarna elke .match() hieronder omvalt. Het
    // antwoord moet onbewerkt blijven.
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: {
      'User-Agent': 'PFASDashboard/1.0 (overheid-monitoring)',
      // Zonder deze regel stuurt axios `Accept: application/json, text/plain,
      // */*`. De API doet aan contentonderhandeling en geeft dan JSON terug in
      // plaats van XML — een antwoord van 290.000 tekens waar geen enkele
      // XML-regex op past. Resultaat: nul records en totaal null, wat er precies
      // zo uitziet als "er is niets gepubliceerd".
      'Accept': 'application/xml, text/xml;q=0.9, */*;q=0.8'
    }
  });
  const xml = String(response.data);

  // SRU meldt fouten via <diagnostic>, met HTTP 200. Zonder deze check ziet een
  // kapotte query er precies zo uit als "geen resultaten" — de failure mode die
  // deze check moet voorkomen.
  const diagnostic = xml.match(/<(?:\w+:)?message>([^<]+)</i);
  if (diagnostic) {
    throw new Error(`SRU-fout: ${diagnostic[1]}`);
  }

  const records = [];
  // `[^>]*` is nodig: het element komt binnen als `<sru:recordData>` mét
  // namespace-attributen. Zonder die ruimte matcht de regex niets, blijft de
  // lijst leeg en meldt de sweep "geen nieuwe bekendmakingen" — terwijl
  // numberOfRecords gewoon een getal boven nul teruggeeft.
  const recordRegex = /<(?:\w+:)?recordData[^>]*>([\s\S]*?)<\/(?:\w+:)?recordData>/g;
  let match;

  while ((match = recordRegex.exec(xml)) !== null) {
    const data = match[1];
    const extract = (field) => {
      const re = new RegExp(`<(?:\\w+:)?${field}[^>]*>([^<]+)<\\/`, 'i');
      const m = data.match(re);
      return m ? m[1].trim() : null;
    };

    const identifier = extract('identifier');

    // KOOP levert de vindplaats als <gzd:itemUrl manifestation="html|xml|pdf">,
    // niet als <url>. Er staan er meerdere per record; de HTML-versie is degene
    // die haalDocumentTekst kan lezen.
    const itemUrls = [...data.matchAll(/<(?:\w+:)?itemUrl[^>]*>([^<]+)<\//gi)].map(m => m[1].trim());
    const docUrl = itemUrls.find(u => /\.html?$/i.test(u)) || itemUrls[0] || extract('url');

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

// Handmatig geverifieerde afwijkingen uit pfas_normen.json, op document-id.
// Alleen deze getallen komen als "afwijkend" in het dashboard: elk ervan is
// nagelezen in het besluit dat in bronDocument staat.
const CURATIE = new Map(
  Object.entries(pfasNormen.afwijkend || {}).map(([naam, data]) => [toDocId(naam), { naam, ...data }])
);

// Gemeenten waar wél lokaal PFAS-beleid bestaat of voorbereid is, maar waar de
// vaststelling niet is gevonden. Die tonen het landelijk kader mét waarschuwing.
const MOGELIJK = new Map(
  Object.entries(pfasNormen.mogelijkAfwijkend || {}).map(([naam, data]) => [toDocId(naam), { naam, ...data }])
);

// Documenten die een mens heeft nagelezen en die geen afwijking bevatten. Een
// AI-signaal uit zo'n document wordt genegeerd, anders komt het elke week terug.
const NAGELEZEN_ZONDER_AFWIJKING = new Set(Object.keys(pfasNormen.nagelezenZonderAfwijking || {}));

// Provincie en CBS-code uit PDOK Bestuurlijke Gebieden (Kadaster).
const GEBIED = new Map(
  Object.entries(require('./gemeente_provincie.json')).map(([naam, d]) => [toDocId(naam), d])
);

// De omgevingsdienst volgt uit het domein van de (gecontroleerde) bronlink in
// gemeente_mapping.json. Voor Noord- en Midden-Limburg verwijst de mapping naar
// de gemeente zelf of de Limburgse BKK-viewer; die gemeenten vallen onder de
// RUD Limburg-Noord.
const OMGEVINGSDIENST_PER_DOMEIN = {
  'odu.nl': 'Omgevingsdienst Utrecht',
  'omwb.nl': 'Omgevingsdienst Midden- en West-Brabant',
  'odzob.nl': 'Omgevingsdienst Zuidoost-Brabant',
  'fumo.nl': 'FUMO (Omgevingsdienst Fryslân)',
  'odgroenemetropool.nl': 'Omgevingsdienst Groene Metropool',
  'odnhn.nl': 'Omgevingsdienst Noord-Holland Noord',
  'odzuidlimburg.nl': 'Omgevingsdienst Zuid-Limburg',
  'omgevingsdiensthaaglanden.nl': 'Omgevingsdienst Haaglanden',
  'dcmr.nl': 'DCMR Milieudienst Rijnmond',
  'odtwente.nl': 'Omgevingsdienst Twente',
  'odijmond.nl': 'Omgevingsdienst IJmond',
  'odveluwe.nl': 'Omgevingsdienst Veluwe IJssel',
  'rud-zeeland.nl': 'RUD Zeeland',
  'oddrenthe.nl': 'Omgevingsdienst Drenthe',
  'ofgv.nl': 'Omgevingsdienst Flevoland & Gooi en Vechtstreek',
  'odijsselland.nl': 'Omgevingsdienst IJsselland',
  'ozhz.nl': 'Omgevingsdienst Zuid-Holland Zuid',
  'odbn.nl': 'Omgevingsdienst Brabant Noord',
  'od-groningen.nl': 'Omgevingsdienst Groningen',
  'odwh.nl': 'Omgevingsdienst West-Holland',
  'odachterhoek.nl': 'Omgevingsdienst Achterhoek',
  'odnzkg.nl': 'Omgevingsdienst Noordzeekanaalgebied',
  'odrivierenland.nl': 'Omgevingsdienst Rivierenland',
  'oddevallei.nl': 'Omgevingsdienst de Vallei',
  'odmh.nl': 'Omgevingsdienst Midden-Holland'
};
const LIMBURG_NOORD = /geowebonline\.nl|(bergen|echt-susteren|gennep|horstaandemaas|leudal|mookenmiddelaar|nederweert|roermond|venlo|venray|weert)\.nl$/;

function omgevingsdienstVan(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (OMGEVINGSDIENST_PER_DOMEIN[host]) return OMGEVINGSDIENST_PER_DOMEIN[host];
    if (LIMBURG_NOORD.test(host)) return 'RUD Limburg-Noord';
  } catch { /* geen geldige URL */ }
  return null;
}

// Een ontwerpbesluit stelt nog niets vast. Almere stond zo op "afwijkend
// beleid" op basis van een ontwerp-omgevingsplan.
const isOntwerp = (titel) => /^\s*(ontwerp|voorontwerp|concept)\b/i.test(String(titel || '')) ||
  /\bontwerp[- ]?(besluit|wijziging|omgevingsplan|nota|bestemmingsplan)\b/i.test(String(titel || ''));

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
      // Zelfde reden als bij haalPagina: de bekendmaking is HTML, geen JSON —
      // en ook hier moet de Accept-header dat zeggen, anders vraagt axios
      // standaard om JSON en onderhandelt de server iets anders terug.
      responseType: 'text',
      transformResponse: [(d) => d],
      headers: {
        'User-Agent': 'PFASDashboard/1.0 (overheid-monitoring)',
        'Accept': 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8'
      }
    });

    // Strip HTML tags voor pure tekst
    let text = String(response.data);
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    
    return text;

  } catch (err) {
    console.error(`Kon document niet ophalen: ${docUrl}:`, err.message);
    return null;
  }
}


/**
 * Kiest de stukken tekst waar de PFAS-normen waarschijnlijk staan.
 *
 * De oude code nam simpelweg de eerste 8000 tekens. In een nota bodembeheer
 * staat de normentabel vrijwel nooit in de inleiding maar tientallen pagina's
 * verderop, dus juist de afwijkende waarden vielen structureel buiten beeld.
 *
 * Deze functie zoekt alle plekken waar een PFAS-term of een eenheid staat en
 * neemt daar een venster omheen. Alleen als er niets gevonden wordt, valt hij
 * terug op het begin van het document.
 */
function selecteerRelevanteTekst(text, maxLengte = 24000) {
  if (!text) return null;
  if (text.length <= maxLengte) return text;

  const trefwoorden = [
    ...PFAS_TERMEN,
    'µg/kg', 'ug/kg', 'μg/kg', 'microgram', 'ng/kg',
    'toepassingswaarde', 'achtergrondwaarde', 'lokale maximale waarde',
    'wonen', 'industrie', 'landbouw', 'natuur'
  ];

  const VENSTER = 1500;
  const vensters = [];

  for (const woord of trefwoorden) {
    let vanaf = 0;
    const lower = text.toLowerCase();
    const doel = woord.toLowerCase();
    while (vensters.length < 200) {
      const i = lower.indexOf(doel, vanaf);
      if (i === -1) break;
      vensters.push([Math.max(0, i - VENSTER / 2), Math.min(text.length, i + VENSTER / 2)]);
      vanaf = i + doel.length;
    }
  }

  if (vensters.length === 0) return text.substring(0, maxLengte);

  // Overlappende vensters samenvoegen zodat tabellen niet in stukken vallen
  vensters.sort((a, b) => a[0] - b[0]);
  const samengevoegd = [vensters[0]];
  for (const [start, eind] of vensters.slice(1)) {
    const laatste = samengevoegd[samengevoegd.length - 1];
    if (start <= laatste[1]) laatste[1] = Math.max(laatste[1], eind);
    else samengevoegd.push([start, eind]);
  }

  let uit = '';
  for (const [start, eind] of samengevoegd) {
    if (uit.length >= maxLengte) break;
    uit += (uit ? '\n[...]\n' : '') + text.substring(start, eind);
  }
  return uit.substring(0, maxLengte);
}


/**
 * Laat de AI specifieke PFAS-waarden extraheren uit een officieel overheidsdocument.
 * De AI krijgt ALLEEN de tekst van het officiële document — geen Google Search.
 * 
 * @param {string} gemeenteNaam 
 * @param {string} documentTekst 
 * @returns {Object|null}
 */
// Kandidaatmodellen voor AI-extractie met automatische fallback bij quota-overschrijding
// (Free Tier: 500 RPD) of tijdelijke capaciteitsproblemen (503/high demand).
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview'
];
let actieveModelIndex = 0;

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
- GenX en elke andere PFAS: Wonen/Industrie 3.0 µg/kg ds, Landbouw/Natuur 1.4 µg/kg ds
- Binnen grondwaterbeschermings- en waterwingebieden: 0.1 µg/kg ds (bepalingsgrens) voor alle PFAS

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

LET OP: de tekst kan bestaan uit losse fragmenten uit een langer document,
gescheiden door [...]. Beoordeel elk fragment; de normentabel staat vaak niet
aan het begin.

REGELS:
1. Alle waarden moeten in µg/kg d.s. zijn. Als je ng/kg ziet, deel door 1000.
2. Rapporteer ELKE afwijkende waarde die je vindt, ook als je maar één klasse
   van één stof kunt vaststellen. Laat de rest null. Onvolledig is prima.
3. Twijfel je over één specifiek getal? Laat dat getal weg, maar houd de andere
   waarden die je wél zeker weet. Gooi niet de hele tabel weg.
4. "zekerheid" gaat over de vraag of dit document echt eigen normen vaststelt:
   - "hoog"  = het document stelt expliciet lokale/gebiedsspecifieke waarden vast
   - "laag"  = je ziet getallen maar het is onduidelijk of ze hier gelden
     (bijv. een voorbeeld, een verwijzing of een tabel zonder context)
5. Als je geen concrete getallen vindt, zet heeftAfwijkendeWaarden op false.
6. Verwijst het document alleen naar het landelijk kader zonder eigen waarden: false.
   Een tabel die de landelijke waarden hierboven herhaalt ("elke andere
   PFAS-verbinding 1,4") is GEEN afwijking.
7. Negeer waarden die alleen gelden voor een bijzondere situatie, want dat zijn
   geen normen voor de bodemfunctieklassen:
   - grondwaterbeschermings- en waterwingebieden (meestal 0,1)
   - toelaatbare kwaliteit bij (zeer) bodemgevoelig gebruik, moestuinen,
     speelplaatsen of interventie-/INEV-waarden
   - toepassen in oppervlaktewater, waterbodem of diepe plassen
8. Een ONTWERP-besluit stelt nog niets vast: zekerheid is dan altijd "laag".
`;

  while (actieveModelIndex < GEMINI_MODELS.length) {
    const model = GEMINI_MODELS[actieveModelIndex];
    const retries = 2;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt
        });

        let raw = response.text;
        raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(raw);

      } catch (err) {
        const msg = err.message || '';
        const isDailyQuota = msg.includes('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
        const isUnavailable = msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE');

        if (isDailyQuota || isUnavailable) {
          console.warn(`⚠️ Model ${model} niet beschikbaar (${isDailyQuota ? 'dagquotum bereikt' : '503 capaciteit'}). Schakel direct over naar volgend model...`);
          actieveModelIndex++;
          break; // Breek uit de retry-loop van dit model, probeer direct volgend model
        }

        const isTransient = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        if (isTransient && i < retries - 1) {
          const m = msg.match(/retry in ([\d\.]+)s/i) || msg.match(/"retryDelay":\s*"(\d+)s"/i);
          const retrySec = m ? Math.min(Math.ceil(parseFloat(m[1])) + 2, 30) : 15;
          console.warn(`⚠️ Rate limit (429) voor ${model} (${gemeenteNaam}). Wacht ${retrySec}s... (Poging ${i + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, retrySec * 1000));
        } else {
          console.error(`AI extractie gefaald voor ${gemeenteNaam} met ${model}:`, msg.slice(0, 150));
          if (isTransient) {
            actieveModelIndex++;
          }
          break;
        }
      }
    }
  }

  console.error(`❌ Alle kandidaatmodellen uitgeput voor ${gemeenteNaam}.`);
  return null;
}


/**
 * Zeeft implausibele waarden eruit, waarde voor waarde.
 *
 * De oude versie keurde de HELE set af zodra één getal niet klopte. Haalde de
 * AI GenX ergens vandaan als 1200 µg/kg, dan verdwenen daarmee ook correct
 * gelezen afwijkende PFOS- en PFOA-waarden uit hetzelfde besluit. Precies de
 * afwijkingen die we willen vinden gingen zo verloren.
 *
 * @returns {{waarden: Object|null, verworpen: Array}}
 */
function filterPlausibeleWaarden(ruw) {
  const verworpen = [];
  if (!ruw) return { waarden: null, verworpen };

  const schoon = {};
  for (const stof of ['pfos', 'pfoa', 'genx']) {
    if (!ruw[stof]) continue;
    const perStof = {};

    for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
      const val = ruw[stof][klasse];
      if (val === null || val === undefined) continue;

      if (typeof val !== 'number' || !Number.isFinite(val)) {
        verworpen.push({ stof, klasse, waarde: val, reden: 'geen getal' });
      } else if (val <= 0) {
        verworpen.push({ stof, klasse, waarde: val, reden: 'nul of negatief' });
      } else if (val <= 0.1) {
        // De bepalingsgrens. In een nota bodembeheer is dat vrijwel altijd de
        // eis voor grondwaterbeschermingsgebieden, niet de norm voor een
        // bodemfunctieklasse. Houten kwam zo op 0,1 voor alles te staan.
        verworpen.push({ stof, klasse, waarde: val, reden: 'bepalingsgrens (grondwaterbeschermingsgebied)' });
      } else if (val > 50) {
        // Vrijwel altijd een eenheidsverwarring (ng/kg) of een andere stof.
        verworpen.push({ stof, klasse, waarde: val, reden: 'boven 50 µg/kg' });
      } else {
        perStof[klasse] = val;
      }
    }

    if (Object.keys(perStof).length > 0) schoon[stof] = perStof;
  }

  return { waarden: Object.keys(schoon).length > 0 ? schoon : null, verworpen };
}

/**
 * Achterwaarts compatibel: zijn ALLE waarden plausibel?
 */
function valideerWaarden(waarden) {
  if (!waarden) return false;
  return filterPlausibeleWaarden(waarden).verworpen.length === 0;
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
      
      // 6. Alleen een signaal, nooit direct naar pfasData. De getallen in het
      //    dashboard komen uitsluitend uit herbouwAfwijkingen, zodat curatie
      //    en herbeoordeling niet omzeild worden.
      signaalData.status = waardenValide ? 'open' : 'twijfelachtig';
      resultaten.signalen++;
      console.log('   📝 Opgeslagen als signaal; de sweep verwerkt het document.');

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
async function verwerkPublicatie(db, pub, { forceer = false, alVerwerkt = null } = {}) {
  if (!pub.identifier) return 'mislukt';

  const docId = toDocId(pub.identifier);

  if (!forceer) {
    if (alVerwerkt && alVerwerkt.has(docId)) return 'overgeslagen';
    if (!alVerwerkt) {
      const docRef = db.collection('pfasDocumenten').doc(docId);
      const bestaand = await docRef.get();
      if (bestaand.exists && bestaand.data().verwerktOp) return 'overgeslagen';
    }
  }

  const docRef = db.collection('pfasDocumenten').doc(docId);

  const gemeenteId = toDocId(pub.gemeente);
  if (!gemeenteId || !pub.url) return 'mislukt';

  const ruweTekst = await haalDocumentTekst(pub.url);
  if (!ruweTekst) return 'mislukt';

  const tekst = selecteerRelevanteTekst(ruweTekst);
  const analyse = await extractWaardenUitDocument(pub.gemeente, tekst);
  if (!analyse) return 'mislukt';

  // Per waarde zeven in plaats van de hele set weggooien bij één fout getal.
  const { waarden, verworpen } = filterPlausibeleWaarden(analyse.gevondenWaarden);
  const wijktAf = wijktAfVanLandelijkKader(waarden);

  // Een document telt als "wijkt af" zodra er ook maar één plausibele waarde in
  // staat die van het landelijk kader verschilt. De zekerheid van de AI bepaalt
  // daarna of dat direct in het dashboard mag of eerst langs een mens moet.
  const afwijkend = Boolean(wijktAf && waarden);

  await docRef.set({
    identifier: pub.identifier,
    gemeente: pub.gemeente,
    gemeenteId,
    titel: pub.title,
    publicatieDatum: pub.date,
    url: pub.url,
    verwerktOp: new Date().toISOString(),
    heeftAfwijkendeWaarden: afwijkend,
    gevondenWaarden: waarden,
    ruweWaarden: analyse.gevondenWaarden || null,
    verworpenWaarden: verworpen,
    toelichting: analyse.toelichting || null,
    aiZekerheid: analyse.zekerheid || null,
    waardenValide: verworpen.length === 0,
    wijktAf,
    // Bijlagen worden nog niet gelezen; zie tekortkomingen in de README.
    heeftPdfBijlage: /\.pdf(["'?#]|$)/i.test(ruweTekst.slice(0, 200000)),
    tekstLengte: ruweTekst.length
  }, { merge: true });

  if (alVerwerkt) alVerwerkt.add(docId);
  return 'verwerkt';
}

/**
 * Beoordeelt één verwerkt document opnieuw met het HUIDIGE landelijk kader.
 *
 * `heeftAfwijkendeWaarden` op het document is berekend met het kader van het
 * moment van verwerken. Stond dat kader verkeerd (GenX landbouw/natuur 0,8 in
 * plaats van 1,4), dan blijft het document anders voor altijd "afwijkend" —
 * zo kwamen Leiden, Voorschoten en vijf andere gemeenten op afwijkend beleid
 * terwijl hun nota alleen het landelijk kader herhaalt.
 *
 * @returns {{waarden: Object|null, afwijkend: boolean, zeker: boolean}}
 */
function herbeoordeelDocument(data) {
  const { waarden } = filterPlausibeleWaarden(data.ruweWaarden || data.gevondenWaarden);
  const afwijkend = Boolean(waarden && wijktAfVanLandelijkKader(waarden));
  const zeker = data.aiZekerheid === 'hoog' && !isOntwerp(data.titel);
  return { waarden, afwijkend, zeker };
}

/**
 * Leidt de toestand van één gemeente af. Puur: geen Firestore, zodat het
 * zonder credentials te testen is.
 *
 * Alleen nagelezen getallen komen in het dashboard. Volgorde:
 *   1. curatie uit pfas_normen.json  → afwijkende normen, met bronbesluit
 *   2. mogelijkAfwijkend (handmatig)  → landelijk kader + waarschuwing
 *   3. een AI-vondst in een besluit   → landelijk kader + waarschuwing
 *   4. niets gevonden                 → landelijk-kader-aanname
 *
 * De AI levert dus signalen, geen getallen. Van de elf gemeenten die de AI
 * zelfstandig op "afwijkend" had gezet, klopte bij nalezing geen enkel getal
 * zoals het getoond werd; twee hadden wél een echte afwijking, maar met andere
 * voorwaarden dan de AI las.
 *
 * Elke tak schrijft ALLE velden die een andere tak zet, zodat er geen restant
 * van een vorige toestand blijft staan.
 */
function leidGemeenteAf({ docId, bron, curatie, mogelijk, bronLinkStandaard, vandaag }) {
  const gebied = (docId && GEBIED.get(docId)) || {};
  const basis = {
    bronDocument: null,
    bronDocumentTitel: null,
    bronDocumentDatum: null,
    mogelijkeWaarden: null,
    perZone: null,
    regio: null,
    geverifieerdOp: null,
    provincie: gebied.provincie || null,
    cbsCode: gebied.cbsCode || null,
    omgevingsdienst: omgevingsdienstVan(bronLinkStandaard),
    laatstGecontroleerd: vandaag
  };
  const kader = () => ({ pfos: { ...LANDELIJK.pfos }, pfoa: { ...LANDELIJK.pfoa }, genx: { ...LANDELIJK.genx } });
  const docLink = (id) => !id ? null : /^https?:/.test(id) ? id : `https://zoek.officielebekendmakingen.nl/${id}.html`;

  if (curatie) {
    return {
      ...basis,
      heeftAfwijkendBeleid: true,
      herkomst: 'curatie',
      tereviewen: false,
      bronType: 'curatie',
      bronLink: curatie.bronLink || bronLinkStandaard || docLink(curatie.bronDocument),
      bronDocument: curatie.bronDocument || null,
      bronDocumentLink: docLink(curatie.bronDocument),
      bronDocumentTitel: curatie.bronDocumentTitel || null,
      bronDocumentDatum: curatie.bronDocumentDatum || null,
      omgevingsdienst: curatie.omgevingsdienst || basis.omgevingsdienst,
      opmerkingen: curatie.opmerkingen || null,
      perZone: curatie.perZone || null,
      regio: curatie.regio || null,
      geverifieerdOp: curatie.geverifieerdOp || null,
      confidenceScore: 100,
      pfos: { ...LANDELIJK.pfos, ...curatie.pfos },
      pfoa: { ...LANDELIJK.pfoa, ...curatie.pfoa },
      genx: { ...LANDELIJK.genx, ...curatie.genx }
    };
  }

  if (mogelijk || bron) {
    const vanAi = !mogelijk;
    const titel = vanAi ? bron.titel : mogelijk.bronDocumentTitel;
    const id = vanAi ? bron.identifier : mogelijk.bronDocument;
    return {
      ...basis,
      ...kader(),
      heeftAfwijkendBeleid: false,
      herkomst: 'mogelijk-afwijkend',
      tereviewen: true,
      bronType: vanAi ? 'officielebekendmakingen.nl' : 'curatie',
      bronLink: bronLinkStandaard || docLink(id),
      bronDocument: id || null,
      bronDocumentLink: vanAi ? bron.url : docLink(id),
      bronDocumentTitel: titel || null,
      bronDocumentDatum: (vanAi ? bron.publicatieDatum : mogelijk.bronDocumentDatum) || null,
      mogelijkeWaarden: vanAi ? (bron.waarden || null) : null,
      geverifieerdOp: vanAi ? null : (mogelijk.geverifieerdOp || null),
      opmerkingen: vanAi
        ? `In ${titel} (${id}) staan mogelijk afwijkende PFAS-normen` +
          `${isOntwerp(titel) ? ' (ontwerpbesluit, nog niet vastgesteld)' : ''}. ` +
          `Dat is automatisch gesignaleerd en nog niet nagelezen. Het dashboard toont het landelijk kader; ` +
          `raadpleeg het besluit en de omgevingsdienst voordat u hierop vertrouwt.`
        : mogelijk.opmerkingen,
      confidenceScore: 50
    };
  }

  // Geen besluit gevonden. Dat is een AANNAME, geen vaststelling.
  return {
    ...basis,
    ...kader(),
    heeftAfwijkendBeleid: false,
    herkomst: 'landelijk-kader-aanname',
    tereviewen: false,
    bronType: null,
    bronLink: bronLinkStandaard || null,
    bronDocumentLink: null,
    opmerkingen: 'Er is geen vastgesteld afwijkend PFAS-beleid gevonden; het landelijk Handelingskader PFAS ' +
      '(versie december 2023) is aangenomen. Dat is geen vaststelling: controleer bij de omgevingsdienst.',
    confidenceScore: 100
  };
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
 *   'curatie'                 - handmatig geverifieerd in pfas_normen.json
 *   'officiele-bekendmaking'  - waarden komen uit een gemeenteblad
 *   'mogelijk-afwijkend'      - afwijking gevonden, nog niet geverifieerd
 *   'landelijk-kader-aanname' - geen document gevonden; landelijk kader aangenomen
 *   'handmatig'               - handmatig overschreven via de Google Sheet
 */
async function herbouwAfwijkingen(db) {
  const docs = await db.collection('pfasDocumenten').get();

  // Nieuwste afwijkende document per gemeente wint; zeker gaat voor onzeker.
  // Onzekere documenten worden NIET weggegooid: de gemeente komt dan op
  // 'mogelijk-afwijkend' in plaats van stilzwijgend op het landelijk kader.
  const perGemeente = new Map();
  docs.forEach(d => {
    const data = d.data();
    if (!data.gemeenteId) return;
    if (NAGELEZEN_ZONDER_AFWIJKING.has(data.identifier)) return;
    const oordeel = herbeoordeelDocument(data);
    if (!oordeel.afwijkend) return;

    const kandidaat = { ...data, ...oordeel };
    const huidig = perGemeente.get(data.gemeenteId);
    if (!huidig ||
        Number(kandidaat.zeker) > Number(huidig.zeker) ||
        (kandidaat.zeker === huidig.zeker &&
         String(kandidaat.publicatieDatum || '') > String(huidig.publicatieDatum || ''))) {
      perGemeente.set(data.gemeenteId, kandidaat);
    }
  });

  const mapping = require('./gemeente_mapping.json');
  const standaardLink = new Map(Object.entries(mapping).map(([naam, url]) => [toDocId(naam), url]));

  const pfasData = await db.collection('pfasData').get();
  const vandaag = new Date().toISOString().split('T')[0];
  const updates = [];
  const telling = { curatie: 0, teReviewen: 0, aanname: 0 };

  pfasData.forEach(doc => {
    const bestaand = doc.data();
    if (bestaand.handmatigeOverschrijving === true) return;

    // Een bronlink die naar een gemeenteblad wees hoort niet te blijven
    // staan als dat gemeenteblad niet meer als bron geldt.
    const oudeLinkIsDocument = /officielebekendmakingen|repository\.overheid\.nl/.test(bestaand.bronLink || '');
    const bronLinkStandaard = standaardLink.get(doc.id) || (oudeLinkIsDocument ? null : bestaand.bronLink);

    const data = leidGemeenteAf({
      docId: doc.id,
      bron: perGemeente.get(doc.id),
      curatie: CURATIE.get(doc.id),
      mogelijk: MOGELIJK.get(doc.id),
      bronLinkStandaard,
      vandaag
    });

    if (data.herkomst === 'curatie') telling.curatie++;
    else if (data.herkomst === 'mogelijk-afwijkend') telling.teReviewen++;
    else telling.aanname++;

    updates.push({ ref: doc.ref, data });
  });

  const LIMIET = 400;
  for (let i = 0; i < updates.length; i += LIMIET) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + LIMIET)) batch.set(u.ref, u.data, { merge: true });
    await batch.commit();
  }

  return { ...telling, documentenInCorpus: docs.size };
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

  // Pre-load de al verwerkte document-IDs uit Firestore. Hiermee voorkomen we
  // honderden opeenvolgende Firestore get()-aanroepen tijdens het doorlopen van records.
  const alVerwerkt = new Set();
  if (!forceer) {
    const docsSnapshot = await db.collection('pfasDocumenten').select('verwerktOp').get();
    docsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data && data.verwerktOp) {
        alVerwerkt.add(doc.id);
      }
    });
    console.log(`   ${alVerwerkt.size} reeds verwerkte documenten geladen uit corpus.`);
  }

  const resultaat = { gevonden: records.length, verwerkt: 0, overgeslagen: 0, mislukt: 0 };
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  let limietBereikt = false;
  for (const pub of records) {
    if (resultaat.verwerkt >= maxDocumenten) {
      console.log(`   Limiet van ${maxDocumenten} nieuwe documenten bereikt; rest volgende run.`);
      limietBereikt = true;
      break;
    }
    try {
      const uitkomst = await verwerkPublicatie(db, pub, { forceer, alVerwerkt });
      resultaat[uitkomst]++;
      if (uitkomst === 'verwerkt') await delay(2500); // rate limit Gemini (Free Tier)
    } catch (err) {
      console.error(`   ❌ ${pub.identifier}: ${err.message}`);
      resultaat.mislukt++;
    }
  }

  const afgeleid = await herbouwAfwijkingen(db);

  // Watermerk alleen bijwerken als ALLES verwerkt is, met een dag overlap
  // tegen publicaties die net na de vorige run zijn toegevoegd. Stopte de run
  // op de limiet of mislukte er een document, dan blijft het watermerk staan:
  // anders valt de rest buiten het venster van elke volgende run en wordt hij
  // nooit meer bekeken. Al verwerkte documenten worden overgeslagen, dus
  // opnieuw beginnen bij het oude watermerk kost geen AI-calls.
  const compleet = !limietBereikt && resultaat.mislukt === 0;
  const gisteren = new Date();
  gisteren.setDate(gisteren.getDate() - 1);
  await configRef.set({
    ...(compleet ? { laatsteGeslaagdeRun: gisteren.toISOString().split('T')[0] } : {}),
    laatsteRunOp: new Date().toISOString(),
    laatsteRunCompleet: compleet,
    laatsteResultaat: { ...resultaat, ...afgeleid, compleet }
  }, { merge: true });

  console.log(`🧹 Sweep klaar:`, JSON.stringify({ ...resultaat, ...afgeleid }));
  return { ...resultaat, ...afgeleid };
}

module.exports = {
  checkOfficieleBekendmakingen,
  filterPlausibeleWaarden,
  selecteerRelevanteTekst,
  zoekRecenteBekendmakingen,
  zoekBekendmakingen,
  bouwCqlQuery,
  sweepBekendmakingen,
  herbouwAfwijkingen,
  herbeoordeelDocument,
  leidGemeenteAf,
  isOntwerp,
  omgevingsdienstVan,
  wijktAfVanLandelijkKader,
  haalDocumentTekst,
  haalPagina,
  SRU_BASE
};
