# PFAS Dashboard — API

Backend (Firebase Cloud Functions) achter het PFAS-dashboard op
<https://pfas-dashboard-nl-a808d.web.app/>.

De API levert per Nederlandse gemeente de geldende PFAS-normen voor grondverzet
(PFOS, PFOA, GenX) en signaleert nieuw lokaal bodembeleid via de officiële
bekendmakingen van de overheid.

## ⚠️ Lees dit voor de eerste hosting-deploy

Een hosting-deploy **vervangt de hele site**. Alles wat nu op
`pfas-dashboard-nl-a808d.web.app` staat maar niet in `public/` zit, is daarna weg.

Dat geldt met name voor **`gemeenten.geojson`**. Dat bestand staat op de live
hosting maar zat nooit in deze repository. Haal het eerst binnen:

```bash
curl -o public/gemeenten.geojson https://pfas-dashboard-nl-a808d.web.app/gemeenten.geojson
```

De frontend werkt ook zonder — hij valt dan terug op de Kadaster-API voor de
gemeentegrenzen — maar dat is een externe afhankelijkheid bij elk paginabezoek.
Met het bestand erbij is de site zelfvoorzienend.

De frontend in `public/index.html` is **opnieuw opgebouwd**, niet gekopieerd: de
oorspronkelijke site was niet in te zien vanaf de plek waar dit werk gedaan is.
Hij gebruikt dezelfde data (`/api/v1/gemeenten`) en dezelfde kleurlogica
(oranje = afwijkend), maar de vormgeving zal verschillen van wat er nu staat.
Vergelijk met de live site voordat je deployt.

Controleer ook de **regio** in de rewrite in `firebase.json`. Die staat op
`us-central1`; staan de functions elders, dan geeft `/api/**` een 404. Zoek de
regio op in de Firebase Console onder Functions.

## Structuur

| Pad | Wat |
| --- | --- |
| `pfasApi_code/index.js` | Alle Cloud Functions + de Express API |
| `pfasApi_code/scraper.js` | Wekelijkse verwerking per gemeente (AI is alleen signaalgever) |
| `pfasApi_code/checkBekendmakingen.js` | Nachtelijke check op officielebekendmakingen.nl |
| `pfasApi_code/syncSheet.js` | Handmatige overschrijvingen vanuit een Google Sheet |
| `pfasApi_code/pfas_normen.json` | **Leidende databron**: landelijk kader + geverifieerde afwijkingen |
| `pfasApi_code/gemeente_mapping.json` | Bronlink per gemeente |
| `pfasApi_code/docId.js` | Enige plek waar Firestore document-id's gemaakt worden |

De AI (Gemini) bepaalt nooit zelf de getallen in het dashboard. `pfas_normen.json`
is leidend; AI-vondsten belanden in de collectie `pfasSignalen` voor handmatige
review.

## Draaien

```bash
cd pfasApi_code
npm ci
npm test          # smoke tests, geen credentials of netwerk nodig
```

Deployen (functions en Firestore-rules, niet hosting):

```bash
firebase deploy --only functions,firestore
```

De Gemini-sleutel hoort in Secret Manager, niet in de code:

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

## Endpoints

Basis: `https://<regio>-pfas-dashboard-nl-a808d.cloudfunctions.net/pfasApi`

| Route | Wat |
| --- | --- |
| `GET /v1/gemeenten` | Alle gemeenten met hun PFAS-normen |
| `GET /v1/gemeenten/:naam` | Eén gemeente |
| `GET /v1/signalen` | Openstaande signalen voor review |

Beheerfuncties (losse HTTPS-functions, schrijven naar Firestore):

| Function | Wat |
| --- | --- |
| `fillDefaultData` | Zet alle gemeenten op het landelijk kader |
| `fixLinks` | Reset normen en bronlinks vanuit de JSON-bestanden |
| `syncSheetNow?sheetId=…` | Haalt handmatige overschrijvingen uit een Google Sheet |
| `checkBekendmakingenNow?dagen=30` | Draait de bekendmakingen-check nu |
| `runScraperNow?gemeente=…` of `?batch=0..6` | Draait de scraper nu |
| `mergeDuplicateDocs` | Voegt dubbele documenten samen (**droogloop**, zie hieronder) |

