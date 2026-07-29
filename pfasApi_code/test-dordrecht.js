const { analyzeWithGemini } = require('./scraper.js');
const admin = require('firebase-admin');

// Initialize Firebase Admin (using Application Default Credentials if possible, or mock it)
// Wait, we don't need to write to firestore immediately, let's just log the result of analyzeWithGemini.

async function test() {
  try {
    const result = await analyzeWithGemini('Dordrecht');
    console.log("AI Result for Dordrecht:");
    console.log(JSON.stringify(result, null, 2));
    
    // Now let's try to update the database
    // We will initialize firebase if we can
    const projectId = process.env.FIREBASE_PROJECT_ID || 'pfas-dashboard-nl-a808d';
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: projectId
      });
    }
    const db = admin.firestore();
    
    // Check if the result is valid
    if (result && result.bronLink) {
       const docRef = db.collection('pfasData').doc('Dordrecht');
       await docRef.set(result, { merge: true });
       console.log("Succesfully updated Dordrecht in Firestore.");
    }
    
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
