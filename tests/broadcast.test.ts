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
import { BROADCASTS, broadcastDef, emailsGoToCustomers, LIVE_PLAN_STATUSES, readAudience, BROADCAST_AUDIENCES } from '../src/utils/broadcast';
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
    assert.match(html, /send\.disabled = input\.value\.trim\(\) !== String\(n\) \|\| n === 0 \|\| !!b\.switchedOff;/);
    assert.match(html, /runBroadcast\(e\.currentTarget, 'send', \{ key: b\.key, expected: waitingNow\(\), audience: pick\.value \}\)/);
    assert.match(html, /pick\.addEventListener\('change', \(\) => \{ input\.value = ''; sync\(\); \}\);/, 'changing the audience clears the typed number');
});

check('ElevenLabs notice: both lists name it, the copy keeps the 14-day objection route and claims no training promise', () => {
    const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === 'subprocessor_elevenlabs_notice')!;
    const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === 'subprocessor_elevenlabs_notice')!;
    for (const s of ['ElevenLabs', 'privacy@bemoreswan.com', '14 days']) {
        assert.ok(tpl.message.includes(s), `in-app: ${s}`);
        assert.ok(email.bodyHtml.includes(s), `email: ${s}`);
    }
    assert.doesNotMatch(email.bodyHtml + tpl.message, /sorry|should have told|apolog/i, 'no apology (owner, 2026-11-20): ElevenLabs was never opened to customers before launch');
    assert.doesNotMatch(email.bodyHtml + tpl.message, /\btrain/i, 'ElevenLabs\' DPA makes no training promise, so neither do we');
    assert.doesNotMatch(email.bodyHtml, /within 14 days of (?:\d|[A-Z][a-z]+ \d)/, 'no fixed objection date: the 14 days run from the send');
    assert.match(read('trust.html'), /<td[^>]*>ElevenLabs<\/td>/);
    assert.match(read('privacy.html'), /<td[^>]*>ElevenLabs<\/td>/);
});

check('Recall.ai notice (Note Taker launch 27 Nov 2026): owners, both lists, every promise matches the code and the published pages', () => {
    const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === 'subprocessor_recall_notice')!;
    const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === 'subprocessor_recall_notice')!;
    assert.ok(tpl && email, 'both templates exist');
    assert.strictEqual(broadcastDef('subprocessor_recall_notice')?.audience, 'owners');
    for (const s of ['Recall.ai', 'AssemblyAI', '27 November 2026', 'privacy@bemoreswan.com', 'do not keep the transcript']) {
        assert.ok(tpl.message.includes(s), `in-app: ${s}`);
        assert.ok(email.bodyHtml.includes(s), `email: ${s}`);
    }
    assert.ok(email.bodyHtml.includes('as soon as the minutes are written'), 'deletion matches the code and privacy/Trust');
    assert.ok(email.bodyHtml.includes('if that deletion fails, the audio and text are deleted within 3 days'), 'exact AssemblyAI wording');
    assert.ok(email.bodyHtml.includes('version 1.2'), 'the specific-authorisation basis');
    assert.ok(email.bodyHtml.includes('On 27 November we will add Recall.ai to the list of sub-processors'), 'true if sent before the launch pages are live (review of #867)');
    assert.ok(tpl.message.includes('US support staff'), 'the in-app copy names the US support access too (review of #867)');
    assert.doesNotMatch(email.bodyHtml + tpl.message, /saved the transcript|30 days|Zoom|within 3 days at most|\btrain/i, 'no promise the code or Recall has not confirmed');
});

