const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // assuming it doesn't exist, we'll try without if it fails
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

async function check() {
  const snapshot = await db.collection('pfasData').get();
  snapshot.forEach(doc => {
    const data = doc.data();
    let maxVal = 0;
    ['pfoa', 'pfos', 'genx'].forEach(stof => {
       if (data[stof]) {
         ['wonen', 'industrie', 'landbouwNatuur'].forEach(klasse => {
            if (data[stof][klasse] > maxVal) maxVal = data[stof][klasse];
         });
       }
    });
    if (maxVal > 50) {
      console.log(data.gemeente, "has crazy value:", maxVal);
      console.log(data.pfoa, data.pfos, data.genx);
    }
  });
}
check();
