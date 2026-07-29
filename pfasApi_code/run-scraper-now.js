const admin = require('firebase-admin');
const { runWeeklyScraper } = require('./scraper');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'pfas-dashboard-nl-a808d'
  });
}
const db = admin.firestore();

process.env.GEMINI_API_KEY = "AIzaSyCU8parcxaNCPxZQ8QKy5uxCQRt8rJgLkc";

console.log("Handmatig de AI Scraper starten...");
runWeeklyScraper(db).then(() => {
  console.log("Scraper is klaar! Data is naar Firestore geschreven.");
  process.exit(0);
}).catch(err => {
  console.error("Fout:", err);
  process.exit(1);
});