## Dubbele documenten opruimen

`fillDefaultData` en `syncSheet` gebruikten `/\\s+/g` in plaats van `/\s+/g`.
Die regex matcht een letterlijke backslash, geen witruimte. Elke gemeente met
een spatie in de naam kreeg daardoor twee documenten:

```
"bergen op zoom"   ← fillDefaultData / syncSheet
"bergen-op-zoom"   ← scraper / checkBekendmakingen
```

Updates van de ene bron kwamen dus nooit aan bij de andere. De code schrijft nu
overal hetzelfde id, maar de dubbelen die al in Firestore staan blijven bestaan.
Opruimen na deploy:

```bash
# 1. Eerst kijken wat er zou gebeuren (verandert niets)
curl "https://<regio>-pfas-dashboard-nl-a808d.cloudfunctions.net/mergeDuplicateDocs"

# 2. Pas doorvoeren als het rapport klopt
curl "https://<regio>-pfas-dashboard-nl-a808d.cloudfunctions.net/mergeDuplicateDocs?apply=true"
```

Handmatige overschrijvingen (`handmatigeOverschrijving: true`) winnen bij het
samenvoegen, daarna het canonieke document, daarna het meest recent bijgewerkte.

## Automatische controles

Draaien zonder dat er iemand — of iets — hoeft mee te kijken.

### GitHub Actions

| Workflow | Wanneer | Wat |
| --- | --- | --- |
| `ci.yml` | elke push en PR | `npm test` plus een laadtest van alle Cloud Functions |
| `bronlinks.yml` | elke maandag 06:00 UTC | haalt elke bronlink echt op; opent of werkt een issue bij als er een 404 geeft |

De linkcheck is er omdat bronlinks stilletjes verlopen: ODRN fuseerde tot
Omgevingsdienst Groene Metropool, RUD Zeeland zit op een domein mét koppelteken.
Zo'n verandering merk je nergens aan, behalve dat iemand die grond wil afvoeren
op een 404 landt. De runner heeft normale netwerktoegang, dus dit is een echte
HTTP-controle — niet af te leiden uit een zoekindex.

De laadtest in `ci.yml` vangt precies de fout die `runScraperNow` maandenlang
stukmaakte: een aanroep zonder import valt pas om bij uitvoering, niet bij
`node --check`.

### Firebase

| Function | Wanneer | Wat |
| --- | --- | --- |
| `dailyHealthCheck` | dagelijks 07:00 | beoordeelt de dataset, schrijft naar `config/healthcheck` |
| `healthCheck` | op aanvraag | zelfde oordeel; **HTTP 200** als alles klopt, **503** als niet |

`dailyHealthCheck` slaat alarm bij ontbrekende gemeenten, verweesde documenten,
dubbele document-id's, onaannemelijke waarden, onbruikbare bronlinks en een
sweep die langer dan tien dagen stilstaat. Bij problemen gaat er een
`console.error` naar Cloud Logging — zet daar een log-based alert op:

```
resource.type="cloud_function"
resource.labels.function_name="dailyHealthCheck"
severity=ERROR
```

`healthCheck` geeft 503 bij problemen, zodat een uptime-monitor (Cloud
Monitoring, of iets als UptimeRobot) er rechtstreeks op kan afgaan zonder de
uitvoer te hoeven lezen.

## Dekking en juistheid

Twee verschillende problemen, met verschillende oplossingen.

### Dekking: krijgt elke gemeente een rij?

Dit is mechanisch en dus oplosbaar. De gemeentelijst komt uit `gemeentelijst.js`,
die het Kadaster (PDOK Bestuurlijke Gebieden) bevraagt en pas terugvalt op
`gemeenten.geojson` als dat niet lukt. Elke bron wordt afgekeurd als hij minder
dan 320 of meer dan 400 gemeenten oplevert, zodat een gewijzigd API-formaat niet
stilletjes een halve lijst doorlaat.

