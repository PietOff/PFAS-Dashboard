/**
 * Smoke tests — draaien zonder Firebase-credentials en zonder netwerk.
 *
 * Dekken bewust de twee fouten die de meeste schade aanrichtten:
 *  1. index.js riep runWeeklyScraper aan zonder het te importeren, waardoor
 *     runScraperNow altijd een ReferenceError gaf.
 *  2. De doc-id regex `/\\s+/g` matchte een backslash in plaats van witruimte,
 *     waardoor elke gemeente met een spatie twee Firestore-documenten kreeg.
 *
 * Gebruik: npm test
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'pfas-dashboard-test';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({
  projectId: process.env.GCLOUD_PROJECT
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
const test = (naam, fn) => tests.push({ naam, fn });

const wortel = path.join(__dirname, '..');

// ------------------------------------------------------------------
test('toDocId maakt consistente id\'s van gemeentenamen', () => {
  const { toDocId } = require('../docId');

  assert.strictEqual(toDocId('Bergen op Zoom'), 'bergen-op-zoom');
  assert.strictEqual(toDocId('Berg en Dal'), 'berg-en-dal');
  assert.strictEqual(toDocId('Den Helder'), 'den-helder');
  assert.strictEqual(toDocId("'s-Hertogenbosch"), "'s-hertogenbosch");
  assert.strictEqual(toDocId('Utrecht'), 'utrecht');

  // Rommelige invoer
  assert.strictEqual(toDocId('  Bergen   op  Zoom  '), 'bergen-op-zoom');
  assert.strictEqual(toDocId(null), null);
  assert.strictEqual(toDocId(''), null);
  assert.strictEqual(toDocId('   '), null);
});

// ------------------------------------------------------------------
test('geen enkel bestand gebruikt nog de kapotte /\\\\s+/ regex', () => {
  const bestanden = fs.readdirSync(wortel)
    .filter(f => f.endsWith('.js'))
    .concat(fs.readdirSync(path.join(wortel, 'adapters')).map(f => path.join('adapters', f)));

  const kapot = bestanden.filter(f =>
    fs.readFileSync(path.join(wortel, f), 'utf8').includes('replace(/\\\\s+/g')
  );

  assert.deepStrictEqual(kapot, [], `Deze bestanden gebruiken nog de kapotte regex: ${kapot.join(', ')}`);
});

// ------------------------------------------------------------------
test('alle doc-id\'s worden via toDocId gemaakt', () => {
  // Voorkomt dat iemand opnieuw een eigen variant introduceert.
  for (const f of ['index.js', 'scraper.js', 'syncSheet.js', 'checkBekendmakingen.js']) {
    const bron = fs.readFileSync(path.join(wortel, f), 'utf8');
    assert.ok(bron.includes("require('./docId')"), `${f} importeert docId niet`);
  }
});

// ------------------------------------------------------------------
test('index.js laadt en exporteert alle Cloud Functions', () => {
  const idx = require('../index.js');

  const verwacht = [
    'pfasApi',
    'nightlyBekendmakingen',
    'checkBekendmakingenNow',
    'runScraperNow',
    'fillDefaultData',
    'fixLinks',
    'syncSheetNow',
    'findRealLinks',
    'mergeDuplicateDocs',
    'auditData',
    'weeklyBekendmakingenSweep',
    'dailyHealthCheck',
    'healthCheck',
    'sweepBekendmakingenNow',
    'herbouwAfwijkingenNow'
  ];

  for (const naam of verwacht) {
    assert.ok(idx[naam], `Cloud Function ontbreekt: ${naam}`);
  }
});

// ------------------------------------------------------------------
test('runScraperNow crasht niet op een ontbrekende import', async () => {
  const idx = require('../index.js');

  let respons = null;
  const req = { query: { gemeente: 'Gouda' } };
  const res = {
    code: 200,
    status(c) { this.code = c; return this; },
    send(m) { respons = { code: this.code, body: String(m) }; },
    json(o) { respons = { code: this.code, body: JSON.stringify(o) }; }
  };

  await idx.runScraperNow(req, res);

  // Zonder credentials mag deze functie best falen op Firestore, maar NOOIT
  // meer op "runWeeklyScraper is not defined".
  assert.ok(respons, 'runScraperNow heeft geen antwoord gestuurd');
  assert.ok(
    !/runWeeklyScraper is not defined/.test(respons.body),
    `runWeeklyScraper is nog steeds niet geimporteerd: ${respons.body}`
  );
});

// ------------------------------------------------------------------
test('elke require in de functions-code is een echte dependency', () => {
  // node-fetch werd gebruikt in adapters/odmh.js maar stond niet in
  // package.json; het werd alleen per ongeluk gevonden via firebase-admin.
  const pkg = require('../package.json');
  const bekend = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {})
  ]);

  const bestanden = ['index.js', 'scraper.js', 'syncSheet.js', 'checkBekendmakingen.js', 'docId.js',
    path.join('adapters', 'index.js'), path.join('adapters', 'odmh.js')];

  const ontbrekend = [];
  for (const f of bestanden) {
    const bron = fs.readFileSync(path.join(wortel, f), 'utf8');
    for (const m of bron.matchAll(/require\(['"]([^'".][^'"]*)['"]\)/g)) {
      const naam = m[1];
      if (naam.startsWith('.')) continue;
      // Scope-package (@a/b) of gewone package: pak de package-naam
      const pkgNaam = naam.startsWith('@') ? naam.split('/').slice(0, 2).join('/') : naam.split('/')[0];
      if (!bekend.has(pkgNaam) && !require('module').builtinModules.includes(pkgNaam)) {
        ontbrekend.push(`${f} -> ${pkgNaam}`);
      }
    }
  }

  assert.deepStrictEqual(ontbrekend, [], `Niet-gedeclareerde dependencies: ${ontbrekend.join(', ')}`);
});

// ------------------------------------------------------------------
test('pfas_normen.json en gemeente_mapping.json zijn geldig', () => {
  const normen = require('../pfas_normen.json');
  const mapping = require('../gemeente_mapping.json');

  for (const stof of ['pfos', 'pfoa', 'genx']) {
    for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
      const v = normen.landelijk_kader[stof][klasse];
      assert.strictEqual(typeof v, 'number', `landelijk_kader.${stof}.${klasse} is geen getal`);
      assert.ok(v > 0 && v <= 50, `landelijk_kader.${stof}.${klasse} is onwaarschijnlijk: ${v}`);
    }
  }

  for (const [gemeente, data] of Object.entries(normen.afwijkend || {})) {
    for (const stof of ['pfos', 'pfoa', 'genx']) {
      if (!data[stof]) continue;
      for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
        const v = data[stof][klasse];
        if (v === undefined || v === null) continue;
        assert.strictEqual(typeof v, 'number', `afwijkend.${gemeente}.${stof}.${klasse} is geen getal`);
        assert.ok(v > 0 && v <= 50, `afwijkend.${gemeente}.${stof}.${klasse} is onwaarschijnlijk: ${v}`);
      }
    }
  }

  assert.ok(Object.keys(mapping).length > 300, 'gemeente_mapping.json lijkt incompleet');
  for (const [gemeente, link] of Object.entries(mapping)) {
    assert.ok(/^https?:\/\//.test(link), `Ongeldige bronLink voor ${gemeente}: ${link}`);
  }
});

// ------------------------------------------------------------------
test('gemeente_mapping bevat geen opgeheven gemeenten', () => {
  // Bij een herindeling moet de oude naam weg en de nieuwe erin, anders blijft
  // het dashboard normen tonen voor een gemeente die niet meer bestaat.
  const mapping = require('../gemeente_mapping.json');

  const opgeheven = {
    'Aalburg': 'Altena', 'Werkendam': 'Altena', 'Woudrichem': 'Altena',
    'Leerdam': 'Vijfheerenlanden', 'Zederik': 'Vijfheerenlanden', 'Vianen': 'Vijfheerenlanden',
    'Binnenmaas': 'Hoeksche Waard', 'Cromstrijen': 'Hoeksche Waard', 'Korendijk': 'Hoeksche Waard',
    'Oud-Beijerland': 'Hoeksche Waard', 'Strijen': 'Hoeksche Waard',
    'Giessenlanden': 'Molenlanden', 'Molenwaard': 'Molenlanden',
    'Noordwijkerhout': 'Noordwijk', 'Haren': 'Groningen', 'Ten Boer': 'Groningen',
    'Appingedam': 'Eemsdelta', 'Delfzijl': 'Eemsdelta', 'Loppersum': 'Eemsdelta',
    'Beemster': 'Purmerend', 'Weesp': 'Amsterdam',
    'Landerd': 'Maashorst', 'Uden': 'Maashorst',
    'Boxmeer': 'Land van Cuijk', 'Cuijk': 'Land van Cuijk', 'Grave': 'Land van Cuijk',
    'Mill en Sint Hubert': 'Land van Cuijk', 'Sint Anthonis': 'Land van Cuijk',
    'Heerhugowaard': 'Dijk en Waard', 'Langedijk': 'Dijk en Waard',
    'Brielle': 'Voorne aan Zee', 'Hellevoetsluis': 'Voorne aan Zee', 'Westvoorne': 'Voorne aan Zee'
  };

  const aanwezig = Object.keys(opgeheven).filter(g => g in mapping);
  assert.deepStrictEqual(aanwezig, [],
    `Opgeheven gemeenten staan nog in de mapping: ${aanwezig.map(g => `${g} -> ${opgeheven[g]}`).join(', ')}`);

  // De opvolgers moeten er juist wél in staan
  const ontbrekend = [...new Set(Object.values(opgeheven))].filter(g => !(g in mapping));
  assert.deepStrictEqual(ontbrekend, [], `Opvolgergemeenten ontbreken: ${ontbrekend.join(', ')}`);
});

// ------------------------------------------------------------------
test('gemeentelijst keurt een onwaarschijnlijk aantal gemeenten af', () => {
  const { MIN_GEMEENTEN, MAX_GEMEENTEN } = require('../gemeentelijst');
  // Nederland heeft 342 gemeenten; de marge moet daar omheen liggen zodat een
  // lege of half geladen bron wordt afgekeurd in plaats van gebruikt.
  assert.ok(MIN_GEMEENTEN < 342 && MAX_GEMEENTEN > 342, 'marge sluit 342 niet in');
  assert.ok(MIN_GEMEENTEN > 200, 'ondergrens te laag om iets af te vangen');
});

// ------------------------------------------------------------------
test('de SRU-query is geldige CQL met serverside datumfilter', () => {
  const { bouwCqlQuery } = require('../checkBekendmakingen');

  const q = bouwCqlQuery({ vanaf: '2024-01-01' });

  // De oude query was kale booleaanse tekst zonder indexnamen; de API verwacht CQL.
  assert.ok(q.includes('c.product-area=="officielepublicaties"'), 'product-area ontbreekt');
  assert.ok(q.includes('w.publicatienaam=="Gemeenteblad"'), 'publicatienaam-filter ontbreekt');
  assert.ok(q.includes('cql.textAndIndexes='), 'tekstindex ontbreekt');

  // Datumfilter MOET serverside staan, anders paginereert hij over de verkeerde set.
  assert.ok(q.includes('dt.modified>="2024-01-01"'), 'serverside datumfilter ontbreekt');

  // Zonder datum geen datumfilter (backfill over het hele corpus)
  assert.ok(!bouwCqlQuery({}).includes('dt.modified'), 'datumfilter hoort weg te blijven zonder vanaf');
});

// ------------------------------------------------------------------
test('de SRU-connectie is oep, niet de product-area', () => {
  const fs2 = require('fs');
  const bron = fs2.readFileSync(path.join(wortel, 'checkBekendmakingen.js'), 'utf8');
  assert.ok(/SRU_CONNECTION\s*=\s*'oep'/.test(bron), "x-connection moet 'oep' zijn");
  assert.ok(!/x-connection=officielepublicaties/.test(bron),
    'x-connection=officielepublicaties is de product-area, niet de connectienaam');
});

// ------------------------------------------------------------------
test('een fout getal gooit de goede getallen niet weg', () => {
  const { filterPlausibeleWaarden } = require('../checkBekendmakingen');

  // De oude valideerWaarden gaf false zodra EEN waarde niet klopte, waardoor
  // correct gelezen afwijkingen uit hetzelfde besluit verdwenen.
  const { waarden, verworpen } = filterPlausibeleWaarden({
    pfos: { wonen: 1.5, industrie: 1.5, landbouwNatuur: 0.9 },  // afwijkend, plausibel
    pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
    genx: { wonen: 1200, industrie: null, landbouwNatuur: 0.8 } // 1200 is onzin
  });

  assert.deepStrictEqual(waarden.pfos, { wonen: 1.5, industrie: 1.5, landbouwNatuur: 0.9 },
    'de afwijkende PFOS-waarden moeten bewaard blijven');
  assert.strictEqual(waarden.genx.landbouwNatuur, 0.8, 'goede GenX-waarde moet blijven');
  assert.strictEqual(waarden.genx.wonen, undefined, '1200 moet eruit gefilterd zijn');
  assert.strictEqual(verworpen.length, 1);
  assert.strictEqual(verworpen[0].reden, 'boven 50 µg/kg');
});

// ------------------------------------------------------------------
test('afwijking diep in een lang document wordt nog gevonden', () => {
  const { selecteerRelevanteTekst } = require('../checkBekendmakingen');

  // Normentabellen staan in een nota bodembeheer tientallen paginas verderop.
  // De oude code nam de eerste 8000 tekens en miste ze structureel.
  const vulling = 'Deze nota beschrijft het bodembeleid. '.repeat(2000);
  const tabel = 'Voor PFOS geldt een lokale maximale waarde van 1,5 ug/kg ds voor wonen.';
  const tekst = vulling + tabel + vulling;

  assert.ok(tekst.length > 50000, 'testdocument moet lang zijn');
  assert.ok(tekst.indexOf(tabel) > 8000, 'tabel moet voorbij de oude 8000-tekengrens liggen');

  const geselecteerd = selecteerRelevanteTekst(tekst);
  assert.ok(geselecteerd.includes('PFOS'), 'de PFOS-passage moet meegenomen worden');
  assert.ok(geselecteerd.includes('1,5'), 'de waarde zelf moet meegenomen worden');
  assert.ok(!tekst.substring(0, 8000).includes('PFOS'), 'controle: oude aanpak zou dit missen');
});

// ------------------------------------------------------------------
test('de zoekopdracht omvat het Blad gemeenschappelijke regeling', () => {
  const { bouwCqlQuery } = require('../checkBekendmakingen');
  const q = bouwCqlQuery({});
  // Omgevingsdiensten zijn gemeenschappelijke regelingen; hun bodembeleid
  // verschijnt daar en niet in een Gemeenteblad.
  assert.ok(q.includes('w.publicatienaam=="Blad gemeenschappelijke regeling"'),
    'omgevingsdiensten publiceren hier hun bodembeleid');
  assert.ok(q.includes('w.publicatienaam=="Gemeenteblad"'));
  assert.ok(q.includes('w.publicatienaam=="Provinciaal blad"'));
});

// ------------------------------------------------------------------
test('de frontend en de hosting-configuratie sluiten op elkaar aan', () => {
  const repo = path.join(wortel, '..');
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'firebase.json'), 'utf8'));

  assert.ok(cfg.hosting, 'firebase.json mist een hosting-blok');
  assert.strictEqual(cfg.hosting.public, 'public');

  const indexPad = path.join(repo, cfg.hosting.public, 'index.html');
  assert.ok(fs.existsSync(indexPad), 'public/index.html ontbreekt');
  const html = fs.readFileSync(indexPad, 'utf8');

  // De frontend praat via de rewrite met de function; als die wegvalt krijgt
  // /api/** een 404 en blijft het dashboard leeg.
  const rewrite = (cfg.hosting.rewrites || []).find(r => r.source === '/api/**');
  assert.ok(rewrite, 'rewrite voor /api/** ontbreekt');
  assert.strictEqual(rewrite.function, 'pfasApi');

  assert.ok(html.includes("'/api/v1/gemeenten'"), 'frontend gebruikt het API-pad niet');

  // Express moet dat pad met /api-prefix ook echt aanbieden.
  const idxBron = fs.readFileSync(path.join(wortel, 'index.js'), 'utf8');
  assert.ok(idxBron.includes("'/api/v1/gemeenten'"), 'index.js serveert /api/v1/gemeenten niet');

  // Alle herkomst-waarden die de backend schrijft moeten in de kaartlegenda
  // voorkomen, anders valt een toestand stil terug op de neutrale kleur.
  for (const h of ['officiele-bekendmaking', 'mogelijk-afwijkend', 'landelijk-kader-aanname', 'handmatig']) {
    assert.ok(html.includes(h), `frontend kent herkomst '${h}' niet`);
  }
});

// ------------------------------------------------------------------
test('geen enkele gemeente heeft alleen een homepage als bron', () => {
  // Een homepage laat de gebruiker zelf zoeken naar het bodembeleid. Waar de
  // omgevingsdienst geen bruikbare pagina heeft, hoort de gemeente zelf de
  // bron te zijn.
  const mapping = require('../gemeente_mapping.json');
  const kaal = Object.entries(mapping)
    .filter(([, u]) => { const p = new URL(u).pathname; return p === '' || p === '/'; })
    .map(([g]) => g);

  assert.deepStrictEqual(kaal, [],
    `Deze gemeenten wijzen naar een homepage zonder bodempagina: ${kaal.join(', ')}`);
});

// ------------------------------------------------------------------
test('geen enkele gemeente wijst naar een opgeheven omgevingsdienst', () => {
  // Een gefuseerde dienst laat zijn oude domein vaak nog jaren staan. De
  // linkcheck ziet dan HTTP 200 en meldt niets, terwijl de gemeente naar een
  // organisatie wijst die het beleid niet meer maakt. Alleen een expliciete
  // lijst vangt dit.
  const mapping = require('../gemeente_mapping.json');
  const opgeheven = {
    'odrn.nl': 'ODRN ging per 1-1-2026 op in Omgevingsdienst Groene Metropool (odgroenemetropool.nl)',
    'odregioarnhem.nl': 'OD Regio Arnhem ging per 1-1-2026 op in Omgevingsdienst Groene Metropool',
    'odru.nl': 'ODRU ging per 1-1-2026 op in Omgevingsdienst Utrecht (odu.nl)',
    'rudutrecht.nl': 'RUD Utrecht ging per 1-1-2026 op in Omgevingsdienst Utrecht (odu.nl)',
    'omgevingsdienst.nl': 'dit is de landelijke koepel Omgevingsdienst NL, geen uitvoerende dienst',
    'omgevingsdienstachterhoek.nl': 'heet nu odachterhoek.nl',
    'odh.nl': 'heet nu omgevingsdiensthaaglanden.nl',
    'rudzeeland.nl': 'het domein heeft een koppelteken: rud-zeeland.nl'
  };

  const fout = [];
  for (const [gemeente, url] of Object.entries(mapping)) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (opgeheven[host]) fout.push(`${gemeente} → ${host} (${opgeheven[host]})`);
  }

  assert.deepStrictEqual(fout, [], 'verouderde omgevingsdiensten in de mapping:\n  ' + fout.join('\n  '));
});

// ------------------------------------------------------------------
test('gemeenten staan bij de omgevingsdienst die hun beleid maakt', () => {
  // Een bronlink kan prima HTTP 200 geven en tóch de verkeerde organisatie zijn.
  // ODNZKG stond ooit op 31 gemeenten terwijl de dienst er 8 bedient; de rest
  // hoort bij OD Noord-Holland Noord en OD IJmond. Zulke fouten zijn met geen
  // enkele HTTP-controle te vinden, dus de deelnemerslijsten staan hier vast.
  const mapping = require('../gemeente_mapping.json');
  const hostVan = (g) => new URL(mapping[g]).hostname.replace(/^www\./, '');

  // Bron: de eigen deelnemerspagina's van de diensten.
  const deelnemers = {
    'odnzkg.nl': ['Aalsmeer', 'Amstelveen', 'Amsterdam', 'Diemen', 'Haarlemmermeer',
      'Ouder-Amstel', 'Uithoorn', 'Zaanstad'],
    'odnhn.nl': ['Alkmaar', 'Bergen (NH)', 'Castricum', 'Den Helder', 'Dijk en Waard',
      'Drechterland', 'Enkhuizen', 'Heiloo', 'Hollands Kroon', 'Hoorn', 'Koggenland',
      'Medemblik', 'Opmeer', 'Schagen', 'Stede Broec', 'Texel'],
    'odijmond.nl': ['Beverwijk', 'Bloemendaal', 'Edam-Volendam', 'Haarlem', 'Heemskerk',
      'Heemstede', 'Landsmeer', 'Oostzaan', 'Purmerend', 'Uitgeest', 'Velsen',
      'Waterland', 'Wormerland', 'Zandvoort'],
    'oddevallei.nl': ['Barneveld', 'Ede', 'Nijkerk', 'Scherpenzeel', 'Wageningen'],
    // ODMH bestaat nog; deze zes stonden bij Haaglanden, dat alleen de
    // Haaglanden-gemeenten bedient. Bron: de gezamenlijke beleidsregels en
    // BKK PFAS Midden-Holland (o.a. gmb-2022-446229).
    'odmh.nl': ['Alphen aan den Rijn', 'Bodegraven-Reeuwijk', 'Gouda', 'Krimpenerwaard',
      'Waddinxveen', 'Zuidplas'],
    // Bodembeheergebied volgens de Nota bodembeheer 2023-2033 (gmb-2024-31450).
    'odwh.nl': ['Hillegom', 'Kaag en Braassem', 'Katwijk', 'Leiden', 'Leiderdorp', 'Lisse',
      'Nieuwkoop', 'Noordwijk', 'Oegstgeest', 'Teylingen', 'Voorschoten', 'Zoeterwoude']
  };

  const fout = [];
  for (const [host, gemeenten] of Object.entries(deelnemers)) {
    for (const g of gemeenten) {
      if (!(g in mapping)) { fout.push(`${g} ontbreekt in de mapping`); continue; }
      if (hostVan(g) !== host) fout.push(`${g} → ${hostVan(g)}, hoort bij ${host}`);
    }
    // De dienst mag ook niet méér gemeenten toebedeeld krijgen dan hij bedient.
    const toegewezen = Object.keys(mapping).filter(g => hostVan(g) === host);
    const teveel = toegewezen.filter(g => !gemeenten.includes(g));
    for (const g of teveel) fout.push(`${g} → ${host}, maar die dienst bedient die gemeente niet`);
  }

  assert.deepStrictEqual(fout, [], 'gemeenten bij de verkeerde omgevingsdienst:\n  ' + fout.join('\n  '));
});

// ------------------------------------------------------------------
test('de SRU-bron wijst naar het endpoint dat KOOP nog bedient', () => {
  // zoek.officielebekendmakingen.nl/sru/Search geeft HTTP 500 op élke query,
  // ook de simpelste. Dat was hier niet aan te zien: een sweep zonder records
  // meldt "geen nieuwe bekendmakingen", precies zoals een rustige week. De
  // enige bron die als vastgesteld beleid geldt viel zo stil weg.
  const { SRU_BASE } = require('../checkBekendmakingen');
  assert.ok(!/zoek\.officielebekendmakingen\.nl\/sru/.test(SRU_BASE),
    'SRU_BASE staat op het uitgefaseerde endpoint dat op elke query 500 geeft');
  assert.ok(/^https:\/\//.test(SRU_BASE), 'SRU_BASE moet een https-endpoint zijn');

  // SRU levert XML en de bekendmakingen leveren HTML. Laat axios die antwoorden
  // ongemoeid: standaard probeert hij er JSON van te maken en dan is het geen
  // string meer, waarna elke .match() erop omvalt.
  const cb = fs.readFileSync(path.join(wortel, 'checkBekendmakingen.js'), 'utf8');
  const rauw = cb.match(/transformResponse: \[\(d\) => d\]/g) || [];
  assert.strictEqual(rauw.length, 2,
    'haalPagina en haalDocumentTekst moeten allebei het rauwe antwoord houden');

  // En allebei moeten ze zelf om XML/HTML vragen. Zonder Accept-header stuurt
  // axios `application/json` vooraan, doet de API aan contentonderhandeling en
  // komt er JSON terug waar geen enkele XML-regex op past — nul records, en dat
  // is niet te onderscheiden van "er is niets gepubliceerd".
  const accepts = cb.match(/'Accept': '[^']+'/g) || [];
  assert.strictEqual(accepts.length, 2,
    'haalPagina en haalDocumentTekst moeten allebei een expliciete Accept-header sturen');
  assert.ok(accepts.some(a => /xml/.test(a)), 'de SRU-aanroep vraagt niet om XML');
  assert.ok(!accepts.some(a => /^'Accept': 'application\/json/.test(a)),
    'geen van beide mag JSON vooraan zetten');

  // check-bronnen.js moet het endpoint uit de productiecode overnemen, anders
  // controleert het iets anders dan de sweep gebruikt.
  const bron = fs.readFileSync(path.join(wortel, 'check-bronnen.js'), 'utf8');
  assert.ok(/SRU_IN_GEBRUIK = SRU_BASE/.test(bron),
    'check-bronnen.js hardcodeert het SRU-endpoint in plaats van het over te nemen');
});

// ------------------------------------------------------------------
test('een SRU-record met namespaces en attributen wordt uitgelezen', () => {
  // Het echte antwoord van KOOP: <sru:recordData> mét namespace-attribuut, en
  // de vindplaats als <gzd:itemUrl manifestation="...">, niet als <url>. De
  // oude regex eiste `recordData>` zonder attributen en vond dus niets — de
  // sweep meldde dan "geen nieuwe bekendmakingen" terwijl numberOfRecords
  // gewoon een getal boven nul teruggaf.
  const cb = fs.readFileSync(path.join(wortel, 'checkBekendmakingen.js'), 'utf8');

  const recordRegex = cb.match(/const recordRegex = (\/.*\/g);/);
  assert.ok(recordRegex, 'recordRegex niet gevonden in checkBekendmakingen.js');

  const xml =
    '<sru:recordData xmlns:gzd="http://standaarden.overheid.nl/sru">' +
    '<gzd:gzd><gzd:originalData><dcterms:identifier>gmb-2024-1</dcterms:identifier>' +
    '<gzd:itemUrl manifestation="xml">https://x/a.xml</gzd:itemUrl>' +
    '<gzd:itemUrl manifestation="html">https://x/a.html</gzd:itemUrl>' +
    '</gzd:originalData></gzd:gzd></sru:recordData>';

  const re = new RegExp(recordRegex[1].slice(1, -2), 'g');
  const treffer = re.exec(xml);
  assert.ok(treffer, 'recordData met een namespace-attribuut wordt niet herkend');

  // En de HTML-versie moet gekozen worden: die kan haalDocumentTekst lezen.
  const urls = [...treffer[1].matchAll(/<(?:\w+:)?itemUrl[^>]*>([^<]+)<\//gi)].map(m => m[1]);
  assert.strictEqual(urls.find(u => /\.html?$/i.test(u)), 'https://x/a.html');
  assert.ok(/itemUrl/.test(cb), 'checkBekendmakingen.js leest itemUrl niet uit');
});

// ------------------------------------------------------------------
test('de linkcheck slaagt niet als hij niets heeft kunnen meten', () => {
  // Draait de check in een omgeving zonder uitgaand netwerk, dan is elke URL
  // "geblokkeerd", is het aantal kapotte links nul en eindigt hij groen — een
  // controle die niets meet die zichzelf goedkeurt. Precies de stille storing
  // die dit script hoort te vinden.
  const bron = fs.readFileSync(path.join(wortel, 'check-links.js'), 'utf8');
  assert.ok(/nietsGemeten/.test(bron), 'check-links.js kent geen nietsGemeten-controle');
  assert.ok(/process\.exit\([^)]*nietsGemeten/.test(bron),
    'nietsGemeten laat de check niet falen');
});

// ------------------------------------------------------------------
test('de kernbronnen worden op bruikbare inhoud gecontroleerd', () => {
  // check-links.js dekt de bronlinks per gemeente. De bronnen waar de data zelf
  // vandaan komt vielen buiten elke controle: die geven HTTP 200 terwijl ze nul
  // bruikbare records leveren.
  const bron = fs.readFileSync(path.join(wortel, 'check-bronnen.js'), 'utf8');

  for (const nodig of ['api.pdok.nl', 'locatieserver', 'sru/Search', 'gemeenten.geojson',
    '/api/v1/gemeenten', 'iplo.nl']) {
    assert.ok(bron.includes(nodig), `check-bronnen.js controleert ${nodig} niet`);
  }

  // Status 200 is niet genoeg: een lege SRU-respons en de HTML-fallback van de
  // hosting zijn allebei "geslaagd" als je alleen naar de statuscode kijkt.
  assert.ok(/numberOfRecords/.test(bron), 'de SRU-check kijkt niet naar het aantal records');
  assert.ok(/JSON\.parse/.test(bron), 'de geojson-check vangt de HTML-fallback niet af');

  // In --json modus is stdout het rapport. De productiecode die wordt
  // aangeroepen schrijft voortgang naar console.log; belandt dat in de JSON, dan
  // is het rapport onleesbaar en verdwijnt de uitkomst zonder foutmelding.
  assert.ok(/console\.log = /.test(bron),
    'check-bronnen.js leidt console.log niet om; voortgang van de productiecode vervuilt de JSON');
  assert.ok(/process\.stdout\.write\(JSON\.stringify/.test(bron),
    'het JSON-rapport moet rechtstreeks naar stdout, niet via de omgeleide console.log');
});

// ------------------------------------------------------------------
test('beoordeelAudit signaleert de stille storingen', () => {
  const { beoordeelAudit } = require('../audit');

  const gezond = beoordeelAudit({
    samenvatting: { ontbrekend: 0, verweesd: 0, dubbeleIds: 0, verdachteWaarden: 0,
      zwakkeBronlinks: 0, dekkingProcent: 100, sweepDagenGeleden: 2 },
    bronWaarschuwingen: []
  });
  assert.strictEqual(gezond.gezond, true, 'een volledige dataset moet gezond heten');

  // Dit zijn precies de storingen die niemand opmerkt tot er een verkeerde
  // norm wordt gebruikt.
  const ziek = beoordeelAudit({
    samenvatting: { ontbrekend: 3, verweesd: 1, dubbeleIds: 40, verdachteWaarden: 2,
      zwakkeBronlinks: 15, dekkingProcent: 99.1, sweepDagenGeleden: 40 },
    bronWaarschuwingen: []
  });
  assert.strictEqual(ziek.gezond, false);
  assert.strictEqual(ziek.problemen.length, 6, 'elke storing hoort apart gemeld te worden');

  // Een sweep die nog nooit draaide is geen "0 dagen geleden".
  const nooit = beoordeelAudit({
    samenvatting: { ontbrekend: 0, verweesd: 0, dubbeleIds: 0, verdachteWaarden: 0,
      zwakkeBronlinks: 0, dekkingProcent: 100, sweepDagenGeleden: null },
    bronWaarschuwingen: []
  });
  assert.strictEqual(nooit.gezond, false);
  assert.ok(/nooit/.test(nooit.problemen[0]));
});

// ------------------------------------------------------------------
// Minimale nep-Firestore: genoeg voor sweepBekendmakingen.
function nepDb(begin = {}) {
  const data = JSON.parse(JSON.stringify(begin));
  const col = (naam) => {
    data[naam] = data[naam] || {};
    const c = data[naam];
    const doc = (id) => ({
      id,
      async get() { return { id, exists: id in c, data: () => c[id] }; },
      async set(v, opt) { c[id] = opt && opt.merge ? { ...(c[id] || {}), ...v } : v; }
    });
    const get = async () => {
      const docs = Object.keys(c).map(id => ({ id, data: () => c[id] }));
      return { size: docs.length, forEach: (f) => docs.forEach(f) };
    };
    return { doc, get, select: () => ({ get }) };
  };
  return { collection: col, _data: data };
}

const pub = (n) => ({ identifier: `gmb-2026-${n}`, gemeente: 'Haarlem', url: `https://x/${n}.html` });
const sweepOpties = (records, verwerk, extra = {}) => ({
  _zoek: async () => ({ records, totaal: records.length }),
  _verwerk: verwerk,
  _herbouw: async () => ({ afwijkend: 0 }),
  ...extra
});

test('het watermerk schuift niet op als de sweep bij de limiet stopt', async () => {
  const { sweepBekendmakingen } = require('../checkBekendmakingen');
  const db = nepDb({ config: { bekendmakingenSweep: { laatsteGeslaagdeRun: '2026-01-01' } } });

  const r = await sweepBekendmakingen(db, {
    maxDocumenten: 1,
    ...sweepOpties([pub(1), pub(2), pub(3)], async () => 'verwerkt')
  });

  // Dit was de fout: het watermerk ging naar gisteren, en pub 2 en 3 kwamen
  // nooit meer aan de beurt omdat de volgende run pas daarna begon.
  assert.strictEqual(r.volledig, false);
  assert.strictEqual(r.gestopt, 'limiet');
  assert.strictEqual(db._data.config.bekendmakingenSweep.laatsteGeslaagdeRun, '2026-01-01');
});

test('de sweep stopt op tijd en draait dan nog steeds herbouw', async () => {
  const { sweepBekendmakingen } = require('../checkBekendmakingen');
  const db = nepDb({ config: { bekendmakingenSweep: { laatsteGeslaagdeRun: '2026-01-01' } } });
  let klok = 0;
  let herbouwd = false;

  const r = await sweepBekendmakingen(db, {
    tijdsbudgetMs: 1000,
    _nu: () => klok,
    ...sweepOpties([pub(1), pub(2), pub(3)], async () => { klok += 600; return 'overgeslagen'; }),
    _herbouw: async () => { herbouwd = true; return {}; }
  });

  assert.strictEqual(r.gestopt, 'tijd');
  assert.ok(herbouwd, 'herbouwAfwijkingen moet ook na een afgebroken run draaien');
  assert.strictEqual(db._data.config.bekendmakingenSweep.laatsteGeslaagdeRun, '2026-01-01');
});

test('een mislukte publicatie houdt het watermerk tegen tot ze is opgegeven', async () => {
  const { sweepBekendmakingen, MAX_POGINGEN } = require('../checkBekendmakingen');
  const db = nepDb({ config: { bekendmakingenSweep: { laatsteGeslaagdeRun: '2026-01-01' } } });
  const opties = sweepOpties([pub(1), pub(2)], async (_db, p) =>
    p.identifier.endsWith('-2') ? 'mislukt' : 'overgeslagen');

  for (let i = 0; i < MAX_POGINGEN; i++) {
    const r = await sweepBekendmakingen(db, opties);
    assert.strictEqual(r.volledig, false, `poging ${i + 1} mag het watermerk niet verzetten`);
    assert.strictEqual(db._data.config.bekendmakingenSweep.laatsteGeslaagdeRun, '2026-01-01');
  }

  // Na MAX_POGINGEN keer is het een verloren zaak, en die mag de rest niet
  // voor altijd tegenhouden.
  const r = await sweepBekendmakingen(db, opties);
  assert.strictEqual(r.opgegeven, 1);
  assert.strictEqual(r.volledig, true);
  assert.notStrictEqual(db._data.config.bekendmakingenSweep.laatsteGeslaagdeRun, '2026-01-01');
});

test('een volledige sweep verzet het watermerk naar gisteren', async () => {
  const { sweepBekendmakingen } = require('../checkBekendmakingen');
  const db = nepDb({ config: { bekendmakingenSweep: { laatsteGeslaagdeRun: '2026-01-01' } } });
  const nu = Date.parse('2026-09-28T03:00:00Z');

  const r = await sweepBekendmakingen(db, {
    _nu: () => nu,
    ...sweepOpties([pub(1)], async () => 'overgeslagen')
  });
  assert.strictEqual(r.volledig, true);
  assert.strictEqual(db._data.config.bekendmakingenSweep.laatsteGeslaagdeRun, '2026-09-27');
});

test('een handmatige sweep vanaf na het watermerk slaat het gat niet over', async () => {
  const { sweepBekendmakingen } = require('../checkBekendmakingen');
  const db = nepDb({ config: { bekendmakingenSweep: { laatsteGeslaagdeRun: '2026-01-01' } } });

  await sweepBekendmakingen(db, { vanaf: '2026-06-01', ...sweepOpties([pub(1)], async () => 'overgeslagen') });
  assert.strictEqual(db._data.config.bekendmakingenSweep.laatsteGeslaagdeRun, '2026-01-01');
});

test('herbouw zet de bronlink uit gemeente_mapping bij een aanname', () => {
  const { bronLinkUitMapping } = require('../checkBekendmakingen');
  const mapping = require('../gemeente_mapping.json');
  assert.strictEqual(bronLinkUitMapping('haarlem'), mapping.Haarlem);
  assert.strictEqual(bronLinkUitMapping('Bestaat Niet'), null);
  // Kaart, PDOK, mapping en Firestore spellen deze niet overal hetzelfde.
  // Welke spelling de mapping ook gebruikt: alle varianten moeten dezelfde,
  // bestaande link opleveren, en de twee Bergens mogen niet verwisselen.
  for (const [a, b] of [['Bergen (NH)', 'Bergen (NH.)'], ['Bergen (L)', 'Bergen (L.)'], ['Hengelo (O)', 'Hengelo']]) {
    assert.ok(bronLinkUitMapping(a), `geen bronlink voor ${a}`);
    assert.strictEqual(bronLinkUitMapping(a), bronLinkUitMapping(b), `${a} en ${b} geven een andere link`);
  }
  assert.notStrictEqual(bronLinkUitMapping('Bergen (NH)'), bronLinkUitMapping('Bergen (L)'));
});

test('een kale homepage in de curatie wint niet van de pagina uit de mapping', () => {
  // De curatie gaf zeven IJmond-gemeenten "https://www.odijmond.nl/" als bron;
  // de audit telde dat terecht als zwakke bronlink.
  const { leidGemeenteAf } = require('../checkBekendmakingen');
  const normen = require('../pfas_normen.json');
  const pagina = 'https://www.odijmond.nl/thema/bodem/pfas/';
  const curatie = { ...Object.values(normen.afwijkend)[0], bronLink: 'https://www.odijmond.nl/' };
  const uit = leidGemeenteAf({ docId: 'velsen', curatie, bronLinkStandaard: pagina, vandaag: '2026-09-28' });
  assert.strictEqual(uit.bronLink, pagina);

  const echt = leidGemeenteAf({ docId: 'velsen', curatie: { ...curatie, bronLink: 'https://example.org/besluit' },
    bronLinkStandaard: pagina, vandaag: '2026-09-28' });
  assert.strictEqual(echt.bronLink, 'https://example.org/besluit', 'een echte curatielink blijft voorgaan');

  for (const [g, c] of Object.entries(normen.afwijkend)) {
    if (!c || !c.bronLink) continue;
    assert.ok(!['', '/'].includes(new URL(c.bronLink).pathname), `${g} heeft alleen een homepage als bron`);
  }
});

test('beoordeelAudit meldt een watermerk dat achterblijft', () => {
  const { beoordeelAudit } = require('../audit');
  const basis = { ontbrekend: 0, verweesd: 0, dubbeleIds: 0, verdachteWaarden: 0,
    zwakkeBronlinks: 0, dekkingProcent: 100, sweepDagenGeleden: 2 };

  assert.strictEqual(beoordeelAudit({ samenvatting: { ...basis, watermerkDagenOud: 8 } }).gezond, true);
  const achter = beoordeelAudit({ samenvatting: { ...basis, watermerkDagenOud: 60 } });
  assert.strictEqual(achter.gezond, false);
  assert.ok(/achter/.test(achter.problemen[0]));
});

// ------------------------------------------------------------------
test('de CI-workflows draaien de tests en de linkcheck', () => {
  const repo = path.join(wortel, '..');
  const ci = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  const links = fs.readFileSync(path.join(repo, '.github/workflows/bronlinks.yml'), 'utf8');

  // De workflows moeten geldige YAML zijn. Een kapotte workflow draait niet en
  // meldt zichzelf niet — hij bestaat gewoon niet voor GitHub.
  for (const [naam, tekst] of [['ci.yml', ci], ['bronlinks.yml', links]]) {
    for (const regel of tekst.split('\n')) {
      const m = regel.match(/^\s+run: (?!\|)(.*)$/);
      assert.ok(!m || !m[1].includes(': '),
        `${naam}: inline \`run:\` met een dubbele punt breekt de YAML — gebruik \`run: |\``);
    }
  }

  // Een deploy van functions mag NOOIT `--only functions` zijn: dat verwijdert
  // functions die niet in deze repo staan, en er draaien er vijf van buiten.
  const deploy = fs.readFileSync(path.join(repo, '.github/workflows/deploy.yml'), 'utf8');
  assert.ok(!/--only[ =]"?functions"?[\s,]/.test(deploy),
    'deploy.yml gebruikt een kale --only functions; dat verwijdert onbekende functions');
  assert.ok(deploy.includes("'functions:' + n"), 'deploy.yml bouwt geen expliciete functielijst');
  assert.ok(deploy.includes('gemeenten.geojson'), 'deploy.yml haalt gemeenten.geojson niet op voor hosting');

  // require() parseert alleen .json als JSON. Op een .geojson valt Node om met
  // een SyntaxError, wat de eerste deploy liet stranden.
  for (const [naam, tekst] of [['deploy.yml', deploy], ['ci.yml', ci], ['bronlinks.yml', links]]) {
    assert.ok(!/require\([^)]*\.geojson/.test(tekst),
      `${naam}: require() op een .geojson werkt niet — gebruik readFileSync + JSON.parse`);
  }

  assert.ok(ci.includes('npm test'), 'CI draait de smoke tests niet');
  assert.ok(ci.includes('pfasApi_code'), 'CI wijst niet naar de functions-map');
  // De linkcheck moet periodiek draaien, niet alleen op verzoek.
  assert.ok(/schedule:/.test(links) && /cron:/.test(links), 'linkcheck heeft geen schema');
  assert.ok(links.includes('check-links.js'), 'linkcheck draait het script niet');
  // De kernbronnen falen stil; ze horen in dezelfde wekelijkse controle.
  assert.ok(links.includes('check-bronnen.js'), 'de kernbronnen worden niet gecontroleerd');
  assert.ok(/steps\.bronnen\.outcome == 'failure'/.test(links),
    'een uitgevallen kernbron laat de workflow niet falen');
});

// ------------------------------------------------------------------
test('er staan geen API-sleutels in de broncode', () => {
  const bestanden = fs.readdirSync(wortel).filter(f => f.endsWith('.js'));
  const verdacht = [];

  for (const f of bestanden) {
    const bron = fs.readFileSync(path.join(wortel, f), 'utf8');
    // Google API-sleutels beginnen met AIza gevolgd door 35 tekens
    if (/AIza[0-9A-Za-z_-]{35}/.test(bron)) verdacht.push(f);
  }

  assert.deepStrictEqual(verdacht, [], `Hardcoded API-sleutel gevonden in: ${verdacht.join(', ')}`);
});

// ------------------------------------------------------------------
test('het landelijk kader volgt het handelingskader PFAS (dec 2023)', () => {
  // IPLO: landbouw/natuur PFOS 1,4 · PFOA 1,9 · overige PFAS incl. GenX 1,4;
  // wonen/industrie 3 · 7 · 3. De 0,8 die hier stond is de waarde voor
  // toepassen in oppervlaktewater, niet voor de landbodem.
  const { landelijk_kader: lk, afwijkend } = require('../pfas_normen.json');
  assert.deepStrictEqual(
    { pfos: lk.pfos, pfoa: lk.pfoa, genx: lk.genx },
    {
      pfos: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 },
      pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
      genx: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 }
    }
  );

  // Een gecureerde afwijking die op GenX gelijk is aan het oude, foute kader
  // is vrijwel zeker een kopie daarvan en geen echte lokale waarde.
  for (const [naam, d] of Object.entries(afwijkend)) {
    assert.notStrictEqual(d.genx.landbouwNatuur, 0.8, `${naam}: GenX landbouw/natuur 0,8 is het oude kader`);
  }

  // Geen hardcoded kopie van het oude kader meer in de code.
  const bestanden = ['index.js', 'seed.js', 'clean.js', 'syncSheet.js', 'scraper.js',
    'checkBekendmakingen.js', 'adapters/odmh.js'];
  for (const f of bestanden) {
    const bron = fs.readFileSync(path.join(wortel, f), 'utf8');
    assert.ok(!/genx[^}]*landbouwNatuur"?\s*:\s*0\.8\b/i.test(bron), `${f} bevat nog GenX landbouw/natuur 0,8`);
    assert.ok(!/GenX[^\n]*Landbouw\/Natuur 0\.8/.test(bron), `${f} geeft de AI nog GenX 0,8 als kader`);
  }
});

// ------------------------------------------------------------------
test('een nota die alleen het landelijk kader herhaalt is geen afwijking', () => {
  const { herbeoordeelDocument } = require('../checkBekendmakingen');

  // Zo stond Leiden (gmb-2024-31450) in het corpus: "elke andere
  // PFAS-verbinding 1,40" werd als GenX-afwijking gelezen.
  const leiden = herbeoordeelDocument({
    titel: 'Nota bodembeheer en oplegnotitie 2023-2033',
    aiZekerheid: 'hoog',
    gevondenWaarden: {
      pfos: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 },
      pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
      genx: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 }
    }
  });
  assert.strictEqual(leiden.afwijkend, false);

  // Houten: 0,1 is de eis in drinkwatergebieden, niet de norm voor landbouw/natuur.
  const houten = herbeoordeelDocument({
    titel: 'Nota bodembeheer 2023, Beleidsnota PFAS en bijbehorende kaarten',
    aiZekerheid: 'hoog',
    gevondenWaarden: {
      pfos: { landbouwNatuur: 0.1 }, pfoa: { landbouwNatuur: 0.1 }, genx: { landbouwNatuur: 0.1 }
    }
  });
  assert.strictEqual(houten.afwijkend, false);

  // Een echte afwijking blijft een afwijking.
  const echt = herbeoordeelDocument({
    titel: 'Beleidsregel hergebruik PFOA', aiZekerheid: 'hoog',
    gevondenWaarden: { pfoa: { landbouwNatuur: 2.3 } }
  });
  assert.strictEqual(echt.afwijkend, true);
  assert.strictEqual(echt.zeker, true);
});

// ------------------------------------------------------------------
test('een ontwerpbesluit is nooit een vastgestelde afwijking', () => {
  const { herbeoordeelDocument, isOntwerp } = require('../checkBekendmakingen');
  assert.ok(isOntwerp('Ontwerp wijziging Omgevingsplan gemeente Almere Bodembeheer'));
  assert.ok(isOntwerp('Kennisgeving ontwerpbesluit nota bodembeheer'));
  assert.ok(!isOntwerp('Nota bodembeheer 2023-2033'));

  const almere = herbeoordeelDocument({
    titel: 'Ontwerp wijziging Omgevingsplan gemeente Almere Bodembeheer, Grondwaterkwaliteit',
    aiZekerheid: 'hoog',
    gevondenWaarden: { genx: { landbouwNatuur: 3 } }
  });
  assert.strictEqual(almere.zeker, false, 'ontwerp mag niet als vastgesteld tellen');
});

// ------------------------------------------------------------------
test('de herbouw laat gecureerde afwijkingen staan en ruimt restanten op', async () => {
  const { herbouwAfwijkingen } = require('../checkBekendmakingen');

  // Minimale nep-Firestore: genoeg voor get(), batch().set() en commit().
  const opslag = {
    pfasDocumenten: {
      'gmb-2024-31450': {
        gemeenteId: 'leiden', titel: 'Nota bodembeheer en oplegnotitie 2023-2033',
        identifier: 'gmb-2024-31450', publicatieDatum: '2024-01-18', aiZekerheid: 'hoog',
        heeftAfwijkendeWaarden: true, url: 'https://zoek.officielebekendmakingen.nl/gmb-2024-31450.html',
        gevondenWaarden: { genx: { landbouwNatuur: 1.4 } }
      },
      'gmb-2021-1': {
        gemeenteId: 'apeldoorn', titel: 'Nota bodembeheer', identifier: 'gmb-2021-1',
        publicatieDatum: '2021-01-01', aiZekerheid: 'hoog', heeftAfwijkendeWaarden: true,
        url: 'https://zoek.officielebekendmakingen.nl/gmb-2021-1.html',
        gevondenWaarden: { pfoa: { landbouwNatuur: 2.5 } }
      }
    },
    pfasData: {
      rotterdam: {
        gemeente: 'Rotterdam', herkomst: 'landelijk-kader-aanname',
        pfos: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 },
        pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
        genx: { wonen: 3, industrie: 3, landbouwNatuur: 0.8 }
      },
      leiden: {
        gemeente: 'Leiden', herkomst: 'officiele-bekendmaking', heeftAfwijkendBeleid: true,
        bronDocument: 'gmb-2024-31450', bronLink: 'https://zoek.officielebekendmakingen.nl/gmb-2024-31450.html',
        genx: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 }
      },
      apeldoorn: {
        gemeente: 'Apeldoorn', herkomst: 'landelijk-kader-aanname',
        // Restant van een eerdere, verkeerde afleiding: mag niet meeliften.
        pfos: { wonen: 3, industrie: 9, landbouwNatuur: 1.4 }
      },
      gouda: { gemeente: 'Gouda', handmatigeOverschrijving: true, pfos: { wonen: 1, industrie: 1, landbouwNatuur: 1 } }
    }
  };
  const ref = (col, id) => ({ col, id });
  const db = {
    collection: (col) => ({
      get: async () => {
        const docs = Object.entries(opslag[col] || {}).map(([id, data]) => ({ id, ref: ref(col, id), data: () => data }));
        return { size: docs.length, forEach: (f) => docs.forEach(f) };
      }
    }),
    batch: () => {
      const ops = [];
      return {
        set: (r, data) => ops.push([r, data]),
        commit: async () => { for (const [r, d] of ops) Object.assign(opslag[r.col][r.id], d); }
      };
    }
  };

  const uitkomst = await herbouwAfwijkingen(db);
  const { pfasData: p } = opslag;

  assert.strictEqual(p.rotterdam.herkomst, 'curatie');
  assert.strictEqual(p.rotterdam.heeftAfwijkendBeleid, true);
  assert.strictEqual(p.rotterdam.pfos.industrie, 7, 'Rotterdam PFOS industrie hoort 7,0 te zijn');
  assert.strictEqual(p.rotterdam.genx.landbouwNatuur, 1.4);

  assert.strictEqual(p.leiden.herkomst, 'landelijk-kader-aanname', 'Leiden herhaalt alleen het kader');
  assert.strictEqual(p.leiden.heeftAfwijkendBeleid, false);
  assert.strictEqual(p.leiden.bronDocument, null, 'oud bronDocument moet weg');
  assert.ok(!/officielebekendmakingen/.test(p.leiden.bronLink || ''), 'bronLink wijst nog naar het oude besluit');

  // Een AI-vondst levert nooit getallen, alleen een signaal.
  assert.strictEqual(p.apeldoorn.herkomst, 'mogelijk-afwijkend');
  assert.strictEqual(p.apeldoorn.heeftAfwijkendBeleid, false);
  assert.strictEqual(p.apeldoorn.pfoa.landbouwNatuur, 1.9, 'AI-getal kwam in het dashboard');
  assert.strictEqual(p.apeldoorn.pfos.industrie, 3, 'restant van een eerdere afleiding liftte mee');
  assert.strictEqual(p.apeldoorn.provincie, 'Gelderland');
  assert.strictEqual(p.rotterdam.provincie, 'Zuid-Holland');
  assert.strictEqual(p.rotterdam.bronDocument, 'gmb-2023-273075');

  assert.strictEqual(p.gouda.pfos.wonen, 1, 'handmatige overschrijving moet blijven');
  assert.strictEqual(uitkomst.curatie, 1);
});

// ------------------------------------------------------------------
test('de audit ziet getallen die niet bij hun herkomst passen', () => {
  const { controleerNormen, beoordeelAudit } = require('../audit');
  const lk = require('../pfas_normen.json').landelijk_kader;

  // Rotterdam zoals het live stond: kadergetallen, curatietekst.
  const rotterdam = controleerNormen('rotterdam', {
    herkomst: 'landelijk-kader-aanname', pfos: lk.pfos, pfoa: lk.pfoa, genx: lk.genx
  });
  assert.ok(rotterdam.length > 0);

  // Het oude kader (GenX 0,8) moet opvallen.
  const oud = controleerNormen('apeldoorn', {
    herkomst: 'landelijk-kader-aanname', pfos: lk.pfos, pfoa: lk.pfoa,
    genx: { wonen: 3, industrie: 3, landbouwNatuur: 0.8 }
  });
  assert.strictEqual(oud.length, 1);

  assert.deepStrictEqual(controleerNormen('apeldoorn', {
    herkomst: 'landelijk-kader-aanname', pfos: lk.pfos, pfoa: lk.pfoa, genx: lk.genx
  }), []);

  const oordeel = beoordeelAudit({ samenvatting: { ontbrekend: 0, verweesd: 0, dubbeleIds: 0,
    verdachteWaarden: 0, inconsistenteNormen: 3, zwakkeBronlinks: 0, sweepDagenGeleden: 1 } });
  assert.strictEqual(oordeel.gezond, false);
});

// ------------------------------------------------------------------
test('de sweep schuift het watermerk niet op over onverwerkte documenten', () => {
  const bron = fs.readFileSync(path.join(wortel, 'checkBekendmakingen.js'), 'utf8');
  const sweep = bron.slice(bron.indexOf('async function sweepBekendmakingen'));
  // Het gedrag zelf staat in de tests met de nep-Firestore hierboven (limiet,
  // tijdsbudget, mislukte publicaties). Dit bewaakt de vorm in de broncode.
  assert.ok(/volledig\s*=\s*!gestopt\s*&&\s*resultaat\.mislukt\s*===\s*0/.test(sweep));
  assert.ok(/if\s*\(\s*volledig\s*&&\s*dektWatermerk\s*\)\s*update\.laatsteGeslaagdeRun/.test(sweep),
    'watermerk wordt onvoorwaardelijk bijgewerkt');
});

// ------------------------------------------------------------------
test('alleen de herbouw schrijft normen naar pfasData', () => {
  // De nachtelijke check schreef AI-getallen direct weg, buiten curatie en
  // herbouw om, en zette zo terug wat de herbouw had rechtgezet.
  const bron = fs.readFileSync(path.join(wortel, 'checkBekendmakingen.js'), 'utf8');
  const check = bron.slice(bron.indexOf('async function checkOfficieleBekendmakingen'),
    bron.indexOf('const CONFIG_DOC'));
  assert.ok(!/collection\('pfasData'\)/.test(check), 'checkOfficieleBekendmakingen schrijft nog naar pfasData');

  const index = fs.readFileSync(path.join(wortel, 'index.js'), 'utf8');
  const nacht = index.slice(index.indexOf('exports.nightlyBekendmakingen'), index.indexOf('exports.checkBekendmakingenNow'));
  assert.ok(/sweepBekendmakingen\(/.test(nacht), 'de nachtelijke job loopt niet via de sweep');
});

// ------------------------------------------------------------------
test('de kaart koppelt namen die tussen bronnen verschillen', () => {
  const html = fs.readFileSync(path.join(wortel, '..', 'public', 'index.html'), 'utf8');
  // De functies uit de pagina halen en los draaien.
  const code = ['toId', 'sleutel', 'kaal'].map(n => {
    const m = html.match(new RegExp(`const ${n} = [^\\n]+`));
    assert.ok(m, `${n} niet gevonden in index.html`);
    return m[0];
  }).join('\n');
  const blok = (naam) => {
    const start = html.indexOf(`function ${naam}(`);
    let diepte = 0, i = html.indexOf('{', start);
    for (; i < html.length; i++) {
      if (html[i] === '{') diepte++;
      if (html[i] === '}' && --diepte === 0) break;
    }
    return html.slice(start, i + 1);
  };
  const maak = new Function('records', `let perId, aliasId;\n${code}\n${blok('vindId')}\n${blok('bouwAliassen')}
    perId = new Map(records.map(r => [r.id, r])); bouwAliassen(); return vindId;`);
  const vindId = maak([
    { id: 'bergen-(nh)', gemeente: 'Bergen (NH)' },
    { id: 'bergen-(l)', gemeente: 'Bergen (L)' },
    { id: 'hengelo-(o)', gemeente: 'Hengelo (O)' },
    { id: 'bergen-op-zoom', gemeente: 'Bergen op Zoom' }
  ]);
  assert.strictEqual(vindId('Bergen (NH.)'), 'bergen-(nh)');
  assert.strictEqual(vindId('Bergen (L.)'), 'bergen-(l)');
  assert.strictEqual(vindId('Hengelo'), 'hengelo-(o)');
  assert.strictEqual(vindId('Bergen op Zoom'), 'bergen-op-zoom');
  assert.ok(/'curatie':\s*\{/.test(html), 'de frontend kent de herkomst curatie niet');
});

// ------------------------------------------------------------------
test('elke afwijkende norm is nagelezen en verwijst naar het besluit', () => {
  const { afwijkend, mogelijkAfwijkend, landelijk_kader: lk } = require('../pfas_normen.json');
  const gebied = require('../gemeente_provincie.json');
  const fout = [];
  for (const [g, d] of Object.entries(afwijkend)) {
    if (!gebied[g]) fout.push(`${g}: geen gemeente volgens PDOK`);
    if (!d.bronDocument) fout.push(`${g}: geen bronDocument`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.geverifieerdOp || '')) fout.push(`${g}: geen geverifieerdOp`);
    if (!d.opmerkingen) fout.push(`${g}: geen toelichting`);
    const leeg = [];
    let wijktAf = false;
    for (const stof of ['pfos', 'pfoa', 'genx']) {
      for (const klasse of ['wonen', 'industrie', 'landbouwNatuur']) {
        const v = d[stof]?.[klasse];
        if (v === null) leeg.push(`${stof}.${klasse}`);
        else if (typeof v !== 'number') fout.push(`${g}: ${stof}.${klasse} ontbreekt`);
        else if (v !== lk[stof][klasse]) wijktAf = true;
      }
    }
    // Een lege waarde mag alleen als er uitgelegd is dat hij per zone verschilt.
    const perZone = d.perZone || [];
    if (leeg.sort().join() !== [...perZone].sort().join()) fout.push(`${g}: lege waarden ${leeg} ≠ perZone ${perZone}`);
    if (!wijktAf && !perZone.length) fout.push(`${g}: staat als afwijkend maar is gelijk aan het kader`);
  }
  for (const g of Object.keys(mogelijkAfwijkend)) {
    if (!gebied[g]) fout.push(`${g}: geen gemeente volgens PDOK`);
    if (afwijkend[g]) fout.push(`${g}: zowel afwijkend als mogelijk-afwijkend`);
  }
  assert.deepStrictEqual(fout, []);
});

// ------------------------------------------------------------------
test('de nagelezen getallen staan zoals in de besluiten', () => {
  // Vastgezet zodat een "opschoonactie" ze niet ongemerkt terugzet. Bron per
  // regel; wie hier iets wijzigt, leest eerst het besluit opnieuw.
  const { afwijkend: a } = require('../pfas_normen.json');
  const verwacht = [
    // Omgevingsplan Gorinchem tabel 21.15.1 / Sliedrecht tabel 11.16.1: 0,0024 en 0,0023 mg/kg
    ['Dordrecht', 'pfos', 'landbouwNatuur', 2.4], ['Dordrecht', 'pfoa', 'landbouwNatuur', 2.3],
    ['Gorinchem', 'pfos', 'landbouwNatuur', 2.4], ['Sliedrecht', 'pfoa', 'landbouwNatuur', 2.3],
    // Nota bodembeheer Rotterdam 2023 (gmb-2023-273075), tabel 4/5 en §3.1.3
    ['Rotterdam', 'pfos', 'landbouwNatuur', 1.6], ['Rotterdam', 'pfos', 'industrie', 7],
    ['Rotterdam', 'pfoa', 'landbouwNatuur', 1.9],
    // Bodemkwaliteitskaart 2024 Nieuwegein
    ['Nieuwegein', 'pfoa', 'landbouwNatuur', 3.8],
    // Nota bodembeheer Rivierenland: 2,8** voor grond binnen de regio
    ['Maasdriel', 'pfoa', 'landbouwNatuur', 2.8], ['Tiel', 'pfoa', 'landbouwNatuur', 2.8],
    // Beleidsnota PFAS Utrecht, tabel 8 (Soest) / 17 (ODRU): zone B3 en B2
    ['Houten', 'pfoa', 'landbouwNatuur', 2.9], ['Houten', 'pfos', 'landbouwNatuur', 1.8],
    ['IJsselstein', 'pfoa', 'landbouwNatuur', 5.2],
    // Nota bodembeheer OD IJmond, tabel 7
    ['Velsen', 'pfos', 'landbouwNatuur', 2.6], ['Velsen', 'pfoa', 'landbouwNatuur', 1.9],
    // Aanvulling Nota bodembeheer Utrecht 2020 (exb-2020-52621), tabel 1
    ['Utrecht', 'pfos', 'landbouwNatuur', 2.19], ['Utrecht', 'pfoa', 'landbouwNatuur', 4.35],
    // Nota bodembeheer regio Achterhoek §2.5.11: toepassingseis Wonen = landelijke achtergrondwaarden
    ['Winterswijk', 'pfoa', 'wonen', 1.9], ['Winterswijk', 'pfos', 'wonen', 1.4],
    // Nota bodembeheer Tholen 2022 art. 5 / Reimerswaal 2023 art. 10
    ['Tholen', 'pfos', 'landbouwNatuur', 1.5], ['Reimerswaal', 'pfos', 'landbouwNatuur', 3],
    // Nota Bodembeheer 2021 Toepassen van grond Nijmegen, tabel 5
    ['Nijmegen', 'pfoa', 'wonen', 1.9], ['Nijmegen', 'pfos', 'industrie', 1.4]
  ];
  for (const [g, stof, klasse, w] of verwacht) {
    assert.strictEqual(a[g]?.[stof]?.[klasse], w, `${g} ${stof} ${klasse}`);
  }
  // De Hoeksche Waard ligt in zone A en volgt het landelijk kader.
  assert.ok(!a['Hoeksche Waard']);
});

// ------------------------------------------------------------------
test('elke gemeente krijgt een provincie en een omgevingsdienst', () => {
  const { omgevingsdienstVan, leidGemeenteAf } = require('../checkBekendmakingen');
  const { toDocId } = require('../docId');
  const mapping = require('../gemeente_mapping.json');
  const gebied = require('../gemeente_provincie.json');
  assert.strictEqual(Object.keys(gebied).length, 342);
  assert.deepStrictEqual(Object.keys(mapping).sort(), Object.keys(gebied).sort(),
    'gemeente_mapping.json gebruikt andere namen dan PDOK');
  const zonder = Object.entries(mapping).filter(([, u]) => !omgevingsdienstVan(u)).map(([g]) => g);
  assert.deepStrictEqual(zonder, [], 'geen omgevingsdienst af te leiden');
  const r = leidGemeenteAf({ docId: toDocId('Aa en Hunze'), bronLinkStandaard: mapping['Aa en Hunze'], vandaag: '2026-01-01' });
  assert.strictEqual(r.provincie, 'Drenthe');
  assert.strictEqual(r.omgevingsdienst, 'Omgevingsdienst Drenthe');
  assert.strictEqual(r.herkomst, 'landelijk-kader-aanname');
});

// ------------------------------------------------------------------
(async () => {
  let geslaagd = 0;
  let gefaald = 0;

  for (const { naam, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${naam}`);
      geslaagd++;
    } catch (err) {
      console.log(`  ❌ ${naam}`);
      console.log(`     ${err.message}`);
      gefaald++;
    }
  }

  console.log(`\n${geslaagd} geslaagd, ${gefaald} gefaald`);
  process.exit(gefaald > 0 ? 1 : 0);
})();
