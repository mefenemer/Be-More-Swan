// tests/chat-my-content.test.ts
// The Video Producer, Brand Designer, Blog Writer and Social Media pages have a "My Content" tab, and
// their chats see what is in it (src/utils/chat-my-content.ts) — owner, 2026-11-10: "both the user
// and the assistant can find their media content". Also pins the Video Producer's tabs: no Review
// Queue (a studio never posts), My Content opening on its videos.
//
// Run:  npx tsx tests/chat-my-content.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MY_CONTENT_ROLES, buildMyContentBlock, describeAsset, madeBy } from '../src/utils/chat-my-content';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

function fakeDb(rows: Array<Record<string, unknown>>, fail = false) {
    return {
        select: (cols: Record<string, unknown>) => {
            if (fail) throw new Error('db down');
            const out = 'n' in cols ? [{ n: rows.length }] : rows;
            const chain: any = {
                from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(out),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(out).then(res, rej),
            };
            return chain;
        },
    } as any;
}

/** The role whose registry entry holds each occurrence of `marker`. */
function ownersOf(reg: string, marker: string): string[] {
    const roles: string[] = [];
    let at = reg.indexOf(marker);
    while (at > -1) {
        const keys = [...reg.slice(0, at).matchAll(/^ {4}([a-z0-9_]+): \{/gm)];
        roles.push(keys[keys.length - 1][1]);
        at = reg.indexOf(marker, at + 1);
    }
    return roles.sort();
}

async function main() {
    const reg = read('src/components/assistant-dashboard-registry.js');
    const video = reg.slice(reg.indexOf('    video_producer: {'), reg.indexOf('    website_assistant: {'));

    console.log('\nTabs');
    await check('the chat roles are exactly the roles with a My Content tab', () => {
        assert.deepStrictEqual(ownersOf(reg, '      myContentTab: {'), Object.keys(MY_CONTENT_ROLES).sort());
    });
    await check('the Video Producer has no Review Queue tab, and My Content opens on videos', () => {
        assert.match(video, /hideReviewQueue: true/);
        assert.doesNotMatch(video, /reviewQueue: \{/);
        assert.match(video, /myContentTab: \{ label: 'My Content', type: 'video' \}/);
        assert.match(read('assistants.js'), /mcHost\.dataset\.type = \(myContent && myContent\.type\) \|\| ''/);
        assert.match(read('my-content.js'), /hasOwnProperty\.call\(MEDIA_TYPES, param\.type\)\) _filterType = param\.type/);
    });
    await check('the Video Producer chat names My Content, not a Review Queue tab', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        const fn = o.slice(o.indexOf('function videoProducerSurfaces'), o.indexOf('function websiteAssistantSurfaces'));
        assert.ok(fn.includes('"My Content" tab') && !fn.includes('"Review Queue" tab'), fn);
        assert.ok(o.includes('platformsBlock, libraryBlock, myContentBlock,'), 'the block must reach the prompt');
    });
    await check('a Video Producer video counts as made by an assistant in My Content', () => {
        assert.match(read('my-content.js'), /asset\.provider === 'video_producer'\) return 'generated'/);
    });

    console.log('\nThe block');
    await check('lists files with kind, shape, length and maker', async () => {
        const db = fakeDb([
            { id: 284, name: 'Studio tour  v2', assetType: 'video', provider: 'video_producer', width: 1080, height: 1080, durationS: 14.9, createdAt: new Date('2026-11-09T10:00:00Z') },
        ]);
        const b = (await buildMyContentBlock(db, { userId: 1, roleKey: 'video_producer' }))!;
        assert.ok(b.includes('1 video file,') && b.includes('- #284 "Studio tour v2" — video, square, 15 s, made by the Video Producer, 2026-11-09'), b);
        assert.ok(b.includes('"My Content" tab') && b.includes('Never claim a file exists that is not listed'), b);
    });
    await check('flyers and cards read as what they are', () => {
        assert.ok(describeAsset({ id: 1, name: 'Open day', assetType: 'document', provider: 'flyer', width: null, height: null, durationS: null, createdAt: '2026-11-01' }).includes('flyer, a printed flyer'));
        assert.strictEqual(madeBy(null), 'their upload');
        assert.strictEqual(madeBy('pexels'), 'stock, found by an assistant');
    });
    await check('empty, other roles and a failed read', async () => {
        assert.ok((await buildMyContentBlock(fakeDb([]), { userId: 1, roleKey: 'brand_designer' }))!.includes('0 picture, card and flyer files.'));
        assert.strictEqual(await buildMyContentBlock(fakeDb([]), { userId: 1, roleKey: 'newsletter_editor' }), null);
        assert.strictEqual(await buildMyContentBlock(fakeDb([], true), { userId: 1, roleKey: 'blog_writer' }), null);
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
