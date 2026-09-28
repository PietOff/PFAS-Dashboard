/**
 * Zet voor elke gemeente met 'mogelijk-afwijkend' beleid de bewijsstukken op
 * een rij, zodat een mens (of een review) per gemeente kan beslissen: wijkt
 * het beleid echt af, en met welke waarden?
 *
 * Twee soorten gevallen:
 *   - door de AI gesignaleerd: het document staat erbij, maar niemand heeft de
 *     waarden nagelezen. Dit script haalt de passages met PFAS-getallen op.
 *   - handmatig gemarkeerd (pfas_normen.json → mogelijkAfwijkend): meestal een
 *     provinciale of regionale nota zonder gevonden vaststelling door de
 *     gemeente. Dit script zoekt in de SRU naar publicaties van die gemeente
 *     zelf die PFAS en bodem noemen, met de passages erbij.
 *
 * Het script beslist niets en schrijft niets; het levert alleen leesbaar
 * bewijs. Draait in CI, omdat overheid.nl daar wel bereikbaar is.
 *
 * Gebruik:
 *   node review-mogelijk.js                  # tekst naar stdout
 *   node review-mogelijk.js --json > r.json  # machineleesbaar
 *   node review-mogelijk.js --uit=r.json     # tekst naar stdout én JSON naar r.json
 */

const axios = require('axios');
const { haalDocumentTekst, zoekBekendmakingen } = require('./checkBekendmakingen');
const { toDocId } = require('./docId');

const SITE = 'https://pfas-dashboard-nl-a808d.web.app';
const alsJson = process.argv.includes('--json');
const uitArg = process.argv.find(a => a.startsWith('--uit='));
const uitPad = uitArg ? uitArg.slice('--uit='.length) : null;

// Een passage telt als het een PFAS-stof noemt met een getal in de buurt.
const STOF = /\b(PFOA|PFOS|GenX|FRD-?903|PFAS|som\s*PFAS|perfluor\w*)\b/gi;
const GETAL = /\d+[,.]?\d*\s*(µg|ug|μg|microgram)/i;
const VENSTER = 350;
const MAX_PER_DOC = 4500;

function passages(tekst) {
  if (!tekst) return [];
  const stukken = [];
  let m;
  STOF.lastIndex = 0;
  while ((m = STOF.exec(tekst)) !== null) {
    const van = Math.max(0, m.index - VENSTER);
    const tot = Math.min(tekst.length, m.index + VENSTER);
    const stuk = tekst.slice(van, tot);
    if (!GETAL.test(stuk) && !/\d+,\d+/.test(stuk)) continue;
    const vorige = stukken[stukken.length - 1];
    if (vorige && van <= vorige.tot) vorige.tot = tot;
    else stukken.push({ van, tot });
  }
  const uit = [];
  let lengte = 0;
  for (const s of stukken) {
    const t = tekst.slice(s.van, s.tot).replace(/\s+/g, ' ').trim();
    if (lengte + t.length > MAX_PER_DOC) { uit.push('… (meer passages ingekort)'); break; }
    uit.push(t);
    lengte += t.length;
  }
  return uit;
}

const docUrl = (id, url) => url || (id ? `https://zoek.officielebekendmakingen.nl/${id}.html` : null);

// Intrekkingsbesluiten vallen buiten de zoekvraag van de sweep: ze noemen PFAS
// maar geen bodemterm ("Besluit tot intrekking van de Beleidsregel PFAS").
// Daardoor stonden zes ingetrokken beleidsregels nog als signaal in het corpus.
async function zoekIntrekkingen(gemeente) {
  const query = `c.product-area=="officielepublicaties" and dt.creator="${gemeente}" ` +
    'and cql.textAndIndexes="PFAS" and dt.title any "intrekking intrekken ingetrokken"';
  const url = 'https://repository.overheid.nl/sru?version=1.2&operation=searchRetrieve' +
    `&x-connection=oep&maximumRecords=20&query=${encodeURIComponent(query)}`;
  try {
    const r = await axios.get(url, {
      timeout: 30000, responseType: 'text', transformResponse: [(d) => d],
      headers: { 'Accept': 'application/xml', 'User-Agent': 'PFASDashboard/1.0 (overheid-monitoring)' }
    });
    const uit = [];
    for (const [, rec] of String(r.data).matchAll(/<(?:\w+:)?recordData[^>]*>([\s\S]*?)<\/(?:\w+:)?recordData>/g)) {
      const veld = (f) => (rec.match(new RegExp(`<(?:\\w+:)?${f}[^>]*>([^<]+)<\\/`)) || [])[1] || null;
      uit.push({ document: veld('identifier'), titel: veld('title'), datum: veld('modified') || veld('date') });
    }
    return uit;
  } catch (err) {
    return [{ fout: err.message }];
  }
}

