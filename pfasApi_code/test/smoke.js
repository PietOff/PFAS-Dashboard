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
    'mergeDuplicateDocs'
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
