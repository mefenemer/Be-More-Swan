// tests/copy-published-post.test.ts
// Sending a post that has ALREADY GONE OUT to another platform.
//
// A published row cannot change platform — it is a matter of record, and set-post-platforms refuses
// it by design. So "also post this to LinkedIn" has to CREATE a post, and the whole risk of the
// feature is in what that new row inherits. Every trap below has already bitten this codebase once
// on a neighbouring path:
//
//   • the source's formatKey copied onto a platform that has no such format (ig_reel on LinkedIn)
//   • the BAKED picture copied instead of the clean original, so the text appears — and publishes —
//     twice (the set-post-platforms bug, fixed 2026-09-07)
//   • the copy joining the published post's crosspost group, which would put a pending row on the
//     same Review Queue card as a post that has gone out
//   • render_status inherited as 'done', so the copy publishes claiming a rendered clip it has not got
//
// Source-level, because the alternative is a live DB, a published post, an image pipeline and a
// model call to catch what are all one-line omissions.
//
// Run:  npx tsx tests/copy-published-post.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PLATFORM_FORMATS } from '../src/config/platform-formats';
import { MEDIA_EDITABLE_STATUSES } from '../src/config/post-status';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const fn = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const COPY = fn('netlify/functions/copy-post-to-platform.ts');

check('only a post that has actually gone out can be copied', () => {
    assert.match(COPY, /const COPYABLE = \['published'\]/,
        'a draft has its own platform picker; copying one would create a row nobody asked for');
    // And the refusal has to say which door to use instead, or it is a dead end.
    assert.match(COPY, /change its platforms from the post editor instead/,
        'an approved or scheduled post needs pointing at set-post-platforms, not just refusing');
    // The status it refuses must not silently become copyable if MEDIA_EDITABLE_STATUSES changes.
    assert.ok(!(MEDIA_EDITABLE_STATUSES as readonly string[]).includes('published'),
        'published is not media-editable — if that ever changes, this feature needs rethinking');
});

check('the copy is its own post, never part of the published group', () => {
    assert.match(COPY, /crosspostGroupId: null/,
        'joining the source group would land a pending row on the published post’s Review Queue card');
    assert.match(COPY, /copiedFromPostId: postId/, 'provenance is what stops a duplicate copy');
    // Copies made TOGETHER are a genuine cross-post of each other and do share a fresh group.
    assert.match(COPY, /if \(copies\.length > 1\)[\s\S]{0,200}randomUUID\(\)/,
        'several copies made in one request share a NEW group id, not the source’s');
});

check('the format comes from the destination, never from the source', () => {
    // Scoped to the INSERT. `source.formatKey` legitimately appears above it, in the read that works
    // out which destinations this post has already gone out on — asserting over the whole file
    // failed on that read, which is the opposite of what this guards.
    const insert = COPY.slice(COPY.indexOf('await db.insert(scheduledPosts).values({'),
                              COPY.indexOf('}).returning({ id: scheduledPosts.id })'));
    assert.ok(insert.length > 200, 'expected to find the insert');
    assert.match(insert, /formatKey: dest\.formatKey/,
        "copying the source's format key would put an ig_reel on a LinkedIn row");
    assert.ok(!/formatKey: source\.formatKey/.test(insert), 'the source format must never be inherited');
    assert.match(COPY, /legacyPostFormat\(dest, copyAssetIds\.length > 0\)/,
        'the loose post_format descriptor has to agree with what is actually attached');
});

check('the copy takes the CLEAN picture, not the published one', () => {
    // Identical rule to set-post-platforms. A published post with text on its image has the
    // flattened copy attached — seeding from it stacks the words twice.
    assert.match(COPY, /const baseAssetId = source\.overlayBaseAssetId \?\? null/,
        'the pre-bake original is the only safe thing to copy');
    assert.match(COPY, /sourceAssetIds\.length === 1 && sourceAssetIds\[0\] !== baseAssetId/,
        'the swap fires only when the attachment actually diverges from the pin');
    assert.match(COPY, /overlayBaseAssetId: baseAssetId/,
        "the pin must travel too, or the copy's own bake has nothing clean to composite onto");
    assert.match(COPY, /contentAssetIds: copyAssetIds/, 'the legacy array takes the clean assets');
    assert.match(COPY, /scheduledPostId: made\.id, contentAssetId, position/,
        'the junction rows must mirror the same assets, or the two disagree at publish time');
});

check('render state is never inherited', () => {
    assert.match(COPY, /renderStatus: null/,
        "a copy claiming the source's 'done' render would publish with no overlaid clip attached");
    assert.ok(!/renderStatus: source\.renderStatus/.test(COPY), 'the source render belongs to the source');
});

check('nothing is published — the copy goes to the Review Queue', () => {
    assert.match(COPY, /status: 'pending_approval'/,
        'a caption written for one platform reads differently on another; a human signs that off');
    assert.ok(!/'publish_now'|status: 'scheduled'|publishedAt:/.test(COPY),
        'this endpoint must never put anything into the publish path');
    assert.match(COPY, /triggerType: 'manual'/, 'the user asked for this, so it is not autonomous work');
    assert.match(COPY, /isAutonomous: false/, 'an autonomous flag here would let auto-publish claim it');
});

