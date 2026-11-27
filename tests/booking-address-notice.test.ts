// tests/booking-address-notice.test.ts
// The one-off notice (owner, 2026-11-27) to owners of workspaces that take bookings but have no own email address:
// booking emails go only from the business's address since release #918. Broadcast audience 'bookings_no_address'
// (src/utils/broadcast.ts) — owners only, bookings in the last 180 days, workspaces WITH a route dropped; the owner
// sends it from Admin → Growth → Broadcast.
//
// Run:  npx tsx tests/booking-address-notice.test.ts

import assert from 'node:assert';
import { broadcastDef, pendingRecipients, BOOKINGS_LOOKBACK_DAYS } from '../src/utils/broadcast';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { TEMPLATE_DEFAULTS } from '../src/utils/email-templates-catalog';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

async function main() {
    console.log('\nbooking-address-notice');

    await check('only owners of booking workspaces with NO route; one row per person', async () => {
        const rows = [
            { id: 1, email: 'a@x.example', first_name: 'A', org_id: 10 },   // no route → gets it
            { id: 2, email: 'b@x.example', first_name: 'B', org_id: 11 },   // has a route → dropped
            { id: 1, email: 'a@x.example', first_name: 'A', org_id: 12 },   // same person, second workspace → once
        ];
        let sqlText = '';
        const db = { execute: async (q: { queryChunks?: unknown[] }) => { sqlText = JSON.stringify(q); return rows; } } as never;
        const got = await pendingRecipients(db, 'booking_emails_need_address_notice', 'bookings_no_address', { routed: async () => [11] });
        assert.deepStrictEqual(got.map((r) => r.id), [1]);
        assert.ok(sqlText.includes("uo.role = 'owner'") && sqlText.includes('FROM bookings b'), 'owners, and a booking in the look-back');
        assert.strictEqual(BOOKINGS_LOOKBACK_DAYS, 180);
    });

    await check('the notice: its own audience, an in-app and an email template, honest copy', () => {
        const def = broadcastDef('booking_emails_need_address_notice');
        assert.ok(def && def.audience === 'bookings_no_address');
        const inApp = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === def!.key);
        const email = TEMPLATE_DEFAULTS.find((t) => t.triggerKey === def!.key);
        assert.ok(inApp && email);
        for (const text of [inApp!.message, email!.bodyHtml]) {
            assert.ok(/Email Studio (▸|&rsaquo;) Sending/.test(text) && /Gmail or Outlook/.test(text));
            assert.ok(!/£|price|charge/i.test(text), 'nothing about money');
        }
    });

    console.log(`\n${passed}/${total} passed`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
