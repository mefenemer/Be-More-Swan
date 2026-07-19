// tests/social-credentials.test.ts
// Credential-store routing for the social publish path (src/utils/social-publish.ts).
//
// Run:  npx tsx tests/social-credentials.test.ts
//
// Social platforms are split across two connection stores — system_connections (Facebook,
// Instagram, LinkedIn, X) and workspace_integrations (Threads, YouTube). chooseCredentialSource
// is the branch that decides which one answers, and getting it wrong is how a post either
// publishes with the wrong account's token or fails with a misleading error. Verifies:
//   - a row owning a vaultRefKey always wins (the legacy path is untouched)
//   - a shadow row (vaultRefKey NULL) routes to workspace_integrations, not an error
//   - a missing row routes to workspace_integrations ONLY for platforms backed there
//   - a missing system_connections platform still fails closed
// Pure logic — no DB required.

import assert from 'node:assert';
import {
    chooseCredentialSource, WORKSPACE_BACKED_PLATFORMS, THREADS_TEXT_MAX,
    youtubeMetaFromCaption, publishYouTube, YOUTUBE_TITLE_MAX,
    type ConnectionRow,
} from '../src/utils/social-publish';
import { normalizePlatform, platformFormat, PLATFORM_FORMATS } from '../src/config/platform-formats';
import { AUTONOMOUS_DRAFT_PLATFORMS } from '../src/utils/publish-policy';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Async variant — a rejected promise inside the sync `check` above would be swallowed as an
// unhandled rejection and the test would report a false pass.
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const LEGACY = ['facebook', 'instagram', 'linkedin', 'x'];
const owned = (over: Partial<ConnectionRow> = {}): ConnectionRow =>
    ({ id: 7, vaultRefKey: 'aura/user-1/x-oauth', externalUserId: 'acct-1', ...over });
const shadow = (over: Partial<ConnectionRow> = {}): ConnectionRow =>
    ({ id: 9, vaultRefKey: null, externalUserId: null, ...over });

// ── The legacy path must be completely unaffected by the bridge ──────────────

check('a row with a vaultRefKey resolves from system_connections', () => {
    for (const p of LEGACY) {
        const s = chooseCredentialSource(p, owned());
        assert.equal(s.store, 'system_connections', p);
    }
});

check('system_connections carries through the row id, vault key and account id', () => {
    const s = chooseCredentialSource('linkedin', owned({ id: 42, vaultRefKey: 'k', externalUserId: 'urn:li:org:5' }));
    assert.equal(s.store, 'system_connections');
    if (s.store !== 'system_connections') return;
    assert.equal(s.connectionId, 42);
    assert.equal(s.vaultRefKey, 'k');
    assert.equal(s.externalUserId, 'urn:li:org:5');
});

check('an owned row wins even for a workspace-backed platform', () => {
    // If Threads ever gains a real system_connections row, its own token must take precedence
    // over the org-wide workspace integration rather than being silently shadowed by it.
    const s = chooseCredentialSource('threads', owned({ vaultRefKey: 'threads-key' }));
    assert.equal(s.store, 'system_connections');
});

// ── Shadow rows: the per-assistant toggle, no token ──────────────────────────

check('a shadow row routes to workspace_integrations, not an error', () => {
    for (const p of WORKSPACE_BACKED_PLATFORMS) {
        const s = chooseCredentialSource(p, shadow());
        assert.equal(s.store, 'workspace_integrations', p);
    }
});

check('a shadow row still surfaces its connection id for scoping', () => {
    const s = chooseCredentialSource('threads', shadow({ id: 99 }));
    assert.equal(s.store, 'workspace_integrations');
    if (s.store !== 'workspace_integrations') return;
    assert.equal(s.connectionId, 99, 'the toggle row id must survive so scoping can be attributed');
});

check('no row at all still routes a workspace-backed platform to its store', () => {
    // The common case: connected on the Integrations page, never toggled per-assistant.
    const s = chooseCredentialSource('youtube', undefined);
    assert.equal(s.store, 'workspace_integrations');
    if (s.store !== 'workspace_integrations') return;
    assert.equal(s.connectionId, null);
});

// ── Fail-closed: the bridge must not swallow genuine misconfiguration ────────

check('a missing legacy connection fails closed rather than falling through', () => {
    // Regression guard: routing Facebook to workspace_integrations would replace "no active
    // facebook connection" with a confusing "connect it on the Integrations page".
    for (const p of LEGACY) {
        assert.equal(chooseCredentialSource(p, undefined).store, 'none', p);
        assert.equal(chooseCredentialSource(p, shadow()).store, 'none', `${p} (shadow row)`);
    }
});

check('an unknown platform never routes anywhere', () => {
    assert.equal(chooseCredentialSource('pinterest', undefined).store, 'none');
    assert.equal(chooseCredentialSource('', undefined).store, 'none');
});

check('the workspace-backed set stays limited to the intended platforms', () => {
    // Widening this set silently re-routes a live platform's credentials — it should be a
    // deliberate edit that trips this test, not a drive-by.
    assert.deepEqual([...WORKSPACE_BACKED_PLATFORMS].sort(), ['threads', 'youtube']);
    for (const p of LEGACY) assert.equal(WORKSPACE_BACKED_PLATFORMS.has(p), false, p);
});

