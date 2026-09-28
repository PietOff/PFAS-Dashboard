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
| `bronlinks.yml` | elke maandag 06:00 UTC | haalt elke bronlink echt op én controleert de kernbronnen; opent of werkt een issue bij als er een 404 geeft |

De linkcheck is er omdat bronlinks stilletjes verlopen: ODRN fuseerde tot
Omgevingsdienst Groene Metropool, RUD Zeeland zit op een domein mét koppelteken.
Zo'n verandering merk je nergens aan, behalve dat iemand die grond wil afvoeren
op een 404 landt. De runner heeft normale netwerktoegang, dus dit is een echte
HTTP-controle — niet af te leiden uit een zoekindex.

De laadtest in `ci.yml` vangt precies de fout die `runScraperNow` maandenlang
stukmaakte: een aanroep zonder import valt pas om bij uitvoering, niet bij
`node --check`.

**De linkcheck faalt nu ook als hij niets heeft kunnen meten.** Draait hij in een
omgeving zonder uitgaand netwerk, dan is elke URL "geblokkeerd", is het aantal
kapotte links nul en eindigde hij groen — een controle die niets meet en zichzelf
goedkeurt. Dat is precies de stille storing die hij hoort te vinden, dus nul
bevestigde URL's geeft nu exitcode 1.

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
`volledig: true` — hij pakt op waar hij bleef. Daarna neemt de wekelijkse run het
over.

Het watermerk staat in `config/bekendmakingenSweep`. De sweep gebruikt dat in
plaats van een vast venster van zeven dagen: als een run faalt of overgeslagen
wordt, ontstaat er anders een gat dat nooit meer gedicht wordt.

Het watermerk schuift alleen op na een **volledige** run: elke publicatie in het
venster is verwerkt, al bekend, of opgegeven. Tot september 2026 schoof het ook
op als de run bij `max` stopte of als er documenten mislukten, en dan kwamen
die publicaties nooit meer aan de beurt. Een run stopt nu zelf na zeven minuten,
zodat `herbouwAfwijkingen` altijd nog binnen de functietimeout draait. Een
publicatie die drie runs achter elkaar mislukt wordt opgegeven (zie de collectie
`sweepMislukt`), zodat één verdwenen document het watermerk niet voor altijd
tegenhoudt. De audit meldt het als het watermerk meer dan drie weken achterloopt.

`herbouwAfwijkingen` zet voor gemeenten zonder eigen publicatie ook de bronlink
uit `gemeente_mapping.json`. Een gerepareerde link staat dus na de volgende sweep
of `herbouw` in het dashboard, zonder `fixLinks` (die ook alle waarden terugzet).

### Juistheid: kloppen de getallen?

De sweep zoekt in officiële gemeentebladen naar besluiten met mogelijk
afwijkende normen. **Getallen uit de AI komen nooit in het dashboard**: een
vondst maakt de gemeente `mogelijk-afwijkend` (landelijk kader + waarschuwing)
tot een mens het besluit heeft nagelezen en de waarden in `pfas_normen.json`
heeft gezet. Zie *Normen-controle september 2026* hieronder voor waarom.

Om de signalen bruikbaar te houden:

1. **Plausibiliteit.** Waarden buiten 0–50 µg/kg ds worden verworpen; dat is
   bijna altijd een eenheidsverwarring (ng/kg) of een ander stofnummer. Waarden
   ≤ 0,1 zijn de bepalingsgrens (grondwaterbeschermingsgebied) en tellen niet.
2. **Herbeoordeling.** Elk document wordt bij elke herbouw opnieuw vergeleken met
   het huidige kader, zodat een fout in het kader niet blijft doorwerken.
3. **Ontwerpbesluiten** tellen nooit als vastgesteld.

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
| `curatie` | Nagelezen afwijking uit `pfas_normen.json`; `bronDocument` verwijst naar het besluit |
| `mogelijk-afwijkend` | Er is een afwijking gesignaleerd maar niet nagelezen. Toont het landelijk kader, met verwijzing naar het besluit. `tereviewen: true` |
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

### Normen-controle september 2026: alleen nagelezen getallen

Een inhoudelijke controle tegen IPLO en de besluiten zelf vond dat de getallen
in het dashboard grotendeels niet klopten, terwijl elke technische controle
"gezond" meldde:

