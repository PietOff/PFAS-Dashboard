const axios = require('axios');
const csv = require('csv-parser');
const { toDocId } = require('./docId');

async function syncGoogleSheetToFirestore(db, sheetId) {
  if (!sheetId) {
    throw new Error("Geen Google Sheet ID opgegeven.");
  }
  
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  console.log(`Downloading CSV van ${csvUrl}...`);
  
  const response = await axios.get(csvUrl, { responseType: 'stream' });
  const result = [];
  
  return new Promise((resolve, reject) => {
    response.data
      .pipe(csv())
      .on('data', (data) => result.push(data))
      .on('end', async () => {
        try {
          console.log(`CSV geparst: ${result.length} rijen gevonden.`);
          let updateCount = 0;
          
          for (const row of result) {
            const gemeenteNaam = row.gemeente || row.Gemeente;
            if (!gemeenteNaam) continue;
            
            const docId = toDocId(gemeenteNaam);
            if (!docId) continue;
            
            // Bouw het update object
            const updateData = {
              gemeente: gemeenteNaam,
              laatstGeupdate: new Date().toISOString().split('T')[0],
              handmatigeOverschrijving: true
            };
            
            if (row.bron_link) updateData.bronLink = row.bron_link;
            if (row.opmerkingen) updateData.opmerkingen = row.opmerkingen;
            if (row.omgevingsdienst) updateData.omgevingsdienst = row.omgevingsdienst;
            
            // PFOA
            if (row.pfoa_wonen || row.pfoa_industrie || row.pfoa_natuur) {
              updateData.pfoa = {
                wonen: parseFloat(row.pfoa_wonen) || 7.0,
                industrie: parseFloat(row.pfoa_industrie) || 7.0,
                landbouwNatuur: parseFloat(row.pfoa_natuur) || 1.9
              };
            }
            
            // PFOS
            if (row.pfos_wonen || row.pfos_industrie || row.pfos_natuur) {
              updateData.pfos = {
                wonen: parseFloat(row.pfos_wonen) || 3.0,
                industrie: parseFloat(row.pfos_industrie) || 3.0,
                landbouwNatuur: parseFloat(row.pfos_natuur) || 1.4
              };
            }
            
            // GenX
            if (row.genx_wonen || row.genx_industrie || row.genx_natuur) {
              updateData.genx = {
                wonen: parseFloat(row.genx_wonen) || 3.0,
                industrie: parseFloat(row.genx_industrie) || 3.0,
                landbouwNatuur: parseFloat(row.genx_natuur) || 0.8
              };
            }
            
            await db.collection('pfasData').doc(docId).set(updateData, { merge: true });
            updateCount++;
          }
          
          resolve(updateCount);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', reject);
  });
}

module.exports = { syncGoogleSheetToFirestore };