Dat de scraper zonder fouten draait bewijst nog niet dat de dekking klopt.
Daarvoor is `auditData`, dat Firestore vergelijkt met de canonieke lijst:

```bash
curl "https://<regio>-pfas-dashboard-nl-a808d.cloudfunctions.net/auditData" | jq .samenvatting
```

```jsonc
{
  "gemeentenVolgensBron": 342,
  "documentenInFirestore": 342,
  "dekkingProcent": 100,
  "ontbrekend": 0,          // in de lijst, niet in Firestore
  "verweesd": 0,            // in Firestore, bestaat niet meer (herindeling)
  "dubbeleIds": 0,          // document-id wijkt af van toDocId(gemeente)
  "verdachteWaarden": 0,    // ontbrekend, <= 0 of > 50 µg/kg
  "zwakkeBronlinks": 0,     // homepage-only, Google-zoekopdracht of ongeldig
  "verouderd": 0            // langer dan ?maxDagen=90 niet bijgewerkt
}
```

Draai dit na elke scraper-run. Alles behalve `dekkingProcent: 100` met nul
`ontbrekend` en nul `verweesd` betekent dat het dashboard gaten heeft.

### De wekelijkse sweep

Elke maandag om 03:00 draait `weeklyBekendmakingenSweep`. Die haalt alle
gemeentebladen op die sinds de vorige geslaagde run zijn gepubliceerd over
PFAS-bodembeleid, analyseert nieuwe documenten en herberekent daarna per
gemeente of er afwijkend beleid geldt.

Twee collecties:

| Collectie | Wat |
| --- | --- |
| `pfasDocumenten/<identifier>` | Elk verwerkt gemeenteblad met de AI-analyse |
| `pfasData/<gemeente>` | De hieruit **afgeleide** toestand per gemeente |

`pfasData` wordt volledig herleid uit `pfasDocumenten` en niet bijgewerkt met
losse ad-hoc updates. Daardoor is het resultaat reproduceerbaar: dezelfde
documenten geven altijd dezelfde uitkomst, ongeacht in welke volgorde ze ooit
binnenkwamen.

Elk document gaat precies één keer door de AI. Een wekelijkse volledige sweep
kost dus alleen API-calls voor wat er nieuw bij is gekomen.

**Eerste keer: het corpus opbouwen.** De sweep kent alleen wat hij ooit gezien
heeft, dus begin met een backfill over de hele historie:

```bash
curl "https://<regio>-…/sweepBekendmakingenNow?vanaf=2019-01-01&max=200"
```

Verwerkte documenten worden onthouden, dus roep dit gewoon herhaald aan tot
`verwerkt: 0` — hij pakt op waar hij bleef. Daarna neemt de wekelijkse run het
over.

Het watermerk staat in `config/bekendmakingenSweep`. De sweep gebruikt dat in
plaats van een vast venster van zeven dagen: als een run faalt of overgeslagen
wordt, ontstaat er anders een gat dat nooit meer gedicht wordt.

### Juistheid: kloppen de getallen?

De sweep leidt de getallen af uit officiële gemeentebladen. Dat is de enige
machineleesbare bron die als vaststaand mag gelden: wat daar staat is juridisch
bindend vastgesteld beleid.

Alleen dat is niet genoeg om een getal te vertrouwen. Er zitten drie horden
tussen "de AI las een getal" en "dit getal komt in het dashboard":

1. **Plausibiliteit.** Waarden buiten 0–50 µg/kg ds worden verworpen; dat is
   bijna altijd een eenheidsverwarring (ng/kg) of een ander stofnummer.
2. **Zekerheid.** Alleen `aiZekerheid: "hoog"` telt mee bij het afleiden.
3. **Nooit null overschrijven.** Vult de AI maar één klasse in, dan blijven de
   andere staan op wat er al was of op het landelijk kader.

Om zo min mogelijk afwijkingen te missen:

- **Het hele document wordt doorzocht,** niet alleen het begin. In een nota
  bodembeheer staat de normentabel vaak tientallen pagina's ver; er worden
  vensters geknipt rond elke PFAS-term en elke eenheid.
