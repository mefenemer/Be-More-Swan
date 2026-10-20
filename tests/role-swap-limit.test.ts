// tests/role-swap-limit.test.ts
// Capped plans may switch to a different assistant role once per billing month.
//
// Owner, 2026-10-20: "Limit Tier 1 to one assistant role change per billing month." Archiving
// frees a seat, so a one-assistant plan could otherwise rotate through every role in the catalogue.
// The rule lives in src/utils/assistant-capacity.ts (roleSwapAllowed / checkRoleSwap) and the
// pricing FAQ quotes it.
//
// Run:  npx tsx tests/role-swap-limit.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    checkRoleSwap, nextPeriodStart, roleSwapAllowed, swapLimitMessage,
    type RoleSwapEvent, type RoleSwapRow,
} from '../src/utils/assistant-capacity';

let passed = 0, total = 0;
const deferred: Array<() => Promise<void>> = [];
/** Queued, not awaited inline: tsx compiles these to CJS, which has no top-level await. */
function check(name: string, fn: () => void | Promise<void>) {
    total++;
    deferred.push(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
    });
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const PERIOD = new Date('2026-10-01T00:00:00Z');
const LAST_MONTH = new Date('2026-09-10T09:00:00Z');
const THIS_MONTH = new Date('2026-10-05T09:00:00Z');

/** A tiny in-memory workspace that hires, archives, reinstates, pauses and resumes like the app. */
function workspace(limit: number, start: RoleSwapRow[] = []) {
    const rows: RoleSwapRow[] = start.map((r) => ({ ...r }));
    const events: RoleSwapEvent[] = [];
    let nextId = 100;
    const allowed = (roleKey: string) => roleSwapAllowed({ limit, periodStart: PERIOD, rows, events, incomingRoleKey: roleKey });
    return {
        rows,
        hire(roleKey: string) {
            if (!allowed(roleKey)) return false;
            rows.push({ id: nextId++, roleKey, createdAt: THIS_MONTH, archivedAt: null, lifecycleStatus: 'working' });
            return true;
        },
        archive(roleKey: string) {
            const r = rows.find((x) => x.roleKey === roleKey && x.lifecycleStatus !== 'archived')!;
            r.lifecycleStatus = 'archived'; r.archivedAt = THIS_MONTH;
            events.push({ assistantId: r.id, kind: 'archive' });
        },
        reinstate(roleKey: string) {
            const r = rows.find((x) => x.roleKey === roleKey && x.lifecycleStatus === 'archived')!;
            if (!allowed(r.roleKey)) return false;
            r.lifecycleStatus = 'paused'; r.archivedAt = null;
            events.push({ assistantId: r.id, kind: 'reinstate' });
            return true;
        },
        pause(roleKey: string) { rows.find((x) => x.roleKey === roleKey)!.lifecycleStatus = 'paused'; },
        resume(roleKey: string) { rows.find((x) => x.roleKey === roleKey)!.lifecycleStatus = 'working'; },
    };
}
const heldSince = (id: number, roleKey: string, extra: Partial<RoleSwapRow> = {}): RoleSwapRow =>
    ({ id, roleKey, createdAt: LAST_MONTH, archivedAt: null, lifecycleStatus: 'working', ...extra });

console.log('\nrole swap limit\n');

// ── The owner's cases ───────────────────────────────────────────────────────────────────────────
check('first hire is allowed (an org with no assistant is not swapping)', () => {
    const ws = workspace(1);
    assert.strictEqual(ws.hire('social_media_manager'), true);
});

check('one swap a month is allowed', () => {
    const ws = workspace(1, [heldSince(1, 'social_media_manager')]);
    ws.archive('social_media_manager');
    assert.strictEqual(ws.hire('lead_generator'), true);
});

check('a second swap in the same period is refused', () => {
    const ws = workspace(1, [heldSince(1, 'social_media_manager')]);
    ws.archive('social_media_manager');
    assert.strictEqual(ws.hire('lead_generator'), true);
    ws.archive('lead_generator');
    assert.strictEqual(ws.hire('blog_writer'), false);
});

check('first hire of the month plus one swap, then refused', () => {
    const ws = workspace(1);
    assert.strictEqual(ws.hire('social_media_manager'), true);   // fills an empty seat
    ws.archive('social_media_manager');
    assert.strictEqual(ws.hire('lead_generator'), true);         // the switch
    ws.archive('lead_generator');
    assert.strictEqual(ws.hire('blog_writer'), false);
});

