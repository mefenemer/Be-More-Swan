// tests/live-social-connections.test.ts
// "Is this org connected to platform X?" must span BOTH credential stores.
//
// Run:  npx tsx tests/live-social-connections.test.ts
//
// This is the read-side twin of tests/social-credentials.test.ts. The publish path was bridged
// across system_connections and workspace_integrations; every READER of connection state was not,
// and each one asked system_connections alone. A fully connected Threads account was therefore
// invisible to them, and the symptom in production was silent: Autopilot fanned each cross-post
// across four platforms and dropped Threads, with no error anywhere to say a fifth post was
// expected. Absence of a row is indistinguishable from "the user never connected it" — which is
// exactly why this needs a test rather than a code review.
//
// Covers the resolver's own logic against a fake db, plus source guards on the call sites that
// gate drafting, approval and kick-off, so a future edit cannot quietly reintroduce the one-store
// lookup.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { systemConnections, workspaceIntegrations } from '../db/schema';
import {
    resolveLiveSocialConnections, resolveLiveSocialPlatforms, WORKSPACE_BACKED_PLATFORMS,
} from '../src/utils/live-social-connections';
import { SOCIAL_PLATFORMS } from '../src/config/platform-formats';
import { AUTONOMOUS_DRAFT_PLATFORMS } from '../src/utils/publish-policy';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

type SysRow = { id: number; serviceName: string; vaultRefKey: string | null };
type WsRow = { provider: string };

