// src/firebase.js
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "SƏNİN_API_KEY",
  authDomain: "layihe-adi.firebaseapp.com",
  databaseURL: "https://layihe-adi-default-rtdb.firebaseio.com", // BU VACİBDİR
  projectId: "layihe-adi",
  storageBucket: "layihe-adi.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:12345:web:abcdef"
};

// Firebase-i başladırıq
const app = initializeApp(firebaseConfig);

// Realtime Database-i ixrac edirik ki, App.js-də istifadə edək
export const db = getDatabase(app);
