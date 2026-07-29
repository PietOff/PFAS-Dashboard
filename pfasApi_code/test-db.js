const admin = require('firebase-admin');

// serviceAccountKey.json bestaat niet in deze repo (en hoort er ook niet in);
// gebruik Application Default Credentials via `firebase login` / gcloud.
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || 'pfas-dashboard-nl-a808d'
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
