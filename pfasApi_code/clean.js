const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'pfas-dashboard-nl-a808d' });
const db = admin.firestore();

async function clean() {
  const snapshot = await db.collection('pfasData').get();
  let count = 0;
  let batch = db.batch();
  snapshot.forEach(doc => {
    const data = doc.data();
    let isCrazy = false;
    ['pfoa', 'pfos', 'genx'].forEach(stof => {
       if (data[stof]) {
         ['wonen', 'industrie', 'landbouwNatuur'].forEach(klasse => {
            if (data[stof][klasse] > 50) isCrazy = true;
         });
       }
    });
    
    if (isCrazy) {
      console.log(`Fixing crazy data for ${data.gemeente}...`);
      // Reset to national framework
      const defaultData = {
        pfoa: { wonen: 7, industrie: 7, landbouwNatuur: 1.9 },
        pfos: { wonen: 3, industrie: 3, landbouwNatuur: 1.4 },
        genx: { wonen: 3, industrie: 3, landbouwNatuur: 0.8 },
        opmerkingen: (data.opmerkingen || '') + " [AI retourneerde onwaarschijnlijke waarden, gereset naar landelijk kader].",
        confidenceScore: 0
      };
      batch.update(doc.ref, defaultData);
      count++;
    }
  });
  if (count > 0) {
    await batch.commit();
    console.log(`Fixed ${count} municipalities.`);
  } else {
    console.log("No crazy data found!");
  }
}
clean().catch(console.error);
