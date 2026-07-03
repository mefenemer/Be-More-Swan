#!/usr/bin/env node
// scripts/generate-notices.js
// US-LEGAL-2.4: Generate THIRD-PARTY-NOTICES from npm dependency licenses.
// Includes all MIT, BSD, Apache-2.0, ISC dependencies plus their copyright notices.
// Apache-2.0 NOTICE files are included where present.
// Run: node scripts/generate-notices.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ALLOWED_PREFIXES = ['MIT', 'BSD', 'Apache', 'ISC'];

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

const output = lines.join('\n');
const outPath = path.join(__dirname, '..', 'THIRD-PARTY-NOTICES');
fs.writeFileSync(outPath, output, 'utf8');
console.log(`Generated ${outPath} (${entries.length} packages)`);
