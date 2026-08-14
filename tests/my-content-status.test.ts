// tests/my-content-status.test.ts
// My Content classifies an asset from the posts that USE it, by the same rule the Calendar reads.
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// content_assets.status is a denormalised copy maintained by hand-written transitions in
// scheduled-posts.ts. Those transitions handle a post becoming scheduled/approved, published, or
// cancelled/rejected — and nothing else. Every other way a post stops being scheduled strands its
// media on 'scheduled' for ever:
//
//   • DELETE soft-cancels with a direct db.update that never propagates at all.
//   • A scheduled post sent back for changes goes to pending_approval / draft / in_review, none of
//     which the propagation handles.
//   • 'missed' is handled nowhere.
//   • Replacing a post's media leaves the old asset attached to nothing, still marked scheduled.
//
// So My Content showed media as "Scheduled" that no scheduled post referenced, disagreeing with the
// Calendar and Review Queue about the same posts. The fix derives the displayed status from live
// rows via isScheduleActive — the Calendar's own rule — so there is no transition left to miss.
//
// Run:  npx tsx tests/my-content-status.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveAssetStatus, type AssetUsage } from '../netlify/functions/content-assets';
import { SCHEDULE_ACTIVE_STATUSES, SCHEDULE_INACTIVE_STATUSES, isScheduleActive } from '../src/config/post-status';
import { landmark } from './landmark';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const use = (status: string, over: Partial<AssetUsage> = {}): AssetUsage =>
    ({ id: 1, platform: 'instagram', publishDate: new Date(), status, assistantId: null, assistantName: null, ...over });

console.log('\nmy content asset status\n');

// ── The reported bug, one case per leak ─────────────────────────────────────────────────────────
check('a stranded "scheduled" asset whose post was DELETED reads as pending', () => {
    // The post is soft-cancelled; the DELETE branch never propagated, so the row still says
    // 'scheduled'. What matters is that no live post uses it.
    assert.strictEqual(deriveAssetStatus('scheduled', [use('cancelled')]), 'pending');
});

check('a post sent BACK for changes releases its media', () => {
    for (const back of ['pending_approval', 'draft', 'in_review']) {
        assert.strictEqual(deriveAssetStatus('scheduled', [use(back)]), 'pending',
            `a post at '${back}' has no live schedule, so its media is not scheduled either`);
    }
});

check('a missed post does not hold its media for ever', () => {
    assert.strictEqual(deriveAssetStatus('scheduled', [use('missed')]), 'pending');
});

check('media detached from every post falls back to the pending pool', () => {
    assert.strictEqual(deriveAssetStatus('scheduled', []), 'pending',
        'no post references it at all — "Scheduled" is meaningless');
});

// ── Still correct where it was already correct ──────────────────────────────────────────────────
check('a genuinely scheduled post still marks its media scheduled', () => {
    assert.strictEqual(deriveAssetStatus('pending', [use('scheduled')]), 'scheduled');
    assert.strictEqual(deriveAssetStatus('pending', [use('approved')]), 'scheduled');
});

check('published wins over scheduled — it went out', () => {
    assert.strictEqual(deriveAssetStatus('scheduled', [use('published')]), 'posted');
    // Reused across two posts: gone out once, still queued elsewhere. "Posted" is the stronger fact.
    assert.strictEqual(deriveAssetStatus('scheduled', [use('scheduled'), use('published')]), 'posted');
});

check('history is never demoted, even if the post row has gone', () => {
    assert.strictEqual(deriveAssetStatus('posted', []), 'posted');
});

check('a moderation rejection is not a post state and is never overturned', () => {
    assert.strictEqual(deriveAssetStatus('rejected', [use('scheduled')]), 'rejected');
    assert.strictEqual(deriveAssetStatus('rejected', [use('published')]), 'rejected');
});

check('one live post among several dead ones is enough', () => {
    assert.strictEqual(
        deriveAssetStatus('pending', [use('cancelled'), use('rejected'), use('scheduled')]),
        'scheduled');
});

// ── It really is the Calendar's rule ────────────────────────────────────────────────────────────
check('every schedule-active status marks media scheduled, and no inactive one does', () => {
    for (const s of SCHEDULE_ACTIVE_STATUSES) {
        const expected = s === 'published' ? 'posted' : 'scheduled';
        assert.strictEqual(deriveAssetStatus('pending', [use(s)]), expected,
            `'${s}' is on the Calendar, so its media must not read as pending`);
    }
    for (const s of SCHEDULE_INACTIVE_STATUSES) {
        assert.strictEqual(deriveAssetStatus('pending', [use(s)]), 'pending',
            `'${s}' is NOT on the Calendar, so its media must not read as scheduled`);
    }
});

