/**
 * src/public/site-theme-core.js
 *
 * The Be More Swan site theme — every editable style token, its default, and the ONE function that
 * turns a theme into CSS.
 *
 * Plain .js, UMD, for the same reason as brand-contrast.js: it runs in two places and a second copy
 * would drift.
 *   · server — netlify/functions/site-theme.ts validates what the admin saves and builds the CSS
 *              every page loads (so a page never needs this file, only the CSS it produced)
 *   · browser — admin.html ▸ Site Styles builds the SAME CSS while the admin edits, to preview the
 *               draft on the admin portal itself before it is set as the standard
 *
 * HOW A THEME REACHES THE PAGE
 * The stylesheet is Tailwind v4: colours, fonts, radii and type sizes are CSS custom properties
 * (--color-gray-900, --font-sans, --radius-lg, --text-3xl) declared in `@layer theme`, and every
 * utility reads them. So most tokens are a variable override on :root — unlayered, which beats the
 * layered default — and the whole site follows without touching a single class. The few things that
 * are not variables (buttons, headings, form labels, plain links, card backgrounds) are written into
 * a NEW cascade layer, `bms-site-theme`. A layer declared after Tailwind's `utilities` outranks it,
 * which is why these rules win against a page's own utility classes without !important.
 *
 * DEFAULTS ARE THE CURRENT DESIGN. Only tokens that differ from their default produce CSS (see
 * themeCss), so publishing the defaults changes nothing.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SiteThemeCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var FONTS = [
        { value: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans (current)', google: 'Plus+Jakarta+Sans:ital,wght@0,400..800;1,400..800' },
        { value: 'Inter', label: 'Inter', google: 'Inter:wght@400..900' },
        { value: 'DM Sans', label: 'DM Sans', google: 'DM+Sans:ital,wght@0,400..900;1,400..900' },
        { value: 'Manrope', label: 'Manrope', google: 'Manrope:wght@400..800' },
        { value: 'Outfit', label: 'Outfit', google: 'Outfit:wght@400..900' },
        { value: 'Poppins', label: 'Poppins', google: 'Poppins:wght@400;500;600;700;800;900' },
        { value: 'Nunito', label: 'Nunito', google: 'Nunito:wght@400..900' },
        { value: 'Lato', label: 'Lato', google: 'Lato:wght@400;700;900' },
        { value: 'Montserrat', label: 'Montserrat', google: 'Montserrat:wght@400..900' },
        { value: 'Space Grotesk', label: 'Space Grotesk', google: 'Space+Grotesk:wght@400..700' },
        { value: 'Fraunces', label: 'Fraunces (serif)', google: 'Fraunces:wght@400..900' },
        { value: 'Playfair Display', label: 'Playfair Display (serif)', google: 'Playfair+Display:wght@400..900' },
        { value: 'Lora', label: 'Lora (serif)', google: 'Lora:wght@400..700' },
        { value: 'system', label: 'System font (no download)', google: null },
    ];

    var WEIGHTS = [['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']];

    function opts(pairs) { return pairs.map(function (p) { return { value: p[0], label: p[1] }; }); }

    // type: 'color' | 'font' | 'select'. `null` default = "as designed": no rule is written.
    var GROUPS = [
        {
            id: 'fonts', title: 'Fonts',
            tokens: [
                { key: 'bodyFont', label: 'Body font', type: 'font', default: 'Plus Jakarta Sans', help: 'Paragraphs, labels, buttons — everything that is not a heading.' },
                { key: 'headingFont', label: 'Heading font', type: 'font', default: 'Plus Jakarta Sans', help: 'Page titles and section headings.' },
            ],
        },
        {
            id: 'headings', title: 'Headings',
            tokens: [
                { key: 'headingColor', label: 'Heading & strong text colour', type: 'color', default: '#1f1e1b', help: 'Titles, headings and bold emphasis.' },
                { key: 'headingWeight', label: 'Heading weight', type: 'select', default: null, options: opts([['', 'As designed']].concat(WEIGHTS)) },
                { key: 'headingTracking', label: 'Heading letter spacing', type: 'select', default: null,
                    options: opts([['', 'As designed'], ['-0.03em', 'Tight'], ['-0.015em', 'Slightly tight'], ['0', 'Normal'], ['0.02em', 'Wide']]) },
                { key: 'headingScale', label: 'Heading size', type: 'select', default: '1',
                    options: opts([['0.85', 'Smaller'], ['0.93', 'Slightly smaller'], ['1', 'As designed'], ['1.08', 'Slightly larger'], ['1.16', 'Larger']]) },
            ],
        },
        {
            id: 'text', title: 'Paragraphs & text',
            tokens: [
                { key: 'bodyColor', label: 'Body text colour', type: 'color', default: '#444036', help: 'Most reading text.' },
                { key: 'bodyStrongColor', label: 'Dark body text colour', type: 'color', default: '#2d2a23' },
                { key: 'mutedColor', label: 'Secondary text colour', type: 'color', default: '#787263', help: 'Descriptions and help text under a field.' },
                { key: 'mutedStrongColor', label: 'Secondary text (darker)', type: 'color', default: '#5c564b' },
                { key: 'faintColor', label: 'Faint text colour', type: 'color', default: '#9ca3af', help: 'Timestamps, hints, placeholders.' },
                { key: 'paragraphLeading', label: 'Paragraph line spacing', type: 'select', default: null,
                    options: opts([['', 'As designed'], ['1.4', 'Compact'], ['1.6', 'Comfortable'], ['1.75', 'Airy']]) },
                { key: 'linkColor', label: 'Link colour', type: 'color', default: '#d6006b', help: 'Plain text links (styled buttons keep their own colours).' },
            ],
        },
        {
            id: 'labels', title: 'Form labels',
            tokens: [
                { key: 'labelColor', label: 'Label colour', type: 'color', default: '#444036' },
                { key: 'labelWeight', label: 'Label weight', type: 'select', default: null, options: opts([['', 'As designed'], ['400', 'Regular']].concat(WEIGHTS)) },
                { key: 'labelSize', label: 'Label size', type: 'select', default: null,
                    options: opts([['', 'As designed'], ['0.75rem', 'Small'], ['0.875rem', 'Medium'], ['1rem', 'Large']]) },
                { key: 'labelCase', label: 'Label case', type: 'select', default: null,
                    options: opts([['', 'As designed'], ['none', 'Normal'], ['uppercase', 'UPPERCASE']]) },
            ],
        },
        {
            id: 'surfaces', title: 'Colours & backgrounds',
            tokens: [
                { key: 'accent', label: 'Brand accent', type: 'color', default: '#ff007f', help: 'Highlights, active tabs, icons, progress bars.' },
                { key: 'accentDark', label: 'Brand accent (dark)', type: 'color', default: '#d6006b' },
                { key: 'accentSoft', label: 'Brand accent (soft wash)', type: 'color', default: '#fff0f5' },
                { key: 'accentSoftBorder', label: 'Brand accent (soft border)', type: 'color', default: '#ffd6e8' },
                { key: 'pageBg', label: 'Page background', type: 'color', default: '#fdfcf9' },
                { key: 'subtleBg', label: 'Subtle panel background', type: 'color', default: '#f6f3eb' },
                { key: 'cardBg', label: 'Card background', type: 'color', default: '#ffffff', help: 'Changing this also replaces hover tints on white cards.' },
                { key: 'focusRing', label: 'Focus ring', type: 'color', default: '#ff007f', help: 'The outline shown when a control is reached by keyboard.' },
            ],
        },
        {
            id: 'borders', title: 'Borders & corners',
            tokens: [
                { key: 'borderColor', label: 'Border colour', type: 'color', default: '#eae4d7', help: 'Cards, panels and dividers.' },
                { key: 'borderSoftColor', label: 'Soft divider colour', type: 'color', default: '#f6f3eb' },
                { key: 'inputBorderColor', label: 'Input border colour', type: 'color', default: '#d1d5db', help: 'Text boxes and dropdowns.' },
                { key: 'radiusScale', label: 'Corner roundness', type: 'select', default: '1',
                    options: opts([['0', 'Square'], ['0.5', 'Subtle'], ['1', 'As designed'], ['1.5', 'Rounder'], ['2', 'Very round']]) },
            ],
        },
        {
            id: 'buttons', title: 'Buttons',
            tokens: [
                { key: 'buttonRadius', label: 'Button shape', type: 'select', default: null,
                    options: opts([['', 'As designed'], ['0.25rem', 'Square-ish'], ['0.5rem', 'Rounded'], ['0.75rem', 'Soft'], ['9999px', 'Pill']]) },
                { key: 'buttonWeight', label: 'Button text weight', type: 'select', default: null, options: opts([['', 'As designed']].concat(WEIGHTS)) },
            ],
        },
    ];

    // The six intent buttons (input.css "BUTTON SYSTEM"): bg / text / hover bg / border each.
    var BUTTONS = [
        ['assistant', 'Assistant & AI', '#d6006b', '#ffffff', '#b0005a', '#d6006b'],
        ['primary', 'Primary', '#d6006b', '#ffffff', '#b0005a', '#d6006b'],
        ['golive', 'Go live / Approve', '#00e55c', '#1f1e1b', '#00cc52', '#00e55c'],
        ['secondary', 'Secondary', '#f6f3eb', '#1f1e1b', '#eae4d7', '#eae4d7'],
        ['destructive', 'Destructive', '#dc2626', '#ffffff', '#b91c1c', '#dc2626'],
        ['utility', 'Utility', '#ffffff', '#5c564b', '#f6f3eb', '#ffffff'],
    ];
    BUTTONS.forEach(function (b) {
        var id = b[0];
        GROUPS.push({
            id: 'btn-' + id, title: b[1] + ' buttons', button: id,
            tokens: [
                { key: 'btn_' + id + '_bg', label: 'Background', type: 'color', default: b[2] },
                { key: 'btn_' + id + '_text', label: 'Text', type: 'color', default: b[3] },
                { key: 'btn_' + id + '_hover', label: 'Hover background', type: 'color', default: b[4] },
                { key: 'btn_' + id + '_border', label: 'Border', type: 'color', default: b[5] },
            ],
        });
    });

    var TOKENS = [];
    GROUPS.forEach(function (g) { g.tokens.forEach(function (t) { TOKENS.push(t); }); });
    var BY_KEY = {};
    TOKENS.forEach(function (t) { BY_KEY[t.key] = t; });

    function defaults() {
        var out = {};
        TOKENS.forEach(function (t) { out[t.key] = t.default; });
        return out;
    }

    function normalizeHex(raw) {
        if (typeof raw !== 'string') return null;
        var s = raw.trim().toLowerCase();
        if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        return /^#[0-9a-f]{6}$/.test(s) ? s : null;
    }

    /**
     * A complete, SAFE theme from anything: unknown keys dropped, every value checked against its
     * token's type (a colour must be a hex, a select must be one of its options, a font one of
     * FONTS). This is what makes the CSS below injection-proof — nothing free-form reaches it.
     */
    function normalizeTheme(raw) {
        var src = raw && typeof raw === 'object' ? raw : {};
        var out = {};
        TOKENS.forEach(function (t) {
            var v = src[t.key];
            if (t.type === 'color') {
                out[t.key] = normalizeHex(v) || t.default;
            } else if (t.type === 'font') {
                out[t.key] = FONTS.some(function (f) { return f.value === v; }) ? v : t.default;
            } else {
                var s = v == null ? '' : String(v);
                var ok = t.options.some(function (o) { return o.value === s; });
                out[t.key] = ok ? (s === '' ? null : s) : t.default;
            }
        });
        return out;
    }

    function fontStack(name) {
        if (name === 'system') return 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        var f = FONTS.filter(function (x) { return x.value === name; })[0];
        var serif = f && /serif\)/.test(f.label) && !/sans/i.test(f.label);
        return '"' + name + '", ' + (serif ? 'Georgia, serif' : 'system-ui, -apple-system, sans-serif');
    }

    /** The Google Fonts stylesheet the theme needs, or null (system font / nothing to load). */
    function fontUrl(theme) {
        var t = normalizeTheme(theme);
        var families = [];
        [t.bodyFont, t.headingFont].forEach(function (name) {
            var f = FONTS.filter(function (x) { return x.value === name; })[0];
            if (f && f.google && families.indexOf(f.google) === -1) families.push(f.google);
        });
        if (!families.length) return null;
        return 'https://fonts.googleapis.com/css2?' + families.map(function (g) { return 'family=' + g; }).join('&') + '&display=swap';
    }

    var TEXT_SIZES = { 'xl': 1.25, '2xl': 1.5, '3xl': 1.875, '4xl': 2.25, '5xl': 3, '6xl': 3.75 };
    var RADII = { 'sm': 0.25, 'md': 0.375, 'lg': 0.5, 'xl': 0.75, '2xl': 1, '3xl': 1.5 };

    function round(n) { return Math.round(n * 1000) / 1000; }

    /**
     * The theme as CSS. Deterministic: the same theme always produces the same string.
     *
     * ⚠️ Only CHANGED tokens are written. A rule in the bms-site-theme layer outranks every utility
     * class — including the hover tints, selected states and busy states pages set from JS — so a
     * rule emitted for an untouched token would quietly flatten those. A default theme therefore
     * produces (almost) no CSS, and publishing it is a true no-op.
     */
    function themeCss(theme) {
        var t = normalizeTheme(theme);
        function changed(key) { return t[key] !== BY_KEY[key].default; }
        var vars = [];
        function v(key, prop, value) { if (changed(key)) vars.push(prop + ':' + (value != null ? value : t[key])); }

        v('bodyFont', '--font-sans', fontStack(t.bodyFont));
        v('headingColor', '--color-gray-900');
        v('bodyStrongColor', '--color-gray-800');
        v('bodyColor', '--color-gray-700');
        v('mutedStrongColor', '--color-gray-600');
        v('mutedColor', '--color-gray-500');
        v('faintColor', '--color-gray-400');
        v('inputBorderColor', '--color-gray-300');
        v('borderColor', '--color-gray-200');
        v('borderSoftColor', '--color-gray-100');
        v('pageBg', '--color-gray-50');
        v('accent', '--color-emerald-700');
        v('accentDark', '--color-emerald-800');
        v('accentSoft', '--color-emerald-50');
        v('accentSoftBorder', '--color-emerald-100');
        if (changed('headingScale')) {
            var scale = Number(t.headingScale) || 1;
            Object.keys(TEXT_SIZES).forEach(function (k) { vars.push('--text-' + k + ':' + round(TEXT_SIZES[k] * scale) + 'rem'); });
        }
        if (changed('radiusScale')) {
            var r = Number(t.radiusScale);
            if (!isFinite(r)) r = 1;
            Object.keys(RADII).forEach(function (k) { vars.push('--radius-' + k + ':' + round(RADII[k] * r) + 'rem'); });
        }

        var rules = [];
        // Headings follow the body font unless told otherwise — so a heading rule is needed whenever
        // the two differ, not only when the heading font itself was changed.
        var headingDecl = [];
        if (changed('headingFont') || t.headingFont !== t.bodyFont) headingDecl.push('font-family:' + fontStack(t.headingFont));
        if (t.headingTracking != null) headingDecl.push('letter-spacing:' + t.headingTracking);
        if (headingDecl.length) rules.push('h1,h2,h3,h4,h5,h6{' + headingDecl.join(';') + '}');
        if (t.headingWeight) rules.push('h1,h2,h3{font-weight:' + t.headingWeight + '}');
        if (t.paragraphLeading) rules.push('p{line-height:' + t.paragraphLeading + '}');
        if (changed('linkColor')) rules.push('a:not([class]){color:' + t.linkColor + '}');
        // Form labels only — `label.block` is the field-label pattern; a label wrapping a whole
        // toggle row is not a "label" in the sense the admin means, and must not go UPPERCASE.
        var labelDecl = [];
        if (changed('labelColor')) labelDecl.push('color:' + t.labelColor);
        if (t.labelWeight) labelDecl.push('font-weight:' + t.labelWeight);
        if (t.labelSize) labelDecl.push('font-size:' + t.labelSize);
        if (t.labelCase) labelDecl.push('text-transform:' + t.labelCase + (t.labelCase === 'uppercase' ? ';letter-spacing:.04em' : ''));
        if (labelDecl.length) rules.push('label.block{' + labelDecl.join(';') + '}');
        if (changed('cardBg')) rules.push('.bg-white{background-color:' + t.cardBg + '}');
        BUTTONS.forEach(function (b) {
            var id = b[0];
            var sel = '.btn-' + id;
            var decl = [];
            if (changed('btn_' + id + '_bg')) decl.push('background-color:' + t['btn_' + id + '_bg']);
            if (changed('btn_' + id + '_text')) decl.push('color:' + t['btn_' + id + '_text']);
            if (changed('btn_' + id + '_border')) decl.push('border-color:' + t['btn_' + id + '_border']);
            if (t.buttonRadius) decl.push('border-radius:' + t.buttonRadius);
            if (t.buttonWeight) decl.push('font-weight:' + t.buttonWeight);
            if (decl.length) rules.push(sel + '{' + decl.join(';') + '}');
            if (changed('btn_' + id + '_hover')) rules.push(sel + ':hover:not(:disabled){background-color:' + t['btn_' + id + '_hover'] + '}');
            if (changed('focusRing')) rules.push(sel + ':focus-visible{outline-color:' + t.focusRing + '}');
        });

        var css = '';
        if (vars.length) css += ':root{' + vars.join(';') + '}';
        if (changed('pageBg')) css += 'body{background-color:' + t.pageBg + '}';
        if (rules.length) css += (css ? '\n' : '') + '@layer bms-site-theme{' + rules.join('') + '}';
        return css;
    }

    return {
        GROUPS: GROUPS,
        TOKENS: TOKENS,
        FONTS: FONTS,
        BY_KEY: BY_KEY,
        defaults: defaults,
        normalizeTheme: normalizeTheme,
        themeCss: themeCss,
        fontUrl: fontUrl,
    };
}));
