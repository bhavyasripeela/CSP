import { db } from '../Backend/firebase-config.js';
import { collection, doc, setDoc, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

window.SmartHealSync = {

    // ── PHASE 8: REAL-TIME SYNCHRONIZATION ──
    // Call this when a dashboard loads to listen for live updates across devices
    initRealTimeSync(onDataChangedCallback) {
        console.log("[SmartHeal Sync] Starting Real-Time Firestore Listeners...");

        // Listen to Queue Records (Phase 6)
        onSnapshot(collection(db, "queueRecords"), (snapshot) => {
            const liveQueue = [];
            snapshot.forEach(doc => liveQueue.push(doc.data()));
            liveQueue.sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));
            
            localStorage.setItem("hospitalQueue", JSON.stringify(liveQueue));
            if (onDataChangedCallback) onDataChangedCallback();
        });

        // Listen to Visit History (Phase 9)
        onSnapshot(collection(db, "visitHistory"), (snapshot) => {
            const visits = [];
            snapshot.forEach(doc => visits.push(doc.data()));
            localStorage.setItem("smartheal_visitHistory", JSON.stringify(visits));
            if (onDataChangedCallback) onDataChangedCallback();
        });

        // Listen to Global Token Counters (Phase 7)
        onSnapshot(doc(db, "departmentCounters", "global"), (docSnap) => {
            if (docSnap.exists()) {
                localStorage.setItem("smartheal_tokenCounter", String(docSnap.data().count || 0));
            }
        });
    },

    getQueue() {
        return JSON.parse(localStorage.getItem("hospitalQueue") || "[]");
    },

    async setQueue(queue) {
        // Instant UI update
        localStorage.setItem("hospitalQueue", JSON.stringify(queue));

        // Background sync to Firestore (Phase 6)
        try {
            const batch = writeBatch(db);
            queue.forEach(record => {
                // Create a unique document ID for each queue entry
                const docId = `Q-${record.token}-${record.phone || 'NA'}`.replace(/[^a-zA-Z0-9-]/g, '');
                const docRef = doc(db, "queueRecords", docId);
                batch.set(docRef, record, { merge: true });
            });
            await batch.commit();
        } catch (error) {
            console.error("Firebase Sync Error (Queue):", error);
        }
    },

    tokenToNum(token) {
        return parseInt(String(token).replace("#", ""), 10);
    },

    formatToken(num) {
        return "#" + String(num).padStart(3, "0");
    },

    getDoctorState() {
        return JSON.parse(localStorage.getItem("doctorState") || "{}");
    },

    async saveDoctorState(state) {
        localStorage.setItem("doctorState", JSON.stringify(state));
        try {
            const uid = localStorage.getItem("currentUser") || "unknown";
            await setDoc(doc(db, "doctors", uid), { state: state }, { merge: true });
        } catch (e) { console.error(e); }
    },

    async addDoctorFollowup(followup) {
        const arr = JSON.parse(localStorage.getItem("doctorFollowups") || "[]");
        arr.push(followup);
        localStorage.setItem("doctorFollowups", JSON.stringify(arr));

        // Phase 12: Follow-Up System
        try {
            const docId = `FU-${Date.now()}`;
            await setDoc(doc(db, "followUps", docId), followup);
        } catch (e) { console.error(e); }
    },

    getDoctorFollowups() {
        return JSON.parse(localStorage.getItem("doctorFollowups") || "[]");
    },

    // ── Token counter (shared between patient app and doctor dashboard) ──
    getTokenCounter() {
        return parseInt(localStorage.getItem("smartheal_tokenCounter") || "0", 10);
    },

    async setTokenCounter(val) {
        localStorage.setItem("smartheal_tokenCounter", String(val));
        try {
            await setDoc(doc(db, "departmentCounters", "global"), { count: parseInt(val, 10) }, { merge: true });
        } catch (e) { console.error(e); }
    },

    // ── Now-serving / calling ──
    getNowServing() {
        return localStorage.getItem("smartheal_nowServing") || null;
    },

    async setNowServing(val) {
        if (val === null || val === undefined) {
            localStorage.removeItem("smartheal_nowServing");
        } else {
            localStorage.setItem("smartheal_nowServing", String(val));
            try {
                await setDoc(doc(db, "system", "status"), { nowServing: String(val) }, { merge: true });
            } catch (e) { console.error(e); }
        }
    },

    getCalling() {
        return localStorage.getItem("smartheal_calling") || null;
    },

    async setCalling(val) {
        if (val === null || val === undefined) {
            localStorage.removeItem("smartheal_calling");
        } else {
            localStorage.setItem("smartheal_calling", String(val));
            try {
                await setDoc(doc(db, "system", "status"), { calling: String(val) }, { merge: true });
            } catch (e) { console.error(e); }
        }
    },

    // ── Health records ──
    getHealthRecords() {
        return JSON.parse(localStorage.getItem("smartheal_healthRecords") || "[]");
    },

    async appendHealthRecord(record) {
        const records = this.getHealthRecords();
        records.push(record);
        localStorage.setItem("smartheal_healthRecords", JSON.stringify(records));

        // Phase 11: MediVault Storage
        try {
            const docId = `MED-${Date.now()}`;
            await setDoc(doc(db, "medicalDocuments", docId), record);
        } catch (e) { console.error(e); }
    },

    // ── Visit History ──
    getAllVisits() {
        return JSON.parse(localStorage.getItem("smartheal_visitHistory") || "[]");
    },

    async saveAllVisits(visits) {
        localStorage.setItem("smartheal_visitHistory", JSON.stringify(visits));
        try {
            const batch = writeBatch(db);
            visits.forEach(v => {
                const docRef = doc(db, "visitHistory", v.visitId);
                batch.set(docRef, v, { merge: true });
            });
            await batch.commit();
        } catch (e) { console.error(e); }
    },

    createVisit(visitData) {
        const visits = this.getAllVisits();
        const newVisit = {
            visitId: "VIS-" + String(visits.length + 1).padStart(3, "0") + "-" + Date.now().toString().slice(-4),
            createdAt: Date.now(),
            doctor: visitData.doctor || null,
            consultationNote: visitData.consultationNote || null,
            prescription: visitData.prescription || null,
            followUp: visitData.followUp || null,
            ...visitData
        };
        visits.push(newVisit);
        this.saveAllVisits(visits); 
        
        // Phase 10: Store Consultation Notes
        if (newVisit.consultationNote) {
            setDoc(doc(db, "consultationNotes", newVisit.visitId), {
                visitId: newVisit.visitId,
                notes: newVisit.consultationNote,
                createdDate: new Date().toISOString()
            }).catch(console.error);
        }

        return newVisit;
    },

    getVisitsByPhone(phone) {
        if (!phone || phone === "—") return [];
        const norm = String(phone).replace(/\D/g, "");
        return this.getAllVisits()
            .filter(v => String(v.phone || "").replace(/\D/g, "") === norm)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    attachConsultationToVisit(visitId, patch) {
        const visits = this.getAllVisits();
        const idx = visits.findIndex(v => v.visitId === visitId);
        if (idx !== -1) {
            visits[idx] = { ...visits[idx], ...patch };
            this.saveAllVisits(visits);
            
            // Phase 10: Store individual Consultation Note updates
            if (patch.consultationNote) {
                setDoc(doc(db, "consultationNotes", visitId), {
                    visitId: visitId,
                    notes: patch.consultationNote,
                    createdDate: new Date().toISOString()
                }, { merge: true }).catch(console.error);
            }
        }
    },

    getUpcomingFollowUps(phone) {
        if (!phone || phone === "—") return [];
        const norm = String(phone).replace(/\D/g, "");
        return this.getAllVisits()
            .filter(v => String(v.phone || "").replace(/\D/g, "") === norm && v.followUpDate)
            .sort((a, b) => (a.followUpDate > b.followUpDate ? 1 : -1));
    }
};