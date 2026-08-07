// tests/admin-message-notification.test.ts
// The ad-hoc admin → user in-app message ("Send a Message" in the admin portal's Comms section).
//
// Every check here guards a failure mode that is SILENT. Nothing in this feature throws:
//   - a type that isn't in the preference matrix falls back to a user-mutable category, so a
//     muted user never receives the message and the admin still sees "sent";
//   - a type accidentally added to EMAIL_FALLBACK_TYPES quietly emails everyone an hour later;
//   - a body that isn't escaped whole gets silently gutted by the client-side allow-list.
// There is no delivery receipt anywhere in this system to catch any of it after the fact.
//
// No database: catalog/config assertions plus source-consistency checks.
// Run:  npx tsx tests/admin-message-notification.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREF_CATEGORIES, categoryForType } from '../src/utils/notification-prefs';
import { EMAIL_FALLBACK_TYPES, CATEGORY_DISMISSIBLE } from '../src/utils/notification-actions';
import { ADMIN_MESSAGE_TYPE } from '../src/utils/notify';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const notifySrc = read('src/utils/notify.ts');
const fnSrc = read('netlify/functions/admin-send-notification.ts');
const adminHtml = read('admin.html');

console.log('\n──── the message cannot be silently muted ────');

check('admin_message has its own preference category, not the fallback', () => {
    const cat = categoryForType(ADMIN_MESSAGE_TYPE);
    // FALLBACK_CATEGORY is product_updates. Landing there would mean anyone who muted
    // "Product, Milestones & Support" never sees a message an admin typed to them by hand.
    assert.notStrictEqual(cat.key, 'product_updates',
        'admin_message fell through to the product_updates fallback — a muted user would never receive it');
    assert.strictEqual(cat.key, 'admin_messages');
});

check('that category is LOCKED on in-app', () => {
    const cat = categoryForType(ADMIN_MESSAGE_TYPE);
    assert.strictEqual(cat.inApp.locked, true, 'in-app must be locked — the user must not be able to mute it');
    assert.strictEqual(cat.inApp.default, true);
});

check('it is account-scope, so the toggle actually renders somewhere', () => {
    // assistant-scope rows render only in the Assistant Profile drawer and key their override on
    // notifications.assistant_id. An ad-hoc message has no assistant, so it would have no UI.
    assert.strictEqual(categoryForType(ADMIN_MESSAGE_TYPE).scope, 'account');
});

check('exactly one category claims the type', () => {
    const owners = PREF_CATEGORIES.filter((c) => c.types.includes(ADMIN_MESSAGE_TYPE));
    assert.strictEqual(owners.length, 1, `expected 1 category to own ${ADMIN_MESSAGE_TYPE}, found ${owners.length}`);
});

console.log('\n──── it stays in-app: no email can leak ────');

check('admin_message is NOT on the email-fallback allowlist', () => {
    assert.ok(!EMAIL_FALLBACK_TYPES.includes(ADMIN_MESSAGE_TYPE),
        'adding it here would email every unread message an hour after sending');
});

check('the endpoint sends no email of its own', () => {
    assert.ok(!/sendEmail|resend|Resend/.test(fnSrc),
        'admin-send-notification must not send email — the feature is in-app only');
});

console.log('\n──── it renders as a dismissible FYI ────');

check('the type falls to the informational default (no DDL needed)', () => {
    // Absent from the CASE in db/notifications-categorization.sql AND from TYPE_CATEGORY, so both
    // the trigger and the code default it to informational. If someone adds it to either, they
    // must add it to both or the card renders one way and sorts another.
    const sql = read('db/notifications-categorization.sql');
    assert.ok(!sql.includes(ADMIN_MESSAGE_TYPE),
        'admin_message appeared in the categorization SQL — the code map must be updated to match');
    const actionsSrc = read('src/utils/notification-actions.ts');
    const inTypeMap = new RegExp(`${ADMIN_MESSAGE_TYPE}\\s*:`).test(actionsSrc);
    assert.ok(!inTypeMap, 'admin_message was added to TYPE_CATEGORY — update the SQL trigger to match');
});

check('informational notifications are dismissible', () => {
    assert.strictEqual(CATEGORY_DISMISSIBLE.informational, true,
        'an FYI from the team must be closeable, or it pins itself to the feed forever');
});

