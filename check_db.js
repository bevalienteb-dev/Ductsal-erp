const firebase = require('firebase/app');
require('firebase/firestore');

const firebaseConfig = {
  apiKey: "AIzaSyBSnGhwh043oV_zW1FlE5z7N8_ywh9FUEA",
  authDomain: "ductsal-erp.firebaseapp.com",
  projectId: "ductsal-erp",
  storageBucket: "ductsal-erp.firebasestorage.app",
  messagingSenderId: "948658286825",
  appId: "1:948658286825:web:e3008dc00f714e57aa0078",
  measurementId: "G-32JZ4MV4FR"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

async function check() {
  const local = await db.collection('prospects_local').get();
  const prod = await db.collection('prospects_prod').get();
  const old = await db.collection('prospects').get();
  console.log("Local prospects count:", local.size);
  console.log("Prod prospects count:", prod.size);
  console.log("Old prospects count:", old.size);
  process.exit(0);
}
check();
