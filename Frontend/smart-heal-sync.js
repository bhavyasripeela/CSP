import { auth, db } from "./firebase-config.js";
import { collection, doc, setDoc, onSnapshot, writeBatch, runTransaction, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

window.SmartHealSync = {

    // ── PHASE 8 & 14: REAL-TIME SYNCHRONIZATION ──
    // Call this when a dashboard loads to listen for live updates across devices
    initRealTimeSync(onDataChangedCallback) {
        console.log("[SmartHeal Sync] Starting Real-Time Firestore Listeners...");

        // ── PHASE 6: AUTOMATIC DAILY QUEUE ARCHIVE & RESET ──
        // Runs once per calendar day, race-safe across simultaneous devices (see
        // checkAndRunDailyReset for the Firestore-transaction explanation).
        this.checkAndRunDailyReset().catch(e => console.error("[SmartHeal Sync] Daily reset check failed:", e));

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

        // Listen to Doctor Applications (Phase 2)
        onSnapshot(collection(db, "doctorApplications"), (snapshot) => {
            const apps = [];
            snapshot.forEach(doc => apps.push(doc.data()));

            // Save full list for admin dashboard
            localStorage.setItem("doctorApplications", JSON.stringify(apps));

            // Save approved list for the doctor login verification system
            const approvedDoctors = apps.filter(a => a.status === 'approved' && a.approved === true);
            localStorage.setItem("smartheal_doctors", JSON.stringify(approvedDoctors));

            if (onDataChangedCallback) onDataChangedCallback();
        });
        // Listen to Feedback (Phase 14 - Admin Dashboard)
        onSnapshot(collection(db, "feedback"), (snapshot) => {
            const feedbacks = [];
            snapshot.forEach(doc => feedbacks.push(doc.data()));
            // Sort by newest first
            feedbacks.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
            localStorage.setItem("smartheal_feedbacks", JSON.stringify(feedbacks));
            if (onDataChangedCallback) onDataChangedCallback();
        });

        // Listen to Notifications (Phase 16)
        onSnapshot(collection(db, "notifications"), (snapshot) => {
            const notifs = [];
            snapshot.forEach(doc => {
                notifs.push({ id: doc.id, ...doc.data() });
            });
            // Sort by newest first
            notifs.sort((a, b) => b.timestamp - a.timestamp);
            localStorage.setItem("smartheal_notifications", JSON.stringify(notifs));
            if (onDataChangedCallback) onDataChangedCallback();
        });
    },

    // ── PUSH NOTIFICATION ──
    async pushNotification(target, text, icon = '🔔') {
        try {
            const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
            await setDoc(doc(collection(db, "notifications"), id), {
                target: target,
                text: text,
                icon: icon,
                unread: true,
                timestamp: Date.now()
            });
        } catch (e) {
            console.error("Error pushing notification:", e);
        }
    },

    // ── PHASE 6: AUTOMATIC DAILY QUEUE ARCHIVE & RESET ──
    // Called once at the top of initRealTimeSync(), from every dashboard that
    // loads SmartHealSync (Patient + Doctor; Admin sees the result for free via
    // its existing localStorage/"storage"-event read path — no changes needed there).
    //
    // Race-safety across simultaneous devices: rather than "check date, then write",
    // which has a gap where two tabs could both see a stale date and both archive,
    // this uses a single Firestore transaction that reads system/queueState and
    // writes the new queueDate IN THE SAME ATOMIC OPERATION. Firestore serializes
    // transactions server-side, so whichever client's transaction commits first
    // "claims" today's reset and the loser's transaction simply sees the already-
    // updated date and does nothing further. No separate lock document is needed.
    async checkAndRunDailyReset() {
        const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
        const stateRef = doc(db, "system", "queueState");

        let iAmResponsibleForReset = false;
        let yesterdayStr = null;

        try {
            await runTransaction(db, async (tx) => {
                const snap = await tx.get(stateRef);
                const storedDate = snap.exists() ? snap.data().queueDate : null;

                if (storedDate === todayStr) {
                    // Someone already claimed/finished today's reset (or it's not a new day).
                    return;
                }

                // Stale or missing — claim today's reset right now, atomically.
                yesterdayStr = storedDate; // may be null on very first run ever
                iAmResponsibleForReset = true;
                tx.set(stateRef, { queueDate: todayStr, lastResetAt: Date.now() }, { merge: true });
            });
        } catch (e) {
            console.error("[SmartHeal Sync] Daily reset transaction failed:", e);
            return;
        }

        if (!iAmResponsibleForReset) return;

        console.log(`[SmartHeal Sync] New day detected (${todayStr}). Archiving and resetting live queue...`);

        try {
            // 1 & 2. Read today's live queue once from Firestore, archive it under
            //    yesterday's date (if any), then delete every record to reset the queue.
            //    Read directly from Firestore rather than the localStorage cache — on a
            //    fresh page load the onSnapshot listener may not have populated
            //    hospitalQueue yet (same race already documented near confirmLogout()'s
            //    cleanup comments).
            const queueSnap = await getDocs(collection(db, "queueRecords"));
            const liveQueue = [];
            queueSnap.forEach(d => liveQueue.push(d.data()));

            if (yesterdayStr && liveQueue.length > 0) {
                // Group by department so the Admin Archived Queue view can render
                // "YYYY-MM-DD → Cardiology / General OPD / ENT / ..." directly.
                const departments = {};
                liveQueue.forEach(record => {
                    const dept = record.dept || 'General OPD';
                    if (!departments[dept]) departments[dept] = [];
                    departments[dept].push(record);
                });

                await setDoc(
                    doc(db, "archivedQueue", yesterdayStr),
                    { date: yesterdayStr, departments, archivedAt: Date.now() },
                    { merge: true }
                );
            }

            const delBatch = writeBatch(db);
            queueSnap.forEach(d => delBatch.delete(d.ref));
            await delBatch.commit();
            localStorage.setItem("hospitalQueue", "[]");

            // 3. Reset department/global token counters (display stat; live numbering
            //    is actually derived from the now-empty queue, but reset explicitly anyway).
            localStorage.setItem("deptCounters", "{}");
            localStorage.setItem("smartheal_tokenCounter", "0");
            await setDoc(doc(db, "departmentCounters", "global"), { count: 0 }, { merge: true });

            // 4. Clear temporary patient + doctor queue state ONLY.
            //    NOT visit history, NOT MediVault, NOT consultation notes/
            //    prescriptions/follow-ups, and critically NOT doctor profile/
            //    account data (name, specialization, email, doctorId, status,
            //    approved, role) — those live in the SAME doctors/{uid} document
            //    as the queue-state "state" field, so this reset deliberately
            //    never writes to the "doctors" collection at all.
            // NOTE: localStorage is per-browser, so this only clears the winning
            // client's own copy of currentTokenData/doctorState. That's sufficient:
            // every OTHER patient's stale currentTokenData now points at a token
            // that no longer exists in the (just-emptied) live queue, so submitReg()'s
            // duplicate-guard finds no match and registration proceeds normally.
            // Every OTHER doctor's own doctorState clears the same way on their own
            // next page load (loadPersistedState() reads localStorage, which starts
            // empty for a session that hasn't run yet), and their next
            // saveDoctorState() call merges fresh empty state into ONLY the "state"
            // field of their own doctors/{uid} doc — profile fields are untouched
            // because saveDoctorState() always writes with { merge: true }.
            localStorage.removeItem("currentTokenData");
            localStorage.removeItem("doctorState");

            console.log("[SmartHeal Sync] Daily archive & reset complete.");
        } catch (e) {
            console.error("[SmartHeal Sync] Daily reset execution failed partway through:", e);
        }
    },

    /**
     * Retrieve an archived day's queue, grouped by department:
     * { "General OPD": [...], "Cardiology": [...], ... }
     * Used by an Admin "Archived Queue" view rendered as date → department.
     */
    async getArchivedQueue(dateStr) {
        try {
            const snap = await getDoc(doc(db, "archivedQueue", dateStr));
            return snap.exists() ? (snap.data().departments || {}) : {};
        } catch (e) {
            console.error("[SmartHeal Sync] Failed to load archive for", dateStr, e);
            return {};
        }
    },

    /** List all archived dates (newest first), for populating an admin date picker. */
    async listArchivedDates() {
        try {
            const snap = await getDocs(collection(db, "archivedQueue"));
            const dates = [];
            snap.forEach(d => dates.push(d.id));
            return dates.sort().reverse();
        } catch (e) {
            console.error("[SmartHeal Sync] Failed to list archived dates:", e);
            return [];
        }
    },

    getQueue() {
        return JSON.parse(
            localStorage.getItem("hospitalQueue") || "[]"
        );
    },

    async setQueue(queue) {
        // Local Cache Update
        localStorage.setItem(
            "hospitalQueue",
            JSON.stringify(queue)
        );

        // Background sync to Firestore (Phase 6)
        try {
            const batch = writeBatch(db);
            queue.forEach(record => {
                // Use tokenNum + registeredAt for a unique, stable ID per patient.
                // Phone-based IDs caused collisions when phone was missing (all became Q-001-NA).
                const tokenPart = String(record.tokenNum || record.token).replace(/[^a-zA-Z0-9]/g, '');
                const timePart = String(record.registeredAt || Date.now());
                const docId = `Q-${tokenPart}-${timePart}`;
                const docRef = doc(db, "queueRecords", docId);
                batch.set(docRef, record, { merge: true });
            });
            await batch.commit();
        } catch (error) {
            console.error("Firebase Sync Error (Queue):", error);
        }
    },

    tokenToNum(token) {
        return parseInt(
            String(token).replace("#", ""),
            10
        );
    },

    formatToken(num) {
        return "#" + String(num).padStart(3, "0");
    },

    getDoctorState() {
        return JSON.parse(
            localStorage.getItem("doctorState") || "{}"
        );
    },

    async saveDoctorState(state) {
        // Local Cache Update
        localStorage.setItem(
            "doctorState",
            JSON.stringify(state)
        );

        // Firebase Sync
        try {
            const uid = localStorage.getItem("currentUser") || "unknown";
            await setDoc(doc(db, "doctors", uid), { state: state }, { merge: true });
        } catch (e) { console.error(e); }
    },

    async addDoctorFollowup(followup) {
        const arr = JSON.parse(
            localStorage.getItem("doctorFollowups") || "[]"
        );

        arr.push(followup);

        localStorage.setItem(
            "doctorFollowups",
            JSON.stringify(arr)
        );

        // Phase 12: Follow-Up System
        try {
            const docId = `FU-${Date.now()}`;
            await setDoc(doc(db, "followUps", docId), followup);
        } catch (e) { console.error(e); }
    },

    getDoctorFollowups() {
        return JSON.parse(
            localStorage.getItem("doctorFollowups") || "[]"
        );
    },

    // ── Token counter (shared between patient app and doctor dashboard) ──
    getTokenCounter() {
        return parseInt(
            localStorage.getItem("smartheal_tokenCounter") || "0",
            10
        );
    },

    async setTokenCounter(val) {
        // Local Cache Update
        localStorage.setItem(
            "smartheal_tokenCounter",
            String(val)
        );

        // Firebase Sync
        try {
            await setDoc(doc(db, "departmentCounters", "global"), { count: parseInt(val, 10) }, { merge: true });
        } catch (e) { console.error(e); }
    },

    // ── Now-serving / calling (written by doctor dashboard, read by patient app) ──
    getNowServing() {
        return localStorage.getItem("smartheal_nowServing") || null;
    },

    async setNowServing(val) {
        if (val === null || val === undefined) {
            localStorage.removeItem("smartheal_nowServing");
        } else {
            localStorage.setItem("smartheal_nowServing", String(val));
            // Firebase Sync
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
            // Firebase Sync
            try {
                await setDoc(doc(db, "system", "status"), { calling: String(val) }, { merge: true });
            } catch (e) { console.error(e); }
        }
    },

    // ── Health records (doctor writes, shared across sessions) ──
    getHealthRecords() {
        return JSON.parse(
            localStorage.getItem("smartheal_healthRecords") || "[]"
        );
    },

    async appendHealthRecord(record) {
        const records = this.getHealthRecords();
        records.push(record);
        // Local Cache Update
        localStorage.setItem(
            "smartheal_healthRecords",
            JSON.stringify(records)
        );

        // Phase 11: MediVault Storage
        try {
            const docId = `MED-${Date.now()}`;
            await setDoc(doc(db, "medicalDocuments", docId), record);
        } catch (e) { console.error(e); }
    },

    // ── Visit History (auto-created on registration, keyed by phone) ──

    getAllVisits() {
        return JSON.parse(
            localStorage.getItem("smartheal_visitHistory") || "[]"
        );
    },

    async saveAllVisits(visits) {
        // Local Cache Update
        localStorage.setItem(
            "smartheal_visitHistory",
            JSON.stringify(visits)
        );

        // Firebase Sync
        try {
            const batch = writeBatch(db);
            visits.forEach(v => {
                const docRef = doc(db, "visitHistory", v.visitId);
                batch.set(docRef, v, { merge: true });
            });
            await batch.commit();
        } catch (e) { console.error(e); }
    },

    /**
     * Create a new visit record when a token is issued.
     * phone is the primary key for grouping visits across sessions.
     */
    createVisit(visitData) {
        const visits = this.getAllVisits();
        const newVisit = {
            visitId: "VIS-" + String(visits.length + 1).padStart(3, "0") + "-" + Date.now().toString().slice(-4),
            createdAt: Date.now(),
            // future-compatible fields default to null
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

    /**
     * Retrieve all visits for a given phone number (primary key).
     * Sorted most-recent first.
     */
    getVisitsByPhone(phone) {
        if (!phone || phone === "—") return [];
        const norm = String(phone).replace(/\D/g, "");
        return this.getAllVisits()
            .filter(v => String(v.phone || "").replace(/\D/g, "") === norm)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    /**
     * Attach consultation data to an existing visit after doctor completes it.
     */
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

    /**
     * Return all visits for a given phone that have a followUpDate set.
     * Used by the patient dashboard to render follow-up reminder cards.
     * Sorted by followUpDate ascending (soonest first).
     */
    getUpcomingFollowUps(phone) {
        if (!phone || phone === "—") return [];
        const norm = String(phone).replace(/\D/g, "");
        return this.getAllVisits()
            .filter(v =>
                String(v.phone || "").replace(/\D/g, "") === norm &&
                v.followUpDate
            )
            .sort((a, b) => (a.followUpDate > b.followUpDate ? 1 : -1));
    },
    // ── PHASE 2: Doctor Applications & Approvals ──
    async updateDoctorApplication(appData) {
        try {
            // Ensure the application has a unique ID
            const docId = appData.uid || appData.id || `DOC-${Date.now()}`;
            appData.uid = docId;

            // Push to Firebase Cloud
            await setDoc(doc(db, "doctorApplications", docId), appData, { merge: true });
        } catch (e) { console.error("Firebase Doctor App Sync Error:", e); }
    },

    // ── PHASE 14: Feedback System ──
    async submitFeedback(feedbackData) {
        try {
            const docId = `FB-${Date.now()}`;
            await setDoc(doc(db, "feedback", docId), feedbackData);
        } catch (e) { console.error("Firebase Feedback Error:", e); }
    }

};