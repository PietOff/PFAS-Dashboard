/**
 * Gebruikt het live dashboard in een echte browser, zoals een bezoeker dat doet.
 *
 * check-bronnen.js controleert of de API en de kaartdata goed binnenkomen. Dat
 * zegt nog niet dat de pagina werkt: een JavaScript-fout, een gemeentenaam die
 * op de kaart anders gespeld is dan in de API, of een adreszoeker die stilletjes
 * niets vindt, zie je alleen als je de pagina echt gebruikt. Dat doet dit script.
 *
 * Elke stap geeft { naam, ok, detail }. Faalt er één, dan is de exitcode 1.
 *
 * Gebruik:
 *   node check-app.js
 *   node check-app.js --json > app.json
 *   SITE=http://localhost:5000 node check-app.js     # tegen een lokale server
 *   CHROME=/pad/naar/chrome node check-app.js       # eigen browser
 */

const fs = require('fs');
const { chromium } = require('playwright-core');

const SITE = (process.env.SITE || 'https://pfas-dashboard-nl-a808d.web.app').replace(/\/$/, '');
const alsJson = process.argv.includes('--json');
const MIN_GEMEENTEN = parseInt(process.env.MIN_GEMEENTEN || '300', 10);

// Een voorbeeldgemeente die zeker bestaat, en de voorbeeldpostcode uit het
// invoerveld van de pagina zelf (1012 AB, de Dam in Amsterdam).
const GEMEENTE = process.env.GEMEENTE || 'Haarlem';
const POSTCODE = process.env.POSTCODE || '1012 AB';

// playwright-core brengt geen browser mee. GitHub-runners hebben Chrome; lokaal
// kan het pad via CHROME.
function vindBrowser() {
  const kandidaten = [
    process.env.CHROME,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/pw-browsers/chromium'
  ].filter(Boolean);
  for (const k of kandidaten) {
    try {
      const st = fs.statSync(k);
      if (st.isFile()) return k;
      if (st.isDirectory()) {
        // /opt/pw-browsers/chromium is een map met de echte binary erin.
        const bin = ['chrome-linux/chrome', 'chrome-linux64/chrome'].map(p => `${k}/${p}`).find(p => fs.existsSync(p));
        if (bin) return bin;
      }
    } catch { /* volgende */ }
  }
  return null;
}

