// tests/fair-use.test.ts
// Chat messages and editing helpers cost no tasks under the single task allowance — only a daily
// fair-use count (src/utils/fair-use.ts, docs/task-metering.md). Two things must hold everywhere:
//   • every such model call is still metered (meterInteraction or checkFairUse), so a button that
//     can be clicked in a loop is never free and unlimited;
//   • a fair-use refusal is "come back tomorrow" — never the upgrade/paywall answer.
//
// Run:  npx tsx tests/fair-use.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAIR_USE_MESSAGE } from '../src/utils/fair-use';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('Fair use — chat and editing helpers are free, but never unlimited');

const METERED = [
    ['netlify/functions/chat-orchestrator.ts', 'chat'],
    ['netlify/functions/rewrite-post-text.ts', 'helpers'],
    ['netlify/functions/suggest-overlay-text.ts', 'helpers'],
    ['netlify/functions/copy-post-to-platform.ts', 'helpers'],
    ['netlify/functions/review-post-quality.ts', 'helpers'],
    ['netlify/functions/apply-post-suggestions.ts', 'helpers'],
    ['netlify/functions/verify-compliance-warning.ts', 'helpers'],
] as const;

for (const [file, kind] of METERED) {
    const src = read(file);
    check(`${file} meters as '${kind}' and never charges a task directly`, () => {
        assert.ok(src.includes(`meterInteraction(db, `) && src.includes(`'${kind}')`), 'no meterInteraction call');
        assert.ok(!/consumeTaskCredit\(/.test(src), 'still calls consumeTaskCredit');
    });
    check(`${file} answers fair use apart from the paywall`, () => {
        assert.match(src, /\.fairUse/, 'never looks at fairUse — a fair-use refusal would read as a plan limit');
    });
}

for (const file of ['netlify/functions/rewrite-section.ts', 'netlify/functions/generate-hooks.ts', 'netlify/functions/newsletter-issues.ts']) {
    check(`${file} — a previously unmetered helper now counts against fair use`, () => {
        assert.match(read(file), /checkFairUse\(db, [a-zA-Z.]+, 'helpers'\)/);
    });
}

check('meterInteraction keeps the old charge while the flag is off', () => {
    const src = read('src/utils/task-credit.ts');
    assert.match(src, /if \(!\(await isUnifiedTaskMetering\(organisationId\)\)\) return consumeTaskCredit\(db, organisationId\);/);
});

check('meterInteraction still requires a paid plan, and fails closed on a fault', () => {
    const src = read('src/utils/task-credit.ts');
    const fn = src.slice(src.indexOf('export async function meterInteraction'));
    assert.match(fn, /if \(!hasPlan\) return \{ allowed: false, noPlan: true, limitMessage: NO_PLAN_MESSAGE \}/);
    assert.match(fn, /failed: true/);
});

check('the fair-use message never tells anyone to upgrade', () => {
    for (const m of Object.values(FAIR_USE_MESSAGE)) {
        assert.ok(!/upgrade|plan|charge/i.test(m), m);
        assert.match(m, /tomorrow/);
    }
});

check('fair use fails OPEN — a rate-limit fault must not take chat down', () => {
    assert.match(read('src/utils/fair-use.ts'), /fail open/);
});

console.log(`\n${passed} checks passed.`);
