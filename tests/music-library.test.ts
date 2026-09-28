// tests/music-library.test.ts
// The rules about what may be offered and what must be credited.
//
// These are pure functions on purpose. The licence questions — may this organisation be shown this
// track, does this post have to carry a credit, has our right to offer it run out — are the ones
// that are expensive to get wrong and impossible to notice: a wrongly-offered track produces a post
// that publishes perfectly and breaches a licence on the customer's account. Nothing about that
// shows up in a render or a preview, so it has to be provable here.
//
// Same reasoning that put audioGainAt in a pure module: fades were stored, defaulted and passed into
// the renderer for a month and then ignored, and the only way anyone would have noticed was a test
// that did not need a renderer.
//
// Run:  npx tsx tests/music-library.test.ts

import assert from 'node:assert';
import {
    usableTracks, requiredCredits, offerableTo, toTrack, MAX_TRACK_S, type MusicTrack,
} from '../src/lib/music-library';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const track = (over: Partial<MusicTrack> = {}): MusicTrack => ({
    id: 1, title: 'Slow Water', artist: 'K. Reed', url: 'https://r2.example/slow-water.mp3',
    durationS: 92, tags: ['calm', 'ambient'],
    licence: { name: 'Standard Commercial (perpetual)', attributionRequired: false },
    isActive: true,
    ...over,
});

const NOW = new Date('2026-09-28T00:00:00Z');

console.log('\nwhat may be offered, and when it stops');

check('a withdrawn track is not offered', () => {
    assert.strictEqual(usableTracks([track({ isActive: false })], NOW).length, 0);
    assert.strictEqual(usableTracks([track()], NOW).length, 1);
});

check('a lapsed licence stops the track being offered', () => {
    const lapsed = track({ licence: { name: 'One year', attributionRequired: false, expiresAt: '2026-09-27' } });
    const live   = track({ licence: { name: 'One year', attributionRequired: false, expiresAt: '2026-09-29' } });
    assert.strictEqual(usableTracks([lapsed], NOW).length, 0, 'an expired licence is still offered');
    assert.strictEqual(usableTracks([live], NOW).length, 1, 'a live licence is withheld');
});

check('no expiry means perpetual, and an unreadable one is not treated as expired', () => {
    assert.strictEqual(usableTracks([track()], NOW).length, 1, 'a perpetual licence is treated as expired');
    // ⚠️ A date we cannot parse is a curation error, not an expiry. Reading it as expired would
    // silently empty the picker; reading it as perpetual keeps the track offered and visible, which
    // is the failure someone will actually notice and fix.
    const junk = track({ licence: { name: 'x', attributionRequired: false, expiresAt: 'not a date' } });
    assert.strictEqual(usableTracks([junk], NOW).length, 1, 'an unparseable date empties the picker');
});

check('neither withdrawal nor expiry is retroactive', () => {
    // Both only decide what is OFFERED. Nothing here removes a track from a post that already
    // carries it — those posts were licensed when they went out, and a function that could retract
    // them would be both wrong and impossible to apply to something already published.
    const dead = track({ isActive: false, licence: { name: 'x', attributionRequired: true, expiresAt: '2020-01-01' } });
    assert.deepStrictEqual(requiredCredits([dead]), ['Music: Slow Water by K. Reed'],
        'a withdrawn track stops producing the credit the published post still needs');
});

console.log('\ncredits that are required, and credits that are not');

check('only a licence that DEMANDS a credit produces one', () => {
    assert.deepStrictEqual(requiredCredits([track()]), [], 'a courtesy credit is being forced');
    const must = track({ licence: { name: 'CC BY 4.0', attributionRequired: true, attributionText: 'Slow Water by K. Reed (CC BY 4.0)' } });
    assert.deepStrictEqual(requiredCredits([must]), ['Slow Water by K. Reed (CC BY 4.0)']);
});

check('the licence\'s own wording is used verbatim, never paraphrased', () => {
    const must = track({ licence: { name: 'CC BY 4.0', attributionRequired: true, attributionText: '© 2026 K. Reed, used under CC BY 4.0' } });
    assert.deepStrictEqual(requiredCredits([must]), ['© 2026 K. Reed, used under CC BY 4.0'],
        'a legal string has been rewritten into an approximation of one');
});