1. **GenX landbouw/natuur stond op 0,8; het is 1,4** (handelingskader dec 2023:
   "overige PFAS incl. GenX"). De 0,8 is de waarde voor oppervlaktewater.
2. **Alle elf AI-"afwijkingen" waren fout getoond.** Zeven nota's herhaalden het
   kader; Almere kwam erop via een ontwerpbesluit en een tabel voor moestuinen;
   Houten via de drinkwatergebied-eis 0,1. Maasdriel en Zaltbommel hadden wél een
   echte afwijking, maar de AI miste dat die voor de hele regio Rivierenland geldt.
3. **De echte afwijkingen werden elke maandag gewist** door de herbouw, en
   `nightlyBekendmakingen` schreef AI-getallen rechtstreeks weg.
4. **De gecureerde waarden zelf klopten deels niet.** OZHZ zone B heeft PFOS
   2,4 (stond 1,4); Helmond kent geen gemeentebrede waarde maar een waarde per
   zone (er stonden verzonnen "middenwaarden").
5. **Heel Utrecht, Rivierenland en Zuid-Kennemerland ontbraken.**
6. **Zes gemeenten stonden bij de verkeerde omgevingsdienst** (Midden-Holland
   bij Haaglanden; Kaag en Braassem en Nieuwkoop horen bij West-Holland), en
   `provincie` was overal "Nederland".

Het principe is nu: **de AI levert signalen, nooit getallen.**

| `herkomst` | Getallen | Wanneer |
| --- | --- | --- |
| `curatie` | lokaal, nagelezen | in `pfas_normen.json` → `afwijkend`, met `bronDocument` en `geverifieerdOp` |
| `mogelijk-afwijkend` | landelijk kader + waarschuwing | in `mogelijkAfwijkend` (bv. alleen een ontwerp gevonden), of een AI-signaal uit een besluit |
| `landelijk-kader-aanname` | landelijk kader | niets gevonden — een aanname, geen vaststelling |
| `handmatig` | uit de Google Sheet | handmatige overschrijving |

Een waarde die per zone verschilt staat als `null` met `perZone`, en het
dashboard toont "per zone". Eén getal zou verzonnen zijn.

**Een AI-signaal afhandelen:** lees het besluit. Wijkt het echt af, voeg de
gemeente toe aan `afwijkend` met de waarden, het besluit en de datum. Wijkt het
niet af, zet het document-id in `nagelezenZonderAfwijking` met de reden, zodat
het signaal niet elke week terugkomt. De tests eisen dat elke afwijking een
bronbesluit heeft en dat een lege waarde verklaard is.

Nagelezen (2026-09-26), met de besluiten in `pfas_normen.json`:

| Regio | Gemeenten | Afwijking (landbouw/natuur tenzij anders) |
| --- | --- | --- |
| Zuid-Holland Zuid, zone B | Alblasserdam, Dordrecht, Gorinchem, Hardinxveld-Giessendam, Hendrik-Ido-Ambacht, Molenlanden, Papendrecht, Sliedrecht, Zwijndrecht | PFOA 2,3 · PFOS 2,4 (omgevingsplannen 2025) |
| Rotterdam | Rotterdam | PFOS 1,6; industrie PFOS 7 voor grond uit Rotterdam |
| Nieuwegein | Nieuwegein | PFOA 3,8 voor grond uit Nieuwegein |
| Helmond | Helmond | per bodemkwaliteitszone |
| Rivierenland | Culemborg, Maasdriel, Neder-Betuwe, Tiel, Zaltbommel, West Betuwe, West Maas en Waal | PFOA 2,8 voor grond uit de regio |
| Utrecht zone B3 | Bunnik, Houten, Renswoude, Rhenen, Soest, Stichtse Vecht, Veenendaal, De Bilt, Leusden, Utrechtse Heuvelrug, Wijk bij Duurstede, Zeist | PFOS 1,8 · PFOA 2,9 binnen de zone |
| Utrecht zone B2 | IJsselstein, Oudewater, Montfoort | PFOS 1,8 · PFOA 5,2 binnen de zone |
| Utrecht, meerdere zones | Woerden, Vijfheerenlanden | per zone |
| Utrecht (gemeente) | Utrecht | PFOS 2,19 · PFOA 4,35 (eigen beleid 2020, bovenste meter) |
| Zuid-Kennemerland-IJmond | Beverwijk, Bloemendaal, Heemskerk, Heemstede, Uitgeest, Velsen, Zandvoort | PFOS 2,6 (bovengrond) |
| Achterhoek | Montferland, Winterswijk | **strenger**: toepassingseis Wonen PFOS 1,4 · PFOA 1,9 · overig 1,4 |
| Nijmegen | Nijmegen | **strenger**: wonen en industrie PFOA 1,9 · overig (incl. PFOS) 1,4 |
| Bevelanden en Tholen | Tholen | PFOS 1,5 voor grond uit de regio |
| Reimerswaal | Reimerswaal | PFOS 3,0 voor eigen grond; strook Westerschelde PFOS 15 · PFOA 7 |
| Hardenberg | Hardenberg | PFOA 30 · PFOS 29 in vier bodembeheergebieden, elders landelijk |

