# SmartHeal — Firebase Setup Guide
## Doctor Approval Workflow

---

## 1. Firestore Collections Schema

### `doctorApplications/{uid}`
```json
{
  "uid": "firebase-auth-uid",
  "name": "Dr. Priya Sharma",
  "email": "priya.sharma@example.com",
  "phone": "9876543210",
  "specialization": "General Physician",
  "licenseNumber": "MCI-2024-AP-12345",
  "doctorId": "DOC1001",
  "status": "pending",
  "approved": false,
  "submittedAt": "Timestamp (serverTimestamp())",
  "approvedAt": "Timestamp | null",
  "rejectedAt": "Timestamp | null"
}
```

### `users/{uid}`
Created/updated on admin approval:
```json
{
  "uid": "firebase-auth-uid",
  "role": "doctor",
  "approved": true,
  "doctorId": "DOC1001",
  "name": "Dr. Priya Sharma",
  "specialization": "General Physician",
  "email": "priya.sharma@example.com",
  "updatedAt": "Timestamp"
}
```

---

## 2. Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── Doctor Applications ──
    match /doctorApplications/{uid} {
      // Doctor can create their own application
      allow create: if request.auth != null
                    && request.auth.uid == uid
                    && request.resource.data.status == 'pending'
                    && request.resource.data.approved == false;

      // Doctor can read only their own application
      allow read: if request.auth != null
                  && request.auth.uid == uid;

      // Only admins can update (approve/reject)
      allow update: if request.auth != null
                    && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';

      allow delete: if false;
    }

    // ── Users ──
    match /users/{uid} {
      // User can read their own document
      allow read: if request.auth != null && request.auth.uid == uid;

      // Admins can read all user documents
      allow read: if request.auth != null
                  && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';

      // Only admins can write user documents
      allow write: if request.auth != null
                   && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }

    // ── Admin full access ──
    match /{document=**} {
      allow read, write: if request.auth != null
                         && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
  }
}
```

---

## 3. Firebase Configuration

### `firebase-config.js` (create this file, add to all HTML pages)
```javascript
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
```

---

## 4. doctor-apply.html — Firebase Integration

Replace the localStorage submit block in `submitApplication()`:

```javascript
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase-config.js';

