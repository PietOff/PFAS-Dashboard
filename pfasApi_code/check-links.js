/**
 * Controleert of de bronlinks in gemeente_mapping.json daadwerkelijk bestaan.
 *
 * Aanleiding: 152 van de 349 links delen exact het pad `/themas/bodem` en 103
 * zijn alleen een homepage. Dat patroon komt niet uit een vondst maar uit een
 * gok — de prompt in findRealLinks droeg de AI letterlijk op om bij twijfel de
 * homepage van de meest waarschijnlijke omgevingsdienst te geven. Een link die
 * 404 geeft is voor een gebruiker erger dan geen link.
 *
 * Gebruik:
 *   node check-links.js              # alle links
 *   node check-links.js --kapot      # alleen de kapotte tonen
 *   node check-links.js --json > rapport.json
 */

const axios = require('axios');
const mapping = require('./gemeente_mapping.json');

const alleenKapot = process.argv.includes('--kapot');
const alsJson = process.argv.includes('--json');
const GELIJKTIJDIG = 8;

async function checkUrl(url) {
  // Eerst HEAD (goedkoop); veel overheidssites weigeren HEAD, dan GET.
  for (const methode of ['head', 'get']) {
    try {
      const r = await axios({
        method: methode,
        url,
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { 'User-Agent': 'PFASDashboard/1.0 (linkcheck; overheid-monitoring)' }
      });
      if (methode === 'head' && (r.status === 405 || r.status === 403)) continue;
      return { status: r.status, eindUrl: r.request?.res?.responseUrl || url };
    } catch (err) {
      if (methode === 'get') return { status: 0, fout: err.code || err.message };
    }
  }
  return { status: 0, fout: 'onbekend' };
}

async function main() {
  // Eén check per unieke URL — veel gemeenten delen dezelfde omgevingsdienst.
  const perUrl = new Map();
  for (const [gemeente, url] of Object.entries(mapping)) {
    if (!perUrl.has(url)) perUrl.set(url, []);
    perUrl.get(url).push(gemeente);
  }

  const urls = [...perUrl.keys()];
  if (!alsJson) {
    console.error(`${urls.length} unieke URL's voor ${Object.keys(mapping).length} gemeenten. Controleren...\n`);
  }

  const resultaten = [];
  for (let i = 0; i < urls.length; i += GELIJKTIJDIG) {
    const groep = urls.slice(i, i + GELIJKTIJDIG);
    const uitkomsten = await Promise.all(groep.map(async url => {
      const r = await checkUrl(url);
      return { url, gemeenten: perUrl.get(url), ...r };
    }));

    for (const u of uitkomsten) {
      resultaten.push(u);
      const ok = u.status >= 200 && u.status < 400;
      if (!alsJson && (!ok || !alleenKapot)) {
        const teken = ok ? '✅' : '❌';
        const detail = u.status || u.fout;
        console.log(`${teken} ${String(detail).padEnd(6)} ${u.url}  (${u.gemeenten.length} gemeenten)`);
      }
    }
  }

  const kapot = resultaten.filter(r => !(r.status >= 200 && r.status < 400));
  const geraaktGemeenten = kapot.reduce((n, r) => n + r.gemeenten.length, 0);

  if (alsJson) {
    console.log(JSON.stringify({
      gecontroleerd: resultaten.length,
      kapot: kapot.length,
      gemeentenMetKapotteLink: geraaktGemeenten,
      resultaten
    }, null, 2));
  } else {
    console.error(`\n${'='.repeat(60)}`);
    console.error(`Gecontroleerd:              ${resultaten.length} unieke URL's`);
    console.error(`Kapot:                      ${kapot.length}`);
    console.error(`Gemeenten met kapotte link: ${geraaktGemeenten}`);
    console.error(`${'='.repeat(60)}`);
  }

  process.exit(kapot.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fout:', err.message);
  process.exit(1);
});