check('Google Cloud notice (Gmail push): owners, both lists, every claim matches the push code and the topic set-up', () => {
    const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === 'subprocessor_google_cloud_notice')!;
    const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === 'subprocessor_google_cloud_notice')!;
    assert.ok(tpl && email, 'both templates exist');
    assert.strictEqual(broadcastDef('subprocessor_google_cloud_notice')?.audience, 'owners', 'DPA clause 5 notice goes to owners');
    for (const s of ['Google Cloud', 'Pub/Sub', 'privacy@bemoreswan.com', '14 days', 'Email Assistant', 'reference number']) {
        assert.ok(tpl.message.includes(s), `in-app: ${s}`);
        assert.ok(email.bodyHtml.includes(s), `email: ${s}`);
    }
    assert.ok(email.bodyHtml.includes('no email content') && tpl.message.includes('never email content'), 'a push carries only the address and historyId (mail-push-gmail.ts)');
    assert.ok(email.bodyHtml.includes('up to 7 days'), 'the subscription keeps undelivered messages 7 days');
    assert.ok(email.bodyHtml.includes('until at least 14 days after this email'), 'production push waits for the notice');
    assert.doesNotMatch(email.bodyHtml, /within 14 days of (?:\d|[A-Z][a-z]+ \d)/, 'no fixed objection date: the 14 days run from the send');
    assert.doesNotMatch(email.bodyHtml + tpl.message, /\btrain|sorry|apolog|EU only|UK only/i, 'no promise the set-up does not keep (topic has no region policy)');
    for (const f of ['trust.html', 'privacy.html']) {
        const html = read(f);
        assert.match(html, /<td[^>]*>Google Cloud \(Pub\/Sub\)<\/td>/, `${f} lists it`);
        assert.match(html, /Google Cloud, (?:on|in) the list above, is different: it is our own\s+account/, `${f} says why it is not a connected platform`);
    }
});

check('audience (owner, 2026-11-20): owners or everyone, picked per send, never widened by a missing field', () => {
    assert.deepStrictEqual([...BROADCAST_AUDIENCES], ['owners', 'everyone']);
    assert.strictEqual(readAudience('owners'), 'owners');
    assert.strictEqual(readAudience('everyone'), 'everyone');
    for (const bad of [undefined, null, '', 'admins', 'Owners']) assert.strictEqual(readAudience(bad), null);
    assert.strictEqual(broadcastDef('subprocessor_elevenlabs_notice')?.audience, 'owners', 'the DPA notice goes to owners');
    assert.strictEqual(broadcastDef('ai_video_per_second_notice')?.audience, 'everyone');
    const util = read('src/utils/broadcast.ts');
    assert.match(util, /\$\{audience === 'owners' \? sql`AND uo\.role = 'owner'` : sql``\}/);
    const fn = read('netlify/functions/admin-broadcast.ts');
    assert.ok(fn.indexOf("const audience = readAudience(body.audience);") < fn.indexOf('const waiting = (await pendingRecipients(db, def.key, audience)).length;'), 'the count is checked for the audience picked');
    assert.match(fn, /if \(!audience\) return json\(400,/);
    assert.match(fn, /body: JSON\.stringify\(\{ key: def\.key, adminId, audience \}\)/);
    const worker = read('netlify/functions/admin-broadcast-background.ts');
    assert.match(worker, /if \(!audience\) return \{ statusCode: 400, body: 'audience required\.' \};/, 'no audience → no send, never everyone');
    assert.match(worker, /recipients = await pendingRecipients\(db, def\.key, audience\);/);
    assert.match(util, /export async function pendingRecipients\(db: Db, key: string, audience: BroadcastAudience\): Promise/, 'no default: every caller says who');
    // Review of #788: two sends of one notice at once must not reach anyone twice.
    assert.ok(worker.indexOf('if (await alreadyHas(db, r.id, sentMark)) continue;') > 0
        && worker.indexOf('if (await alreadyHas(db, r.id, sentMark)) continue;') < worker.indexOf('const ok = await createNotification('), 'checked again just before each send');
    assert.match(read('admin.html'), /b\.switchedOff \?/, 'a switched-off notice says so on the card');
});

check('the Broadcast page previews the copy that will go out, saved Admin edits included', () => {
    const fn = read('netlify/functions/admin-broadcast.ts');
    assert.match(fn, /const tpl = await renderNotification\(b\.key,/);
});

console.log(`\n${passed} checks passed`);
