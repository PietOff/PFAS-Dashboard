const odmhAdapter = require('./odmh');

// Mapping van gemeenten naar specifieke Omgevingsdienst adapters
// Gemeentenamen moeten lowercase zijn.
const MUNICIPALITY_TO_ADAPTER = {
  'gouda': odmhAdapter,
  'waddinxveen': odmhAdapter,
  'bodegraven-reeuwijk': odmhAdapter,
  'krimpenerwaard': odmhAdapter,
  'zuidplas': odmhAdapter,
};

/**
 * Controleert of er een directe API-adapter is voor deze gemeente.
 * @param {string} gemeente - De naam van de gemeente
 * @returns {Promise<Object|null>} - De data uit de API of null als er geen adapter is / ophalen mislukt.
 */
async function getAdapterData(gemeente) {
  try {
    const normalizedGemeente = gemeente.toLowerCase().trim();
    const adapter = MUNICIPALITY_TO_ADAPTER[normalizedGemeente];
    
    if (adapter) {
      console.log(`[AdapterManager] Adapter gevonden voor ${gemeente}. Start API scraping...`);
      return await adapter.fetchData(gemeente);
    }
    
    return null; // Geen adapter beschikbaar
  } catch (error) {
    console.error(`[AdapterManager] Fout bij het ophalen via adapter voor ${gemeente}:`, error);
    return null; // Val terug op AI bij een fout
  }
}

module.exports = {
  getAdapterData
};
