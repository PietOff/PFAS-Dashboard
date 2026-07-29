# PFAS Dashboard — API

Backend (Firebase Cloud Functions) achter het PFAS-dashboard op
<https://pfas-dashboard-nl-a808d.web.app/>.

De API levert per Nederlandse gemeente de geldende PFAS-normen voor grondverzet
(PFOS, PFOA, GenX) en signaleert nieuw lokaal bodembeleid via de officiële
bekendmakingen van de overheid.

> **Let op:** in deze repository staat alleen de **backend**. De frontend die op
> `pfas-dashboard-nl-a808d.web.app` draait — inclusief `gemeenten.geojson`, dat
> `fillDefaultData` en de scraper ophalen — zit hier niet in en staat dus ook
> niet onder versiebeheer. `firebase.json` bevat daarom bewust **geen**
> `hosting`-blok: een deploy vanuit deze repo mag de live site niet overschrijven.

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

### Juistheid: kloppen de getallen?

**De app scrapet de getallen niet en hoort dat ook niet te doen.**
`pfas_normen.json` is leidend: het landelijk kader plus een handmatig
geverifieerde lijst van gemeenten die daarvan afwijken. `getHardcodedData()`
geeft die waarden terug; de AI-scan schrijft nooit een getal naar het dashboard.

Dat is bewust. Een gehallucineerde norm voor grondverzet is erger dan geen norm,
want iemand handelt ernaar. Meer gemeenten scrapen maakt geen enkel getal
juister — het vult alleen meer rijen met dezelfde aanname.

De juistheid hangt dus aan één vraag: **klopt de lijst met afwijkende
gemeenten?** Op dit moment staan er 12 in. Elke gemeente die lokaal beleid heeft
maar niet in die lijst staat, toont nu het landelijk kader alsof dat vaststaat.

Er bestaat geen landelijk register van lokale PFAS-normen, dus dit is geen
technisch probleem dat je wegprogrammeert. Wat het systeem wel kan:

1. **Officiële Bekendmakingen als enige automatische bron.** `checkBekendmakingen`
   leest de SRU API van KOOP. Dat is juridisch bindend gepubliceerd beleid — de
   enige machineleesbare bron die als vaststaand mag gelden.
2. **Alles anders belandt in `pfasSignalen`** voor handmatige review, niet in het
   dashboard.
3. **Toon het verschil in de UI.** Een waarde die uit een gemeenteblad komt is
   iets anders dan de aanname "volgt landelijk kader". `heeftAfwijkendBeleid`,
   `bronType` en `confidenceScore` staan al in de documenten; presenteer een
   aanname nooit als een vaststelling.

### Bronlinks

`check-links.js` controleert of de links in `gemeente_mapping.json` bestaan:

```bash
node check-links.js --kapot      # alleen de kapotte
node check-links.js --json > rapport.json
```

Dit is nodig omdat de links deels gegokt zijn: 152 van de 349 deelden exact het
pad `/themas/bodem` en 103 waren alleen een homepage. De prompt in
`findRealLinks` droeg de AI letterlijk op om bij twijfel de homepage van de
meest waarschijnlijke omgevingsdienst te geven. Een link die 404 geeft is voor
een gebruiker erger dan geen link.

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