check('a destination that cannot carry the post is refused, with a reason', () => {
    assert.match(COPY, /copyIsVideo && !spec\.canPublishVideo/,
        'the publishers take an image or nothing — a video copy would go out as a bare caption');
    assert.match(COPY, /spec\.mediaMandatory && !copyAssetIds\.length/,
        'Instagram cannot publish without a picture, so a text-only copy there is a dead draft');
    assert.match(COPY, /wentOutOn\.has\(platform\)/, 'the post already went out there');
    assert.match(COPY, /copiedTo\.has\(platform\)/, 'a copy is already waiting in the queue');
    // Every refusal carries prose, not a code — this panel has no second surface to explain itself.
    const reasons = COPY.match(/skipped\.push\(\{[\s\S]{0,200}?reason:/g) || [];
    assert.ok(reasons.length >= 5, `every skip needs a readable reason, found ${reasons.length}`);

    // A copy the user threw away must not block a fresh attempt.
    assert.match(COPY, /\['rejected', 'cancelled'\]\.includes\(c\.status\)/,
        'a rejected copy is not a reason to refuse a new one');
});

check('the caption is copied verbatim, and reworded ONLY when it cannot fit', () => {
    assert.match(COPY, /if \(caption\.length > limit\)/,
        'a caption that fits is the same post — rewriting it when nothing required it is not an improvement');
    assert.match(COPY, /const credit = await consumeTaskCredit\(db, orgId\)/,
        'the rewrite is paid work and must go through the cap like every other paid action');
    // The credit is taken INSIDE the over-length branch, or every copy bills for nothing. Measured
    // against the CALL, not the import at the top of the file.
    const branch = COPY.indexOf('if (caption.length > limit)');
    const call = COPY.indexOf('await consumeTaskCredit(');
    assert.ok(branch !== -1 && call !== -1 && call > branch,
        'a credit spent before the length check bills the user for copies that needed no rewrite');

    // The gap this exists for. If these two ever converge, the whole branch is dead code.
    assert.ok(PLATFORM_FORMATS.instagram.charLimit > PLATFORM_FORMATS.x.charLimit * 5,
        'the Instagram→X gap is the case this feature exists for');

    // A failed rewrite must not lose the draft.
    assert.match(COPY, /if \(fitted\) \{ finalCaption = fitted; captionReworded = true; \}/,
        'a model failure falls back to the original text rather than refusing the copy');
    assert.match(COPY, /captionReworded/,
        'the user has to be told their words were changed');
});

check('the proposed slot is in the future', () => {
    assert.match(COPY, /async function proposeSlot\(/,
        'a copy landing on a past date would argue with approve-post’s past-schedule gate');
    assert.match(COPY, /now\.getTime\(\) \+ 24 \* 60 \* 60 \* 1000/, 'tomorrow is the fallback');
    assert.match(COPY, /slots\.find\(s => s\.getTime\(\) > now\.getTime\(\)\)/,
        'a cadence slot must be a FUTURE one');
    assert.ok(!/publishDate: source\.publishDate/.test(COPY),
        "the source's publish date is in the past — it has already gone out");
});

check('the column it depends on is applied by hand, before the code', () => {
    const sqlPath = 'db/post-copied-from.sql';
    assert.ok(existsSync(path.join(ROOT, sqlPath)), `${sqlPath} must exist — this column is hand-applied`);
    const sql = fn(sqlPath);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS copied_from_post_id/, 'idempotent, so a re-run is safe');
    assert.match(sql, /ON DELETE SET NULL/,
        'deleting the original must never take the copy with it — the copy is a post in its own right');
    assert.match(sql, /APPLY THIS TO BOTH DATABASES \*BEFORE\* DEPLOYING/,
        'a bare db.select() names every column in schema.ts, so the DDL has to land first');
    // The header must NAME the readers that break, per the repo's own convention — "some functions
    // will fail" is not something anyone can act on at 2am.
    for (const reader of ['set-post-platforms.ts', 'reject-post.ts', 'publish-youtube-background.ts',
                          'scheduled-posts.ts', 'copy-post-to-platform.ts']) {
        assert.ok(sql.includes(reader), `the warning must name ${reader}, which reads with a bare select`);
    }
    // And it must say how to reach PROD, which the runner does NOT do by default.
    assert.match(sql, /--url-var DATABASE_URL_PROD/,
        'without --url-var the runner applies to staging twice and reports success both times');

    // The Drizzle mirror has to agree with the SQL, or the bare select names a column that is not there.
    assert.match(fn('db/schema.ts'), /copiedFromPostId: integer\("copied_from_post_id"\)/,
        'the schema mirror must name the same column');
});

check('the client states the scope it showed, and never guesses a format', () => {
    const ws = fn('workspace.html');
    assert.match(ws, /_rqCopyElsewhereHtml\(\)/, 'the published banner is where this belongs');
    assert.match(ws, /nothing goes out until you approve it/,
        'the panel must say the copy is a draft — "post this elsewhere" otherwise reads as publishing');
    assert.match(ws, /destinations: \[\.\.\._rqCopyTargets\]\.map\(platform => \(\{ platform, formatKey: null \}\)\)/,
        'the client must not send a format — the destination decides it');
    assert.match(ws, /rqPlatformConnected\(p\.id\)/,
        'offering an unconnected platform creates a draft that cannot be approved');
    assert.match(ws, /The caption was shortened to fit/,
        'a reworded caption has to be said out loud, next to the thing that did it');
    // The picker must not leak between posts.
    assert.match(ws, /_rqCopyReset\(\);/, 'the picker is a persistent element and has to be re-armed per post');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
