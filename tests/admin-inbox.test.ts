// tests/admin-inbox.test.ts
// Admin alert EMAILS go to the business inbox, not each admin's personal account (2026-10-03).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminInbox } from '../src/utils/admin-inbox';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('defaults to hello@bemoreswan.com, overridable and de-duplicated', () => {
    const was = process.env.ADMIN_ALERT_EMAIL;
    delete process.env.ADMIN_ALERT_EMAIL;
    assert.deepStrictEqual(adminInbox(), ['hello@bemoreswan.com']);
    process.env.ADMIN_ALERT_EMAIL = 'a@x.com, b@x.com,a@x.com';
    assert.deepStrictEqual(adminInbox(), ['a@x.com', 'b@x.com']);
    if (was == null) delete process.env.ADMIN_ALERT_EMAIL; else process.env.ADMIN_ALERT_EMAIL = was;
});

check('all four admin emails send to the inbox, never to an admin user\'s own address', () => {
    for (const f of ['netlify/functions/quarterly-bias-reminder.ts', 'netlify/functions/bias-sampling.ts', 'netlify/functions/report-security-incident.ts']) {
        const s = read(f);
        assert.match(s, /for \(const to of adminInbox\(\)\)/, `${f} does not email the inbox`);
        assert.doesNotMatch(s, /to: (admin|sa)\.email/, `${f} still emails an admin account`);
    }
    const ir = read('src/utils/issue-reports.ts');
    assert.match(ir, /: adminInbox\(\);/);
    assert.doesNotMatch(ir, /eq\(users\.role, 'super_admin'\), eq\(users\.role, 'admin'\)/);
});

console.log(`\n${passed} checks passed`);