Nagelezen en **gelijk aan het landelijk kader**: Twente, Noord-Brabant (BKK
PFAS), Midden-Holland (wel geen dubbele toets voor grond uit de regio),
Zaanstreek-Waterland, Noord-Veluwe, De Vallei, Moerdijk, Hoeksche Waard (zone
A), Kerkrade en Noord- en Midden-Limburg.

Review van de 48 `mogelijk-afwijkend`-gemeenten (2026-09-28): 13 bleken vastgesteld
afwijkend (hierboven verwerkt), 24 volgen het landelijk kader en 11 blijven twijfelachtig.
Landelijk kader, met het signaaldocument in `nagelezenZonderAfwijking`:
Aalsmeer, Amstelveen, Diemen, Ouder-Amstel, Uithoorn en Haarlemmermeer (PFAS-beleidsregel
ingetrokken in 2023), de Brabantse gemeenten Alphen-Chaam, Baarle-Nassau, Bergen op Zoom,
Breda, Eersel, Geertruidenberg, Gilze en Rijen, Loon op Zand, Reusel-De Mierden,
Roosendaal, Sint-Michielsgestel, Steenbergen en Tilburg (de PFOS 10,1 in de regionale nota
geldt alleen voor Waalwijk GOL/Haven Acht), en Leeuwarden, Losser, Scherpenzeel en
Zoetermeer. Twijfel, op `mogelijkAfwijkend` met de reden: Amersfoort, Baarn, Bunschoten,
Eemnes, Lopik, Woudenberg (geen vaststelling gevonden) en Buren (alleen ontwerp). Na controle
in het register lokale regelgeving: Montfoort blijkt de ODRU-nota te hebben vastgesteld (zone B2);
De Ronde Venen en Nissewaard volgen het landelijk kader.

Let op: de sweep vindt intrekkingsbesluiten niet, omdat die geen bodemterm bevatten. De
zes ingetrokken beleidsregels hierboven stonden daardoor nog als signaal in het corpus.

Het corpus bevatte bij de controle **25 van de 999** relevante publicaties: de
backfill vanaf 2019 is nooit afgemaakt. Draai na deploy de sweep met
`vanaf=2019-01-01` tot `verwerkt: 0` en handel de signalen af zoals hierboven.

### Kernbronnen

`check-links.js` controleert de pagina's waar de **gebruiker** heen klikt.
`check-bronnen.js` controleert de bronnen waar de **data** vandaan komt. Die
tweede groep viel tot nu toe buiten elke controle:

```bash
node check-bronnen.js
node check-bronnen.js --json > bronnen.json
```

| Bron | Waarom | Wat er gecontroleerd wordt |
| --- | --- | --- |
| PDOK Bestuurlijke Gebieden | canonieke gemeentelijst | plausibel aantal gemeenten, niet alleen HTTP 200 |
| PDOK Locatieserver | het zoekveld in de frontend | levert treffers voor een bestaande plaatsnaam |
| SRU officielebekendmakingen | enige bron die als vaststaand beleid geldt | `numberOfRecords` > 0 én records die écht te verwerken zijn |
| `gemeenten.geojson` | kaartlaag en terugval voor de gemeentelijst | geldige JSON met een plausibel aantal features |
| `/api/v1/gemeenten` | de data die het dashboard toont | volledige lijst, elke gemeente met bruikbare normen |
| IPLO handelingskader | de bronlink onder het landelijk kader | pagina bestaat én noemt PFAS |

