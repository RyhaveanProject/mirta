import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBpHCFFXChXiFHm_zQrx5dIwwrGDeF73Ag",
  authDomain: "ryhavean.firebaseapp.com",
  projectId: "ryhavean",
  storageBucket: "ryhavean.firebasestorage.app",
  messagingSenderId: "1090136784407",
  appId: "1:1090136784407:web:c7120e092be2d3d43be652",
  measurementId: "G-SN5QQCM7ZF",
  // Yeni regionlu linkini bura əlavə etdik:
  databaseURL: "https://ryhavean-default-rtdb.europe-west1.firebasedatabase.app/" 
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