check('pausing and resuming the same assistant never counts', () => {
    const ws = workspace(1, [heldSince(1, 'social_media_manager')]);
    for (let i = 0; i < 5; i++) { ws.pause('social_media_manager'); ws.resume('social_media_manager'); }
    // The switch is still there to use…
    ws.archive('social_media_manager');
    assert.strictEqual(ws.hire('lead_generator'), true);
    // …and pausing/resuming the new one does not use up anything either.
    ws.pause('lead_generator'); ws.resume('lead_generator');
    assert.strictEqual(roleSwapAllowed({ limit: 1, periodStart: PERIOD, rows: ws.rows, events: [], incomingRoleKey: 'lead_generator' }), true);
});

check('reinstating the role held at the start of the period is free', () => {
    const ws = workspace(1, [heldSince(1, 'social_media_manager')]);
    ws.archive('social_media_manager');
    assert.strictEqual(ws.hire('lead_generator'), true);       // the switch
    ws.archive('lead_generator');
    assert.strictEqual(ws.reinstate('social_media_manager'), true, 'going back to the starting role is not a switch');
});

check('reinstating a role archived BEFORE the period is a switch', () => {
    const ws = workspace(1, [
        heldSince(1, 'social_media_manager'),
        heldSince(2, 'lead_generator', { lifecycleStatus: 'archived', archivedAt: new Date('2026-09-25T00:00:00Z') }),
        heldSince(3, 'blog_writer', { lifecycleStatus: 'archived', archivedAt: new Date('2026-09-26T00:00:00Z') }),
    ]);
    ws.archive('social_media_manager');
    assert.strictEqual(ws.reinstate('lead_generator'), true, 'the one switch');
    ws.archive('lead_generator');
    assert.strictEqual(ws.reinstate('blog_writer'), false, 'a second switch, by reinstating');
});

check('getting back the same new role is not a second switch', () => {
    const ws = workspace(1, [heldSince(1, 'social_media_manager')]);
    ws.archive('social_media_manager');
    assert.strictEqual(ws.hire('lead_generator'), true);
    ws.archive('lead_generator');
    assert.strictEqual(ws.reinstate('lead_generator'), true);
});

check('bonus seats empty at the start of the period can be filled, plus one switch', () => {
    const ws = workspace(2, [heldSince(1, 'social_media_manager')]);
    assert.strictEqual(ws.hire('lead_generator'), true, 'fills the empty bonus seat');
    ws.archive('lead_generator');
    assert.strictEqual(ws.hire('blog_writer'), true, 'the switch');
    ws.archive('blog_writer');
    assert.strictEqual(ws.hire('email_marketing'), false);
});

check('a row reinstated this period after being archived last month was not held at the start', () => {
    // Reinstating clears archivedAt, so the audit trail is what says it was gone on the 1st.
    const rows = [heldSince(1, 'social_media_manager', { lifecycleStatus: 'archived', archivedAt: THIS_MONTH }), heldSince(2, 'lead_generator', { lifecycleStatus: 'paused' })];
    const events: RoleSwapEvent[] = [{ assistantId: 2, kind: 'reinstate' }, { assistantId: 1, kind: 'archive' }];
    // Held = {social_media_manager}; brought = {lead_generator} — the switch is spent.
    assert.strictEqual(roleSwapAllowed({ limit: 1, periodStart: PERIOD, rows, events, incomingRoleKey: 'blog_writer' }), false);
});

// ── Plans the rule does not apply to ────────────────────────────────────────────────────────────
/** Answers checkRoleSwap's reads in order: plan, org bonus, assistant rows, audit events. */
function fakeDb(opts: { plan: unknown; rows?: unknown[]; audit?: unknown[] }) {
    let call = 0;
    const chain: any = {
        from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain,
        limit: async () => (call === 1 ? (opts.plan ? [opts.plan] : []) : [{ bonusAssistants: 0 }]),
        then: (res: (v: unknown) => void) => res(call === 3 ? (opts.rows ?? []) : (opts.audit ?? [])),
    };
    return { select: () => { call++; return chain; } } as any;
}
const raw = (id: number, roleKey: string, createdAt: Date, archivedAt: Date | null, lifecycleStatus: string) =>
    ({ id, masterRoleKey: roleKey, configuration: null, name: roleKey, createdAt, archivedAt, lifecycleStatus, provisioningStatus: 'complete' });

