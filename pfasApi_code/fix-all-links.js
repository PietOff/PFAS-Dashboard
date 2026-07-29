const admin = require('firebase-admin');
const mapping = require('./gemeente_mapping.json');

// Uses Application Default Credentials (firebase-tools login)
admin.initializeApp({
  projectId: 'pfas-dashboard-nl-a808d'
});

const db = admin.firestore();

async function run() {
  console.log('Fetching all documents from pfasData...');
  const snapshot = await db.collection('pfasData').get();
  console.log('Total docs:', snapshot.size);
  
  let updates = [];
  
  snapshot.forEach(doc => {
    const data = doc.data();
    const naam = data.naam;
    const currentLink = data.bronLink;
    const correctLink = mapping[naam];
    
    if (correctLink && currentLink !== correctLink) {
      updates.push({ ref: doc.ref, naam, currentLink, correctLink });
    }
  });

  console.log('Links te updaten:', updates.length);

  if (updates.length === 0) {
    console.log('Geen updates nodig.');
    process.exit(0);
    return;
  }

  // Process in batches of 400
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch();
    const chunk = updates.slice(i, i + 400);
    chunk.forEach(u => {
      console.log(`  ${u.naam}: ${u.correctLink}`);
      batch.update(u.ref, { bronLink: u.correctLink });
    });
    await batch.commit();
    console.log(`Batch ${Math.floor(i/400)+1} committed (${chunk.length} docs)`);
  }
  
  console.log('\n✅ Klaar! Alle bronLinks bijgewerkt in Firestore.');
  process.exit(0);
}

run().catch(e => {
  console.error('❌ Fout:', e.message);
  process.exit(1);
});
