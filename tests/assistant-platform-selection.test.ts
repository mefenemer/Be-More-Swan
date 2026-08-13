// tests/assistant-platform-selection.test.ts
// Turning a platform OFF for an assistant must actually stop it drafting for that platform.
//
// Run:  npx tsx tests/assistant-platform-selection.test.ts
//
// The bug this protects against was invisible in exactly the way that matters: the switch in the
// assistant's Connections tab saved, the card said "Not enabled", and every autonomous path kept
// asking a different question — "is the ORG connected?" — so the assistant carried on drafting for
// the platform week after week. Found in production on YouTube, where the weekly Short is the ONLY
// autonomous producer, so a user who had switched YouTube off still found a new Short in the Review
// Queue every week and no setting anywhere would stop it.
//
// Two things are being held down here, and the second is the one that could hurt:
//
//  1. A recorded selection NARROWS what gets drafted — at every enqueue point, not just one.
//  2. NO recorded selection changes nothing. An assistant hired before the switches existed has an
//     empty selection, and reading that as "the user turned everything off" would silently stop a
//     whole workspace from drafting — a far worse failure than the one being fixed.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { systemConnections, workspaceIntegrations } from '../db/schema';
import {
    resolveAssistantEnabledPlatforms,
    isPlatformEnabledForAssistant,
    isPlatformOptedInForAssistant,
    type AssistantPlatformScope,
} from '../src/utils/assistant-platform-selection';

let passed = 0;
const test = (name: string, fn: () => void | Promise<void>) => {
    const done = () => { console.log(`  ✓ ${name}`); passed++; };
    const fail = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        return out instanceof Promise ? out.then(done, fail) : (done(), Promise.resolve());
    } catch (err) { fail(err); return Promise.resolve(); }
};

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * A drizzle-shaped stand-in that answers per TABLE, because the resolver reads two of them: a
 * ticked connection id is a system_connections row when positive and a workspace_integrations row
 * when negative, and conflating them is how a connected YouTube account reads as absent.
 */
const fakeDb = (sysRows: { serviceName: string | null }[], wsRows: { provider: string }[]) => ({
    select: () => ({
        from: (table: unknown) => ({
            where: async () => (table === systemConnections ? sysRows : wsRows),
        }),
    }),
}) as unknown as Parameters<typeof resolveAssistantEnabledPlatforms>[0];

const scope = (ctx: unknown, configuration?: unknown): AssistantPlatformScope =>
    ({ organisationId: 10, onboardingContext: ctx, configuration });

console.log('\nPer-assistant platform selection\n');

