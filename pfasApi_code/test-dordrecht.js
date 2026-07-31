/**
 * Handmatige check: wat vindt de AI-scan voor één gemeente?
 *
 * Dit script riep eerder `analyzeWithGemini` aan, een functie die scraper.js
 * nooit geëxporteerd heeft — het faalde dus altijd meteen. Het gebruikt nu
 * scanForNewPolicy, dezelfde functie die de scraper zelf draait.
 *
 * Gebruik: GEMINI_API_KEY=... node test-dordrecht.js [gemeentenaam]
 *
 * Let op: dit schrijft NIETS naar Firestore. De AI-scan is bewust alleen een
 * signaalgever — de waarden in pfas_normen.json blijven leidend. De oude versie
 * schreef het AI-antwoord rechtstreeks naar het document 'Dordrecht' (met
 * hoofdletter, dus ook nog eens een ander document dan 'dordrecht').
 */
const { scanForNewPolicy } = require('./scraper.js');

const gemeente = process.argv[2] || 'Dordrecht';

async function test() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ontbreekt. Start met: GEMINI_API_KEY=... node test-dordrecht.js');
    process.exit(1);
  }

  const result = await scanForNewPolicy(gemeente);
  console.log(`AI-scan resultaat voor ${gemeente}:`);
  console.log(JSON.stringify(result, null, 2));
}

test().catch(err => {
  console.error('Fout:', err);
  process.exit(1);
});
