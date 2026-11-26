// tests/shop-checkout-reminder-db.test.ts
// The abandoned-checkout reminder on REAL Postgres (online shop Phase 2, slice 5; feature request #35,
// docs/online-shop-review-plan.md §12; src/utils/shop-checkout-reminder.ts): only a ticked checkout with an email,
// only the basket's latest checkout, never twice, never to a refused address, no route = not sent, the Shop tab
// counts, the unsubscribe link, and the sweep keeping reminded baskets.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`: columns, defaults, checks, indexes; no foreign keys) in
// a throwaway schema, search_path set to it. CI's database comes from db/schema.ts (drizzle push), so site_baskets'
// new columns and their check here are the schema's. The send route and the sender are stubbed for the "sent" case.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-checkout-reminder-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type Stripe from 'stripe';
import { closeDbPools } from '../db/client';
import { loadReminderStats, saveReminderEmail, sendCheckoutReminder, stopRemindedAddress } from '../src/utils/shop-checkout-reminder';
import { sweepBaskets } from '../src/utils/shop-basket';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('Abandoned-checkout reminder: ticked only, once, never refused, own route only (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_checkout_reminder_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['organisations', 'sites', 'site_baskets', 'site_orders', 'audience_contacts', 'audience_consent_events', 'lead_opt_outs', 'suppression_list', 'newsletter_sending_domains']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 7, SITE = 70, ACCT = 'acct_kudzu';
        await sql.unsafe(`INSERT INTO organisations (id, name, slug) VALUES (${ORG}, 'Kudzu Candles', 'kudzu-test')`);
        await sql.unsafe(`INSERT INTO sites (id, organisation_id, ai_assistant_id, slug, draft) VALUES (${SITE}, ${ORG}, 1, 'kudzu', '{}'::jsonb)`);

        const connectAccountFor = async () => ({ stripeAccountId: ACCT });
        const sent: { to: string; subject: string; html: string; listUnsubscribe: string | null }[] = [];
        const okRoute = { resolveRoute: (async () => ({ route: { provider: 'gmail', from: null, replyTo: null, engagementTracked: false } })) as never, deliver: (async (_db: unknown, _r: unknown, _o: unknown, m: { to: string; subject: string; html: string; listUnsubscribe: string | null }) => { sent.push(m); return null; }) as never };
        const now = new Date();
        let n = 0;
        const basket = async (o: { email: string | null; ticked?: boolean; items?: string }) => {
            n++;
            const id = `Basket${String(n).padStart(2, '0')}${'x'.repeat(16)}`.slice(0, 24);
            const sid = `cs_test_${n}`;
            await sql.unsafe(`INSERT INTO site_baskets (id, site_id, organisation_id, items, checkout_lines, checkout_session_id)
                VALUES ($1, ${SITE}, ${ORG}, $2::jsonb, jsonb_build_object($3::text, '[{"productId":1,"optionId":null,"name":"Fig candle","unit":1200,"qty":2}]'::jsonb), $3)`,
                [id, o.items ?? '[{"productId":1,"optionId":null,"sectionId":"s","qty":2}]', sid]);
            await saveReminderEmail(db, { basketId: id, siteId: SITE, sessionId: sid, email: o.email, expiresAt: o.email ? new Date(now.getTime() - 60_000) : null });
            const session = {
                id: sid, expires_at: Math.floor(now.getTime() / 1000) - 60, cancel_url: `https://kudzu.example/basket?b=${id}`,
                metadata: { bms_basket: id, bms_site_id: String(SITE), ...(o.ticked === false ? {} : { bms_news: '1' }) },
            } as unknown as Stripe.Checkout.Session;
            return { id, sid, session };
        };
        const row = async (id: string) => (await sql.unsafe(`SELECT reminder_email, reminded_at, reminder_result FROM site_baskets WHERE id = $1`, [id]))[0];
        const remind = (session: Stripe.Checkout.Session, extra: Record<string, unknown> = okRoute, account = ACCT) =>
            sendCheckoutReminder(db, account, session, { baseUrl: 'https://bms.example', connectAccountFor, ...extra });

        await check('ticked with an email → ONE reminder from the owner\'s route, with the link back and an unsubscribe link', async () => {
            const b = await basket({ email: 'sam@example.com' });
            assert.strictEqual(await remind(b.session), 'sent');
            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].to, 'sam@example.com');
            assert.ok(sent[0].html.includes(`https://kudzu.example/basket?b=${b.id}`) && sent[0].html.includes('Fig candle × 2'));
            assert.strictEqual(sent[0].listUnsubscribe, `<https://bms.example/.netlify/functions/shop-reminder-stop?b=${b.id}>`);
            assert.strictEqual((await row(b.id)).reminder_result, 'sent');
            assert.strictEqual(await remind(b.session), 'nothing', 'a repeat delivery sends nothing');
            assert.strictEqual(sent.length, 1);
        });
        await check('not ticked → nothing kept, nothing sent', async () => {
            const b = await basket({ email: null, ticked: false });
            assert.strictEqual((await row(b.id)).reminder_email, null);
            assert.strictEqual(await remind(b.session), 'not_ticked');
        });
        await check('an older checkout of the basket (a newer one was started) → nothing', async () => {
            const b = await basket({ email: 'old@example.com' });
            await sql.unsafe(`UPDATE site_baskets SET checkout_session_id = 'cs_newer' WHERE id = $1`, [b.id]);
            assert.strictEqual(await remind(b.session), 'nothing');
            assert.strictEqual((await row(b.id)).reminded_at, null);
        });
        await check('paid meanwhile (basket emptied) → nothing', async () => {
            const b = await basket({ email: 'paid@example.com', items: '[]' });
            assert.strictEqual(await remind(b.session), 'nothing');
        });
        await check('another Stripe account than the workspace\'s → not ours; a late retry → too late', async () => {
            const b = await basket({ email: 'acct@example.com' });
            assert.strictEqual(await remind(b.session, okRoute, 'acct_other'), 'not_ours');
            const late = { ...b.session, expires_at: Math.floor(now.getTime() / 1000) - 7 * 3600 } as Stripe.Checkout.Session;
            assert.strictEqual(await remind(late), 'too_late');
            assert.strictEqual((await row(b.id)).reminded_at, null);
        });
        await check('an address that unsubscribed before → refused, not sent', async () => {
            await sql.unsafe(`INSERT INTO audience_contacts (organisation_id, email, status, source) VALUES (${ORG}, 'gone@example.com', 'unsubscribed', 'web_form')`);
            const b = await basket({ email: 'gone@example.com' });
            const before = sent.length;
            assert.strictEqual(await remind(b.session), 'refused');
            assert.strictEqual(sent.length, before);
            assert.strictEqual((await row(b.id)).reminder_result, 'refused');
        });
        await check('review #907: not in the Audience but opted out of outreach, or on a suppressed domain → refused', async () => {
            await sql.unsafe(`INSERT INTO lead_opt_outs (organisation_id, email) VALUES (${ORG}, 'stopped@example.com')`);
            const a = await basket({ email: 'stopped@example.com' });
            assert.strictEqual(await remind(a.session), 'refused');
            await sql.unsafe(`INSERT INTO suppression_list (organisation_id, domain) VALUES (${ORG}, 'blocked.example')`);
            const b = await basket({ email: 'anyone@blocked.example' });
            assert.strictEqual(await remind(b.session), 'refused');
        });
        await check('review #907: a pending contact (unconfirmed elsewhere) is reminded — the tick is the consent — unless paused', async () => {
            await sql.unsafe(`INSERT INTO audience_contacts (organisation_id, email, status, source) VALUES (${ORG}, 'pend@example.com', 'pending', 'web_form')`);
            const a = await basket({ email: 'pend@example.com' });
            assert.strictEqual(await remind(a.session), 'sent');
            await sql.unsafe(`INSERT INTO audience_contacts (organisation_id, email, status, source, paused_until) VALUES (${ORG}, 'quiet@example.com', 'pending', 'web_form', now() + interval '20 days')`);
            const b = await basket({ email: 'quiet@example.com' });
            assert.strictEqual(await remind(b.session), 'refused');
        });
        await check('review #907: one reminder per address per week, however many baskets name it', async () => {
            const a = await basket({ email: 'repeat@example.com' });
            assert.strictEqual(await remind(a.session), 'sent');
            const b = await basket({ email: 'repeat@example.com' });
            assert.strictEqual(await remind(b.session), 'nothing');
            await sql.unsafe(`UPDATE site_baskets SET reminded_at = now() - interval '8 days' WHERE id = $1`, [a.id]);
            assert.strictEqual(await remind(b.session), 'sent');
        });
        await check('no sending domain and no mailbox (the real route check) → not sent, recorded as no_route', async () => {
            const b = await basket({ email: 'noroute@example.com' });
            assert.strictEqual(await remind(b.session, {}), 'no_route');
            assert.strictEqual((await row(b.id)).reminder_result, 'no_route');
        });
        await check('a send failure releases the claim (Stripe retries) and throws', async () => {
            const b = await basket({ email: 'fail@example.com' });
            await assert.rejects(remind(b.session, { ...okRoute, deliver: (async () => { throw new Error('mailbox down'); }) as never }));
            assert.strictEqual((await row(b.id)).reminded_at, null);
            assert.strictEqual(await remind(b.session), 'sent');
        });
        await check('the Shop tab: sent this week, of which came back and paid, and no_route', async () => {
            const first = (await sql.unsafe(`SELECT id, checkout_session_id FROM site_baskets WHERE reminder_result = 'sent' ORDER BY id LIMIT 1`))[0];
            await sql.unsafe(`INSERT INTO site_orders (site_id, organisation_id, stripe_account_id, checkout_session_id, item_name, quantity, amount_total, currency, status, created_at)
                VALUES (${SITE}, ${ORG}, '${ACCT}', $1, 'Fig candle', 2, 2400, 'gbp', 'paid', now() + interval '1 minute')`, [first.checkout_session_id]);
            assert.deepStrictEqual(await loadReminderStats(db, ORG), { sent: 4, paid: 1, noRoute: 1 });
            assert.deepStrictEqual(await loadReminderStats(db, ORG + 1), { sent: 0, paid: 0, noRoute: 0 });
        });
        await check('the unsubscribe link: the address becomes unsubscribed (a row made), evidence kept, email cleared; repeat is fine', async () => {
            const b = (await sql.unsafe(`SELECT id FROM site_baskets WHERE reminder_email = 'sam@example.com'`))[0];
            assert.deepStrictEqual(await stopRemindedAddress(db, b.id), { business: 'Kudzu Candles' });
            const c = (await sql.unsafe(`SELECT status FROM audience_contacts WHERE organisation_id = ${ORG} AND email = 'sam@example.com'`))[0];
            assert.strictEqual(c.status, 'unsubscribed');
            const ev = await sql.unsafe(`SELECT event FROM audience_consent_events WHERE organisation_id = ${ORG} AND email = 'sam@example.com'`);
            assert.deepStrictEqual(ev.map((e) => e.event), ['unsubscribed']);
            assert.strictEqual((await row(b.id)).reminder_email, null);
            assert.deepStrictEqual(await stopRemindedAddress(db, b.id), { business: 'Kudzu Candles' });
            assert.strictEqual(await stopRemindedAddress(db, 'NeverRemindedBasketId123'), null);
        });
        await check('an unticked second checkout clears the email', async () => {
            const b = await basket({ email: 'change@example.com' });
            await saveReminderEmail(db, { basketId: b.id, siteId: SITE, sessionId: b.sid, email: null, expiresAt: null });
            assert.strictEqual((await row(b.id)).reminder_email, null);
            assert.strictEqual(await remind(b.session), 'nothing');
        });
        await check('the sweep: week-old baskets go, a reminded one stays 60 days from its reminder', async () => {
            const kept = (await sql.unsafe(`SELECT id FROM site_baskets WHERE reminder_result = 'sent' ORDER BY id LIMIT 1`))[0].id;
            const gone = (await sql.unsafe(`SELECT id FROM site_baskets WHERE reminded_at IS NULL ORDER BY id LIMIT 1`))[0].id;
            await sql.unsafe(`UPDATE site_baskets SET updated_at = now() - interval '8 days'`);
            await sweepBaskets(db);
            const left = (await sql.unsafe(`SELECT id FROM site_baskets`)).map((r) => r.id);
            assert.ok(left.includes(kept) && !left.includes(gone));
            await sql.unsafe(`UPDATE site_baskets SET reminded_at = now() - interval '61 days' WHERE id = $1`, [kept]);
            await sweepBaskets(db);
            assert.ok(!(await sql.unsafe(`SELECT id FROM site_baskets`)).map((r) => r.id).includes(kept));
        });
        await check('the database refuses an unknown reminder result', async () => {
            await assert.rejects(sql.unsafe(`UPDATE site_baskets SET reminder_result = 'bogus'`), (e: { code?: string }) => e.code === '23514');
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
        await closeDbPools();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
