/**
 * Firebase Configuration & Modular SDK Exports
 * ---------------------------------------------
 * Replace the placeholder values below with your real Firebase web config
 * from the Firebase Console → Project Settings → Your apps → Web app.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ============================================================
// Firebase project: ai-booking-scheduler
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCj8NMD_FgvA4I5BqdGOU74xVucTS-zL6U",
  authDomain: "ai-booking-scheduler.firebaseapp.com",
  projectId: "ai-booking-scheduler",
  storageBucket: "ai-booking-scheduler.firebasestorage.app",
  messagingSenderId: "692249307485",
  appId: "1:692249307485:web:0b361291a7b007437160b4",
  measurementId: "G-VT1JGB0M4M"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
  Timestamp
};
