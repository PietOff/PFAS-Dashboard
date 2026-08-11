/**
 * Controleert de kernbronnen waar het dashboard op draait.
 *
 * `check-links.js` controleert de bronlinks per gemeente — de pagina's waar een
 * gebruiker naartoe geklikt wordt. Dit script controleert de bronnen waar de
 * data zelf vandaan komt. Die twee zijn niet hetzelfde, en tot nu toe werd
 * alleen de eerste groep bewaakt.
 *
 * Waarom dit nodig is: elk van deze bronnen faalt stil. PDOK kan van pad
 * veranderen, waarna `gemeentelijst.js` ongemerkt terugvalt op de geojson en
 * de dekkingscontrole een verouderde lijst gaat vergelijken. De SRU-API
 * antwoordt met HTTP 200 en nul records als de query niet meer klopt — precies
 * hoe "er is deze week niets gepubliceerd" eruitziet. Geen van beide levert een
 * foutmelding op waar iemand op wacht.
 *
 * Daarom controleert dit script niet op status 200 maar op bruikbare inhoud:
 * levert PDOK een plausibel aantal gemeenten, geeft de SRU-query echt records
 * terug, staat er in de geojson wat erin hoort te staan.
 *
 * Gebruik:
 *   node check-bronnen.js
 *   node check-bronnen.js --json > bronnen.json
 */

const axios = require('axios');
const { bouwCqlQuery } = require('./checkBekendmakingen');
const { MIN_GEMEENTEN, MAX_GEMEENTEN } = require('./gemeentelijst');

const alsJson = process.argv.includes('--json');

const SITE = 'https://pfas-dashboard-nl-a808d.web.app';
const UA = 'PFASDashboard/1.0 (bronbewaking)';

async function haal(url, { type = 'json', timeout = 30000 } = {}) {
  return axios.get(url, {
    timeout,
    responseType: type === 'json' ? 'json' : 'text',
    // De SRU-API en de geojson leveren tekst; forceer geen JSON-parse daarop.
    transformResponse: type === 'json' ? undefined : [(d) => d],
    headers: { 'User-Agent': UA, 'Accept': type === 'json' ? 'application/json' : '*/*' },
    validateStatus: () => true
  });
}

/**
 * Elke controle geeft { ok, detail } terug. `ok: false` laat het script falen;
 * een controle die zichzelf niet kan uitvoeren geeft dat expliciet aan in
 * `detail` in plaats van stilletjes te slagen.
 */