// Het register lokale regelgeving (CVDR) bevat de geldende regels van een
// gemeente, ook als de bekendmaking alleen "vastgesteld" zegt en de inhoud in
// een bijlage staat (Montfoort). Het is ook het beste bewijs dat iets ontbreekt:
// staat er geen bodemnota, dan is er waarschijnlijk geen vastgesteld beleid.
async function zoekCvdr(gemeente) {
  const url = 'https://lokaleregelgeving.overheid.nl/ZoekResultaat?count=100&onderwerpen=milieu' +
    `&gemeenten=${encodeURIComponent(gemeente)}`;
  try {
    const r = await axios.get(url, {
      timeout: 30000, responseType: 'text', transformResponse: [(d) => d],
      headers: { 'User-Agent': 'Mozilla/5.0 (PFASDashboard/1.0)' }
    });
    const gezien = new Set();
    const uit = [];
    for (const [, id, titel] of String(r.data).matchAll(/href="\/(CVDR\d+)(?:\/\d+)?"[^>]*>\s*([^<]{3,200})</g)) {
      const t = titel.replace(/\s+/g, ' ').trim();
      if (gezien.has(id) || !/bodem|grond|PFAS|bagger/i.test(t)) continue;
      gezien.add(id);
      uit.push({ cvdr: id, titel: t, url: `https://lokaleregelgeving.overheid.nl/${id}` });
    }
    return uit;
  } catch (err) {
    return [{ fout: err.message }];
  }
}

async function main() {
  const r = await axios.get(`${SITE}/api/v1/gemeenten`, { timeout: 60000 });
  const lijst = r.data.filter(g => g.herkomst === 'mogelijk-afwijkend');
  console.error(`${lijst.length} gemeenten met mogelijk afwijkend beleid.\n`);

  // Eén SRU-zoekvraag voor alles, dan per gemeente groeperen: goedkoper dan
  // 48 losse zoekvragen, en dezelfde query als de sweep.
  let perGemeente = new Map();
  try {
    const { records } = await zoekBekendmakingen({ vanaf: '2019-01-01', maxRecords: 3000 });
    for (const rec of records) {
      const id = toDocId(rec.gemeente);
      if (!perGemeente.has(id)) perGemeente.set(id, []);
      perGemeente.get(id).push(rec);
    }
  } catch (err) {
    console.error('SRU niet bereikbaar:', err.message);
  }

  const rapport = [];
  for (const g of lijst) {
    const item = {
      gemeente: g.gemeente,
      id: g.id,
      bronType: g.bronType,
      omgevingsdienst: g.omgevingsdienst || null,
      document: g.bronDocument || null,
      titel: g.bronDocumentTitel || null,
      datum: g.bronDocumentDatum || null,
      aiWaarden: g.mogelijkeWaarden || null,
      opmerking: g.opmerkingen || null,
      passages: [],
      eigenPublicaties: []
    };

    const url = docUrl(g.bronDocument, g.bronDocumentLink);
    if (url) {
      const tekst = await haalDocumentTekst(url);
      item.tekstLengte = tekst ? tekst.length : 0;
      item.passages = passages(tekst);
    }

    // Publicaties van de gemeente zelf: daar staat een eventuele vaststelling.
    const eigen = (perGemeente.get(toDocId(g.gemeente)) || [])
      .filter(p => p.identifier !== g.bronDocument)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 4);
    for (const p of eigen) {
      const tekst = await haalDocumentTekst(docUrl(p.identifier, p.url));
      item.eigenPublicaties.push({
        document: p.identifier, titel: p.title, datum: p.date,
        passages: passages(tekst).slice(0, 4)
      });
    }

    item.intrekkingen = await zoekIntrekkingen(g.gemeente);
    item.cvdr = await zoekCvdr(g.gemeente);

    rapport.push(item);
    console.error(`✓ ${g.gemeente}: ${item.passages.length} passages, ${item.eigenPublicaties.length} eigen publicaties, ` +
      `${item.intrekkingen.length} intrekkingen, ${item.cvdr.length} CVDR-regelingen`);
  }

  const json = JSON.stringify({ tijdstip: new Date().toISOString(), rapport }, null, 2) + '\n';
  if (uitPad) require('fs').writeFileSync(uitPad, json);
  if (alsJson) {
    process.stdout.write(json);
    return;
  }

  for (const it of rapport) {
    console.log(`\n${'='.repeat(78)}\n### ${it.gemeente}  [${it.bronType}]  ${it.omgevingsdienst || ''}`);
    console.log(`Document: ${it.document || '—'} | ${it.titel || '—'} | ${it.datum || '—'}`);
    if (it.aiWaarden) console.log(`AI-waarden: ${JSON.stringify(it.aiWaarden)}`);
    if (it.bronType === 'curatie' && it.opmerking) console.log(`Notitie: ${it.opmerking}`);
    console.log(`Tekst: ${it.tekstLengte || 0} tekens, ${it.passages.length} passages`);
    it.passages.forEach((p, i) => console.log(`  [${i + 1}] ${p}`));
    for (const e of it.eigenPublicaties) {
      console.log(`  -- eigen publicatie ${e.document} | ${e.titel} | ${e.datum}`);
      e.passages.forEach((p, i) => console.log(`     [${i + 1}] ${p}`));
    }
    for (const x of it.intrekkingen) console.log(`  -- intrekking ${x.document || ''} | ${x.titel || x.fout} | ${x.datum || ''}`);
    for (const c of it.cvdr) console.log(`  -- CVDR ${c.cvdr || ''} | ${c.titel || c.fout} | ${c.url || ''}`);
  }
}

main().catch(err => {
  console.error('Fout:', err.message);
  process.exit(2);
});