- **Eén fout getal gooit de rest niet weg.** Waarden worden stuk voor stuk
  gezeefd, zodat een hallucinatie bij GenX geen correct gelezen PFOS-afwijking
  meesleept. Verworpen waarden blijven zichtbaar in `verworpenWaarden`.
- **Ook het Blad gemeenschappelijke regeling wordt doorzocht.** Omgevingsdiensten
  zijn gemeenschappelijke regelingen en publiceren daar; door alleen op
  Gemeenteblad te filteren bleef juist de partij die het beleid maakt buiten beeld.
- **Ruime zoektermen.** Liever een paar irrelevante documenten analyseren dan een
  gemeente met eigen normen missen.

Wat de sweep nog steeds **niet** kan, en wat je moet weten voordat je hierop test:

- De AI leest een PDF-bijlage niet, alleen de HTML-tekst van de bekendmaking.
  Staat de normentabel uitsluitend in een bijlage, dan wordt hij niet gelezen.
  `heeftPdfBijlage: true` op het document markeert die gevallen.
- Een gemeente kan afwijkend beleid hebben dat nooit als bekendmaking met deze
  zoektermen is gepubliceerd. Die blijft op de aanname staan.
- Beleid van vóór 2019 valt buiten de backfill zolang je `vanaf` niet eerder zet.

Daarom krijgt elke gemeente een expliciete `herkomst`:

| `herkomst` | Betekenis |
| --- | --- |
| `officiele-bekendmaking` | Waarden komen uit een gemeenteblad; `bronDocument` verwijst naar het exacte besluit |
| `mogelijk-afwijkend` | Er is een afwijking gevonden maar niet geverifieerd. Toont het landelijk kader, met verwijzing naar het besluit. `tereviewen: true` |
| `landelijk-kader-aanname` | **Geen document gevonden.** Het landelijk kader is aangenomen, niet vastgesteld |
| `handmatig` | Handmatig overschreven via de Google Sheet |

Een gevonden afwijking verdwijnt nooit stilzwijgend. Kan de AI niet vaststellen
dat het document echt eigen normen vaststelt, dan gaat de gemeente naar
`mogelijk-afwijkend` in plaats van terug naar "volgt landelijk kader". De
werkvoorraad staat op `GET /v1/te-reviewen`.

Zie de verdeling met `auditData`:

```bash
curl "https://<regio>-…/auditData" | jq .herkomst
```

**Presenteer `landelijk-kader-aanname` in de UI nooit als een vaststelling.**
Voor iemand die op basis hiervan grond laat keuren is het verschil tussen "dit
is vastgesteld beleid" en "hier is niets over gevonden" precies het verschil dat
telt. Het dashboard hoort daarbij door te verwijzen naar de bronlink en de
omgevingsdienst — het vervangt geen milieuhygiënische verklaring.

### Bronlinks

`check-links.js` controleert of de links in `gemeente_mapping.json` bestaan:

```bash
node check-links.js --kapot      # alleen de kapotte
node check-links.js --json > rapport.json
```

Dit was nodig omdat de links deels gegokt waren: 152 van de 349 deelden exact
het pad `/themas/bodem` en 103 waren alleen een homepage. De prompt in
`findRealLinks` droeg de AI letterlijk op om bij twijfel de homepage van de
meest waarschijnlijke omgevingsdienst te geven. Een link die 404 geeft is voor
een gebruiker erger dan geen link.

Alle 24 omgevingsdienst-domeinen zijn nagelopen; 316 van de 340 gemeenten
kregen een andere bronlink. Drie daarvan waren geen verkeerd pad maar een
verkeerde organisatie:

| Was | Is | Waarom |
| --- | --- | --- |
| `www.odrn.nl` | `www.odgroenemetropool.nl` | ODRN en OD Regio Arnhem zijn per 1-1-2026 gefuseerd tot Omgevingsdienst Groene Metropool |
| `www.omgevingsdienst.nl` | `www.od-groningen.nl` | `omgevingsdienst.nl` is de landelijke koepel Omgevingsdienst NL, niet OD Groningen |
| `www.rudzeeland.nl` | `rud-zeeland.nl` | het domein heeft een koppelteken |

