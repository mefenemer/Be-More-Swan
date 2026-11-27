// tests/booking-emails-own-address.test.ts
// Booking emails to customers (confirmations with their calendar invite, receipts, reminders, cancellations, stay
// emails, deposit and balance receipts) go ONLY from the owner's own address (owner 2026-11-27;
// src/utils/business-email.ts), never "via Be More Swan"; with none they aren't sent and the owner is told. A mailbox
// send carries the .ics invite (gmail.ts gmailMime multipart/mixed; outlook.ts fileAttachment).
//
// Run:  npx tsx tests/booking-emails-own-address.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingEmailLine, bookingEmailsBlocked, sendBusinessEmail } from '../src/utils/business-email';
import { gmailMime } from '../src/utils/gmail';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const db = {} as never;
const ICS = Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n').toString('base64');

async function main() {
    console.log('\nbooking-emails-own-address');

    await check('with a route: sent through it, with a text part and the invite; replies to the owner when the domain names none', async () => {
        const seen: Array<{ route: { replyTo: string | null; from: string | null }; m: { to: string; text: string; attachments?: unknown[] } }> = [];
        const r = await sendBusinessEmail(db, 5, { business: 'Willow Salon', to: 'sam@x.example\r\n', subject: 'Booking confirmed', html: '<p>See you <strong>Monday</strong>.</p>', replyTo: 'owner@willow.example', attachments: [{ filename: 'booking.ics', content: ICS, contentType: 'text/calendar' }] }, {
            resolveRoute: (async () => ({ route: { provider: 'resend', from: 'Willow <hi@willow.example>', replyTo: null, engagementTracked: false } })) as never,
            deliver: (async (_db: unknown, route: never, _org: number, m: never) => { seen.push({ route, m }); return null; }) as never,
        });
        assert.strictEqual(r, 'sent');
        assert.strictEqual(seen[0].m.to, 'sam@x.example');
        assert.strictEqual(seen[0].route.replyTo, 'owner@willow.example');
        assert.ok(!/bemoreswan/i.test(String(seen[0].route.from)));
        assert.ok(seen[0].m.text.includes('Monday') && !seen[0].m.text.includes('<'));
        assert.strictEqual(seen[0].m.attachments?.length, 1);
    });

    await check('no route → not sent ("no_route"); a refusal → "failed"; never throws', async () => {
        let delivered = 0;
        const none = await sendBusinessEmail(db, 5, { business: 'W', to: 'a@b.example', subject: 's', html: 'h' }, {
            resolveRoute: (async () => ({ error: 'none' })) as never, deliver: (async () => { delivered++; return null; }) as never,
        });
        assert.strictEqual(none, 'no_route');
        assert.strictEqual(delivered, 0);
        const failed = await sendBusinessEmail(db, 5, { business: 'W', to: 'a@b.example', subject: 's', html: 'h' }, {
            resolveRoute: (async () => ({ route: { provider: 'gmail', from: null, replyTo: null, engagementTracked: false } })) as never,
            deliver: (async () => { throw new Error('token expired'); }) as never,
        });
        assert.strictEqual(failed, 'failed');
    });

    await check('the owner\'s lines and the Bookings tab warning', async () => {
        assert.ok(/NOT sent their booking confirmation/.test(String(bookingEmailLine('no_route'))) && /yourself/.test(String(bookingEmailLine('no_route'))));
        assert.ok(/cancellation couldn't be sent/.test(String(bookingEmailLine('failed', 'cancellation'))));
        assert.strictEqual(bookingEmailLine('sent'), null);
        assert.ok(/Customers get no booking emails/.test(String(await bookingEmailsBlocked(db, 5, (async () => ({ error: 'x' })) as never))));
        assert.strictEqual(await bookingEmailsBlocked(db, 5, (async () => ({ route: {} })) as never), null);
    });

    await check('Gmail: the invite rides in multipart/mixed after the text/HTML alternative; no attachment = unchanged shape', () => {
        const mime = gmailMime({ to: 'sam@x.example', subject: 'Booking confirmed', body: 'See you Monday', html: '<p>See you Monday</p>', attachments: [{ filename: 'booking".ics', content: ICS, contentType: 'text/calendar' }] });
        assert.ok(mime.includes('Content-Type: multipart/mixed; boundary="bms-mixed-boundary-3d7e9b"'));
        assert.ok(mime.indexOf('multipart/alternative') < mime.indexOf('Content-Disposition: attachment; filename="booking.ics"'), 'content first, file after; quotes stripped');
        assert.ok(mime.includes('Content-Type: text/calendar; name="booking.ics"') && mime.includes(ICS));
        assert.ok(mime.trimEnd().endsWith('--bms-mixed-boundary-3d7e9b--'));
        const plain = gmailMime({ to: 'a@b.example', subject: 's', body: 'b', html: '<p>b</p>' });
        assert.ok(!plain.includes('multipart/mixed') && plain.includes('multipart/alternative'));
    });

    await check('wired: no Be More Swan sender left for any booking email; Outlook carries files; owner told', () => {
        for (const f of ['src/utils/bookings.ts', 'src/utils/stay-jobs.ts', 'src/utils/site-stay-booking.ts', 'netlify/functions/stripe-connect-webhook.ts']) {
            assert.ok(!/fromLine|\(via Be More Swan\)|from: .*noreply@/.test(read(f)), f);
        }
        const bk = read('src/utils/bookings.ts');
        assert.ok(bk.includes('const r = await sendBusinessEmail(db, b.organisationId, {') && bk.includes("filename: 'booking.ics'"));
        const announce = bk.slice(bk.indexOf('export async function announceNewBooking('));
        assert.ok(announce.indexOf('await emailCustomer(db, b,') < announce.indexOf('to: owner.email'), 'customer first, so the owner email can say');
        assert.ok(read('src/utils/outlook.ts').includes("'@odata.type': '#microsoft.graph.fileAttachment'"));
        assert.ok(read('src/utils/newsletter-sequence.ts').includes('...(msg.attachments?.length ? { attachments: msg.attachments } : {}),'));
        assert.ok(read('netlify/functions/sites.ts').includes('emailBlocked: await bookingEmailsBlocked(db, orgId)') && read('netlify/functions/sites.ts').includes('emailLine: r.emailLine'));
        assert.ok(read('src/components/assistant-site-editor.js').includes('data-booking-email-blocked') && read('src/components/site-booking-calendar.js').includes('if (r && r.emailLine)'));
        const stay = read('src/utils/stay-jobs.ts');
        assert.ok(stay.includes('else await db.update(bookings).set({ reminderSentAt: null })'), 'arrival details: retried once there is an address');
    });

    console.log(`\n${passed}/${total} passed`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