const CONTROLES = [
  {
    naam: 'PDOK Bestuurlijke Gebieden (gemeentelijst)',
    waarom: 'primaire bron voor de canonieke gemeentelijst',
    async run() {
      const url = 'https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/' +
        'gemeentegebied/items?f=json&limit=500';
      const r = await haal(url);
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };

      const namen = (r.data.features || [])
        .map(f => f.properties && (f.properties.naam || f.properties.identificatie))
        .filter(Boolean);
      const uniek = new Set(namen.map(n => String(n).trim()));

      if (uniek.size < MIN_GEMEENTEN || uniek.size > MAX_GEMEENTEN) {
        return {
          ok: false,
          detail: `${uniek.size} gemeenten — buiten de marge ${MIN_GEMEENTEN}-${MAX_GEMEENTEN}. ` +
            'Het API-formaat is waarschijnlijk gewijzigd; gemeentelijst.js valt nu terug op de geojson.'
        };
      }
      return { ok: true, detail: `${uniek.size} gemeenten` };
    }
  },

  {
    naam: 'PDOK Locatieserver (zoekveld frontend)',
    waarom: 'de zoekfunctie in het dashboard bevraagt deze API rechtstreeks',
    async run() {
      const url = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=' +
        encodeURIComponent('Gouda');
      const r = await haal(url);
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
      const gevonden = r.data?.response?.numFound;
      if (!gevonden) return { ok: false, detail: 'geen resultaten voor een bestaande plaatsnaam' };
      return { ok: true, detail: `${gevonden} resultaten voor "Gouda"` };
    }
  },

  {
    naam: 'SRU officielebekendmakingen.nl',
    waarom: 'enige bron die als vaststaand beleid mag gelden',
    async run() {
      // Een ruim venster: de vraag is of de query werkt, niet of er deze week
      // toevallig iets gepubliceerd is.
      const query = bouwCqlQuery({ vanaf: '2019-01-01' });
      const url = 'https://zoek.officielebekendmakingen.nl/sru/Search' +
        '?version=1.2&operation=searchRetrieve&x-connection=oep' +
        `&startRecord=1&maximumRecords=1&query=${encodeURIComponent(query)}`;

      const r = await haal(url, { type: 'text' });
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };

      const xml = String(r.data);
      const diagnostic = xml.match(/<(?:\w+:)?message>([^<]+)</i);
      if (diagnostic) return { ok: false, detail: `SRU-diagnostic: ${diagnostic[1]}` };

      const m = xml.match(/<(?:\w+:)?numberOfRecords>(\d+)/);
      if (!m) return { ok: false, detail: 'geen numberOfRecords in het antwoord' };

      const aantal = parseInt(m[1], 10);
      if (aantal === 0) {
        return {
          ok: false,
          detail: 'query levert 0 records over de hele historie sinds 2019. ' +
            'Dat is niet geloofwaardig: de query of de connectie klopt niet meer.'
        };
      }
      return { ok: true, detail: `${aantal} records sinds 2019-01-01` };
    }
  },

  {
    naam: 'gemeenten.geojson (eigen hosting)',
    waarom: 'kaartlaag van de frontend en terugval voor de gemeentelijst',
    async run() {
      const r = await haal(`${SITE}/gemeenten.geojson`, { type: 'text' });
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };

      let data;
      try {
        data = JSON.parse(r.data);
      } catch {
        // Een hosting-deploy zonder dit bestand levert de SPA-fallback: HTTP 200
        // met HTML erin. Zonder deze parse ziet dat eruit als een geslaagde check.
        return { ok: false, detail: 'antwoord is geen geldige JSON (waarschijnlijk de HTML-fallback)' };
      }

      const n = (data.features || []).length;
      if (n < MIN_GEMEENTEN || n > MAX_GEMEENTEN) {
        return { ok: false, detail: `${n} features — buiten de marge ${MIN_GEMEENTEN}-${MAX_GEMEENTEN}` };
      }
      return { ok: true, detail: `${n} features` };
    }
  },

  {
    naam: 'API /api/v1/gemeenten',
    waarom: 'de data die het dashboard toont',
    async run() {
      const r = await haal(`${SITE}/api/v1/gemeenten`);
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };

      const lijst = Array.isArray(r.data) ? r.data : (r.data.gemeenten || r.data.data);
      if (!Array.isArray(lijst)) return { ok: false, detail: 'antwoord is geen lijst gemeenten' };
      if (lijst.length < MIN_GEMEENTEN) {
        return { ok: false, detail: `${lijst.length} gemeenten — het dashboard heeft gaten` };
      }

      const zonderNormen = lijst.filter(g => !g || !g.pfos || typeof g.pfos.wonen !== 'number');
      if (zonderNormen.length) {
        return { ok: false, detail: `${zonderNormen.length} van de ${lijst.length} gemeenten zonder bruikbare PFOS-waarde` };
      }
      return { ok: true, detail: `${lijst.length} gemeenten met normen` };
    }
  },

  {
    naam: 'IPLO handelingskader PFAS',
    waarom: 'de bronlink onder het landelijk kader',
    async run() {
      const url = 'https://iplo.nl/thema/bodem/regelgeving/hergebruik-bouwstoffen-grond-of-baggerspecie/' +
        'kwaliteitseisen-toepassen-grond-baggerspecie/handelingskader-pfas/';
      const r = await haal(url, { type: 'text' });
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
      if (!/pfas/i.test(String(r.data))) {
        return { ok: false, detail: 'pagina bestaat maar noemt PFAS niet — vermoedelijk doorgestuurd' };
      }
      return { ok: true, detail: 'bereikbaar en noemt PFAS' };
    }
  }
];

async function main() {
  const uitkomsten = [];

  for (const c of CONTROLES) {
    let uitkomst;
    try {
      uitkomst = await c.run();
    } catch (err) {
      uitkomst = { ok: false, detail: `niet bereikbaar (${err.code || err.message})` };
    }
    uitkomsten.push({ naam: c.naam, waarom: c.waarom, ...uitkomst });
    console.error(`${uitkomst.ok ? '✅' : '❌'} ${c.naam.padEnd(42)} ${uitkomst.detail}`);
  }

  const kapot = uitkomsten.filter(u => !u.ok);

  console.error(`\n${'='.repeat(64)}`);
  console.error(`Kernbronnen gecontroleerd: ${uitkomsten.length}`);
  console.error(`In orde:                   ${uitkomsten.length - kapot.length}`);
  console.error(`Probleem:                  ${kapot.length}`);
  console.error(`${'='.repeat(64)}`);

  if (kapot.length) {
    console.error('\nDeze bronnen leveren geen bruikbare data:');
    for (const k of kapot) console.error(`  • ${k.naam} — ${k.detail}\n    (${k.waarom})`);
  }

  if (alsJson) {
    console.log(JSON.stringify({
      gecontroleerd: uitkomsten.length,
      kapot: kapot.length,
      uitkomsten
    }, null, 2));
  }

  process.exit(kapot.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fout:', err.message);
  process.exit(2);
});
