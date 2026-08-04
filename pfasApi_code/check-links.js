/**
 * Controleert of de bronlinks in gemeente_mapping.json daadwerkelijk bestaan.
 *
 * Aanleiding: de links waren deels gegokt — 152 van de 349 deelden exact het
 * pad `/themas/bodem` en 103 waren alleen een homepage. Een link die 404 geeft
 * is voor iemand die grond wil afvoeren erger dan geen link.
 *
 * Drie uitkomsten, want ze vragen om verschillende actie:
 *   OK          2xx/3xx — pagina bestaat.
 *   KAPOT       404/410 of DNS/verbindingsfout — pagina is weg, moet vervangen.
 *   GEBLOKKEERD 403/405/429 — de site weert geautomatiseerd verkeer. Zegt niets
 *               over of de pagina bestaat, dus dit laat de check NIET falen.
 *
 * Alleen KAPOT geeft exitcode 1. Anders zou elke gemeente met een bot-filter
 * de controle rood maken en werd hij binnen een maand genegeerd.
 *
 * Gebruik:
 *   node check-links.js              # alles
 *   node check-links.js --kapot      # alleen wat actie vraagt
 *   node check-links.js --json > rapport.json
 */

const axios = require('axios');
const mapping = require('./gemeente_mapping.json');

const alleenKapot = process.argv.includes('--kapot');
const alsJson = process.argv.includes('--json');
const GELIJKTIJDIG = 6;

// Sommige overheidssites weigeren onbekende clients. Een normale browser-UA
// haalt de meeste van die filters weg zonder iets te omzeilen wat afgeschermd is.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0 Safari/537.36 PFASDashboard-linkcheck';

const GEBLOKKEERD = new Set([401, 403, 405, 406, 429, 503]);

async function checkUrl(url) {
  let laatste = null;
  for (const methode of ['head', 'get']) {
    try {
      const r = await axios({
        method: methode,
        url,
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*',
          'Accept-Language': 'nl,en;q=0.8'
        }
      });
      laatste = { status: r.status, eindUrl: r.request?.res?.responseUrl || url };
      // HEAD wordt vaak geweigerd terwijl GET prima werkt; dan doorgaan.
      if (methode === 'head' && (r.status >= 400)) continue;
      return laatste;
    } catch (err) {
      laatste = { status: 0, fout: err.code || err.message };
    }
  }
  return laatste || { status: 0, fout: 'onbekend' };
}

function oordeel(r) {
  if (r.status >= 200 && r.status < 400) return 'ok';
  if (GEBLOKKEERD.has(r.status)) return 'geblokkeerd';
  return 'kapot';
}

async function main() {
  // Eén check per unieke URL — veel gemeenten delen dezelfde omgevingsdienst.
  const perUrl = new Map();
  for (const [gemeente, url] of Object.entries(mapping)) {
    if (!perUrl.has(url)) perUrl.set(url, []);
    perUrl.get(url).push(gemeente);
  }

  const urls = [...perUrl.keys()];
  console.error(`${urls.length} unieke URL's voor ${Object.keys(mapping).length} gemeenten. Controleren...\n`);

  const resultaten = [];
  for (let i = 0; i < urls.length; i += GELIJKTIJDIG) {
    const groep = urls.slice(i, i + GELIJKTIJDIG);
    const uit = await Promise.all(groep.map(async url => {
      const r = await checkUrl(url);
      return { url, gemeenten: perUrl.get(url), oordeel: oordeel(r), ...r };
    }));

    for (const u of uit) {
      resultaten.push(u);
      if (alleenKapot && u.oordeel === 'ok') continue;
      const teken = u.oordeel === 'ok' ? '✅' : u.oordeel === 'geblokkeerd' ? '🚧' : '❌';
      // Altijd naar stderr, ook in --json modus: anders is een rode build
      // in de CI-logs niet te lezen zonder het artifact te downloaden.
      console.error(`${teken} ${String(u.status || u.fout).padEnd(7)} ${u.url}  (${u.gemeenten.length} gemeenten)`);
    }
  }

  const kapot = resultaten.filter(r => r.oordeel === 'kapot');
  const geblokkeerd = resultaten.filter(r => r.oordeel === 'geblokkeerd');
  const gemeentenKapot = kapot.reduce((n, r) => n + r.gemeenten.length, 0);

  console.error(`\n${'='.repeat(64)}`);
  console.error(`Gecontroleerd:              ${resultaten.length} unieke URL's`);
  console.error(`OK:                         ${resultaten.length - kapot.length - geblokkeerd.length}`);
  console.error(`Geblokkeerd (bot-filter):   ${geblokkeerd.length}  — niet fout, wel onverifieerbaar`);
  console.error(`Kapot:                      ${kapot.length}`);
  console.error(`Gemeenten met kapotte link: ${gemeentenKapot}`);
  console.error(`${'='.repeat(64)}`);

  if (kapot.length) {
    console.error('\nDeze moeten vervangen worden:');
    for (const k of kapot) {
      console.error(`  ${k.status || k.fout}  ${k.url}`);
      console.error(`      ${k.gemeenten.join(', ')}`);
    }
  }

  if (alsJson) {
    console.log(JSON.stringify({
      gecontroleerd: resultaten.length,
      kapot: kapot.length,
      geblokkeerd: geblokkeerd.length,
      gemeentenMetKapotteLink: gemeentenKapot,
      resultaten
    }, null, 2));
  }

  process.exit(kapot.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fout:', err.message);
  process.exit(2);
});
