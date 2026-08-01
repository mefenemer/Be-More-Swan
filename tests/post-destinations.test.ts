// tests/post-destinations.test.ts
// A destination is a platform AND a format.
//
// The model this pins is the whole reason "Instagram, Reel, nothing else" became askable. Everything
// that touches a cross-post group used to key on PLATFORM, which quietly imposed two rules nobody
// chose: a post could hold at most one row per platform, and that row's format was whatever the
// router derived from its media. Both are gone; these checks are what stops them coming back.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDestinations, destinationKey, legacyPostFormat, canonicalPlatform } from '../src/utils/post-destinations';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

console.log('\npost destinations\n');

// ── The key ─────────────────────────────────────────────────────────────────────────────────────
check('two destinations are the same one only when platform AND format match', () => {
    const reel = { platform: 'instagram', formatKey: 'ig_reel' };
    const carousel = { platform: 'instagram', formatKey: 'ig_carousel' };
    assert.notStrictEqual(destinationKey(reel), destinationKey(carousel),
        'a Reel and a carousel on one account are two destinations, not one');
    assert.strictEqual(destinationKey(reel), destinationKey({ platform: 'instagram', formatKey: 'ig_reel' }));
});

check('a format-less destination is a real destination, not a missing one', () => {
    // Every row created before formats existed carries null, and Autopilot still creates them.
    assert.strictEqual(destinationKey({ platform: 'x', formatKey: null }), 'x|');
    assert.notStrictEqual(destinationKey({ platform: 'x', formatKey: null }), destinationKey({ platform: 'x', formatKey: 'x_video' }));
});

check('twitter and x are one destination, not two', () => {
    // Legacy rows store 'twitter'; the catalogue only knows 'x'. Keying them apart would delete an
    // old X post and rebuild it the first time anyone touched its format.
    assert.strictEqual(canonicalPlatform('twitter'), 'x');
    assert.strictEqual(
        destinationKey({ platform: 'twitter', formatKey: 'x_video' }),
        destinationKey({ platform: 'x', formatKey: 'x_video' }));
});

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────
check('the destinations shape carries the format through', () => {
    const r = parseDestinations({ destinations: [{ platform: 'instagram', formatKey: 'ig_reel' }] });
    assert.strictEqual(r.error, undefined);
    assert.deepStrictEqual(r.destinations, [{ platform: 'instagram', formatKey: 'ig_reel' }]);
});

check('the older platforms shape still means what it always meant', () => {
    // Not deprecated-and-broken: "these platforms, format derived" is a legitimate request and is
    // exactly what Autopilot wants.
    const r = parseDestinations({ platforms: ['instagram', 'linkedin'] });
    assert.deepStrictEqual(r.destinations, [
        { platform: 'instagram', formatKey: null },
        { platform: 'linkedin', formatKey: null },
    ]);
});

check('a platform named without a format keeps the format its row already has', () => {
    // THE regression this guards: an old-shape request against a group whose Instagram row is a
    // declared Reel would otherwise read as a different destination — deleting the Reel and
    // replacing it with a format-less row, losing the user's choice to a caller that never mentioned
    // format at all.
    const existing = (p: string) => (p === 'instagram' ? 'ig_reel' : null);
    const r = parseDestinations({ platforms: ['instagram', 'linkedin'] }, existing);
    assert.deepStrictEqual(r.destinations, [
        { platform: 'instagram', formatKey: 'ig_reel' },
        { platform: 'linkedin', formatKey: null },
    ]);
});

check('a format must belong to the platform it is paired with', () => {
    const r = parseDestinations({ destinations: [{ platform: 'linkedin', formatKey: 'ig_reel' }] });
    assert.ok(r.error, 'an ig_reel on a LinkedIn row names a format that platform does not have');
    assert.match(r.error!, /LinkedIn|linkedin/, 'the message must name the platform it was aimed at');
    assert.strictEqual(r.destinations.length, 0);
});

