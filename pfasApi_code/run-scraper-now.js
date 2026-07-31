const admin = require('firebase-admin');
const { runWeeklyScraper } = require('./scraper');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || 'pfas-dashboard-nl-a808d'
  });
}
const db = admin.firestore();

// De API-sleutel hoort NIET in de repo. Meegeven via de omgeving:
//   GEMINI_API_KEY=... node run-scraper-now.js
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY ontbreekt. Start met: GEMINI_API_KEY=... node run-scraper-now.js');
  process.exit(1);
}

console.log("Handmatig de AI Scraper starten...");
runWeeklyScraper(db).then(() => {
  console.log("Scraper is klaar! Data is naar Firestore geschreven.");
  process.exit(0);
}).catch(err => {
  console.error("Fout:", err);
  process.exit(1);
});