check('a required credit with no wording still produces one', () => {
    // A licence that demands attribution but records no text is a curation error, and silence is the
    // one response that cannot be right — fall back to the plainest true statement.
    const must = track({ licence: { name: 'Unknown', attributionRequired: true } });
    assert.deepStrictEqual(requiredCredits([must]), ['Music: Slow Water by K. Reed']);
});

check('one artist under one licence is one credit, not two', () => {
    const a = track({ id: 1, licence: { name: 'CC BY', attributionRequired: true, attributionText: 'Music by K. Reed' } });
    const b = track({ id: 2, title: 'Fast Water', licence: { name: 'CC BY', attributionRequired: true, attributionText: 'Music by K. Reed' } });
    assert.deepStrictEqual(requiredCredits([a, b]), ['Music by K. Reed'],
        'a caption gathers a duplicate credit per clip, which is how a credit block gets deleted');
});

console.log('\nan organisation that publishes without credits');

check('is offered only the tracks that do not need one', () => {
    // ⚠️ Not a warning and not a checkbox. A track whose licence demands a credit is not theirs to
    // use on those terms, so it is not shown. Offering it and hoping is how the breach happens.
    const free = track({ id: 1 });
    const must = track({ id: 2, licence: { name: 'CC BY', attributionRequired: true } });
    assert.deepStrictEqual(offerableTo([free, must], { creditsEnabled: false }).map(t => t.id), [1]);
    assert.deepStrictEqual(offerableTo([free, must], { creditsEnabled: true }).map(t => t.id), [1, 2]);
});

console.log('\nreading a row');

check('a row with no url or no duration is not a track', () => {
    // ⚠️ null rather than a partial: a bed with no url renders silence, and one with no duration
    // cannot be drawn on the timeline. Both would reach the editor looking like a track and behaving
    // like a fault — which is the shape of every bug in this feature's history.
    assert.strictEqual(toTrack({ id: 1, url: '', durationS: 90 }), null, 'a track with no file is accepted');
    assert.strictEqual(toTrack({ id: 1, url: 'x', durationS: 0 }), null, 'a track with no length is accepted');
    assert.strictEqual(toTrack({ id: 0, url: 'x', durationS: 9 }), null, 'a track with no id is accepted');
    assert.strictEqual(toTrack(null), null);
});

check('an unrecorded licence is read as the STRICTER one', () => {
    // Crediting a track that did not need it costs a line of caption. Not crediting one that did is
    // a breach on the customer's account. The default has to fall on the safe side.
    const t = toTrack({ id: 1, url: 'https://r2/x.mp3', durationS: 30, title: 'X', artist: 'Y' });
    assert.ok(t, 'a usable row was rejected');
    assert.strictEqual(t!.licence.attributionRequired, true, 'an unknown licence is assumed permissive');
    assert.strictEqual(t!.licence.name, 'Unspecified');
});

check('snake_case and camelCase rows both read', () => {
    // The row arrives from drizzle as camelCase and from a raw db.execute as snake_case, and both
    // are used in this codebase.
    const a = toTrack({ id: 1, url: 'https://r2/x.mp3', duration_s: 30, title: 'X', artist: 'Y', is_active: false });
    assert.strictEqual(a?.durationS, 30, 'a raw SQL row loses its duration');
    assert.strictEqual(a?.isActive, false, 'a raw SQL row is always read as active');
});

check('tags are normalised, because a picker filters on them', () => {
    const t = toTrack({ id: 1, url: 'https://r2/x.mp3', durationS: 30, tags: ['  Calm ', 'AMBIENT', ''] });
    assert.deepStrictEqual(t?.tags, ['calm', 'ambient'], 'a stray capital or space makes a filter miss');
});

check('there is a stated ceiling on a bed\'s length', () => {
    assert.strictEqual(typeof MAX_TRACK_S, 'number');
    assert.ok(MAX_TRACK_S > 0);
});

console.log(`\n${passed} checks passed.\n`);