console.log('\n──── the copy is escaped whole ────');

check('createAdminMessage escapes the title and the body', () => {
    assert.ok(/export async function createAdminMessage/.test(notifySrc), 'createAdminMessage is missing');
    const body = notifySrc.slice(notifySrc.indexOf('export async function createAdminMessage'));
    assert.ok(/escapeHtml\(opts\.title\)/.test(body), 'the title must be escaped');
    assert.ok(/escapeAdminText\(opts\.message\)/.test(body), 'the message must go through escapeAdminText');
});

check('escapeAdminText escapes first, then promotes newlines', () => {
    // Order matters: escaping after the newline swap would turn our own <br> into &lt;br&gt;.
    const m = notifySrc.match(/function escapeAdminText[\s\S]*?\n}/);
    assert.ok(m, 'escapeAdminText is missing');
    const src = m![0];
    assert.ok(src.indexOf('escapeHtml') < src.indexOf('<br>'), 'escape must happen before the newline replacement');
});

check('<br> is the only tag produced, and it survives the client allow-list', () => {
    // notifications.js drops any element outside this set and strips every attribute, so a tag
    // the server emits that is not on the list is silently deleted from what the user reads.
    const clientSrc = read('notifications.js');
    const m = clientSrc.match(/SANITIZE_ALLOWED = new Set\(\[([^\]]+)\]\)/);
    assert.ok(m, 'could not find SANITIZE_ALLOWED in notifications.js');
    assert.ok(m![1].includes("'BR'"), 'BR is no longer allow-listed client-side — line breaks would vanish');
});

console.log('\n──── the endpoint is guarded ────');

check('it gates on manage_comms_templates', () => {
    assert.ok(/requirePermission\(admin\.role, 'manage_comms_templates'\)/.test(fnSrc));
});

check('it refuses to send from an impersonated session', () => {
    assert.ok(/scope === 'impersonate'/.test(fnSrc),
        'a message sent while impersonating would be attributed to the wrong person');
});

check('it resolves the environment like the user picker does', () => {
    // The picker is admin-api?resource=users, which runs env-routed. Without the same resolution
    // here, picking sandbox user #42 would insert a row for LIVE user #42 — a different person.
    assert.ok(/resolveEnvironment\(event\.headers/.test(fnSrc), 'must resolve X-Environment');
    assert.ok(/runWithEnvironment\(env/.test(fnSrc), 'the insert must run inside the resolved environment');
});

check('it treats a false return as a failure, not a send', () => {
    assert.ok(/if \(!sent\)/.test(fnSrc),
        'createAdminMessage returns false rather than throwing — a human is waiting on this one');
});

check('it audits the send', () => {
    assert.ok(/action: 'notification_sent'/.test(fnSrc));
    const auditSrc = read('src/utils/admin-audit.ts');
    assert.ok(/'notification_sent'/.test(auditSrc), "notification_sent is missing from the AdminAction union");
});

console.log('\n──── the portal wires it up ────');

check('the nav entry, view section and dispatch all exist', () => {
    assert.ok(/view: 'send-notification'/.test(adminHtml), 'nav entry missing');
    assert.ok(/id="view-send-notification"/.test(adminHtml), 'view section missing');
    assert.ok(/if \(view === 'send-notification'\)/.test(adminHtml), 'view dispatch missing');
    assert.ok(/'send-notification': 'Send a Message'/.test(adminHtml), 'page title missing');
});

check('the nav entry carries the same permission as the endpoint', () => {
    const m = adminHtml.match(/view: 'send-notification'[^}]*perm: '([^']+)'/);
    assert.ok(m, 'could not read the nav entry permission');
    assert.strictEqual(m![1], 'manage_comms_templates',
        'the nav gate and the API gate must agree or the entry shows and then 403s');
});

