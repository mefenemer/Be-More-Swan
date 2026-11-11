// tests/broadcast.test.ts
// Growth → Broadcast: a reviewed notice to every customer, once each (src/utils/broadcast.ts).
// What goes wrong silently if these drift:
//   · staging emailing real people (its database holds real addresses)
//   · a second press, or a retried worker, emailing everyone twice
//   · a notice going out with no email twin, or a free-text broadcast nobody reviewed
//   · a send firing from a stale page that showed a different count
// No network, no database.
//
// Run:  npx tsx tests/broadcast.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROADCASTS, broadcastDef, emailsGoToCustomers, LIVE_PLAN_STATUSES } from '../src/utils/broadcast';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { TEMPLATE_DEFAULTS } from '../src/utils/email-templates-catalog';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

check('every broadcast has an in-app and an email template with the same key, and the email is transactional', () => {
    assert.ok(BROADCASTS.length > 0);
    for (const b of BROADCASTS) {
        assert.ok(NOTIFICATION_DEFAULTS.some((t) => t.templateKey === b.key && t.type === b.key), `${b.key}: in-app template whose type is the key (the once-each mark)`);
        const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === b.key);
        assert.ok(email, `${b.key}: email template`);
        assert.strictEqual(email!.transactional, true, 'a notice of a terms change is not marketing');
    }
    assert.strictEqual(broadcastDef('anything_else'), null, 'only listed notices');
});

check('the in-app and email copy say the same date and figures', () => {
    const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === 'ai_video_per_second_notice')!;
    const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === 'ai_video_per_second_notice')!;
    for (const s of ['3 December', '4 tasks for each second']) {
        assert.ok(tpl.message.includes(s) || tpl.title.includes(s), `in-app: ${s}`);
        assert.ok(email.bodyHtml.includes(s) || email.subject.includes(s), `email: ${s}`);
    }
    for (const [len, now] of [['3 seconds', '12 tasks'], ['5 seconds', '20 tasks'], ['6 seconds', '24 tasks'], ['10 seconds', '40 tasks']]) {
        assert.match(email.bodyHtml, new RegExp(`${len}</td><td[^>]*>20 tasks</td><td[^>]*>${now}</td>`));
    }
});

check('customer emails only from the production deploy', () => {
    const was = { CONTEXT: process.env.CONTEXT, BRANCH: process.env.BRANCH };
    const prod = { host: 'bemoreswan.com' };
    const staging = { host: 'staging--bemoreswan.netlify.app' };
    try {
        process.env.CONTEXT = 'production'; assert.strictEqual(emailsGoToCustomers(staging), true);
        process.env.CONTEXT = 'branch-deploy'; assert.strictEqual(emailsGoToCustomers(prod), false, 'a branch build never emails customers');
        delete process.env.CONTEXT; delete process.env.BRANCH;
        // ⚠️ The case that shipped broken (2026-11-02): no CONTEXT at function runtime ON production.
        assert.strictEqual(emailsGoToCustomers(prod), true, 'production is known by its host when CONTEXT is missing');
        assert.strictEqual(emailsGoToCustomers({ host: 'www.bemoreswan.com' }), true);
        assert.strictEqual(emailsGoToCustomers({ 'x-forwarded-host': 'bemoreswan.com' }), true);
        assert.strictEqual(emailsGoToCustomers(staging), false, 'staging never emails customers');
        assert.strictEqual(emailsGoToCustomers({ host: 'deploy-preview-12--bemoreswan.netlify.app' }), false);
        assert.strictEqual(emailsGoToCustomers({}), false, 'no host: we cannot tell, so no customer email');
        assert.strictEqual(emailsGoToCustomers(undefined), false);
    } finally {
        for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    const worker = read('netlify/functions/admin-broadcast-background.ts');
    assert.match(worker, /const live = emailsGoToCustomers\(event\.headers/);
    for (const f of ['netlify/functions/admin-broadcast.ts', 'netlify/functions/admin-task-costs.ts', 'netlify/functions/admin-broadcast-background.ts']) {
        assert.doesNotMatch(read(f), /emailsGoToCustomers\(\)/, `${f} must pass the request headers`);
    }
    assert.ok(worker.indexOf('if (!live) continue;') < worker.indexOf('sendTemplatedEmail('), 'no customer email off production');
});

check('once each: the in-app row is the mark, written before the email, and recipients exclude anyone who has it', () => {
    const util = read('src/utils/broadcast.ts');
    assert.match(util, /AND NOT EXISTS \(SELECT 1 FROM notifications n WHERE n\.user_id = u\.id AND n\.type = \$\{key\}\)/);
    assert.match(util, /WHERE u\.status = 'active'/);
    assert.deepStrictEqual([...LIVE_PLAN_STATUSES], ['active', 'past_due', 'cancelling', 'downgrading']);
    const worker = read('netlify/functions/admin-broadcast-background.ts');
    assert.ok(worker.indexOf('createNotification(db, def.key') < worker.indexOf('sendTemplatedEmail('), 'mark first');
    assert.match(worker, /if \(!ok\) continue;/, 'no mark → no email');
});

check('a send needs the count the admin saw, the secret, super-admin and the live database', () => {
    const fn = read('netlify/functions/admin-broadcast.ts');
    assert.match(fn, /if \(!Number\.isInteger\(body\.expected\) \|\| body\.expected !== waiting\)/);
    assert.match(fn, /return json\(409,/);
    assert.match(fn, /requirePermission\(admin\.role, 'manage_comms_templates'\)/);
    assert.match(fn, /tok\.scope === 'impersonate'/);
    assert.match(fn, /!== 'live'\) \{/);
    assert.match(fn, /Authorization: `Bearer \$\{secret\}`/);
    assert.match(read('netlify/functions/admin-broadcast-background.ts'), /auth\.replace\(\/\^Bearer\\s\+\/i, ''\)\.trim\(\) !== secret/);
});

check('the admin page sends only after the number waiting is typed', () => {
    const html = read('admin.html');
    assert.ok(html.includes('id="view-broadcast"'));
    assert.match(html, /\{ view: 'broadcast', +icon: '📣', label: 'Broadcast', +perm: 'manage_comms_templates', +group: 'Messages' \}/);
    assert.match(html, /send\.disabled = input\.value\.trim\(\) !== String\(b\.waiting\) \|\| b\.waiting === 0;/);
    assert.match(html, /runBroadcast\(e\.currentTarget, 'send', \{ key: b\.key, expected: b\.waiting \}\)/);
});

console.log(`\n${passed} checks passed`);