// tsx transpiles these files to CJS, so the async checks live inside main() rather than leaning on
// top-level await.
async function main() {

// ── 1. The fail-open contract ────────────────────────────────────────────────

await test('an assistant with no selection recorded is never filtered', async () => {
    // null means "nobody has said anything", NOT "everything is off". Every caller treats it as
    // no-filter, which is what keeps assistants hired before the switches existed drafting.
    const db = fakeDb([], []);
    assert.equal(await resolveAssistantEnabledPlatforms(db, scope({})), null);
    assert.equal(await resolveAssistantEnabledPlatforms(db, scope(null)), null);
    assert.equal(await resolveAssistantEnabledPlatforms(db, scope({ primary_platforms: [] })), null);
    assert.equal(await isPlatformEnabledForAssistant(db, scope({}), 'youtube'), true);
});

await test('a selection naming nothing recognisable is treated as no selection', async () => {
    // Junk in, current behaviour out. A stored value we cannot read must not silently switch an
    // assistant off — the same reasoning as the empty case above.
    const db = fakeDb([], []);
    assert.equal(await resolveAssistantEnabledPlatforms(db, scope({ primary_platforms: ['pinterest'] })), null);
});

// ── 2. Reading the selection the UI actually writes ──────────────────────────

await test('the short codes the platform picker stores are understood', async () => {
    // onboarding-social-media.html and _intToggleUseForAssistant both write short codes.
    const enabled = await resolveAssistantEnabledPlatforms(
        fakeDb([], []),
        scope({ primary_platforms: ['ig', 'li', 'yt'] }),
    );
    assert.deepEqual([...(enabled ?? [])].sort(), ['instagram', 'linkedin', 'youtube']);
});

await test('a platform ticked as a CONNECTION ID counts, in either store', async () => {
    // This is the half that cannot be skipped. The client builds primary_platforms from connections
    // carrying a user_id, and a workspace_integrations-backed platform (Threads, YouTube) merges
    // into the grid without one — so ticking YouTube can write its id and no slug at all. Reading
    // slugs alone would report YouTube as switched OFF for an assistant the user just switched ON.
    const db = fakeDb([{ serviceName: 'linkedin' }], [{ provider: 'youtube' }]);
    const enabled = await resolveAssistantEnabledPlatforms(db, scope({ linked_integrations: [7, -3] }));
    assert.deepEqual([...(enabled ?? [])].sort(), ['linkedin', 'youtube']);
});

await test('configuration.appliedDefaults.platforms is read alongside linked_integrations', async () => {
    // update-assistant-context writes the same tick list to both places; a selection recorded in
    // only one of them is still a selection.
    const db = fakeDb([{ serviceName: 'facebook' }], []);
    const enabled = await resolveAssistantEnabledPlatforms(
        db,
        scope({}, { appliedDefaults: { platforms: [4] } }),
    );
    assert.deepEqual([...(enabled ?? [])], ['facebook']);
});

// ── 3. The refusal itself ────────────────────────────────────────────────────

await test('a platform left out of a real selection is switched OFF', async () => {
    const db = fakeDb([], []);
    const s = scope({ primary_platforms: ['ig', 'fb', 'li', 'x'] });
    assert.equal(await isPlatformEnabledForAssistant(db, s, 'youtube'), false);
    assert.equal(await isPlatformEnabledForAssistant(db, s, 'instagram'), true);
});

await test('opt-in and default-on disagree on a blank selection, and must keep disagreeing', async () => {
    // The two rules exist precisely to differ here. Collapsing them either way loses something: one
    // rule for everything would either resume drafting weekly Shorts nobody asked for, or stop an
    // untouched workspace posting at all.
    const db = fakeDb([], []);
    const blank = scope({});
    assert.equal(await isPlatformEnabledForAssistant(db, blank, 'youtube'), true);
    assert.equal(await isPlatformOptedInForAssistant(db, blank, 'youtube'), false);
});

await test('an explicit YouTube tick opts in, however it was recorded', async () => {
    // The tick reaches us as a NEGATIVE id (workspace_integrations) or as a slug, depending on the
    // path that wrote it — and a user who has turned Shorts on must get them either way.
    const bySlug = await isPlatformOptedInForAssistant(
        fakeDb([], []),
        scope({ primary_platforms: ['yt'] }),
        'youtube',
    );
    const byId = await isPlatformOptedInForAssistant(
        fakeDb([], [{ provider: 'youtube' }]),
        scope({ linked_integrations: [-1] }),
        'youtube',
    );
    assert.equal(bySlug, true);
    assert.equal(byId, true);
});

await test('a selection that names other platforms does not opt into YouTube', async () => {
    // The production shape this was found in: a social media manager ticked for x/linkedin/
    // instagram/facebook and nothing else, still receiving a Short every week.
    const db = fakeDb([{ serviceName: 'x' }, { serviceName: 'linkedin' }, { serviceName: 'instagram' }, { serviceName: 'facebook' }], []);
    const s = scope({ primary_platforms: [], linked_integrations: [1, 2, 3, 4] });
    assert.equal(await isPlatformOptedInForAssistant(db, s, 'youtube'), false);
    assert.equal(await isPlatformEnabledForAssistant(db, s, 'youtube'), false);
    assert.equal(await isPlatformEnabledForAssistant(db, s, 'x'), true);
});

// ── 4. Every enqueue point has to ask ────────────────────────────────────────

test('the cross-post fan-out resolves platforms for the ASSISTANT, not just the org', () => {
    // resolveConnectedDraftPlatforms answers org-level when called with no assistant. That overload
    // is deliberate (some callers have no single assistant in scope) and it is also exactly how the
    // switch got ignored, so the drafting callers must pass one.
    const runtime = src('src/utils/auto-publish-runtime.ts');
    assert.ok(
        /resolveAssistantEnabledPlatforms/.test(runtime),
        'the drafter platform resolver must consult the per-assistant selection',
    );
    for (const path of ['src/utils/schedule-gap-fill.ts', 'netlify/functions/autonomous-media-suggestions.ts']) {
        const s = src(path);
        assert.ok(
            /resolveConnectedDraftPlatforms\(\s*db,[^)]*onboardingContext/s.test(s),
            `${path} must pass the assistant, or a switched-off platform stays in the fan-out`,
        );
    }
});

test('the weekly Short checks the switch BEFORE it enqueues', () => {
    // YouTube is absent from AUTONOMOUS_DRAFT_PLATFORMS, so the Short is the only autonomous
    // producer for it — this one check is the whole difference between the switch working and not.
    const s = src('src/utils/schedule-gap-fill.ts');
    const fn = s.slice(s.indexOf('async function resolveWeeklyShortSlot'), s.indexOf('async function orgHasAvailableManualAsset'));
    // OPT-IN, not the default-on rule: a live channel is not a request for a video a week, and the
    // assistants this was found on had no recorded selection at all.
    assert.ok(/isPlatformOptedInForAssistant/.test(fn), 'the weekly Short must require an explicit tick');
    assert.ok(
        !/isPlatformEnabledForAssistant/.test(fn),
        'the default-on rule would resume drafting Shorts for every untouched workspace',
    );
    assert.ok(
        fn.indexOf('isPlatformOptedInForAssistant') < fn.indexOf('resolveLiveSocialConnections'),
        'ask the cheap local question first — a switched-off platform should not cost a connection lookup',
    );
});

test('the weekly Short dedupes on a window that looks BACKWARD too', () => {
    // A forward-only window is not a weekly cadence, it is a daily one: the moment a Short's slot
    // passes it stops matching, the next hourly run sees no future Short and drafts another. Found
    // in production as nine Shorts in nine working days, none ever approved.
    const s = src('src/utils/schedule-gap-fill.ts');
    const fn = s.slice(s.indexOf('async function resolveWeeklyShortSlot'), s.indexOf('async function orgHasAvailableManualAsset'));
    assert.ok(/weekAgo/.test(fn), 'the planned-Short lookup must have a lower bound in the PAST');
    assert.ok(
        !/gte\(scheduledPosts\.publishDate, now\)/.test(fn),
        'anchoring the window at `now` is the daily-drafting bug itself',
    );
    assert.ok(
        /'publishing','published'/.test(fn),
        'a Short that already published is the strongest evidence this week is done',
    );
});

test('an on-demand Short refuses with a message that names the switch', () => {
    const s = src('netlify/functions/trigger-youtube-short.ts');
    assert.ok(/YOUTUBE_DISABLED_FOR_ASSISTANT/.test(s), 'the trigger must refuse when the assistant is switched off');
    assert.ok(
        s.indexOf('YOUTUBE_DISABLED_FOR_ASSISTANT') < s.indexOf('enqueueYoutubeShortJob(db, {'),
        'the refusal must precede the enqueue',
    );
    assert.ok(
        /Use for this assistant/.test(s),
        'a refusal about a plainly-connected account has to say which switch to flip',
    );
});

test('a Short already queued when the switch flipped is cancelled, not drafted', () => {
    // The enqueue-side gate only stops the NEXT one, and a Short is queued up to a week ahead — so
    // without this the user watches one more unwanted post arrive after changing the setting.
    const s = src('netlify/functions/process-content-jobs.ts');
    assert.ok(
        /isYoutubeShort && !\(await isPlatformOptedInForAssistant/.test(s),
        'the worker must re-check the switch for a standalone Short',
    );
    assert.ok(
        s.indexOf('isYoutubeShort && !(await isPlatformOptedInForAssistant') < s.indexOf('const isVideo'),
        'the check must come before the prompt is built and the model is called',
    );
});

console.log(`\n${passed} checks passed\n`);

}

void main();
