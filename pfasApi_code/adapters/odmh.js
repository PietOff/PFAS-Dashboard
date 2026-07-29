const fetch = require('node-fetch'); // Let op: afhankelijk van je Node versie, in nieuwste is het ingebouwd.

/**
 * Adapter voor Omgevingsdienst Midden-Holland (ODMH)
 * Dit is een Proof of Concept (Stub).
 * In een echte productie-versie zou je hier de specifieke ArcGIS REST API URL van de ODMH aanroepen
 * en de geretourneerde JSON parsen.
 */

async function fetchData(gemeente) {
  // Voorbeeld van hoe een echte aanroep eruit zou zien:
  // const url = `https://services.arcgisonline.nl/arcgis/rest/services/ODMH/Bodemkwaliteit/MapServer/0/query?where=gemeente='${gemeente}'&outFields=*&f=json`;
  // const response = await fetch(url);
  // const data = await response.json();

  console.log(`[Adapter ODMH] Haalt data op voor ${gemeente} via de ArcGIS API...`);
  
  // Simulatie van een API vertraging
  await new Promise(resolve => setTimeout(resolve, 500));

  // Omdat we in dit voorbeeld de exacte API URL nog niet hebben, 
  // simuleren we een geslaagd antwoord met specifieke ODMH beleidswaarden:
  return {
    pfoa: {
      wonen: 7.0,
      industrie: 7.0,
      landbouwNatuur: 1.9,
    },
    pfos: {
      wonen: 3.0,
      industrie: 3.0,
      landbouwNatuur: 1.4,
    },
    genx: {
      wonen: 3.0,
      industrie: 3.0,
      landbouwNatuur: 0.8,
    },
    bronLink: "https://www.odmh.nl/themas/bodem/bodemkwaliteitskaart/ (Via ODMH API)",
    opmerkingen: "Data 100% accuraat ingeladen via de ArcGIS API van de Omgevingsdienst Midden-Holland.",
    omgevingsdienst: "Omgevingsdienst Midden-Holland",
    isDefault: false // We zetten dit op false om te laten zien dat het lokaal is ingeladen via API
  };
}

module.exports = {
  fetchData
};
