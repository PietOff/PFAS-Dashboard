const admin = require('firebase-admin');

// Haal project id uit firebase config of probeer default credentials
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'pfas-dashboard-nl-a808d'
});

const db = admin.firestore();

const fallbackData = [
  {
    gemeente: "Rotterdam",
    omgevingsdienst: "DCMR Milieudienst Rijnmond",
    provincie: "Zuid-Holland",
    pfoa: { wonen: 7.0, industrie: 7.0, landbouwNatuur: 1.9 },
    pfos: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 1.4 },
    genx: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 0.8 },
    laatstGeupdate: "2024-01-15",
    opmerkingen: "Volgt landelijk Handelingskader voor grondverzet. Kaarten en details via DCMR bodemloket.",
    bronLink: "https://www.dcmr.nl/bodem/pfas"
  },
  {
    gemeente: "Amsterdam",
    omgevingsdienst: "ODNZKG",
    provincie: "Noord-Holland",
    pfoa: { wonen: 7.0, industrie: 7.0, landbouwNatuur: 1.9 },
    pfos: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 1.4 },
    genx: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 0.8 },
    laatstGeupdate: "2025-01-01",
    opmerkingen: "Nieuwe Bodemkwaliteitskaart in 2025 vastgesteld. Let op: alle PFAS gelden als ZZS.",
    bronLink: "https://odnzkg.nl/themas/bodem/pfas/"
  },
  {
    gemeente: "'s-Hertogenbosch",
    omgevingsdienst: "ODBN",
    provincie: "Noord-Brabant",
    pfoa: { wonen: 7.0, industrie: 7.0, landbouwNatuur: 1.9 },
    pfos: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 1.4 },
    genx: { wonen: 3.0, industrie: 3.0, landbouwNatuur: 0.8 },
    laatstGeupdate: "2024-05-12",
    opmerkingen: "Volgt landelijk handelingskader (update dec 2023).",
    bronLink: "https://odbn.nl/pfas/"
  }
];

async function seed() {
  try {
    const batch = db.batch();
    fallbackData.forEach((data, index) => {
      const docRef = db.collection('pfasData').doc(String(index + 1));
      batch.set(docRef, data);
    });
    await batch.commit();
    console.log('Seeding successful!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  }
}

seed();
