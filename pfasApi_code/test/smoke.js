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
