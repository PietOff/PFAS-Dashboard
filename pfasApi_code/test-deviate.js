const admin = require('firebase-admin');

// Initialize Firebase Admin (assuming default credentials work here, or we need the service account)
// Since this is run from the same environment where firebase-tools is authenticated, it might need the project ID.
admin.initializeApp({
  projectId: 'pfas-dashboard-nl-a808d'
});

const db = admin.firestore();

async function run() {
  await db.collection('pfasData').doc('amsterdam').set({
    gemeente: 'Amsterdam',
    omgevingsdienst: 'Test OD',
    provincie: 'Noord-Holland',
    pfoa: { wonen: 2.0, industrie: 2.0, landbouwNatuur: 1.0 }, // Deviating!
    pfos: { wonen: 1.0, industrie: 1.0, landbouwNatuur: 0.5 }, // Deviating!
    genx: { wonen: 1.0, industrie: 1.0, landbouwNatuur: 0.5 },
    opmerkingen: 'Let op: Dit is een handmatige test-injectie om de oranje kleur te testen.',
    bronLink: 'https://test.nl'
  }, { merge: true });
  console.log('Amsterdam updated to deviate!');
}

run().catch(console.error);