check('the two lists agree with isScheduleActive itself', () => {
    // Guards the derivation against the config drifting underneath it.
    for (const s of SCHEDULE_ACTIVE_STATUSES) assert.ok(isScheduleActive(s));
    for (const s of SCHEDULE_INACTIVE_STATUSES) assert.ok(!isScheduleActive(s));
});

// ── The wiring ──────────────────────────────────────────────────────────────────────────────────
check('the listing derives the status instead of trusting the column', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/content-assets.ts'), 'utf8');
    assert.ok(!/const bucket = grouped\[r\.status\] \?\? \[\];/.test(src),
        'grouping straight off the stored column is the bug');
    assert.match(src, /const status = deriveAssetStatus\(r\.status, usage\)/);
    assert.match(src, /isScheduleActive/, 'and it must use the Calendar\'s rule, not a local list');
});

check('the delete warning still lists only work that would BREAK', () => {
    // The usage lookup now includes published posts so "posted" can be derived — but a published
    // post is finished with, so it must not turn up in the "this asset is in use" warning.
    const src = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/content-assets.ts'), 'utf8');
    assert.match(src, /usedInPosts: usage\.filter\(u => ACTIVE_POST_STATUSES\.includes\(u\.status\)\)/);
});

// ── The "Post #N" badge ─────────────────────────────────────────────────────────────────────────
// content_assets.scheduled_post_id is written once and never cleared, so it outlived the post it
// named: a stale id sat under the Scheduled chip and in the delete warning, pointing at a post that
// had been cancelled, sent back for changes, or given different media. The served value is now
// found the same way the status is, so the two can never disagree.

/** The endpoint's rule for which post the badge names. */
function livePostFor(usage: AssetUsage[]) {
    return usage.find(u => u.status === 'published')
        ?? usage.find(u => isScheduleActive(u.status))
        ?? null;
}

check('the badge names the post that actually holds the media', () => {
    const usage = [use('cancelled', { id: 11 }), use('scheduled', { id: 22 })];
    assert.strictEqual(livePostFor(usage)?.id, 22, 'the cancelled post must not be named');
});

check('no live post means no badge at all, rather than a stale number', () => {
    assert.strictEqual(livePostFor([use('cancelled', { id: 11 })]), null);
    assert.strictEqual(livePostFor([]), null);
});

check('badge and status are found the same way, so they cannot disagree', () => {
    for (const s of [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES]) {
        const usage = [use(s, { id: 9 })];
        const status = deriveAssetStatus('pending', usage);
        const live = livePostFor(usage);
        if (status === 'pending') assert.strictEqual(live, null, `'${s}' is not live, so nothing to name`);
        else assert.strictEqual(live?.id, 9, `'${s}' gave status '${status}' but named no post`);
    }
});

check('the endpoint serves the derived id, not the stored column', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/content-assets.ts'), 'utf8');
    assert.match(src, /scheduledPostId: livePost\?\.id \?\? null/,
        'the served id must come from live usage');
    assert.match(src, /const livePost = usage\.find\(u => u\.status === 'published'\)/);
});

// ── The source pills ────────────────────────────────────────────────────────────────────────────
/** Lift a top-level function out of the my-content.js IIFE and make it callable. */
function clientFn<T>(names: string[]): T {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'my-content.js'), 'utf8');
    const bodies = names.map(name => {
        const i = src.indexOf(`function ${name}(`);
        if (i < 0) throw new Error(`${name} not found in my-content.js`);
        let d = 0;
        for (let j = src.indexOf('{', i); j < src.length; j++) {
            if (src[j] === '{') d++;
            else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
        }
        throw new Error(`unbalanced ${name}`);
    });
    // MEDIA_TYPES is a const the helpers close over; lift it too.
    const consts = src.slice(landmark(src, 'const MEDIA_TYPES = {'), landmark(src, '/** Which of MEDIA_TYPES'));
    return new Function(`${consts}\n${bodies.join('\n')}\nreturn ${names[names.length - 1]};`)() as T;
}

/**
 * The real _sourceInfo, lifted out of my-content.js — together with _sourceKey, which it now
 * branches on. Lifting it alone used to work and stopped the moment the two were joined, which is
 * itself the point: they are one rule in two places.
 */
const sourceInfo = clientFn<(a: Record<string, unknown>) => { label: string } | null>(['_sourceKey', '_sourceInfo']);

check('the pills name the assistant when we know it', () => {
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'fal', assistantName: 'Ava' })?.label,
        'Generated by Ava');
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'pexels', assistantName: 'Ava' })?.label,
        'Sourced by Ava');
});

check('and fall back to the generic wording when we do not', () => {
    // The name comes from the posts using the asset, so media on no post genuinely has none.
    // "Generated by undefined" would be worse than the generic label it replaced.
    for (const name of [null, undefined, '', '   ']) {
        assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'fal', assistantName: name })?.label,
            'AI Generated', `a ${JSON.stringify(name)} name must not reach the badge`);
        assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'pexels', assistantName: name })?.label,
            'Sourced by Assistant');
    }
});

check('Canva and your own uploads are untouched by the rename', () => {
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'canva', assistantName: 'Ava' })?.label, 'From Canva');
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: null, assistantName: 'Ava' })?.label, 'Your Upload');
    assert.strictEqual(sourceInfo({ assetType: 'link', provider: 'fal', assistantName: 'Ava' }), null);
});

// ── Filter & group facets ───────────────────────────────────────────────────────────────────────
// Two facets the library can be sliced by. Each has ONE definition shared by the filter, the
// grouping and the badge — the point being that anything a badge says must be reachable by
// filtering for it.

const mediaTypeKey = clientFn<(a: unknown) => string>(['_mediaTypeKey']);
const sourceKey = clientFn<(a: unknown) => string>(['_sourceKey']);

check('a branded card is its own media type, not an image', () => {
    // Stored as an image with provider 'brand_card'. Nobody hunting for "the cards I made" thinks
    // of them as images, and lumping them in would make the Image filter useless.
    assert.strictEqual(mediaTypeKey({ assetType: 'image', provider: 'brand_card' }), 'card');
    assert.strictEqual(mediaTypeKey({ assetType: 'image', provider: null }), 'image');
});

check('video, sound and link each have a type', () => {
    assert.strictEqual(mediaTypeKey({ assetType: 'video', provider: null }), 'video');
    assert.strictEqual(mediaTypeKey({ assetType: 'audio', provider: null }), 'audio');
    assert.strictEqual(mediaTypeKey({ assetType: 'link', provider: null }), 'link');
});

check('an unknown asset type does not vanish from the list', () => {
    // A type added server-side before this map knows about it must still be reachable, not filtered
    // into nowhere.
    assert.strictEqual(mediaTypeKey({ assetType: 'hologram', provider: null }), 'link');
});

check('a branded card counts as GENERATED, not sourced', () => {
    // It is rendered deterministically for this business, not found somewhere. It used to fall
    // through to the generic "provider is set" branch and label itself "Sourced by Assistant".
    assert.strictEqual(sourceKey({ provider: 'brand_card' }), 'generated');
    assert.strictEqual(sourceKey({ provider: 'fal' }), 'generated');
    assert.strictEqual(sourceKey({ provider: 'remotion' }), 'generated');
});

check('stock is sourced, Canva is Canva, and no provider is your upload', () => {
    assert.strictEqual(sourceKey({ provider: 'pexels' }), 'sourced');
    assert.strictEqual(sourceKey({ provider: 'canva' }), 'canva');
    assert.strictEqual(sourceKey({ provider: null }), 'upload');
    assert.strictEqual(sourceKey({}), 'upload');
});

check('the badge and the source filter cannot disagree', () => {
    // The whole reason _sourceInfo branches on _sourceKey: a badge reading "Generated by Ava" that
    // the Generated filter then hid would be worse than no filter at all.
    const cases: Array<[Record<string, unknown>, string]> = [
        [{ assetType: 'image', provider: 'fal', assistantName: 'Ava' }, 'generated'],
        [{ assetType: 'image', provider: 'brand_card', assistantName: 'Ava' }, 'generated'],
        [{ assetType: 'image', provider: 'pexels', assistantName: 'Ava' }, 'sourced'],
        [{ assetType: 'image', provider: 'canva' }, 'canva'],
        [{ assetType: 'image', provider: null }, 'upload'],
    ];
    const expected: Record<string, RegExp> = {
        generated: /^Generated by |^AI Generated$/,
        sourced: /^Sourced by /,
        canva: /^From Canva$/,
        upload: /^Your Upload$/,
    };
    for (const [asset, key] of cases) {
        assert.strictEqual(sourceKey(asset), key);
        assert.match(String(sourceInfo(asset)?.label), expected[key],
            `the badge for a '${key}' asset must read as ${key}`);
    }
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
