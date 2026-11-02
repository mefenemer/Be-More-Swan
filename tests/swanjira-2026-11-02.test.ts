// tests/swanjira-2026-11-02.test.ts
// Source checks for SwanJira tickets SWAN-14 to SWAN-16 (raised on staging 2026-11-02). SWAN-14's
// behaviour is also proved against real Postgres in tests/partner-applications-db.test.ts (CI).
//
// Run:  npx tsx tests/swanjira-2026-11-02.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(p, 'utf8');

check('SWAN-14: an application is linked by its own email, never by who is signed in', () => {
    const lib = read('src/utils/partner-applications.ts');
    assert.match(lib, /export async function recordApplication\(db: Db, v: ApplicationInput\): Promise</);
    assert.ok(!/let userId = signedInUserId/.test(lib), 'the session still decides whose application it is');
    const fn = read('netlify/functions/partner-apply.ts');
    assert.match(fn, /await recordApplication\(db, v\);/);
    assert.ok(!fn.includes('aura_session'), 'partner-apply still reads the session cookie');
});

check('SWAN-15: Partner Terms describe today\'s refer-a-friend reward and a current price', () => {
    const terms = read('partner-terms.html');
    assert.ok(!terms.includes('referral tokens'));
    assert.match(terms, /earns free months of Be More Swan, not commission/);
    assert.match(terms, /pays £69 excluding VAT, £13\.80 is deducted for costs, leaving £55\.20; at a 25% rate you earn £13\.80/);
});

check('SWAN-15: the arithmetic in the worked example is right', () => {
    const price = 69, deduction = 0.2, rate = 0.25;
    assert.strictEqual((price * deduction).toFixed(2), '13.80');
    assert.strictEqual((price * (1 - deduction)).toFixed(2), '55.20');
    assert.strictEqual((price * (1 - deduction) * rate).toFixed(2), '13.80');
});

check('SWAN-15: the application email links over https and fits existing customers', () => {
    const cat = read('src/utils/email-templates-catalog.ts');
    const i = cat.indexOf("triggerKey: 'partner_application_received'");
    const block = cat.slice(i, cat.indexOf('triggerKey:', i + 20));
    assert.match(block, /<a href="https:\/\/bemoreswan\.com"/);
    assert.match(block, /If you already use Be More Swan, your Partner page will be waiting in your workspace/);
});

check('SWAN-16: the admin guard does not pose as an OAuth refusal', () => {
    const admin = read('admin.html');
    assert.ok(!admin.includes("replace('/workspace.html?error=access_denied')"));
    assert.match(admin, /window\.location\.replace\('\/workspace\.html'\);/);
});

console.log(`\n${passed} passed`);