// ── Threads platform wiring (Phase 2) ───────────────────────────────────────

check('normalizePlatform recognises Threads in every stored form', () => {
    // primary_platforms holds short codes from onboarding ('th') or full names, and the
    // onboarding checkbox has captured Threads since before it was publishable — those values
    // were being silently dropped, which is the bug this fixes.
    for (const raw of ['threads', 'Threads', 'th', ' THREADS ']) {
        assert.equal(normalizePlatform(raw), 'threads', JSON.stringify(raw));
    }
});

check('the loose X fallback does not swallow Threads', () => {
    // normalizePlatform's X arm ends in /(^|\W)x(\W|$)/, so ordering is load-bearing.
    assert.equal(normalizePlatform('threads'), 'threads');
    assert.equal(normalizePlatform('x'), 'x');
    assert.equal(normalizePlatform('twitter'), 'x');
});

check('Threads is text-first with the API character limit', () => {
    const f = platformFormat('threads');
    assert.equal(f.charLimit, 500);
    assert.equal(f.charLimit, THREADS_TEXT_MAX, 'the composer limit and the driver truncation must agree');
    assert.equal(f.mediaMandatory, false, 'Threads must never require an image');
    assert.equal(f.defaultPostFormat, 'text');
    assert.equal(f.label, 'Threads');
});

check('every autonomously-drafted platform has a format entry', () => {
    // The drafter drives entirely off platformFormat(); a platform in the draft list with no
    // format entry silently falls back to Instagram's 4:5 image-mandatory rules.
    for (const p of AUTONOMOUS_DRAFT_PLATFORMS) {
        assert.ok(PLATFORM_FORMATS[p], `${p} has no PLATFORM_FORMATS entry`);
    }
});

check('Threads is drafted autonomously and resolves to its own format', () => {
    assert.ok(AUTONOMOUS_DRAFT_PLATFORMS.includes('threads' as never));
    // Guard the fallback: an unknown key returns Instagram, so a typo would look like it worked.
    assert.notEqual(platformFormat('threads').label, PLATFORM_FORMATS.instagram.label);
});

// ── YouTube wiring (Phase 3) ────────────────────────────────────────────────

check('YouTube is video-only and never text-fallback', () => {
    const f = platformFormat('youtube');
    assert.equal(f.mediaKind, 'video');
    assert.equal(f.mediaMandatory, true);
    assert.equal(f.defaultPostFormat, 'video');
});

check('every image platform is tagged mediaKind image', () => {
    // Guards the inverse of the YouTube case: mis-tagging an image platform as video would make
    // the composer demand a video file for, say, Instagram.
    for (const p of ['instagram', 'facebook', 'linkedin', 'x', 'threads'] as const) {
        assert.equal(PLATFORM_FORMATS[p].mediaKind, 'image', p);
    }
});

check('YouTube is NOT autonomously drafted', () => {
    // Deliberate: every drafter produces stills, so an autonomous YouTube draft could never
    // publish. If this ever flips, the drafter must be able to produce video first.
    assert.equal(AUTONOMOUS_DRAFT_PLATFORMS.includes('youtube' as never), false);
});

// Top-level await isn't available under tsx's cjs transform, so the async checks run in a
// main() that the runner awaits before printing the summary.
async function asyncChecks(): Promise<void> {
    await checkAsync('publishing YouTube without a video fails instead of uploading nothing', async () => {
        // Pure guard — returns before any network call, so this is safe without credentials.
        const res = await publishYouTube({ title: 't', description: 'd', tags: [] }, 'token', null);
        assert.equal(res.ok, false);
        if (res.ok) return;
        assert.match(res.error, /require a video/i);
    });
}

check('caption first line becomes the title, whole caption the description', () => {
    const m = youtubeMetaFromCaption('Cold brew season\nOur new single-origin is here.', '#coffee #cold');
    assert.equal(m.title, 'Cold brew season');
    assert.match(m.description, /single-origin/);
    assert.deepEqual(m.tags, ['coffee', 'cold']);
});

check('an empty caption still yields a usable title', () => {
    // The publisher lets YouTube through with no caption, so the driver must not produce an
    // empty title — YouTube rejects that.
    assert.equal(youtubeMetaFromCaption('', '').title, 'New video');
    assert.equal(youtubeMetaFromCaption('   \n  \n', '').title, 'New video');
});

check('titles are capped and the Shorts marker still fits', () => {
    const long = 'x'.repeat(200);
    assert.equal(youtubeMetaFromCaption(long, '').title.length, YOUTUBE_TITLE_MAX);
    const shorts = youtubeMetaFromCaption(long, '', 'shorts');
    assert.ok(shorts.title.length <= YOUTUBE_TITLE_MAX, `got ${shorts.title.length}`);
    assert.match(shorts.title, /#Shorts$/, 'the marker must survive truncation, not be cut off');
});

check('the Shorts marker is not duplicated when already present', () => {
    const m = youtubeMetaFromCaption('Behind the bar #shorts', '', 'shorts');
    assert.equal((m.title.match(/#shorts/gi) || []).length, 1, m.title);
});

asyncChecks().then(() => {
    console.log(`\n${passed} passed`);
});