check('an unschedulable format is ACCEPTED here, on purpose', () => {
    // save-post-format.ts deliberately lets a planned format be saved so a user can lay out a
    // carousel before we can publish one; approve-post is the gate. Two endpoints disagreeing would
    // make the same format legal to set and illegal to create with. The composer's picker is what
    // declines to offer it (see _pceToggleDestination).
    const r = parseDestinations({ destinations: [{ platform: 'instagram', formatKey: 'ig_story' }] });
    assert.strictEqual(r.error, undefined, 'availability belongs to the approval gate, not to parsing');
});

check('an unknown platform or format is refused', () => {
    assert.ok(parseDestinations({ destinations: [{ platform: 'myspace', formatKey: null }] }).error);
    assert.ok(parseDestinations({ destinations: [{ platform: 'instagram', formatKey: 'ig_hologram' }] }).error);
    assert.ok(parseDestinations({}).error, 'a post has to go somewhere');
    assert.ok(parseDestinations({ destinations: [] }).error);
});

check('duplicates collapse, and order is preserved', () => {
    const r = parseDestinations({ destinations: [
        { platform: 'instagram', formatKey: 'ig_reel' },
        { platform: 'linkedin', formatKey: 'li_feed' },
        { platform: 'instagram', formatKey: 'ig_reel' },
    ] });
    assert.strictEqual(r.destinations.length, 2, 'the same destination twice is one destination');
    // Order is the order the composer shows its tabs in; reordering moves the tab under the cursor.
    assert.deepStrictEqual(r.destinations.map(d => d.platform), ['instagram', 'linkedin']);
});

// ── The legacy column ───────────────────────────────────────────────────────────────────────────
check('post_format is derived from the declared format, not guessed from the media', () => {
    // It used to be `contentAssetIds.length ? 'image' : 'text'`, so a Reel with no media yet was
    // recorded as text and a Reel with a photo as image — neither of which is what it is.
    assert.strictEqual(legacyPostFormat({ platform: 'instagram', formatKey: 'ig_reel' }, false), 'video');
    assert.strictEqual(legacyPostFormat({ platform: 'instagram', formatKey: 'ig_feed' }, true), 'image');
    assert.strictEqual(legacyPostFormat({ platform: 'instagram', formatKey: 'ig_feed' }, false), 'text');
    // No declaration: the old guess, which is still the best available answer.
    assert.strictEqual(legacyPostFormat({ platform: 'x', formatKey: null }, true), 'image');
});

// ── The endpoints ───────────────────────────────────────────────────────────────────────────────
check('set-post-platforms keys its sibling map by destination', () => {
    const src = read('netlify/functions/set-post-platforms.ts');
    assert.match(src, /const byDestination = new Map\(/, 'keying by platform caps a post at one row per platform');
    assert.ok(!/const byPlatform = new Map\(siblings/.test(src), 'the platform-keyed map is the bug this replaces');
    assert.match(src, /formatKey: dest\.formatKey/, 'a created sibling takes the destination’s format');
    // Copying the anchor's key would put an ig_reel on a LinkedIn row.
    assert.ok(!/formatKey: anchor\.formatKey/.test(src), 'the format must never be copied from the anchor');
});

check('set-post-platforms still refuses to delete a committed row', () => {
    const src = read('netlify/functions/set-post-platforms.ts');
    assert.match(src, /const MUTABLE = \['draft', 'pending_approval', 'in_review'\]/);
    assert.match(src, /if \(!MUTABLE\.includes\(s\.status\)\) locked\.push\(destLabel\(/,
        'a locked destination must be reported by name — a bare platform id cannot say WHICH of its destinations was committed');
});

check('create-manual-post stores the declared format', () => {
    const src = read('netlify/functions/create-manual-post.ts');
    assert.match(src, /formatKey: dest\.formatKey/, 'the row must record what it was created as');
    assert.match(src, /postFormat: legacyPostFormat\(dest, hasMedia\)/);
    // The group id counts destinations, so a Reel + carousel on one platform still share a card.
    assert.match(src, /destinations\.length > 1 \? randomUUID\(\) : null/);
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