check('Tier 2 (no assistant limit) is never limited', async () => {
    const tier2 = { assistantLimit: null, featureOverrides: null };
    assert.strictEqual(await checkRoleSwap(fakeDb({ plan: tier2 }), 1, 1, 'blog_writer', PERIOD), null);
});

check('a capped plan past its switch gets 409 SWAP_LIMIT with the next date', async () => {
    const db = fakeDb({
        plan: { assistantLimit: 1, featureOverrides: null },
        rows: [raw(1, 'social_media_manager', LAST_MONTH, THIS_MONTH, 'archived'), raw(2, 'lead_generator', THIS_MONTH, THIS_MONTH, 'archived')],
        audit: [{ resourceId: '1', actionType: 'assistant_lifecycle_archived', newState: {} }, { resourceId: '2', actionType: 'assistant_lifecycle_archived', newState: {} }],
    });
    const refusal = await checkRoleSwap(db, 1, 1, 'blog_writer', PERIOD);
    assert.strictEqual(refusal?.status, 409);
    assert.strictEqual(refusal?.code, 'SWAP_LIMIT');
    assert.strictEqual(refusal?.nextSwitchAt, '2026-11-01T00:00:00.000Z');
    assert.strictEqual(refusal?.error,
        'On your plan you can switch to a different assistant once a month. Your next switch is available on 1 November 2026. Upgrade to run every assistant at once.');
});

check('the next period rolls over the year', () => {
    assert.strictEqual(nextPeriodStart(new Date('2026-12-01T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
    assert.match(swapLimitMessage(new Date('2027-01-01T00:00:00Z')), /available on 1 January 2027\./);
});

// ── Every way to bring a role in asks, after the capacity check and before the write ───────────
check('hire-assistant checks the switch limit after capacity and before the insert', () => {
    const src = read('netlify/functions/hire-assistant.ts');
    const cap = src.indexOf('checkAssistantCapacity(db, userId, orgId)');
    const swap = src.indexOf('checkRoleSwap(db, userId, orgId, master.roleKey)');
    const insert = src.indexOf('db.insert(aiAssistants)');
    assert.ok(cap > 0 && swap > cap && insert > swap);
});

check('onboarding checks the switch limit after capacity and before the insert', () => {
    const src = read('netlify/functions/onboarding.ts');
    const cap = src.indexOf('checkAssistantCapacity(db, existingUser.id, orgId)');
    const swap = src.indexOf('checkRoleSwap(db, existingUser.id, orgId, assistantRecord.roleKey)');
    const insert = src.indexOf('db.insert(aiAssistants)');
    assert.ok(cap > 0 && swap > cap && insert > swap);
});

check('reinstate checks the switch limit before the transition', () => {
    const src = read('netlify/functions/manage-assistant.ts');
    const swap = src.indexOf('checkRoleSwap(db, ctx.userId, orgId, { assistantId: id })');
    const write = src.indexOf("transitionAssistantStatus(db, id, 'paused', { reason: 'user_reinstate'");
    assert.ok(swap > 0 && write > swap);
});

check('the catalogue Hire button asks before opening a setup wizard and shows the refusal', () => {
    const src = read('assistant-catalogue.html');
    const fn = src.indexOf('window._catHire = async function');
    const body = src.slice(fn, fn + 3000);
    assert.match(body, /check-capacity\?roleKey=\$\{encodeURIComponent\(roleKey\)\}/);
    assert.match(body, /cap\.roleSwap\.code === 'SWAP_LIMIT'/);
    assert.match(body, /cap\.roleSwap\.error/);
    assert.ok(body.indexOf("cap.roleSwap.code === 'SWAP_LIMIT'") < body.indexOf('assistant-setup.html?roleKey='), 'refuse before routing');
    assert.match(read('netlify/functions/check-capacity.ts'), /checkRoleSwap\(db, userId, orgId, askedRoleKey\)/);
});

(async () => {
    for (const run of deferred) await run();
    console.log(`\n${passed}/${total} passed\n`);
})();