Verder: `omgevingsdienstachterhoek.nl` → `odachterhoek.nl` en `odh.nl` →
`omgevingsdiensthaaglanden.nl`.

> **Belangrijke kanttekening bij de verificatie.** De links zijn gecontroleerd
> tegen een zoekindex, niet door ze op te halen — de omgeving waarin dit werk is
> gedaan had geen uitgaand netwerk naar die domeinen. Dat een URL in de index
> staat is sterk bewijs dat de pagina bestaat, maar geen bevestigde HTTP 200.
> Draai `node check-links.js` een keer vanaf een machine met normale
> netwerktoegang om dit hard te maken.

### Herindelingen

Gemeenten verdwijnen en ontstaan. `npm test` faalt als er een opgeheven gemeente
in `gemeente_mapping.json` staat of als een opvolger ontbreekt; `auditData`
meldt verweesde documenten in Firestore. Negen opgeheven gemeenten (Aalburg,
Beemster, Boxmeer, Cuijk, Grave, Landerd, Mill en Sint Hubert, Sint Anthonis,
Uden) stonden er nog in en zijn verwijderd.

## Firestore-rules

`firestore.rules` staat publiek lezen toe op `pfasData` en `pfasSignalen` en
weigert alle schrijfacties vanaf clients. De Cloud Functions gebruiken de Admin
SDK en omzeilen deze rules, dus die blijven gewoon werken.

Stond het project nog op de tijdelijke "test mode"-rules, dan verliepen die na
30 dagen en werd daarna álle toegang geweigerd — een veelvoorkomende oorzaak van
een dashboard dat ineens leeg is.

## Deployen en onderhoud via GitHub

Alles wat live iets verandert, kan vanuit **Actions** — er is geen terminal voor
nodig.

### Eenmalig instellen

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Naam | Waarde |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | de volledige JSON van een serviceaccount-sleutel |

Maak die sleutel in de Google Cloud Console onder IAM & Admin → Service
Accounts, met de rollen **Firebase Admin**, **Cloud Functions Admin** en
**Service Account User**.

### Deploy naar Firebase

Actions → *Deploy naar Firebase* → Run workflow. Kies `hosting`, `firestore`,
`functions` of `alles`, en typ `DEPLOY` ter bevestiging.

De workflow draait eerst de tests, haalt `gemeenten.geojson` van de live hosting
op zodat een hosting-deploy dat bestand niet wist, en deployt daarna.

> **Functions worden per stuk gedeployd, met opzet.** `firebase deploy --only
> functions` verwijdert functions die niet meer in de broncode staan. In dit
> project draaien vijf functions die niet in deze repository zitten — `api`,
> `weeklyBronbewaking`, `bronbewakingNow`, `verzoenGemeenteAliases` en
> `dailyBekendmakingenSweep`. Een gewone deploy zou die weggooien. De workflow
> bouwt daarom een expliciete lijst uit de exports van `index.js` en raakt niets
> anders aan. Een test bewaakt dat dit zo blijft.

### Data-onderhoud

Actions → *Data-onderhoud* → Run workflow. Roept de functies aan die al live
staan; de uitkomst komt in de samenvatting van de run te staan.

| Actie | Wat | Schrijft |
| --- | --- | --- |
| `audit` | hoe staat de dataset ervoor | nee |
| `dubbelen-droog` | rapport van dubbele documenten | nee |
| `dubbelen-echt` | voegt dubbelen samen (typ `VERWIJDER`) | ja |
| `sweep` | haalt bekendmakingen op en verwerkt ze | ja |
| `herbouw` | leidt de toestand per gemeente opnieuw af | ja |

Volgorde bij een eerste keer: `audit` → `dubbelen-droog` → `dubbelen-echt` →
`sweep` (met `vanaf` op `2019-01-01`, herhalen tot `verwerkt: 0`) → `audit`.
