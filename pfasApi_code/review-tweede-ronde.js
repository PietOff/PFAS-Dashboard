/**
 * Tweede ronde van de review van 'mogelijk afwijkend' beleid.
 *
 * De eerste ronde (review-mogelijk.js) toonde per gemeente de passages rond
 * PFAS-getallen in het brondocument en de vier recentste eigen publicaties.
 * Voor een deel van de gemeenten was dat niet genoeg om te beslissen: de
 * doorslaggevende tabel of het vaststellingsbesluit viel buiten beeld.
 *
 * Dit script haalt per open geval gericht de documenten op die in de eerste
 * ronde als kandidaat naar voren kwamen, toont ruime passages rond de
 * zoektermen die de beslissing dragen, en zet álle eigen PFAS/bodem-
 * publicaties van de gemeente op een rij (titel en datum), zodat een
 * vaststelling of intrekking niet door een recentere publicatie wordt
 * verdrongen.
 *
 * Beslist niets en schrijft niets.
 */

const { haalDocumentTekst, zoekBekendmakingen } = require('./checkBekendmakingen');
const { toDocId } = require('./docId');

const docUrl = (id) => `https://zoek.officielebekendmakingen.nl/${id}.html`;

// Per gemeente: welke documenten, en waar in die documenten de beslissing staat.
const GEVALLEN_2 = [
  // Utrecht: heeft de gemeente de provinciale PFAS-zonering met LMW vastgesteld?
  { gemeente: 'Utrechtse Heuvelrug', docs: ['gmb-2022-506420', 'gmb-2022-502317'], zoek: /lokale maximale waarde|PFAS[- ]zone|B3|vaststel/i },
  { gemeente: 'Wijk bij Duurstede', docs: ['gmb-2022-531251'], zoek: /lokale maximale waarde|PFAS[- ]zone|B3|vaststel/i },
  { gemeente: 'Zeist', docs: ['gmb-2022-524144'], zoek: /lokale maximale waarde|PFAS[- ]zone|B3|vaststel/i },
  { gemeente: 'Eemnes', docs: ['gmb-2024-450837'], zoek: /PFAS|lokale maximale waarde|nota bodembeheer/i },
  { gemeente: 'Bunschoten', docs: ['gmb-2021-33441'], zoek: /PFAS|lokale maximale waarde/i },
  { gemeente: 'Montfoort', docs: ['gmb-2024-440271'], zoek: /PFAS|lokale maximale waarde|B2/i },
  { gemeente: 'Utrecht', docs: ['gmb-2026-396152'], zoek: /PFAS|lokale maximale waarde|B2/i },
  { gemeente: 'Lopik', docs: [], zoek: null },
  { gemeente: 'Amersfoort', docs: [], zoek: null },
  { gemeente: 'Baarn', docs: [], zoek: null },
  { gemeente: 'De Bilt', docs: [], zoek: null },
  { gemeente: 'De Ronde Venen', docs: [], zoek: null },
  { gemeente: 'Leusden', docs: [], zoek: null },
  { gemeente: 'Woudenberg', docs: [], zoek: null },
  // Referentie: hoe ziet een vastgestelde Utrechtse LMW eruit (curatie Veenendaal/Renswoude)?
  { gemeente: 'Veenendaal', referentie: true, docs: ['gmb-2024-102794'], zoek: /lokale maximale waarde|B3|1,8|2,9/i },

  // Rivierenland: tabel 4.2 met de PFAS-LMW, en de vaststelling per gemeente.
  { gemeente: 'West Betuwe', docs: ['gmb-2021-127031'], zoek: /tabel 4\.2|4\.3\.7|2,8/i },
  { gemeente: 'West Maas en Waal', docs: ['gmb-2021-337387'], zoek: /bodem|PFAS|nota/i },
  { gemeente: 'Buren', docs: ['gmb-2021-428289'], zoek: /tabel 4\.2|4\.3\.7|2,8/i },
  { gemeente: 'Tiel', referentie: true, docs: ['gmb-2021-355457'], zoek: /tabel 4\.2|4\.3\.7|2,8/i },

  // Achterhoek: §2.5.11, toepassen PFAS-houdende grond bij wonen/industrie.
  { gemeente: 'Montferland', docs: ['gmb-2021-428353', 'gmb-2024-52385'], zoek: /2\.5\.11|achtergrondwaarden mag|toepassingswaarden PFAS/i },
  { gemeente: 'Winterswijk', docs: ['gmb-2023-554135'], zoek: /PFAS.{0,80}(wonen|industrie|achtergrond)/i },

  // Zeeland: artikel 4, 5 en 11 van de nota.
  { gemeente: 'Reimerswaal', docs: ['gmb-2024-37380'], zoek: /Artikel (4|5|11)\b/ },

  // Brabant: opvolger van de tijdelijke handreiking 2019/2020?
  { gemeente: 'Tilburg', docs: ['gmb-2023-506770', 'gmb-2024-47591'], zoek: /PFAS.{0,120}(µg|μg|lokale maximale)|lokale maximale waarden PFAS/i },
  { gemeente: 'Sint-Michielsgestel', docs: ['gmb-2020-350808'], zoek: /toepassingsnorm|tabel 2|landbouw ?\/ ?natuur/i },
  { gemeente: 'Geertruidenberg', docs: [], zoek: null },
  { gemeente: 'Bergen op Zoom', docs: [], zoek: null },

  // Noordzeekanaalgebied: ingetrokken zoals in Diemen?
  { gemeente: 'Aalsmeer', docs: [], zoek: null },
  { gemeente: 'Amstelveen', docs: [], zoek: null },
  { gemeente: 'Ouder-Amstel', docs: [], zoek: null },

  // Overig
  { gemeente: 'Nissewaard', docs: [], zoek: null },
  { gemeente: 'Scherpenzeel', docs: ['gmb-2023-337424', 'gmb-2026-167995'], zoek: /PFAS.{0,160}(µg|μg)|toepassingseis.{0,80}PFAS/i },
  { gemeente: 'Hardenberg', docs: ['gmb-2025-568235'], zoek: /bodembeheergebied|4\.5|30 µg/i }
];

