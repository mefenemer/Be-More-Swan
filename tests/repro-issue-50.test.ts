// tests/repro-issue-50.test.ts
// Issue #50: "Footage review: image boxes not loading". After the footage review chose the sections of the
// owner's own video, the storyboard's scene boxes stayed empty (Edge on Windows). Each box is a <video> of
// the whole upload (17.5 MB). While a project is reviewing / planning / building / rendering, the Videos
// tab re-reads the project every 5 s (assistant-videos.js POLL_MS) and redraws; projectView re-signed every
// scene URL on every read, so each redraw handed every box a NEW url and the browser started loading the
// big file again from scratch, never getting as far as a picture. The finished video was already signed
// with a stable window; the scene thumbnails now are too, so a re-read gives the same address.
import assert from 'node:assert';

process.env.R2_ACCOUNT_ID ||= 'test-account';
process.env.R2_ACCESS_KEY_ID ||= 'test-key';
process.env.R2_SECRET_ACCESS_KEY ||= 'test-secret';
process.env.R2_BUCKET_NAME ||= 'test-bucket';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/** Every select resolves to the one stored footage asset (the only query projectView makes for this row). */
function fakeDb() {
    const rows = [{ id: 2660, storageKey: 'org/38/footage/first-step.mp4', externalUrl: null }];
    const chain: any = {
        from: () => chain, where: () => chain, limit: () => chain, orderBy: () => chain,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
    };
    return { select: () => chain, execute: async () => [] } as any;
}

const row = {
    id: 1, aiAssistantId: 5, title: 'First step', status: 'reviewing', brief: {}, storyboard: null, changes: null, note: null,
    scheduledPostId: null, creditsSpent: 0, voiceoverAssetId: null, origin: null, sourcePostId: null, campaignId: null,
    footageReview: null, outputAssetId: null, version: 1, parentProjectId: null, momentNotes: null, timeline: null,
    editCount: 0, archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
    sceneAssets: { s2: 2660, s3: 2660, s4: 2660, s5: 2660 },
} as any;

(async () => {
    const { projectView } = await import('../src/utils/video-producer');
    await check('a re-read 2 s later gives every scene box the SAME address (no reload from scratch)', async () => {
        const a = await projectView(fakeDb(), 38, row);
        await new Promise((r) => setTimeout(r, 2100));
        const b = await projectView(fakeDb(), 38, row);
        assert.ok(a.sceneThumbs.s2 && /X-Amz-Signature=/.test(a.sceneThumbs.s2), 'a signed URL');
        assert.strictEqual(b.sceneThumbs.s2, a.sceneThumbs.s2, 'the scene URL changed between two reads of the same project');
        assert.strictEqual(b.sceneThumbs.s5, a.sceneThumbs.s5);
    });
    console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}.`);
})();
