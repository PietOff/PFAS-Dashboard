const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // Wait, we don't have serviceAccountKey.json, but functions/index.js uses default creds
