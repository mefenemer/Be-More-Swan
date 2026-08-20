// tests/newsletter-link-clicks.test.ts
// "Which link worked" — the half of a click rate a tenant can act on.
//
// Four ways a per-link report is worse than no report:
//
//   1. ⚠️ IT DROWNS IN UNSUBSCRIBE LINKS. Every recipient's unsubscribe url carries their own
//      token, so a 5,000-person issue produces up to 5,000 distinct one-click rows and buries the
//      three links the tenant actually wrote.
//   2. IT COUNTS ONE ENTHUSIAST AS A CROWD. Total clicks is not people, and the number a tenant
//      plans around is people.
//   3. IT REPORTS ZERO WHERE IT MEANS "WE CANNOT SEE". Mailbox-sent issues rewrite no links.
//   4. IT TAKES DOWN THE WEBHOOK. A report that 500s a provider callback costs bounces and
//      complaints — the events that stop us emailing people who asked us not to.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { landmark } from './landmark';
import {
    MAX_URL_CHARS, normaliseClickUrl, recordLinkClick,
} from '../src/utils/newsletter-link-clicks';

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

const SQL = read('db/newsletter-link-clicks.sql');
const MOD = read('src/utils/newsletter-link-clicks.ts');
const HOOK = read('netlify/functions/newsletter-webhook.ts');
const UI = read('newsletter.js');

/** Records what recordLinkClick tried to write. `conflict` simulates the row already existing. */
function fakeDb(opts: { conflict?: boolean; throws?: boolean } = {}) {
    const calls: { inserted?: Record<string, unknown>; updated?: boolean } = {};
    const db: any = {
        insert: () => ({
            values: (v: Record<string, unknown>) => {
                if (opts.throws) return { onConflictDoNothing: () => ({ returning: () => Promise.reject(new Error('table missing')) }) };
                calls.inserted = v;
                return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(opts.conflict ? [] : [{ id: 1 }]) }) };
            },
        }),
        update: () => ({ set: () => ({ where: () => { calls.updated = true; return Promise.resolve([]); } }) }),
    };
    return { db, calls };
}

const args = { organisationId: 1, issueId: 2, sendId: 3 };