> **De eerste run legde de sweep stil bloot.** Er zaten drie fouten achter
> elkaar, en elk daarvan zag er van buiten uit als "er is niets gepubliceerd":
>
> 1. **Het endpoint was uitgefaseerd.** `zoek.officielebekendmakingen.nl/sru/Search`
>    geeft HTTP 500 op élke query, ook op de simpelste. KOOP bedient dezelfde
>    collectie via `repository.overheid.nl/sru`.
> 2. **De verkeerde inhoud werd opgevraagd.** Axios stuurt uit zichzelf
>    `Accept: application/json, text/plain, */*`. De API doet aan
>    contentonderhandeling en gaf keurig JSON terug — een geldig antwoord op een
>    vraag die niemand bedoelde te stellen, waar geen enkele XML-regex op past.
>    `haalPagina` vraagt nu expliciet om XML, `haalDocumentTekst` om HTML.
> 3. **De records werden niet uitgelezen.** Het element komt binnen als
>    `<sru:recordData>` mét namespace-attribuut, en de vindplaats staat in
>    `<gzd:itemUrl manifestation="html">`, niet in een `<url>`.
>
> Geen van drieën leverde ooit een foutmelding op. De sweep meldde "geen nieuwe
> bekendmakingen gevonden" en alle gemeenten bleven op `landelijk-kader-aanname`
> staan alsof er niets te vinden was — terwijl er sinds 2019 **992 publicaties**
> op deze zoekopdracht matchen. Precies waarom deze controle op records kijkt en
> niet op HTTP 200, en waarom ze de échte productiecode aanroept in plaats van
> een nagebouwd verzoek: fout 2 en 3 zijn alleen zo te vinden.

Deze bronnen falen allemaal **stil**. PDOK kan van pad veranderen, waarna
`gemeentelijst.js` ongemerkt terugvalt op de geojson en de dekkingscontrole een
verouderde lijst vergelijkt. De SRU-API antwoordt met HTTP 200 en nul records als
de query niet meer klopt — niet te onderscheiden van "er is deze week niets
gepubliceerd". Een hosting-deploy zonder `gemeenten.geojson` levert HTTP 200 met
de HTML-fallback erin. Op de statuscode alleen zien die drie er gezond uit,
daarom controleert dit script op bruikbare inhoud.

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

Die verificatie is inmiddels hard gemaakt: de wekelijkse `bronlinks.yml`-run van
**10 augustus 2026** haalde alle unieke URL's op vanaf een gewone runner en kreeg
op elk daarvan HTTP 200. Geen enkele bronlink was kapot of geblokkeerd.

### Bij de juiste omgevingsdienst

Een bronlink kan HTTP 200 geven en tóch de verkeerde organisatie zijn. Dat is een
ander soort fout dan een 404, en met geen enkele HTTP-controle te vinden — de
pagina bestaat immers gewoon. Vier groepen stonden verkeerd:

| Gemeenten | Stond op | Hoort bij | Waarom |
| --- | --- | --- | --- |
| 16 in Noord-Holland Noord (Alkmaar, Den Helder, Hoorn, Texel, …) | ODNZKG | `odnhn.nl` | ODNZKG bedient 8 gemeenten rond Amsterdam, niet heel Noord-Holland |
| 7 in Zaanstreek-Waterland en Uitgeest | ODNZKG | `odijmond.nl` | OD IJmond voert het bodembeheer voor deze gemeenten uit |
| 26 in de provincie Utrecht | ODRU | `odu.nl` | ODRU en RUD Utrecht zijn per 1-1-2026 gefuseerd tot Omgevingsdienst Utrecht |
| Barneveld, Ede, Nijkerk, Scherpenzeel, Wageningen | OD Veluwe / ODRU / Groene Metropool | `oddevallei.nl` | deze vijf vormen samen het bodembeheergebied van Omgevingsdienst de Vallei |

Na de correctie komen de aantallen precies uit op de deelnemerslijsten van de
diensten zelf: ODNZKG 8, OD IJmond 14, OD NHN 16, ODU 26, OddV 5.

Twee tests bewaken dit, omdat de linkcheck het niet kan zien: één met de
deelnemerslijst per dienst, en één die de mapping afwijst zodra er een domein van
een opgeheven organisatie in staat (`odrn.nl`, `odru.nl`, `rudutrecht.nl`,
`omgevingsdienst.nl`, …). Een gefuseerde dienst laat zijn oude domein vaak nog
jaren staan; zonder zo'n lijst blijft die link stilletjes "werken".

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
