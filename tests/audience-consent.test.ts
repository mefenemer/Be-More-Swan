// tests/audience-consent.test.ts
// "May this organisation email this address?" — asked once, answered for every assistant.
//
// The Newsletter Assistant introduces a second place that can send to a person the Lead Generator
// already knows about. That is where the promise on the tin ("your contacts work across every
// assistant") either becomes real or becomes a liability: an unsubscribe recorded by one feature
// and ignored by another is not a missing feature, it is a stranger receiving mail they explicitly
// refused, from a domain the tenant has to keep deliverable.
//
// Three failures are silent, ship green, and only surface as a complaint:
//
//   1. NOT READING lead_opt_outs. The newsletter has its own status column, so a send worker that
//      trusts it looks completely correct — and mails everyone who ever told the cold-outreach side
//      to stop. This is the exact shape of the bug that left suppression_list written-but-unread
//      for months: a well-formed table with no reader.
//   2. MAILING 'pending'. Double opt-in is decorative unless the unconfirmed state is unmailable.
//   3. FAILING OPEN. A lookup error that resolves to "no block found" sends to everyone at the
//      moment the database is least trustworthy.
//
// So this suite is mostly about what happens when things are missing or broken, not when they work.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audienceContacts, leadOptOuts, suppressionList } from '../db/schema';
import {
    checkAudienceConsent,
    checkAudienceConsentBulk,
    SKIP_REASON_LABEL,
    type AudienceSkipReason,
} from '../src/utils/audience-consent';
import { looksLikeEmail, normaliseEmail } from '../src/utils/audience-contacts';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

// ── A fake db that records what was asked of it ─────────────────────────────
// Same shape as tests/prospect-erasure.test.ts: enough drizzle to run the real function, so the
// test can see which tables were consulted and what happens when one of them fails.

const TABLES = new Map<unknown, string>([
    [audienceContacts, 'audience_contacts'],
    [leadOptOuts, 'lead_opt_outs'],
    [suppressionList, 'suppression_list'],
]);

interface FakeOpts {
    /** "select:<table>" → rows that await should yield. */
    rows?: Record<string, unknown[]>;
    /** "select:<table>" that should throw. */
    throwOn?: string;
    /** pg error code carried by that throw — '42P01' is "relation does not exist". */
    throwCode?: string;
}

function fakeDb(opts: FakeOpts = {}) {
    const calls: string[] = [];

    const chain = (op: string) => {
        let table = '';
        const key = () => `${op}:${table}`;
        const record = (args: unknown[]) => {
            for (const a of args) {
                const named = TABLES.get(a);
                if (named) table = named;
            }
            return proxy;
        };
        const proxy: any = new Proxy(function () { /* drizzle builder stand-in */ } as never, {
            apply(_t, _this, args: unknown[]) { return record(args); },
            get(_t, prop) {
                if (prop === 'then') {
                    return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
                        calls.push(key());
                        if (opts.throwOn === key()) {
                            const err: Error & { code?: string } = new Error(`boom: ${key()}`);
                            if (opts.throwCode) err.code = opts.throwCode;
                            return Promise.reject(err).then(res, rej);
                        }
                        return Promise.resolve(opts.rows?.[key()] ?? []).then(res, rej);
                    };
                }
                return (...args: unknown[]) => record(args);
            },
        });
        return proxy;
    };

    const db = { select: (cols: unknown) => chain('select')(cols) };
    return { db: db as never, calls };
}

const SUBSCRIBED = { 'select:audience_contacts': [{ email: 'jane@acme.com', status: 'subscribed', unsubscribedAt: null }] };

