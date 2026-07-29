const admin = require('firebase-admin');

// Initialize Firebase without credentials (uses ADC, might work if firebase-tools is logged in)
// If not, we will need to use a cloud function.
admin.initializeApp({
  projectId: 'pfas-dashboard-nl-a808d'
});

const db = admin.firestore();
const OLD_LINK = 'https://www.bodemplus.nl/onderwerpen/wet-regelgeving/rubrieken/pfas/handelingskader/';
const NEW_LINK = 'https://iplo.nl/thema/bodem/regelgeving/hergebruik-bouwstoffen-grond-of-baggerspecie/kwaliteitseisen-toepassen-grond-baggerspecie/handelingskader-pfas/';

async function run() {
  console.log('Fetching documents...');
  const snapshot = await db.collection('pfasData').get();
  
  let count = 0;
  let batch = db.batch();
  
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.bronLink === OLD_LINK || (data.bronLink && data.bronLink.includes('wegwijzer-bodem'))) {
      batch.update(doc.ref, { bronLink: NEW_LINK });
      count++;
    }
  });

  if (count > 0) {
    console.log(`Committing ${count} updates...`);
    await batch.commit();
    console.log('Updates committed.');
  } else {
    console.log('No documents needed updating.');
  }
}

run().catch(console.error);
