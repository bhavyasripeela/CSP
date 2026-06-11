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
    }

};