async function main() {

    // ── 1. The cross-assistant promise ───────────────────────────────────────────

    await check('an address that opted out of OUTREACH is not mailable by the NEWSLETTER', async () => {
        // The whole reason this module exists. The audience row says 'subscribed' — a send worker
        // reading that column alone would mail someone who already told this tenant to stop.
        const { db, calls } = fakeDb({
            rows: {
                ...SUBSCRIBED,
                'select:lead_opt_outs': [{ email: 'jane@acme.com', reason: 'reply_opt_out' }],
            },
        });
        const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
        assert.equal(v.sendable, false, 'an opt-out recorded by the Lead Generator must block a newsletter send');
        assert.equal(v.reason, 'opted_out');
        assert.ok(calls.includes('select:lead_opt_outs'), 'lead_opt_outs must actually be READ, not merely documented');
    });

    await check('an individual opt-out outranks a domain suppression when both hit', async () => {
        // Mirrors src/utils/suppression.ts precedence: address grain before domain grain, because the
        // personal instruction is the stronger and more specific claim.
        const { db } = fakeDb({
            rows: {
                ...SUBSCRIBED,
                'select:lead_opt_outs': [{ email: 'jane@acme.com', reason: 'link_opt_out' }],
                'select:suppression_list': [{ domain: 'acme.com', reason: 'existing_customer' }],
            },
        });
        const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
        assert.equal(v.reason, 'opted_out', 'the person asked; the CRM only classified their employer');
    });

    await check('a suppressed DOMAIN blocks a subscribed contact', async () => {
        const { db } = fakeDb({
            rows: { ...SUBSCRIBED, 'select:suppression_list': [{ domain: 'acme.com', reason: 'existing_customer' }] },
        });
        const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
        assert.equal(v.sendable, false);
        assert.equal(v.reason, 'suppressed');
    });

    // ── 2. Double opt-in is only real if 'pending' is unmailable ─────────────────

    await check("a 'pending' contact is never sendable", async () => {
        const { db } = fakeDb({
            rows: { 'select:audience_contacts': [{ email: 'jane@acme.com', status: 'pending', unsubscribedAt: null }] },
        });
        const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
        assert.equal(v.sendable, false, 'mailing an unconfirmed address makes double opt-in decorative');
        assert.equal(v.reason, 'unconfirmed');
    });

    await check('every non-subscribed status is blocked, each with its own reason', async () => {
        const expected: Record<string, AudienceSkipReason> = {
            unsubscribed: 'opted_out',
            bounced:      'bounced_previously',
            complained:   'complained_previously',
            suppressed:   'suppressed',
            // Schema drift must not read as permission.
            something_new: 'consent_check_failed',
        };
        for (const [status, reason] of Object.entries(expected)) {
            const { db } = fakeDb({
                rows: { 'select:audience_contacts': [{ email: 'jane@acme.com', status, unsubscribedAt: null }] },
            });
            const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
            assert.equal(v.sendable, false, `status '${status}' must not be sendable`);
            assert.equal(v.reason, reason, `status '${status}' → ${reason}`);
        }
    });

    await check('an address with no contact row is not in the audience, and not sendable', async () => {
        const { db } = fakeDb();
        const v = await checkAudienceConsent(db, 7, 'stranger@example.com');
        assert.equal(v.sendable, false);
        assert.equal(v.reason, 'not_in_audience');
    });

    // ── 3. Failing closed ────────────────────────────────────────────────────────

    await check('a failed CONTACT lookup blocks everyone — including on a missing table', async () => {
        // ⚠️ The asymmetry with suppression.ts, and it is deliberate. There, a missing table means "no
        // block list exists, so nothing is blocked". Here the question is the opposite one — "is this
        // person SUBSCRIBED?" — and an absent table can never answer yes.
        for (const code of [undefined, '42P01']) {
            const { db } = fakeDb({ rows: SUBSCRIBED, throwOn: 'select:audience_contacts', throwCode: code });
            const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
            assert.equal(v.sendable, false, `contact lookup failure (code ${code ?? 'none'}) must block the send`);
            assert.equal(v.reason, 'consent_check_failed');
            assert.equal(v.unknown, true, 'the verdict must declare itself a guess, not a finding');
        }
    });

    await check('a broken OPT-OUT lookup blocks a subscribed contact', async () => {
        // We cannot prove they did not opt out. One delayed newsletter versus one email to someone who
        // asked us to stop — not symmetric.
        const { db } = fakeDb({ rows: SUBSCRIBED, throwOn: 'select:lead_opt_outs' });
        const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
        assert.equal(v.sendable, false);
        assert.equal(v.reason, 'consent_check_failed');
        assert.equal(v.unknown, true);
    });

    await check('a MISSING lead_opt_outs table is treated as empty, not as an outage', async () => {
        // An environment where the outreach feature was never applied has no opt-outs to violate.
        // Failing closed there would block every newsletter in the product rather than protect anyone.
        const { db } = fakeDb({ rows: SUBSCRIBED, throwOn: 'select:lead_opt_outs', throwCode: '42P01' });
        const v = await checkAudienceConsent(db, 7, 'jane@acme.com');
        assert.equal(v.sendable, true);
    });

    await check('a broken SUPPRESSION lookup blocks; a missing suppression_list does not', async () => {
        const broken = fakeDb({ rows: SUBSCRIBED, throwOn: 'select:suppression_list' });
        assert.equal((await checkAudienceConsent(broken.db, 7, 'jane@acme.com')).reason, 'consent_check_failed');

        const absent = fakeDb({ rows: SUBSCRIBED, throwOn: 'select:suppression_list', throwCode: '42P01' });
        assert.equal((await checkAudienceConsent(absent.db, 7, 'jane@acme.com')).sendable, true);
    });

    // ── 4. Normalisation — the constraint is only as good as the writer ──────────

    await check('lookups match the stored grain regardless of case or stray whitespace', async () => {
        const { db } = fakeDb({ rows: SUBSCRIBED });
        const v = await checkAudienceConsent(db, 7, '  Jane@ACME.com ');
        assert.equal(v.sendable, true, 'a reader that normalises differently from the writer misses every row');
    });

    await check('a syntactically impossible address is rejected without touching the database', async () => {
        const { db, calls } = fakeDb();
        const v = await checkAudienceConsent(db, 7, 'not-an-address');
        assert.equal(v.reason, 'invalid_address');
        assert.equal(calls.length, 0, 'a send ledger row that can only ever fail is not worth a query');
    });

    await check('looksLikeEmail keeps the addresses that work and drops the ones that cannot', async () => {
        for (const good of ['jane@acme.com', 'jane+news@acme.co.uk', "o'brien@sub.domain.io"]) {
            assert.ok(looksLikeEmail(good), `${good} must be accepted`);
        }
        for (const bad of ['', 'jane', 'jane@', '@acme.com', 'jane@acme', 'jane@acme..com', 'a b@acme.com', 'jane<@acme.com']) {
            assert.ok(!looksLikeEmail(bad), `${bad} must be rejected`);
        }
        // +tags and dots are NOT stripped: they are different mailboxes almost everywhere but Gmail.
        assert.equal(normaliseEmail(' Jane+News@Acme.com '), 'jane+news@acme.com');
    });

    // ── 5. Bulk is the same rule, not a second one ───────────────────────────────

    await check('the bulk path deduplicates, so nobody receives an issue twice', async () => {
        const { db } = fakeDb({ rows: SUBSCRIBED });
        const map = await checkAudienceConsentBulk(db, 7, ['jane@acme.com', 'JANE@acme.com', ' jane@acme.com ']);
        assert.equal(map.size, 1, 'one person, one verdict — a segment and the whole-audience fallback can name them twice');
    });

    await check('single and bulk agree on the same fixture', async () => {
        // Two implementations of "may we email this person" is the drift this module exists to prevent,
        // so the single-address form is built on the bulk one. This asserts it stays that way.
        const rows = {
            'select:audience_contacts': [
                { email: 'jane@acme.com', status: 'subscribed', unsubscribedAt: null },
                { email: 'sam@acme.com', status: 'pending', unsubscribedAt: null },
            ],
            'select:lead_opt_outs': [{ email: 'jane@acme.com', reason: 'reply_opt_out' }],
        };
        const bulk = await checkAudienceConsentBulk(fakeDb({ rows }).db, 7, ['jane@acme.com', 'sam@acme.com']);
        for (const email of ['jane@acme.com', 'sam@acme.com']) {
            const one = await checkAudienceConsent(fakeDb({ rows }).db, 7, email);
            assert.deepEqual(one, bulk.get(email), `single and bulk must agree for ${email}`);
        }
    });

    // ── 6. The vocabulary is shared with the send ledger ─────────────────────────

    await check('every skip reason is a legal newsletter_sends.skip_reason', async () => {
        // The ledger stores the verdict verbatim. A reason this module can produce but the CHECK
        // constraint rejects turns a skipped recipient into a failed INSERT mid-send — a whole batch
        // lost to a value nobody thought of as a schema change.
        const sql = read('db/newsletter.sql');
        const start = landmark(sql, 'newsletter_sends_skip_reason_check');
        const clause = sql.slice(start, landmark(sql, 'END $$;', start));
        for (const reason of Object.keys(SKIP_REASON_LABEL)) {
            assert.ok(clause.includes(`'${reason}'`), `db/newsletter.sql must allow skip_reason '${reason}'`);
        }
        // And the drizzle mirror, which is what actually runs in the app.
        const schema = read('db/schema.ts');
        const mirrorStart = landmark(schema, 'newsletter_sends_skip_reason_check');
        const mirror = schema.slice(mirrorStart, mirrorStart + 600);
        for (const reason of Object.keys(SKIP_REASON_LABEL)) {
            assert.ok(mirror.includes(`'${reason}'`), `db/schema.ts must allow skip_reason '${reason}'`);
        }
    });

    await check('every reason has UI copy', async () => {
        // A blank cell in the send report is how "we did not email 400 of your subscribers" becomes
        // invisible.
        for (const [reason, label] of Object.entries(SKIP_REASON_LABEL)) {
            assert.ok(label && label.length > 3, `${reason} needs a human-readable label`);
        }
    });

    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