check('the recipient picker avoids inline onclick', () => {
    // Attribute values are entity-decoded before the JS is parsed, so an escaped apostrophe in a
    // name like O'Brien would break out of the argument string.
    const block = adminHtml.slice(adminHtml.indexOf('async function runUserSearch'));
    const searchBody = block.slice(0, block.indexOf('function chooseSendRecipient'));
    assert.ok(!/onclick="chooseSendRecipient/.test(searchBody), 'result rows must not use an inline onclick');
    assert.ok(/data-name=/.test(searchBody) && /addEventListener\('click'/.test(searchBody));
});

console.log('\n──── the sent messages show up in Contacts ────');

const adminApiSrc = read('netlify/functions/admin-api.ts');

check('contact-detail returns adminMessages', () => {
    assert.ok(/JSON\.stringify\(\{ lead, thread, tasks, client, tickets, issues, adminMessages \}\)/.test(adminApiSrc),
        'contact-detail must include adminMessages in its response');
});

check('the query filters on the shared constant, not a literal', () => {
    // A hardcoded 'admin_message' here would silently return nothing the day the type is renamed
    // in notify.ts — the panel would just look like no messages were ever sent.
    assert.ok(/import \{ createNotification, ADMIN_MESSAGE_TYPE \}/.test(adminApiSrc),
        'admin-api must import ADMIN_MESSAGE_TYPE from notify.ts');
    assert.ok(/eq\(notifications\.type, ADMIN_MESSAGE_TYPE\)/.test(adminApiSrc),
        'the contact-detail query must filter by ADMIN_MESSAGE_TYPE');
});

check('the section renders before Tasks', () => {
    const detail = adminHtml.slice(adminHtml.indexOf('function renderContactDetail'));
    const body = detail.slice(0, detail.indexOf('function _ctSection'));
    const msgs = body.indexOf('_ctAdminMessagesSection(');
    const tasks = body.indexOf("'Tasks',");
    assert.ok(msgs > -1, 'the In App Messages section is not rendered');
    assert.ok(tasks > -1, 'could not locate the Tasks section');
    assert.ok(msgs < tasks, 'In App Messages must render before the Tasks section');
});

check('the section is titled "In App Messages"', () => {
    assert.ok(/'In App Messages'/.test(adminHtml), 'the section heading is missing');
});

check('openContact passes the messages through', () => {
    assert.ok(/data\.adminMessages \|\| \[\]/.test(adminHtml),
        'openContact must forward data.adminMessages to renderContactDetail');
});

check('the panel does not escape the copy a second time', () => {
    // createAdminMessage stores title/message ALREADY escaped. Running them through _escH here
    // would surface literal &amp;/&lt; to the admin, and would turn its own <br> into text.
    const start = adminHtml.indexOf('function _ctAdminMessagesSection');
    assert.ok(start > -1, '_ctAdminMessagesSection is missing');
    const body = adminHtml.slice(start, adminHtml.indexOf('function _ctQuickAction'));
    assert.ok(!/_escH\(m\.(title|message)\)/.test(body), 'stored admin copy must not be re-escaped');
    assert.ok(/_ctAdminMsgHtml\(m\.title\)/.test(body) && /_ctAdminMsgHtml\(m\.message\)/.test(body),
        'title and message must go through the _ctAdminMsgHtml allow-list');
});

check('the allow-list drops attributes and unknown tags', () => {
    const m = adminHtml.match(/function _ctAdminMsgHtml\(s\) \{[\s\S]*?\n\}/);
    assert.ok(m, '_ctAdminMsgHtml is missing');
    // Reconstruct the one-liner so the regex itself is under test, not a copy of it.
    const fn = new Function('s', m![0].replace(/^function _ctAdminMsgHtml\(s\) \{/, '').replace(/\}$/, '')) as (s: string) => string;
    assert.strictEqual(fn('line one<br>line two'), 'line one<br>line two', '<br> must survive');
    assert.strictEqual(fn('<b>bold</b>'), '<b>bold</b>', 'plain <b> must survive');
    assert.strictEqual(fn('<img src=x onerror=alert(1)>'), '', 'unknown tags must be stripped');
    // A tag carrying attributes is dropped wholesale (an orphaned </b> may remain — inert).
    assert.ok(!fn('<b onclick="x()">hi</b>').includes('onclick'), 'tags carrying attributes must be stripped');
    assert.ok(!fn('<a href="http://evil">x</a>').includes('href'), 'links must not survive');
});

console.log(`\n${passed} checks passed.\n`);
