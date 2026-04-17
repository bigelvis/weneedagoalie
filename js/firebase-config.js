import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDOvPnszOEGHnj2sqzLVn7ccMHRGIs6OZU",
  authDomain: "weneedagoalie.firebaseapp.com",
  projectId: "weneedagoalie",
  storageBucket: "weneedagoalie.firebasestorage.app",
  messagingSenderId: "151415451382",
  appId: "1:151415451382:web:5a29a552ccd092682986d7"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };
