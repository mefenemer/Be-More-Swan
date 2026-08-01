// tests/crosspost-format-routing.test.ts
// Each platform's format is derived from ITS OWN row, not from whichever tab is open.
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// A cross-post is one scheduled_posts row per platform, each with its own contentAssetIds. The
// composer's tab strip labels every tab from a single route-post-formats call — and that endpoint
// routed EVERY platform in the group against the media of the row named in the query string.
//
// So: attach a picture on Instagram, and the strip correctly reads "Instagram / auto-cropped". Click
// Facebook, the strip re-asks from the Facebook row, that row carries no media of its own, and
// routeAsset returns 'none' for every platform — including Instagram, which is mediaMandatory. The
// strip then struck Instagram through and relabelled it "no format", a second after it had been
// right. Nothing about Instagram had changed; only which row was asked.
//
// These tests pin the routing rule that fixes it. The endpoint's own query is source-checked, since
// exercising it needs a database.
//
// Run:  npx tsx tests/crosspost-format-routing.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assetIdList, loadAssetMetricsById, orderMetrics, routeAsset } from '../src/utils/format-router';

let passed = 0, total = 0;
const deferred: Array<() => Promise<void>> = [];
/** Queued rather than awaited inline: tsx compiles these tests to CJS, which has no top-level await. */
function check(name: string, fn: () => void | Promise<void>) {
    total++;
    deferred.push(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
    });
}

const ROOT = path.resolve(import.meta.dirname, '..');

/** Minimal stand-in for the drizzle chain the loader uses. */
function fakeDb(rows: any[]) {
    return { select: () => ({ from: () => ({ where: async () => rows }) }) };
}

// A 4:5 photo — Instagram publishes it cropped, which is the "auto-cropped" the user saw.
const PHOTO = { id: 1, assetType: 'image', width: 1080, height: 1350, durationS: null };

/** The endpoint's rule: route each platform from its own row. */
async function routeGroup(rows: Array<{ platform: string; contentAssetIds: number[] }>, assetRows: any[]) {
    const metrics = await loadAssetMetricsById(fakeDb(assetRows) as any, rows.flatMap(r => assetIdList(r.contentAssetIds)));
    const out: Record<string, ReturnType<typeof routeAsset>> = {};
    for (const r of rows) out[r.platform] = routeAsset(r.platform, orderMetrics(assetIdList(r.contentAssetIds), metrics));
    return out;
}

console.log('\ncross-post format routing\n');

check('the platform holding the picture is routed from its own media', async () => {
    const routes = await routeGroup([
        { platform: 'instagram', contentAssetIds: [1] },
        { platform: 'facebook', contentAssetIds: [] },
    ], [PHOTO]);
    assert.notStrictEqual(routes.instagram.state, 'none',
        'Instagram HAS the picture — it must never read as "no format"');
    assert.ok(routes.instagram.format, 'a routed platform names a format');
});

check('asking from an EMPTY sibling does not blank the platform that has media', async () => {
    // This is the reported bug, exactly: the answer for Instagram must not change because the
    // composer switched to the Facebook tab.
    const rows = [
        { platform: 'instagram', contentAssetIds: [1] },
        { platform: 'facebook', contentAssetIds: [] },
        { platform: 'linkedin', contentAssetIds: [] },
        { platform: 'x', contentAssetIds: [] },
    ];
    const routes = await routeGroup(rows, [PHOTO]);
    assert.notStrictEqual(routes.instagram.state, 'none', 'Instagram struck through by another tab');

    // And the old rule — every platform routed from ONE row — is what produced it.
    const metrics = await loadAssetMetricsById(fakeDb([PHOTO]) as any, [1]);
    const fromFacebookRow = routeAsset('instagram', orderMetrics(assetIdList([]), metrics));
    assert.strictEqual(fromFacebookRow.state, 'none',
        'the fixture must actually reproduce the old failure, or this test proves nothing');
});

check('a text-only platform with no media is still fine', async () => {
    const routes = await routeGroup([
        { platform: 'instagram', contentAssetIds: [1] },
        { platform: 'facebook', contentAssetIds: [] },
    ], [PHOTO]);
    assert.strictEqual(routes.facebook.state, 'ok', 'Facebook publishes text alone');
});

check('a platform that genuinely cannot publish is still reported', async () => {
    // The strike-through is CORRECT here: Instagram's own row has nothing on it.
    const routes = await routeGroup([
        { platform: 'instagram', contentAssetIds: [] },
        { platform: 'facebook', contentAssetIds: [] },
    ], []);
    assert.strictEqual(routes.instagram.state, 'none', 'Instagram cannot publish without media');
    assert.match(String(routes.instagram.reason), /without media/i);
});

check('platforms differ when their media differs — the supported case', async () => {
    // "Apply to all platforms" can be unticked, so siblings legitimately carry different pictures.
    const VIDEO = { id: 2, assetType: 'video', width: 1080, height: 1920, durationS: 20 };
    const routes = await routeGroup([
        { platform: 'instagram', contentAssetIds: [2] },
        { platform: 'facebook', contentAssetIds: [1] },
    ], [PHOTO, VIDEO]);
    assert.notStrictEqual(routes.instagram.state, 'none');
    assert.notStrictEqual(routes.facebook.state, 'none');
    assert.notStrictEqual(routes.instagram.format?.key, routes.facebook.format?.key,
        'a video row and a photo row must not resolve to the same format');
});

check('one metrics query serves the whole group', async () => {
    let queries = 0;
    const db = { select: () => ({ from: () => ({ where: async () => { queries++; return [PHOTO]; } }) }) };
    const rows = [
        { platform: 'instagram', contentAssetIds: [1] },
        { platform: 'facebook', contentAssetIds: [1] },
        { platform: 'linkedin', contentAssetIds: [1] },
        { platform: 'x', contentAssetIds: [1] },
    ];
    await loadAssetMetricsById(db as any, rows.flatMap(r => assetIdList(r.contentAssetIds)));
    assert.strictEqual(queries, 1, 'routing per platform must not become a query per platform');
});

// ── The endpoint ────────────────────────────────────────────────────────────────────────────────
check('the endpoint routes per row, and scopes siblings to the tenant', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/route-post-formats.ts'), 'utf8');
    assert.ok(!/routeAcross\(platforms, assets\)/.test(src),
        'routing every platform from one row is the bug');
    // Keyed by row ID now, not by platform. Same invariant, stricter: one entry per ROW means two
    // destinations on one platform — a Reel and a carousel — each get their own answer, where the
    // platform map could only hold whichever was written last.
    assert.match(src, /for \(const \[id, row\] of rows\)/, 'each row needs its own route');
    assert.match(src, /routeAsset\(row\.platform, orderMetrics\(assetIdList\(row\.contentAssetIds\), metrics\), row\.formatKey\)/,
        'and must be routed from THAT row\'s media, against THAT row\'s declared format');
    // The sibling read used to have no org filter at all; a crosspost_group_id is not a secret.
    const sibling = src.slice(src.indexOf('const siblings = groupId'), src.indexOf('// ── Keyed by ROW'));
    assert.match(sibling, /me\.organisationId/, 'the sibling query must be tenant-scoped');
    assert.match(sibling, /formatKey: scheduledPosts\.formatKey/, 'the declared format must be read for every sibling');
});

check('the queried row still describes its own platform', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/route-post-formats.ts'), 'utf8');
    // The by-platform map is a fallback for callers that have only a platform. Where two rows share
    // one, it can hold just one of them — so the queried post must be the one that wins, and the
    // composer must read the by-id map instead (which it does).
    assert.match(src, /if \(!byPlatform\[row\.platform\] \|\| id === post\.id\)/,
        'the post you asked about wins for its platform');
    assert.match(src, /routesByPlatform/, 'the fallback map must still be returned');
});

(async () => {
    for (const run of deferred) await run();
    console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
    if (passed !== total) process.exit(1);
})();