async function main() {
  const uitkomsten = [];
  const log = (u) => {
    uitkomsten.push(u);
    console.error(`${u.ok ? '✅' : '❌'} ${u.naam.padEnd(40)} ${u.detail}`);
  };

  const pad = vindBrowser();
  if (!pad) {
    log({ naam: 'Browser starten', ok: false, detail: 'geen Chrome of Chromium gevonden; zet CHROME=/pad' });
    return rapporteer(uitkomsten);
  }

  const browser = await chromium.launch({ executablePath: pad, headless: true });
  const page = await browser.newPage({ locale: 'nl-NL', viewport: { width: 1280, height: 900 } });

  // Alles wat in de console van een bezoeker rood zou kleuren.
  const jsFouten = [];
  page.on('pageerror', e => jsFouten.push(e.message));
  page.on('console', m => {
    // "Failed to load resource" is een mislukt verzoek, geen scriptfout; dat
    // meldt de stap "Geen mislukte verzoeken" al, met de URL erbij.
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) jsFouten.push(m.text());
  });
  const mislukt = [];
  page.on('requestfailed', r => mislukt.push(`${r.url()} (${r.failure() && r.failure().errorText})`));
  page.on('response', r => {
    // Een ontbrekend favicon ziet een bezoeker niet; daar hoeft niets rood van te worden.
    if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) mislukt.push(`${r.url()} (HTTP ${r.status()})`);
  });

  const stap = async (naam, fn) => {
    try {
      const detail = await fn();
      log({ naam, ok: true, detail });
    } catch (e) {
      log({ naam, ok: false, detail: e.message.split('\n')[0] });
    }
  };

  await stap('Pagina laadt', async () => {
    const r = await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!r || r.status() >= 400) throw new Error(`HTTP ${r ? r.status() : 'geen antwoord'}`);
    return `HTTP ${r.status()}`;
  });

  await stap('Kaart wordt getekend', async () => {
    // Laadt de kaart niet, dan zet de pagina zelf een foutmelding in map-status.
    await page.waitForFunction(() => {
      const s = document.getElementById('map-status');
      return !document.getElementById('map-wrap').classList.contains('hidden') ||
        (s && s.classList.contains('err'));
    }, null, { timeout: 60000 });
    const fout = await page.$eval('#map-status', s => s.classList.contains('err') ? s.textContent : null);
    if (fout) throw new Error(fout.trim());
    const n = await page.$$eval('#map path[data-id]', p => p.length);
    if (n < MIN_GEMEENTEN) throw new Error(`maar ${n} gemeenten op de kaart`);
    return `${n} gemeenten op de kaart`;
  });

  await stap('Tabel toont alle gemeenten', async () => {
    const t = (await page.textContent('#tabel-telling')) || '';
    const m = t.match(/van de (\d+) gemeenten/);
    if (!m) throw new Error(`onverwachte telling: "${t.trim()}"`);
    const n = parseInt(m[1], 10);
    if (n < MIN_GEMEENTEN) throw new Error(`maar ${n} gemeenten in de tabel`);
    const rijen = await page.$$eval('#tabel tbody tr', r => r.length);
    return `${n} gemeenten, ${rijen} rijen`;
  });

  // De kaart haalt namen uit de geojson, de normen komen uit de API. Spelt één
  // van beide een gemeente anders ("Súdwest-Fryslân", "'s-Hertogenbosch"), dan
  // staat die gemeente grijs op de kaart met "Nog geen data" — zonder foutmelding.
  await stap('Kaart en normen sluiten op elkaar aan', async () => {
    const { zonder, totaal } = await page.evaluate(async () => {
      const toId = (n) => n == null ? null : String(n).toLowerCase().trim().replace(/\s+/g, '-') || null;
      const api = await (await fetch('/api/v1/gemeenten')).json();
      const ids = new Set(api.map(r => r.id || toId(r.gemeente)));
      const paden = [...document.querySelectorAll('#map path[data-id]')];
      // Bij elke gemeente zonder match: welk API-record lijkt erop? Dan is in
      // één run te zien of het aan de kaartnaam of aan het document-id ligt.
      const eerste = (x) => String(x || '').toLowerCase().split(/[\s(-]/)[0];
      return {
        totaal: paden.length,
        zonder: paden.filter(p => !ids.has(p.dataset.id)).map(p => {
          const lijkt = api.filter(r => eerste(r.gemeente) === eerste(p.dataset.naam) || eerste(r.id) === eerste(p.dataset.naam))
            .map(r => `id "${r.id}" / naam "${r.gemeente}"`);
          return `${p.dataset.naam} (kaart-id "${p.dataset.id}"; API: ${lijkt.length ? lijkt.join(', ') : 'niets vergelijkbaars'})`;
        })
      };
    });
    if (zonder.length) {
      throw new Error(`${zonder.length} van ${totaal} gemeenten op de kaart zonder normen: ` +
        zonder.slice(0, 12).join('; ') + (zonder.length > 12 ? '; …' : ''));
    }
    return `alle ${totaal} gemeenten op de kaart hebben normen`;
  });

  await stap(`Zoeken op gemeente (${GEMEENTE})`, async () => {
    await page.fill('#zoek', GEMEENTE);
    await page.waitForFunction((g) =>
      (document.getElementById('detail-titel').textContent || '').includes(g), GEMEENTE, { timeout: 10000 });
    const cellen = await page.$$eval('#detail-body td.num', t => t.map(x => x.textContent.trim()));
    const getallen = cellen.filter(c => c !== '—').length;
    if (!getallen) throw new Error('detail toont geen enkele norm');
    const bron = await page.$('#detail-body a[href]');
    return `${getallen} normen getoond` + (bron ? ', met bronlink' : ', zonder bronlink');
  });

  await stap('Bronlink in het detail werkt', async () => {
    const href = await page.$eval('#detail-body a[href]', a => a.href).catch(() => null);
    if (!href) throw new Error('geen bronlink bij ' + GEMEENTE);
    const r = await page.request.get(href, { timeout: 30000, failOnStatusCode: false, maxRedirects: 5 });
    // 403/429: bot-filter; dat zegt niets over de pagina (zie check-links.js).
    if (r.status() >= 400 && ![401, 403, 405, 406, 429].includes(r.status())) {
      throw new Error(`${href} gaf HTTP ${r.status()}`);
    }
    return `${href} (HTTP ${r.status()})`;
  });

  await stap('Grondverzet-vergelijking', async () => {
    const opties = await page.$$eval('#bron option', o => o.map(x => x.value).filter(Boolean));
    if (opties.length < MIN_GEMEENTEN) throw new Error(`maar ${opties.length} gemeenten in de keuzelijst`);
    await page.selectOption('#bron', opties[0]);
    await page.selectOption('#best', opties[1]);
    await page.waitForFunction(() => (document.getElementById('verdict').textContent || '').trim().length > 0,
      null, { timeout: 5000 });
    const oordeel = (await page.textContent('#verdict strong')) || '';
    return `${opties[0]} → ${opties[1]}: "${oordeel.trim()}"`;
  });

  await stap(`Zoeken op postcode (${POSTCODE})`, async () => {
    await page.fill('#adres', POSTCODE);
    await page.click('#adres-knop');
    await page.waitForFunction(() => {
      const t = document.getElementById('adres-uitslag').textContent || '';
      return t && t !== 'Zoeken…';
    }, null, { timeout: 20000 });
    const t = ((await page.textContent('#adres-uitslag')) || '').trim();
    if (!/ligt in gemeente/.test(t)) throw new Error(t);
    if (/nog geen normen/.test(t)) throw new Error(t);
    return t;
  });

  await stap('Deelbare link (?gemeente=)', async () => {
    const id = GEMEENTE.toLowerCase().replace(/\s+/g, '-');
    await page.goto(`${SITE}/?gemeente=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction((g) =>
      (document.getElementById('detail-titel').textContent || '').includes(g), GEMEENTE, { timeout: 60000 });
    return `opent op ${GEMEENTE}`;
  });

  await stap('Geen JavaScript-fouten', async () => {
    const uniek = [...new Set(jsFouten)];
    if (uniek.length) throw new Error(uniek.slice(0, 5).join(' | '));
    return 'geen';
  });

  await stap('Geen mislukte verzoeken', async () => {
    // De bronlink-controle hierboven gaat buiten de pagina om; die telt hier niet.
    const uniek = [...new Set(mislukt)];
    if (uniek.length) throw new Error(uniek.slice(0, 5).join(' | '));
    return 'geen';
  });

  await browser.close();
  return rapporteer(uitkomsten);
}

function rapporteer(uitkomsten) {
  const fout = uitkomsten.filter(u => !u.ok);
  console.error(`\n${'='.repeat(64)}`);
  console.error(`Stappen:  ${uitkomsten.length}`);
  console.error(`In orde:  ${uitkomsten.length - fout.length}`);
  console.error(`Probleem: ${fout.length}`);
  console.error('='.repeat(64));
  if (alsJson) {
    // Rechtstreeks naar stdout: console.log staat niet omgeleid, maar zo is het
    // net zo duidelijk als in check-bronnen.js.
    process.stdout.write(JSON.stringify({ site: SITE, uitkomsten }, null, 2) + '\n');
  }
  process.exit(fout.length ? 1 : 0);
}

main().catch(err => {
  console.error('Fout:', err.message);
  process.exit(2);
});
