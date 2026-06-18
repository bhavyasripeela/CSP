// Import the core Firebase App setup
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";

// Import Authentication and Firestore database tools
import { getAuth } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDZ5Fr-VcbGG6T0OUfMTRXSsdpWXeGaABU",
  authDomain: "smartheal-csp.firebaseapp.com",
  projectId: "smartheal-csp",
  storageBucket: "smartheal-csp.firebasestorage.app",
  messagingSenderId: "869203745689",
  appId: "1:869203745689:web:dc3e7145c1f6ee8b4c9108"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Auth and Database
const auth = getAuth(app);
const db = getFirestore(app);

// Export them so your frontend files can connect to them
export { app, auth, db };