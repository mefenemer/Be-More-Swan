// Load swan-cursor on every page that includes this file
(function () {
  var s = document.createElement('script');
  s.src = '/swan-cursor.js';
  document.head.appendChild(s);
})();

function setupMobileMenu() {
    const menuButton = document.getElementById('mobile-menu-button');
    const mobileMenu = document.getElementById('mobile-menu');
    const iconPath = document.getElementById('menu-icon-path');

    if (menuButton && mobileMenu && iconPath) {
        menuButton.onclick = () => {
            // Check desktop nav to determine routing state
            const navAppLinks = document.getElementById('nav-app-links');
            const isApp = navAppLinks && !navAppLinks.classList.contains('hidden');

            const pub = document.getElementById('mobile-public-links');
            const app = document.getElementById('mobile-app-links');

            // Force inline style toggling instead of relying on CSS classes
            if (mobileMenu.style.display === 'none') {
                // Open menu
                mobileMenu.style.display = 'block';
                iconPath.setAttribute('d', 'M6 18L18 6M6 6l12 12'); // 'X' Icon

                // Route correctly
                if (pub && app) {
                    if (isApp) {
                        pub.style.display = 'none';
                        app.style.display = 'flex';
                    } else {
                        pub.style.display = 'flex';
                        app.style.display = 'none';
                    }
                }
            } else {
                // Close menu
                mobileMenu.style.display = 'none';
                iconPath.setAttribute('d', 'M4 6h16M4 12h16M4 18h16'); // Burger Icon
            }
        };
    } else {
        console.warn("Mobile menu elements not found.");
    }
}