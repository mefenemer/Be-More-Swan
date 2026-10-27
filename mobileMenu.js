// mobileMenu.js — the public nav's hamburger menu, and the check that decides when the nav needs it.
//
// Self-starting (2026-10-27): nine pages (trust, register, partners…) never loaded this file, so
// their hamburger did nothing. The toggle is now one click listener on `document`, which works
// whenever the nav is injected and needs no call. setupMobileMenu() stays because pages still call it.
//
// Fit check: the desktop links did not fit one row from 1024px up to ~1060px in English, and in
// Spanish/Portuguese/German up to ~1460px — a fixed breakpoint cannot know how long a translated or
// waitlist label is. So the nav is measured, and when the links don't fit beside the logo the
// <html> element gets `bms-nav-compact` and components/nav.html shows the hamburger instead.
(function () {
    if (window.__bmsMobileMenu) return;
    window.__bmsMobileMenu = true;

    var COMPACT = 'bms-nav-compact';
    var BREATHING = 24; // px kept clear between the logo and the first link

    function toggleMenu() {
        var mobileMenu = document.getElementById('mobile-menu');
        var iconPath = document.getElementById('menu-icon-path');
        if (!mobileMenu || !iconPath) return;

        // Check desktop nav to determine routing state
        var navAppLinks = document.getElementById('nav-app-links');
        var isApp = navAppLinks && !navAppLinks.classList.contains('hidden');
        var pub = document.getElementById('mobile-public-links');
        var app = document.getElementById('mobile-app-links');

        // Force inline style toggling instead of relying on CSS classes
        if (mobileMenu.style.display === 'none') {
            mobileMenu.style.display = 'block';
            iconPath.setAttribute('d', 'M6 18L18 6M6 6l12 12'); // 'X' Icon
            if (pub && app) {
                pub.style.display = isApp ? 'none' : 'flex';
                app.style.display = isApp ? 'flex' : 'none';
            }
        } else {
            mobileMenu.style.display = 'none';
            iconPath.setAttribute('d', 'M4 6h16M4 12h16M4 18h16'); // Burger Icon
        }
    }

    document.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('#mobile-menu-button')) toggleMenu();
    });

    // Measured with the compact class off, then set again in the same task, so nothing paints between.
    function fit() {
        var root = document.documentElement;
        var desktop = document.querySelector('.bms-nav-desktop');
        var logo = desktop && desktop.parentElement && desktop.parentElement.firstElementChild;
        if (!desktop || !logo || logo === desktop) return;
        root.classList.remove(COMPACT);
        if (getComputedStyle(desktop).display === 'none') return; // below 1024px the CSS already shows the hamburger
        var app = document.getElementById('nav-app-links');
        var group = app && getComputedStyle(app).display !== 'none' ? app : document.getElementById('nav-public-links');
        if (!group) return;
        var row = desktop.parentElement;
        var needed = logo.getBoundingClientRect().width + group.scrollWidth + BREATHING;
        root.classList.toggle(COMPACT, needed > row.clientWidth);
    }

    var queued = false;
    function schedule() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () { queued = false; fit(); });
    }

    // Watch the nav once it is injected: its row's width (window resizes) and its text (i18n,
    // waitlist relabel, the public/app link swap). The class lives on <html>, outside what is
    // observed, so a fit never re-triggers itself.
    var watched = null;
    function watch() {
        var nav = document.querySelector('.bms-nav-desktop');
        nav = nav && nav.closest('nav');
        if (!nav || nav === watched) return;
        watched = nav;
        new MutationObserver(schedule).observe(nav, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
        if (window.ResizeObserver) new ResizeObserver(schedule).observe(nav);
        else window.addEventListener('resize', schedule);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
        schedule();
    }

    function start() {
        watch();
        new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);

    window.bmsNavFit = schedule;
})();

// Kept for the pages that call it after injecting the nav; the document listener does the toggling.
function setupMobileMenu() {
    if (window.bmsNavFit) window.bmsNavFit();
}