async function submitApplication() {
  const btn = document.getElementById('submitBtn');
  btn.classList.add('loading');
  try {
    // 1. Create Firebase Auth account
    const cred = await createUserWithEmailAndPassword(auth, appData.email, appData.pw);
    const uid = cred.user.uid;

    // 2. Store application in Firestore
    await setDoc(doc(db, 'doctorApplications', uid), {
      uid,
      name: `${appData.fname} ${appData.lname}`,
      email: appData.email,
      phone: appData.phone,
      specialization: appData.spec,
      licenseNumber: appData.license,
      status: 'pending',
      approved: false,
      submittedAt: serverTimestamp()
    });

    // 3. Show success state
    btn.classList.remove('loading');
    document.getElementById('app-ref-id').textContent = uid.slice(0, 12).toUpperCase();
    document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panelSuccess').classList.add('active');

  } catch (err) {
    btn.classList.remove('loading');
    const code = err.code;
    const msgs = {
      'auth/email-already-in-use': 'This email is already registered.',
      'auth/weak-password': 'Password is too weak. Use at least 8 characters.',
      'auth/invalid-email': 'Invalid email address.'
    };
    document.getElementById('submit-error-text').textContent = msgs[code] || err.message;
    document.getElementById('submit-error').classList.add('show');
  }
}
```

---

## 5. loginn_fixed.html — Firebase Doctor Login

Replace the localStorage check inside `handleLogin()` for doctors:

```javascript
if (currentRole === 'doctor') {
  const { signInWithEmailAndPassword } = await import('firebase/auth');
  const { doc, getDoc, collection, query, where, getDocs } = await import('firebase/firestore');
  try {
    // 1. Look up doctorId in doctorApplications to find email
    const enteredId = id.toUpperCase().trim();
    const appsRef = collection(db, 'doctorApplications');
    const q = query(appsRef, where('doctorId', '==', enteredId));
    const snap = await getDocs(q);
    if (snap.empty) {
      showMsg('loginError', 'error', '⚠️', `Doctor ID "${enteredId}" not found. Apply via the link below.`);
      return;
    }
    const appData = snap.docs[0].data();

    // 2. Sign in with Firebase Auth using stored email + entered password
    const cred = await signInWithEmailAndPassword(auth, appData.email, pw);
    const uid = cred.user.uid;

    // 3. Re-fetch application to check approval status
    const appSnap = await getDoc(doc(db, 'doctorApplications', uid));
    if (!appSnap.exists()) {
      showMsg('loginError', 'error', '⚠️', 'No doctor application found for this account.');
      return;
    }
    const latest = appSnap.data();

    // 4. Approval gate
    if (latest.status === 'rejected') {
      showMsg('loginError', 'error', '❌', 'Your application was rejected. Contact hospital administration.');
      return;
    }
    if (!latest.approved || latest.status !== 'approved') {
      showMsg('loginError', 'warning', '⏳',
        'Your account is awaiting administrator approval. You will be notified by email.');
      return;
    }

    // 5. Approved — store session and redirect
    localStorage.setItem('currentUser', uid);
    localStorage.setItem('currentDoctor', JSON.stringify({ uid, doctorId: latest.doctorId, name: latest.name, specialization: latest.specialization }));
    loginSuccess(btn, r.redirect, uid);

  } catch (err) {
    const code = err.code;
    const msgs = {
      'auth/wrong-password': 'Incorrect password. Please try again.',
      'auth/too-many-requests': 'Too many attempts. Please wait a moment.'
    };
    showMsg('loginError', 'error', '⚠️', msgs[code] || err.message);
    shake(document.getElementById('loginCard'));
  }
  return;
}
```

---

## 6. admin.html — Firebase Approve/Reject

Replace `approveDoctor()` and `rejectDoctor()`:

```javascript
async function approveDoctor(uid) {
  const { doc, updateDoc, setDoc, serverTimestamp, getDocs, collection, query, orderBy } = await import('firebase/firestore');
  try {
    // 1. Generate next Doctor ID
    const appsSnap = await getDocs(query(collection(db, 'doctorApplications')));
    let maxNum = 1000;
    appsSnap.forEach(d => {
      const id = d.data().doctorId;
      if (id && /^DOC\d+$/.test(id)) {
        const n = parseInt(id.replace('DOC', ''), 10);
        if (n > maxNum) maxNum = n;
      }
    });
    const doctorId = 'DOC' + (maxNum + 1);

    // 2. Update application status
    await updateDoc(doc(db, 'doctorApplications', uid), {
      status: 'approved',
      approved: true,
      doctorId,
      approvedAt: serverTimestamp()
    });

    // 3. Create/update user document with role and doctorId
    const app = allApplications.find(a => a.uid === uid);
    await setDoc(doc(db, 'users', uid), {
      uid,
      role: 'doctor',
      approved: true,
      doctorId,
      name: app.name,
      specialization: app.specialization,
      email: app.email,
      updatedAt: serverTimestamp()
    });

    showAdminToast('success', '✅', `Dr. ${app.name} approved — Doctor ID: ${doctorId}`);
    loadApplications(); // refresh list
  } catch (err) {
    alert('Approval failed: ' + err.message);
  }
}

async function rejectDoctor(uid) {
  const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore');
  try {
    await updateDoc(doc(db, 'doctorApplications', uid), {
      status: 'rejected',
      approved: false,
      rejectedAt: serverTimestamp()
    });
    const app = allApplications.find(a => a.uid === uid);
    showAdminToast('reject', '✗', `Application for ${app.name} has been rejected.`);
    loadApplications();
  } catch (err) {
    alert('Rejection failed: ' + err.message);
  }
}
```

---

## 7. File Modification Summary

| File | What Changed |
|------|-------------|
| `doctor-apply.html` | **NEW FILE** — 3-step doctor application form |
| `loginn_fixed.html` | `handleLogin()` now checks `approved` flag for doctors; shows pending message; adds "Apply" link |
| `admin.html` | New **Doctor Applications** section with Approve/Reject controls + pending badge in sidebar |
| `smart-heal-sync.js` | No changes needed |
| `doctor-fixed.html` | No changes needed (add session guard later if desired) |