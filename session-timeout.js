// session-timeout.js — issue #127
// Shows a "stay signed in?" countdown after a period of workspace inactivity and
// auto-logs the user out if the countdown expires. Both the inactivity period and
// the countdown length are admin-configurable (defaults: 15 min idle, 10 min countdown).
(function () {
    const DEFAULT_INACTIVITY_MINUTES = 15;
    const DEFAULT_COUNTDOWN_MINUTES = 10;

    let inactivityTimeoutMs = DEFAULT_INACTIVITY_MINUTES * 60 * 1000;
    let countdownMs = DEFAULT_COUNTDOWN_MINUTES * 60 * 1000;

    const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'wheel'];

    let idleTimer = null;
    let countdownInterval = null;
    let countdownRemainingMs = 0;

    function $(id) { return document.getElementById(id); }

    function formatTime(ms) {
        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function isModalOpen() {
        const modal = $('session-timeout-modal');
        return !!modal && !modal.classList.contains('hidden');
    }

    function updateCountdownText() {
        const el = $('session-timeout-countdown');
        if (el) el.textContent = formatTime(countdownRemainingMs);
    }

    function showModal() {
        const modal = $('session-timeout-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        countdownRemainingMs = countdownMs;
        updateCountdownText();
        clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            countdownRemainingMs -= 1000;
            if (countdownRemainingMs <= 0) {
                clearInterval(countdownInterval);
                logout();
                return;
            }
            updateCountdownText();
        }, 1000);
    }

    function hideModal() {
        const modal = $('session-timeout-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        clearInterval(countdownInterval);
    }

    function logout() {
        window.location.href = '/logout.html';
    }

    function resetIdleTimer() {
        // Once the countdown modal is up, only the modal's own buttons should dismiss it.
        if (isModalOpen()) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(showModal, inactivityTimeoutMs);
    }

    function onStayClicked() {
        hideModal();
        resetIdleTimer();
    }

    async function loadConfig() {
        try {
            const res = await fetch('/.netlify/functions/platform-config-public');
            if (!res.ok) return;
            const data = await res.json();
            if (data.sessionInactivityTimeoutMinutes > 0) inactivityTimeoutMs = data.sessionInactivityTimeoutMinutes * 60 * 1000;
            if (data.sessionCountdownMinutes > 0) countdownMs = data.sessionCountdownMinutes * 60 * 1000;
        } catch {
            // keep defaults if config can't be reached
        }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        await loadConfig();
        ACTIVITY_EVENTS.forEach(evt => document.addEventListener(evt, resetIdleTimer, { passive: true }));
        const stayBtn = $('session-timeout-stay-btn');
        if (stayBtn) stayBtn.addEventListener('click', onStayClicked);
        const logoutBtn = $('session-timeout-logout-btn');
        if (logoutBtn) logoutBtn.addEventListener('click', logout);
        resetIdleTimer();
    });
})();