/** Minimal stand-in for the drizzle builder the resolver uses: select(...).from(t).where(...). */
const fakeDb = (sys: SysRow[], ws: WsRow[]) => ({
    select: () => ({
        from: (table: unknown) => ({
            where: () => Promise.resolve(table === systemConnections ? sys : ws),
        }),
    }),
}) as never;

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const run = async () => {

console.log('\nLive social connections — one question, both stores\n');

// ── The resolver ─────────────────────────────────────────────────────────────

await check('a workspace-backed platform counts as connected with no system_connections row', async () => {
    const live = await resolveLiveSocialConnections(fakeDb([], [{ provider: 'threads' }]), 1);
    assert.ok(live.has('threads'), 'a connected Threads account read as not connected');
    assert.equal(live.get('threads')!.store, 'workspace_integrations');
    assert.equal(live.get('threads')!.connectionId, null, 'no row exists to point at, and that is fine');
});

await check('the legacy store still answers for the four platforms it owns', async () => {
    const rows = [
        { id: 1, serviceName: 'instagram', vaultRefKey: 'k1' },
        { id: 2, serviceName: 'facebook', vaultRefKey: 'k2' },
        { id: 3, serviceName: 'linkedin', vaultRefKey: 'k3' },
        { id: 4, serviceName: 'twitter', vaultRefKey: 'k4' },  // legacy alias for x
    ];
    const live = await resolveLiveSocialConnections(fakeDb(rows, []), 1);
    assert.deepEqual([...live.keys()], ['instagram', 'facebook', 'linkedin', 'x']);
    assert.equal(live.get('x')!.connectionId, 4);
    assert.equal(live.get('instagram')!.store, 'system_connections');
});

await check('a shadow row supplies the connection id without supplying liveness', async () => {
    // A shadow row carries the per-assistant toggle and NO token (vaultRefKey NULL). Present
    // alongside the workspace row it is the id connection_id should point at...
    const withToken = await resolveLiveSocialConnections(
        fakeDb([{ id: 55, serviceName: 'threads', vaultRefKey: null }], [{ provider: 'threads' }]), 1,
    );
    assert.equal(withToken.get('threads')!.connectionId, 55);
    assert.equal(withToken.get('threads')!.store, 'workspace_integrations');

    // ...but on its own it must NOT read as connected: it holds nothing to publish with, and
    // treating it as live would send drafts to a platform with no credentials at all.
    const orphan = await resolveLiveSocialConnections(
        fakeDb([{ id: 55, serviceName: 'threads', vaultRefKey: null }], []), 1,
    );
    assert.equal(orphan.has('threads'), false, 'a token-less shadow row must not count as connected');
});

await check('platforms come back in catalogue order regardless of row order', async () => {
    const live = await resolveLiveSocialPlatforms(fakeDb(
        [{ id: 9, serviceName: 'linkedin', vaultRefKey: 'k' }, { id: 8, serviceName: 'instagram', vaultRefKey: 'k' }],
        [{ provider: 'threads' }],
    ), 1);
    const expected = SOCIAL_PLATFORMS.filter(p => ['instagram', 'linkedin', 'threads'].includes(p));
    assert.deepEqual(live, expected);
});

await check('non-social services in system_connections are ignored', async () => {
    const live = await resolveLiveSocialPlatforms(fakeDb(
        [{ id: 1, serviceName: 'canva', vaultRefKey: 'k' }, { id: 2, serviceName: 'gmail', vaultRefKey: 'k' }], [],
    ), 1);
    assert.deepEqual(live, []);
});

await check('every workspace-backed platform is one the catalogue knows', () => {
    for (const p of WORKSPACE_BACKED_PLATFORMS) {
        assert.ok((SOCIAL_PLATFORMS as string[]).includes(p), `${p} is not in the catalogue`);
    }
    // Threads is drafted autonomously; YouTube deliberately is not (video-only, and every drafter
    // produces stills). If that ever changes, this test should be the thing that notices.
    assert.ok((AUTONOMOUS_DRAFT_PLATFORMS as readonly string[]).includes('threads'));
    assert.equal((AUTONOMOUS_DRAFT_PLATFORMS as readonly string[]).includes('youtube'), false);
});

// ── The call sites ───────────────────────────────────────────────────────────

await check('the drafting fan-out asks the bridge, not one store', () => {
    const s = src('src/utils/auto-publish-runtime.ts');
    assert.ok(s.includes('resolveLiveSocialConnections'), 'auto-publish-runtime must use the bridge');
    assert.ok(
        !/from\(systemConnections\)/.test(s),
        'auto-publish-runtime queries system_connections directly again — Threads will vanish from cross-posts',
    );
});

await check('the auto-publish gate separates "connected" from "which row"', () => {
    const s = src('src/utils/auto-publish-runtime.ts');
    // The bug: connectionId === null was read as "not connected", which is true for the legacy
    // store and false for a workspace-backed platform, so every Threads draft was forced to
    // review with reason 'no_live_connection'.
    assert.ok(
        !/if \(connectionId === null\)/.test(s),
        'liveness is being inferred from connectionId again',
    );
    assert.ok(/live/.test(s) && /connectionId/.test(s), 'the gate should read a separate live flag');
});

await check('the approve gate and the kick-off gate span both stores', () => {
    for (const f of ['netlify/functions/approve-post.ts', 'netlify/functions/kickoff-assistant.ts']) {
        const s = src(f);
        assert.ok(
            /resolveLiveSocial(Connections|Platforms)/.test(s),
            `${f} must resolve connections across both stores — approving/starting on Threads fails otherwise`,
        );
    }
});

await check('the composer/capacity platform list includes workspace-backed platforms', () => {
    const s = src('netlify/functions/check-capacity.ts');
    assert.ok(
        /resolveLiveSocialPlatforms/.test(s),
        'connectedPlatforms drives the editor tabs and the approve-time prompt; it must see Threads',
    );
});

await check('the worker fallback platform can never be a platform with no drafter', () => {
    const s = src('netlify/functions/process-content-jobs.ts');
    assert.ok(
        /resolveConnectedDraftPlatforms\(db, organisationId\)/.test(s),
        'resolveFallbackPlatform should reuse the drafter list (keeps YouTube out, brings Threads in)',
    );
});

console.log(`\n${passed} checks passed\n`);
};

run();
