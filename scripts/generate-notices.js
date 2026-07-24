#!/usr/bin/env node
// scripts/generate-notices.js
// US-LEGAL-2.4: Generate THIRD-PARTY-NOTICES from npm dependency licenses.
// Includes all MIT, BSD, Apache-2.0, ISC dependencies plus their copyright notices.
// Apache-2.0 NOTICE files are included where present.
// Run: node scripts/generate-notices.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Licenses we emit a notice for. This is an ATTRIBUTION list, not a policy list — what may be
// depended on is decided by .github/workflows/license-check.yml, which hard-fails on GPL/AGPL/
// EUPL/CDDL and merely warns on LGPL/MPL.
//
// MPL was added when the brand-card renderer pulled in satori and @resvg/resvg-js (both MPL-2.0).
// Leaving it out did not keep MPL code out of the product — lightningcss was already here — it only
// meant MPL packages shipped with NO notice at all, which is the one thing MPL-2.0 §3.2 actually
// requires. Omission from this list is silent, so it must not be used as a filter.
const ALLOWED_PREFIXES = ['MIT', 'BSD', 'Apache', 'ISC', 'MPL'];

function isAllowed(license) {
    if (!license) return false;
    return ALLOWED_PREFIXES.some(p => license.startsWith(p));
}

let json;
try {
    const output = execSync(
        'npx license-checker --excludePrivatePackages --json',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    json = JSON.parse(output);
} catch (err) {
    console.error('license-checker failed:', err.message);
    process.exit(1);
}

const lines = [
    'THIRD-PARTY-NOTICES',
    '===================',
    '',
    'Be More Swan uses open-source software. The following packages are included',
    'in this product and their licenses are listed below.',
    '',
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '─'.repeat(80),
    '',
];

const entries = Object.entries(json)
    .filter(([, v]) => isAllowed(v.licenses))
    .sort(([a], [b]) => a.localeCompare(b));

for (const [pkg, info] of entries) {
    lines.push(`Package: ${pkg}`);
    lines.push(`License: ${info.licenses}`);
    if (info.repository) lines.push(`Repository: ${info.repository}`);
    if (info.publisher) lines.push(`Publisher: ${info.publisher}`);

    // Include licenseText if available
    if (info.licenseFile && fs.existsSync(info.licenseFile)) {
        const licenseText = fs.readFileSync(info.licenseFile, 'utf8').trim();
        lines.push('');
        lines.push('License Text:');
        lines.push(licenseText.split('\n').map(l => '  ' + l).join('\n'));
    }

    // Include Apache NOTICE file if present
    if (info.licenses && info.licenses.startsWith('Apache')) {
        const noticeFile = path.join(path.dirname(info.licenseFile || ''), 'NOTICE');
        if (fs.existsSync(noticeFile)) {
            const noticeText = fs.readFileSync(noticeFile, 'utf8').trim();
            lines.push('');
            lines.push('NOTICE:');
            lines.push(noticeText.split('\n').map(l => '  ' + l).join('\n'));
        }
    }

    lines.push('');
    lines.push('─'.repeat(80));
    lines.push('');
}

// Bundled assets that are NOT npm packages, so the walk above can never see them. They still ship
// inside the product and still carry attribution obligations, and this file is regenerated
// wholesale — appending by hand would be erased by the next run, which is why they live here.
lines.push('');
lines.push('BUNDLED ASSETS (not npm packages)');
lines.push('─'.repeat(80));
lines.push('');
lines.push('Asset: Plus Jakarta Sans (Regular 400, ExtraBold 800 — latin subset)');
lines.push('License: SIL Open Font License 1.1');
lines.push('Copyright: Copyright 2020 The Plus Jakarta Sans Project Authors');
lines.push('Repository: https://github.com/tokotype/PlusJakartaSans');
lines.push('Embedded in: src/lib/brand-card-fonts.ts (base64), used to render branded text cards.');
lines.push('License Text: https://openfontlicense.org/open-font-license-official-text/');
lines.push('');
lines.push('─'.repeat(80));
lines.push('');

const output = lines.join('\n');
const outPath = path.join(__dirname, '..', 'THIRD-PARTY-NOTICES');
fs.writeFileSync(outPath, output, 'utf8');
console.log(`Generated ${outPath} (${entries.length} packages)`);