// Derde ronde: wat de tweede ronde nog openliet, plus buurgemeenten die
// onder dezelfde regionale nota vallen maar nu als 'landelijk kader' staan.
const GEVALLEN_3 = [
  { gemeente: 'Utrecht', docs: ['gmb-2020-255720', 'gmb-2020-83142'], zoek: /PFOA|PFOS|lokale maximale waarde/i },
  { gemeente: 'Leusden', docs: ['gmb-2022-576422'], zoek: /PFAS|ODRU|lokale maximale waarde|B3/i },
  { gemeente: 'Tiel', referentie: true, docs: ['gmb-2021-355457'], zoek: /4\.3\.7 Lokale Maximale Waarden toepassen PFAS|Tabel 4\.2/ },
  { gemeente: 'Reimerswaal', docs: ['gmb-2024-37380'], zoek: /Artikel (9|10) \(/ },
  // Zoetermeer: neemt de Nota 2022 de lokale PFAS-toepassingseis (PFOS 2,6 · PFOA 1,55) over?
  { gemeente: 'Zoetermeer', docs: ['gmb-2022-547675'], zoek: /toepassingseis.{0,200}PFAS|PFAS.{0,200}toepassingseis|beleidsregel PFAS|ACN/i },
  // Regio Achterhoek: wie heeft de nota met §2.5.11 vastgesteld?
  { gemeente: 'Aalten', docs: [], zoek: null },
  { gemeente: 'Berkelland', docs: [], zoek: null },
  { gemeente: 'Bronckhorst', docs: [], zoek: null },
  { gemeente: 'Doetinchem', docs: [], zoek: null },
  { gemeente: 'Oost Gelre', docs: [], zoek: null },
  { gemeente: 'Oude IJsselstreek', docs: [], zoek: null },
  // Regio Bevelanden en Tholen: zelfde PFAS-artikelen als Tholen/Reimerswaal?
  { gemeente: 'Borsele', docs: [], zoek: null },
  { gemeente: 'Goes', docs: [], zoek: null },
  { gemeente: 'Kapelle', docs: [], zoek: null },
  { gemeente: 'Noord-Beveland', docs: [], zoek: null }
];

// Vierde ronde: de artikelen zelf, waar de derde ronde alleen de inhoudsopgave
// of de wonen/industrie-regel liet zien.
const GEVALLEN_4 = [
  // Bevelanden en Tholen: art. 5 lid 1 (landbouw/natuur) in de eigen nota.
  { gemeente: 'Borsele', docs: ['gmb-2024-227327'], zoek: /PFOS \(som\)|regio Bevelanden en Tholen/ },
  { gemeente: 'Goes', docs: ['gmb-2022-464666'], zoek: /PFOS \(som\)|regio Bevelanden en Tholen/ },
  { gemeente: 'Noord-Beveland', docs: ['gmb-2020-304142'], zoek: /PFOS \(som\)|toepassingsnorm.{0,80}PFAS/i },
  // Achterhoek: de tekst van §2.5.11 zelf (niet de inhoudsopgave).
  { gemeente: 'Oude IJsselstreek', docs: ['gmb-2024-31587'], zoek: /2\.5\.11 Toepassen van PFAS-houdende grond bij de toepassingseis kwaliteitsklasse ‘Wonen’ of ‘Industrie’ (?!2\.6|26)/ },
  { gemeente: 'Oost Gelre', docs: [], zoek: null }
];

// Bij buurgemeenten zonder vooraf bekend document: zoek in hun eigen nota's
// naar de PFAS-artikelen.
const AUTO_ZOEK = /PFAS.{0,200}(µg|μg)|2\.5\.11|achtergrondwaarden mag|lokale maximale waarde/i;
const AUTO_TITEL = /nota bodembeheer|bodemkwaliteitskaart|PFAS|bodembeleid/i;

const RONDE = (process.argv.find(a => a.startsWith('--ronde=')) || '--ronde=2').split('=')[1];
const GEVALLEN = { 3: GEVALLEN_3, 4: GEVALLEN_4 }[RONDE] || GEVALLEN_2;

const VENSTER = 1400;
const MAX_PER_DOC = 9000;

function passages(tekst, zoek) {
  if (!tekst || !zoek) return [];
  const re = new RegExp(zoek.source, zoek.flags.includes('g') ? zoek.flags : zoek.flags + 'g');
  const stukken = [];
  let m;
  while ((m = re.exec(tekst)) !== null) {
    const van = Math.max(0, m.index - 200);
    const tot = Math.min(tekst.length, m.index + VENSTER);
    const vorige = stukken[stukken.length - 1];
    if (vorige && van <= vorige.tot) vorige.tot = tot;
    else stukken.push({ van, tot });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  const uit = [];
  let lengte = 0;
  for (const s of stukken) {
    const t = tekst.slice(s.van, s.tot).replace(/\s+/g, ' ').trim();
    if (lengte + t.length > MAX_PER_DOC) { uit.push('… (ingekort)'); break; }
    uit.push(t);
    lengte += t.length;
  }
  return uit;
}

// Titel uit de HTML van zoek.officielebekendmakingen.nl.
const titelVan = (tekst) => {
  const m = tekst && tekst.match(/Gepubliceerd op \d{4}-\d\d-\d\d Toon volledige inhoudsopgave (?:Aanhef |Lichaam )?(.{0,200})/);
  return m ? m[1].slice(0, 160) : null;
};

// De SRU van overheid.nl reageert soms even niet (timeout); een nieuwe poging
// na een paar seconden lukt dan meestal. Zelfde wachttijden als check-bronnen.js.
const SRU_WACHTTIJDEN_MS = [5000, 15000, 30000];

async function zoekMetHerkansing() {
  for (let poging = 0; ; poging++) {
    try {
      return await zoekBekendmakingen({ vanaf: '2019-01-01', maxRecords: 3000 });
    } catch (err) {
      if (poging >= SRU_WACHTTIJDEN_MS.length) throw err;
      console.error(`SRU: ${err.message}; nieuwe poging over ${SRU_WACHTTIJDEN_MS[poging] / 1000} s`);
      await new Promise(res => setTimeout(res, SRU_WACHTTIJDEN_MS[poging]));
    }
  }
}

async function main() {
  const { records } = await zoekMetHerkansing();
  const perGemeente = new Map();
  for (const r of records) {
    const id = toDocId(r.gemeente);
    if (!perGemeente.has(id)) perGemeente.set(id, []);
    perGemeente.get(id).push(r);
  }

  for (const g of GEVALLEN) {
    console.log(`\n${'='.repeat(78)}\n### ${g.gemeente}${g.referentie ? '  (REFERENTIE)' : ''}`);
    const eigen = (perGemeente.get(toDocId(g.gemeente)) || [])
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    console.log(`Alle eigen PFAS/bodem-publicaties (${eigen.length}):`);
    for (const p of eigen) console.log(`   ${p.date}  ${p.identifier}  ${p.title}`);

    // Geen bekend document: neem de eigen nota's/kaarten (max. 3, recentste eerst).
    const docs = g.docs.length ? g.docs
      : eigen.filter(p => AUTO_TITEL.test(p.title || '')).slice(-3).map(p => p.identifier);
    const zoek = g.zoek || AUTO_ZOEK;
    for (const id of docs) {
      const tekst = await haalDocumentTekst(docUrl(id));
      console.log(`  -- ${id}: ${tekst ? tekst.length : 0} tekens | ${titelVan(tekst) || ''}`);
      passages(tekst, zoek).forEach((p, i) => console.log(`     [${i + 1}] ${p}`));
    }
  }
}

main().catch(err => {
  console.error('Fout:', err.message);
  process.exit(2);
});