async function main() {

// ── 1. The unsubscribe collapse ─────────────────────────────────────────────

await check('every recipient\'s unsubscribe link collapses to ONE row', () => {
    // ⚠️ Without this the report is a wall of one-click rows and the tenant cannot read it.
    const a = normaliseClickUrl('https://acme.example/api/newsletter/unsubscribe?t=AAAAAAAAAAAAAAAAAA');
    const b = normaliseClickUrl('https://acme.example/api/newsletter/unsubscribe?t=BBBBBBBBBBBBBBBBBB');
    assert.ok(a && b);
    assert.strictEqual(a!.hash, b!.hash, 'two recipients must produce one link');
    assert.ok(a!.isUnsubscribe);
    assert.ok(!a!.url.includes('?t='), 'and the token is not stored');
});

await check('the function-path form of the same endpoint collapses too', () => {
    const viaFn = normaliseClickUrl('https://acme.example/.netlify/functions/newsletter-unsubscribe?t=X1234567890');
    assert.ok(viaFn?.isUnsubscribe);
});

await check('it is kept, not dropped', () => {
    // How many people went looking for the way out is worth knowing; hiding it would be its own
    // kind of dishonest.
    assert.match(MOD, /kept rather than dropped/);
    assert.match(UI, /Unsubscribe link/);
});

await check('a tenant\'s own links are left exactly alone, utm and all', () => {
    // Two urls differing only by campaign tag are two links they chose to distinguish.
    const one = normaliseClickUrl('https://shop.example/x?utm_source=news');
    const two = normaliseClickUrl('https://shop.example/x?utm_source=social');
    assert.notStrictEqual(one!.hash, two!.hash);
    assert.strictEqual(one!.url, 'https://shop.example/x?utm_source=news');
    assert.ok(!one!.isUnsubscribe);
});

await check('the hash is of the stored url, so the two can never disagree', () => {
    const n = normaliseClickUrl('https://shop.example/deal');
    assert.strictEqual(n!.hash, createHash('sha256').update(n!.url).digest('hex'));
});

await check('junk is refused and long urls are bounded', () => {
    for (const bad of ['', 'not a url', 'javascript:alert(1)', 'mailto:a@b.c', null, undefined]) {
        assert.strictEqual(normaliseClickUrl(bad), null, `${bad} must not be recorded`);
    }
    const long = normaliseClickUrl(`https://shop.example/?q=${'x'.repeat(5000)}`);
    assert.ok(long!.url.length <= MAX_URL_CHARS);
});

// ── 2. People, not clicks ───────────────────────────────────────────────────

await check('the first click on a link inserts a row', async () => {
    const { db, calls } = fakeDb();
    assert.strictEqual(await recordLinkClick(db, { ...args, rawUrl: 'https://shop.example/deal' }), 'new');
    assert.strictEqual(calls.inserted!.clickCount, 1);
    assert.ok(calls.inserted!.urlHash);
});

await check('a repeat click increments that row instead of adding a person', async () => {
    // ⚠️ The row IS the unique click. count(*) is people; sum(click_count) is times.
    const { db, calls } = fakeDb({ conflict: true });
    assert.strictEqual(await recordLinkClick(db, { ...args, rawUrl: 'https://shop.example/deal' }), 'repeat');
    assert.ok(calls.updated, 'the existing row must be incremented');
});

await check('the uniqueness is enforced by the database, not by the check above', () => {
    assert.match(SQL, /newsletter_link_clicks_send_url_uidx[\s\S]{0,120}\(send_id, url_hash\)/);
    assert.match(MOD, /onConflictDoNothing\(\)/);
});

await check('the report says which number is which', () => {
    // The formula is written down where the table is defined; the labels are on the type.
    assert.match(SQL, /unique clicks on a link = count/);
    assert.match(MOD, /How many PEOPLE/);
    assert.match(MOD, /How many TIMES/);
    const fn = UI.slice(landmark(UI, 'function renderLinks'), landmark(UI, 'function renderStats'));
    assert.match(fn, /People/);
    assert.match(fn, /counts each subscriber once/);
});

await check('the report is aggregate, and says so', () => {
    // The rows underneath name a recipient — so "unique" is exact, not so anyone can build a view
    // of who clicked what.
    assert.match(MOD, /Aggregate by choice/);
    assert.match(MOD, /groupBy\(newsletterLinkClicks\.urlHash\)/);
});

// ── 3. Zero vs unmeasurable ─────────────────────────────────────────────────

await check('a mailbox-sent issue says clicks could not be measured', () => {
    const fn = UI.slice(landmark(UI, 'function renderLinks'), landmark(UI, 'function renderStats'));
    assert.match(fn, /!issue\.engagementTracked/);
    assert.match(fn, /does not rewrite links/);
    // And a tracked issue with no clicks says THAT, which is a different sentence.
    assert.match(fn, /Nobody has clicked a link/);
});

await check('an issue sent BEFORE this existed does not claim nobody clicked', () => {
    // ⚠️ Found after the migration went out: an issue with clicks and no link rows was sent before
    // per-link recording, and "nobody clicked" there is the same lie as 0% opens on a mailbox send.
    // The issue's own clickedCount is what tells the two apart.
    const fn = UI.slice(landmark(UI, 'function renderLinks'), landmark(UI, 'function renderStats'));
    assert.match(fn, /issue\.clickedCount/);
    assert.match(fn, /before we started recording which link/);
});

await check('a draft shows no report at all', () => {
    const fn = UI.slice(landmark(UI, 'function renderLinks'), landmark(UI, 'function renderStats'));
    assert.match(fn, /if \(!issue\.sentAt\)/);
    assert.match(read('netlify/functions/newsletter-issues.ts'), /issue\.sentAt \? await linkReportForIssue/);
});

// ── 4. It cannot break the webhook ──────────────────────────────────────────

await check('a failure to record a click is swallowed', async () => {
    // ⚠️ A 500 here makes the provider retry the WHOLE event, and the bounce and complaint writes
    // beside it are what stop us emailing people who asked us not to.
    const { db } = fakeDb({ throws: true });
    assert.strictEqual(await recordLinkClick(db, { ...args, rawUrl: 'https://shop.example/deal' }), 'skipped');
});

await check('a missing table degrades to an empty report, not a 500', () => {
    const fn = MOD.slice(landmark(MOD, 'export async function linkReportForIssue'));
    assert.match(fn, /42P01/);
    assert.match(fn, /return \[\]/);
});

await check('the click is recorded beside the ledger write, not instead of it', () => {
    const branch = HOOK.slice(landmark(HOOK, "if (type === 'email.opened' || type === 'email.clicked')"));
    assert.match(branch, /recordLinkClick/);
    assert.ok(landmark(branch, 'recordLinkClick') < landmark(branch, 'THE FIRST-TOUCH GUARD'),
        'and it must not sit inside the first-touch branch — a repeat click is still a click on a link');
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
