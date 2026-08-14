// tests/post-formats.test.ts
// The post-format catalogue reaches the editor through a GENERATED file:
//   1. src/config/post-formats.ts   — the server's, and the authority. approve-post refuses an
//      unschedulable format from here, so this one decides what can actually be queued.
//   2. src/generated/platform-constants.js — written by `npm run gen:constants`, read by
//      workspace.html as `_PCE_FORMATS = window.PlatformConstants.formats`.
//
// It used to be a hand-written inline mirror of ~30 records in workspace.html, and these tests
// existed to catch it drifting. It drifted anyway in a way no equality check caught: the mirror had
// no `minItems` at all, so the editor could not enforce a carousel's two-slide minimum. Generating
// it removes the whole class — what is left to assert is that the generated file is FRESH, and that
// what it carries still means the same thing on both sides.
//
// A drift is not cosmetic. If the picker calls a format available when the server does not, the user
// designs a whole post and is refused at the last step; if it calls one unavailable when the server
// would take it, a working format silently disappears from the product.
//
// Run:  npx tsx tests/post-formats.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { POST_FORMATS, formatSchedulable, formatBlockedReason, formatsForPlatform, defaultFormatFor, postFormatSpec } from '../src/config/post-formats';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const WORKSPACE = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');

// The records the browser actually receives, read out of the generated file. Parsed from source
// rather than executed: the point is to check what is WRITTEN there, with no chance of a stub
// filling anything in.
function clientFormats(): Array<{ k: string; p: string; a: string; min: number; max: number; why?: string }> {
    const js = readFileSync(new URL('../src/generated/platform-constants.js', import.meta.url), 'utf8');
    const start = js.indexOf('var POST_FORMATS = [');
    assert.ok(start > -1, 'POST_FORMATS missing from the generated constants — run: npm run gen:constants');
    const end = landmark(js, '\n  ];', start);
    return js.slice(start, end)
        .split('\n')
        .map(l => l.trim().replace(/,$/, ''))
        .filter(l => l.startsWith('{'))
        .map(l => JSON.parse(l));
}

check('workspace.html reads the generated list instead of carrying its own', () => {
    assert.ok(
        /const _PCE_FORMATS = window\.PlatformConstants\.formats;/.test(WORKSPACE),
        'the editor must read the generated formats',
    );
    assert.ok(
        !/const _PCE_FORMATS = \[/.test(WORKSPACE),
        'a hand-written _PCE_FORMATS has been reintroduced — that is the drift class this replaced',
    );
});

// The client says 'blocked' where the server says 'not_schedulable' — same meaning, shorter to type
// in a page that repeats it 7 times. Everything else is identical by name.
const AVAIL: Record<string, string> = { live: 'live', planned: 'planned', not_schedulable: 'blocked' };

check('every server format exists in the editor’s picker, and vice versa', () => {
    const server = POST_FORMATS.map(f => f.key).sort();
    const client = clientFormats().map(f => f.k).sort();
    assert.deepEqual(client, server, 'the two catalogues list different formats');
});

check('platform and availability agree for every format', () => {
    const byKey = new Map(clientFormats().map(f => [f.k, f]));
    for (const spec of POST_FORMATS) {
        const c = byKey.get(spec.key)!;
        assert.equal(c.p, spec.platform, `${spec.key}: platform drifted`);
        assert.equal(c.a, AVAIL[spec.availability], `${spec.key}: availability drifted — the picker would ${c.a === 'live' ? 'offer a format approval refuses' : 'hide a format that works'}`);
    }
});

check('item limits agree, so the picker cannot promise more slides than the format takes', () => {
    const byKey = new Map(clientFormats().map(f => [f.k, f]));
    for (const spec of POST_FORMATS) {
        assert.equal(byKey.get(spec.key)!.max, spec.maxItems, `${spec.key}: maxItems drifted`);
        // minItems was absent from the old hand-written mirror entirely, which is why the editor
        // could not tell anyone a carousel needs two slides until approval refused it.
        assert.equal(byKey.get(spec.key)!.min, spec.minItems, `${spec.key}: minItems drifted`);
    }
});

check('every unavailable format explains itself, on both sides', () => {
    for (const spec of POST_FORMATS.filter(f => f.availability !== 'live')) {
        assert.ok(spec.unavailableReason && spec.unavailableReason.length > 20,
            `${spec.key}: server reason missing or too terse to be useful`);
    }
    for (const c of clientFormats().filter(f => f.a !== 'live')) {
        assert.ok(c.why && c.why.length > 20, `${c.k}: picker gives no reason it is unavailable`);
    }
});

check('formatSchedulable gates on availability, and never blocks a legacy post', () => {
    // No format recorded = a draft from before the catalogue. Blocking those would strand every
    // existing post in the queue.
    assert.equal(formatSchedulable(null), true);
    assert.equal(formatSchedulable(undefined), true);
    // An unknown key is treated the same way: better to publish than to strand a post on a key some
    // future deploy wrote and this one doesn't know.
    assert.equal(formatSchedulable('some_future_format'), true);
    assert.equal(formatSchedulable('ig_feed'), true);
    // Carousels went live once multi-attachment publishing existed; Stories have not.
    assert.equal(formatSchedulable('ig_carousel'), true);
    assert.equal(formatSchedulable('ig_story'), false);
    assert.equal(formatSchedulable('x_space'), false);
});

check('formatBlockedReason is present exactly when scheduling is blocked', () => {
    for (const spec of POST_FORMATS) {
        const reason = formatBlockedReason(spec.key);
        if (spec.availability === 'live') assert.equal(reason, null, `${spec.key} is live but gives a block reason`);
        else assert.ok(reason, `${spec.key} is blocked but gives no reason`);
    }
    assert.equal(formatBlockedReason(null), null);
});

check('every platform has at least one live format to fall back to', () => {
    for (const p of ['instagram', 'facebook', 'threads', 'linkedin', 'x', 'youtube']) {
        const live = formatsForPlatform(p).filter(f => f.availability === 'live');
        assert.ok(live.length > 0, `${p} has no publishable format at all`);
        // The default must be one we can actually send, or every new post starts blocked.
        assert.equal(defaultFormatFor(p)!.availability, 'live', `${p}'s default format is not publishable`);
    }
});

check('format keys are unique and resolve', () => {
    const keys = POST_FORMATS.map(f => f.key);
    assert.equal(new Set(keys).size, keys.length, 'duplicate format key');
    for (const k of keys) assert.equal(postFormatSpec(k)!.key, k);
    assert.equal(postFormatSpec('nope'), null);
});

check('a mandatory-media format never declares itself media-free', () => {
    for (const spec of POST_FORMATS) {
        if (spec.mediaMandatory) {
            assert.notEqual(spec.media, 'none', `${spec.key} requires media but declares media 'none'`);
            assert.ok(spec.minItems >= 1, `${spec.key} requires media but allows zero items`);
        }
        assert.ok(spec.maxItems >= spec.minItems, `${spec.key}: maxItems below minItems`);
    }
});

console.log(`\n${passed}/10 passed`);
