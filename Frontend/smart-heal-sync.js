window.SmartHealSync = {

    getQueue() {
        return JSON.parse(
            localStorage.getItem("hospitalQueue") || "[]"
        );
    },

    setQueue(queue) {
        localStorage.setItem(
            "hospitalQueue",
            JSON.stringify(queue)
        );
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

    saveDoctorState(state) {
        localStorage.setItem(
            "doctorState",
            JSON.stringify(state)
        );
    },

    addDoctorFollowup(followup) {
        const arr = JSON.parse(
            localStorage.getItem("doctorFollowups") || "[]"
        );

        arr.push(followup);

        localStorage.setItem(
            "doctorFollowups",
            JSON.stringify(arr)
        );
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

    setTokenCounter(val) {
        localStorage.setItem(
            "smartheal_tokenCounter",
            String(val)
        );
    },

    // ── Now-serving / calling (written by doctor dashboard, read by patient app) ──
    getNowServing() {
        return localStorage.getItem("smartheal_nowServing") || null;
    },

    setNowServing(val) {
        if (val === null || val === undefined) {
            localStorage.removeItem("smartheal_nowServing");
        } else {
            localStorage.setItem("smartheal_nowServing", String(val));
        }
    },

    getCalling() {
        return localStorage.getItem("smartheal_calling") || null;
    },

    setCalling(val) {
        if (val === null || val === undefined) {
            localStorage.removeItem("smartheal_calling");
        } else {
            localStorage.setItem("smartheal_calling", String(val));
        }
    },

    // ── Health records (doctor writes, shared across sessions) ──
    getHealthRecords() {
        return JSON.parse(
            localStorage.getItem("smartheal_healthRecords") || "[]"
        );
    },

    appendHealthRecord(record) {
        const records = this.getHealthRecords();
        records.push(record);
        localStorage.setItem(
            "smartheal_healthRecords",
            JSON.stringify(records)
        );
    },

    // ── Visit History (auto-created on registration, keyed by phone) ──

    getAllVisits() {
        return JSON.parse(
            localStorage.getItem("smartheal_visitHistory") || "[]"
        );
    },

    saveAllVisits(visits) {
        localStorage.setItem(
            "smartheal_visitHistory",
            JSON.stringify(visits)
        );
    },

    /**
     * Create a new visit record when a token is issued.
     * phone is the primary key for grouping visits across sessions.
     */
    createVisit(visitData) {
        const visits = this.getAllVisits();
        const newVisit = {
            visitId: "VIS-" + String(visits.length + 1).padStart(3, "0"),
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
    }

};