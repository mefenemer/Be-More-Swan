// tests/site-draft-media.test.ts — placeholder pictures and videos on a first draft (owner,
// 2026-11-06): what is offered and what it costs, where media goes, that a failed lookup never fails
// the draft, and that an imported site has no path into any of it.
//
// Pexels, fal and the model are faked through DraftMediaDeps: nothing here touches a real one.
//
// Run:  npx tsx tests/site-draft-media.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { siteFromDraftReply, buildDraftPrompt, type DraftBrief } from '../src/utils/site-draft';
import {
    buildMediaPlanPrompt, cleanMediaPlan, DRAFT_MEDIA_CAPS, DRAFT_NOTE_ADDING_MEDIA, DRAFT_NOTE_MEDIA_STOPPED, DRAFT_NOTE_READY, draftMediaMaxTasks, draftMediaPromptLine,
    draftNoteIsFailure, mediaSlots, placeMedia, resolveDraftMedia, wantsDraftMedia, type DraftMediaChoice, type DraftMediaOptions, type MediaSlot,
} from '../src/utils/site-draft-media';
import { sourceDraftMedia, type DraftMediaDeps } from '../src/utils/site-draft-media-run';
import { DRAFT_VIDEO_SECONDS } from '../src/utils/site-draft-media-options';
import { markVideos } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { DEFAULT_TASK_COSTS, DEFAULT_TASK_WEIGHTS, aiVideoTasks } from '../src/config/task-weights';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
};

const site = (pages: unknown[], settings: Record<string, unknown> = {}): SiteDefinition => normaliseSiteDefinition({ settings: { siteName: 'Fern & Co', ...settings }, pages }).definition;
const hero = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'hero', props: { layout: 'centered', headline: `Headline ${id}`, ...extra } });
const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', props: { heading: `Heading ${id}`, body: 'Words.', ...extra } });
const FROM_SCRATCH = site([
    { id: 'home', slug: '', title: 'Home', sections: [hero('h1'), text('t1'), text('t2'), { id: 'f1', type: 'faq', props: { items: [{ q: 'Q?', a: 'A.' }] } }] },
    { id: 'about', slug: 'about', title: 'About', sections: [hero('h2'), text('t3')] },
    { id: 'privacy', slug: 'privacy', title: 'Privacy', sections: [text('p1')] },
]);

const options = (over: { imageAi?: boolean; videoAi?: boolean; images?: DraftMediaChoice['images'] | null; videos?: DraftMediaChoice['videos'] | null } = {}): DraftMediaOptions => ({
    images: { aiAllowed: over.imageAi ?? true, aiWhyNot: over.imageAi === false ? 'No AI images here.' : null, aiTasksEach: DEFAULT_TASK_WEIGHTS.ai_image, aiMax: DRAFT_MEDIA_CAPS.aiImages, stockMax: DRAFT_MEDIA_CAPS.stockImages },
    videos: { aiAllowed: over.videoAi ?? true, aiWhyNot: over.videoAi === false ? 'AI video is on the higher plans.' : null, aiTasksEach: 20, aiMax: DRAFT_MEDIA_CAPS.aiVideos, stockMax: DRAFT_MEDIA_CAPS.stockVideos },
    answers: { images: over.images ?? null, videos: over.videos ?? null },
});

/** Everything works unless a test says otherwise; records what was asked for. */
function fakeDeps(slots: MediaSlot[], over: Partial<DraftMediaDeps> = {}) {
    let next = 100;
    const calls = { stockImage: 0, stockVideo: 0, aiImage: 0, startVideo: 0, excluded: [] as string[][] };
    const deps: DraftMediaDeps = {
        expired: () => false,
        plan: async () => slots.map((s) => ({ sectionId: s.sectionId, query: `q ${s.sectionId}`, scene: `scene ${s.sectionId}`, alt: `alt ${s.sectionId}` })),
        stock: async (kind, _q, exclude) => {
            calls[kind === 'video' ? 'stockVideo' : 'stockImage']++;
            calls.excluded.push([...exclude]);
            next++;
            return { assetId: next, providerAssetId: `px${next}` };
        },
        aiImage: async () => { calls.aiImage++; return { assetId: ++next }; },
        startVideo: async () => { calls.startVideo++; return { jobId: 7 }; },
        waitForVideo: async () => ({ assetId: 999 }),
        ...over,
    };
    return { deps, calls };
}

(async () => {
    await check('costs come from the live weights, and are a true ceiling', () => {
        assert.strictEqual(draftMediaMaxTasks({ images: 'stock', videos: 'stock' }, options()), 0, 'stock is free');
        assert.strictEqual(draftMediaMaxTasks({ images: 'none', videos: 'none' }, options()), 0);
        assert.strictEqual(draftMediaMaxTasks({ images: 'ai', videos: 'ai' }, options()), DEFAULT_TASK_WEIGHTS.ai_image * DRAFT_MEDIA_CAPS.aiImages + 20);
        const run = read('src/utils/site-draft-media-options.ts');
        assert.ok(run.includes('aiVideoTasks(billedSecondsFor(DRAFT_VIDEO_SECONDS), costs)'), 'the video price is the price the hold uses, at the live costs');
        assert.ok(aiVideoTasks(DRAFT_VIDEO_SECONDS, DEFAULT_TASK_COSTS) > 0);
        const line = draftMediaPromptLine(options());
        assert.match(line, /stock is free/);
        assert.match(line, /1 task each, 4 at most/);
        assert.match(line, /20 tasks for one clip/);
        assert.match(draftMediaPromptLine(options({ videoAi: false })), /AI video: not available \(AI video is on the higher plans\.\)/);
    });

    await check('the choice: card or button first, then their set-up answer, then nothing', () => {
        assert.deepStrictEqual(resolveDraftMedia(undefined, options()), { choice: { images: 'none', videos: 'none' } });
        assert.deepStrictEqual(resolveDraftMedia(undefined, options({ images: 'stock', videos: 'ai' })), { choice: { images: 'stock', videos: 'ai' } });
        assert.deepStrictEqual(resolveDraftMedia({ images: 'none' }, options({ images: 'stock', videos: 'stock' })), { choice: { images: 'none', videos: 'stock' } });
        assert.deepStrictEqual(resolveDraftMedia({ images: 'nonsense' }, options()), { choice: { images: 'none', videos: 'none' } }, 'unknown values count for nothing');
    });

    await check('AI the workspace cannot have is refused when asked for, and an old answer falls back quietly', () => {
        assert.deepStrictEqual(resolveDraftMedia({ videos: 'ai' }, options({ videoAi: false })), { error: 'AI video is on the higher plans.' });
        assert.deepStrictEqual(resolveDraftMedia({ images: 'ai' }, options({ imageAi: false })), { error: 'No AI images here.' });
        assert.deepStrictEqual(resolveDraftMedia(undefined, options({ videoAi: false, videos: 'ai', images: 'stock' })), { choice: { images: 'stock', videos: 'none' } });
    });

    await check('slots: hero and text sections, home first, every page reached before any second helping, no legal pages', () => {
        assert.deepStrictEqual(mediaSlots(FROM_SCRATCH).map((s) => s.sectionId), ['h1', 'h2', 't1', 't3', 't2']);
    });

    await check('slots: the owner\'s own library picture is never replaced', () => {
        const d = site([{ id: 'home', slug: '', title: 'Home', sections: [hero('h1', { image: { assetId: 5, alt: 'Mine' } }), text('t1')] }]);
        assert.deepStrictEqual(mediaSlots(d).map((s) => s.sectionId), ['t1']);
    });

    await check('slots: a template keeps its layout — only sample pictures are swapped, none added', () => {
        const d = site([{ id: 'home', slug: '', title: 'Home', sections: [hero('h1', { layout: 'cover', image: { url: 'https://images.pexels.com/photos/1/a.jpeg', alt: 'Sample' } }), text('t1'), text('t2', { image: { assetId: 9, alt: 'Mine' } })] }], { template: 'willow' });
        assert.deepStrictEqual(mediaSlots(d, { onlyReplace: true }).map((s) => s.sectionId), ['h1']);
    });

    await check('the plan: the model\'s where usable, a plain one where not, so a bad reply never empties the site', () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const brief = { name: 'Fern & Co', industry: 'Florist', description: null, request: null };
        const plan = cleanMediaPlan({ media: [{ sectionId: 'h1', query: 'florist at work', scene: 'A florist at a bench.', alt: 'A florist' }, { sectionId: 'not-ours', query: 'x', scene: 'x', alt: 'x' }] }, slots, brief);
        assert.strictEqual(plan.length, slots.length, 'one per slot, and nothing for a section that isn\'t there');
        assert.strictEqual(plan[0].query, 'florist at work');
        assert.strictEqual(plan[1].query, 'Florist', 'missed by the model');
        for (const bad of [null, 'nope', { media: 'x' }]) assert.strictEqual(cleanMediaPlan(bad, slots, brief).length, slots.length);
        assert.ok(plan[1].alt, 'a picture is never left without a description, or the gate drops it');
        assert.match(buildMediaPlanPrompt(brief, slots).user, /No words, signs, logos/);
    });

    await check('stock: each section gets a different one, and nothing spends tasks', async () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const { deps, calls } = fakeDeps(slots);
        const r = await sourceDraftMedia({ images: 'stock', videos: 'none' }, slots, deps);
        assert.strictEqual(r.placements.length, slots.length);
        assert.strictEqual(r.note, null);
        assert.strictEqual(calls.aiImage + calls.startVideo, 0);
        assert.deepStrictEqual(calls.excluded.at(-1), ['px101', 'px102', 'px103', 'px104'], 'photos already used are skipped');
    });

    await check('a stock video goes at the top of the home page; pictures fill the rest', async () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const { deps, calls } = fakeDeps(slots);
        const r = await sourceDraftMedia({ images: 'stock', videos: 'stock' }, slots, deps);
        assert.strictEqual(calls.stockVideo, DRAFT_MEDIA_CAPS.stockVideos);
        assert.strictEqual(r.placements[0].sectionId, 'h1');
        assert.strictEqual(r.placements.length, slots.length);
    });

    await check('AI: never more than the stated cap', async () => {
        const many: MediaSlot[] = Array.from({ length: 12 }, (_, i) => ({ pageId: 'home', sectionId: `s${i}`, type: 'text', page: 'Home', about: '' }));
        const { deps, calls } = fakeDeps(many);
        const r = await sourceDraftMedia({ images: 'ai', videos: 'ai' }, many, deps);
        assert.strictEqual(calls.aiImage, DRAFT_MEDIA_CAPS.aiImages);
        assert.strictEqual(calls.startVideo, DRAFT_MEDIA_CAPS.aiVideos);
        assert.strictEqual(r.placements.length, DRAFT_MEDIA_CAPS.aiImages + DRAFT_MEDIA_CAPS.aiVideos);
    });

    await check('a lookup that throws, an empty search and a dead planner all leave a draft and a note', async () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const empty = fakeDeps(slots, { stock: async () => null });
        const a = await sourceDraftMedia({ images: 'stock', videos: 'none' }, slots, empty.deps);
        assert.strictEqual(a.placements.length, 0);
        assert.match(a.note!, /^Your draft is ready\. 5 pictures couldn't be found or made/);

        const thrown = fakeDeps(slots, { stock: async () => { throw new Error('Pexels 429'); } });
        const b = await sourceDraftMedia({ images: 'stock', videos: 'stock' }, slots, thrown.deps);
        assert.strictEqual(b.placements.length, 0, 'never throws');
        assert.ok(b.note && !draftNoteIsFailure(b.note), 'and the draft still counts as done');

        const planless = fakeDeps(slots, { plan: async () => { throw new Error('model down'); } });
        const c = await sourceDraftMedia({ images: 'stock', videos: 'none' }, slots, planless.deps);
        assert.deepStrictEqual(c, { placements: [], note: null });
    });

    await check('out of tasks: AI spots are skipped and said, never charged, and not called a failure', async () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const { deps } = fakeDeps(slots, { aiImage: async () => 'no_tasks', startVideo: async () => 'no_tasks' });
        const r = await sourceDraftMedia({ images: 'ai', videos: 'ai' }, slots, deps);
        assert.strictEqual(r.placements.length, 0);
        assert.match(r.note!, /Your tasks ran out/);
        assert.doesNotMatch(r.note!, /couldn't be found/);
    });

    await check('a failed AI video leaves its section to a picture', async () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const { deps } = fakeDeps(slots, { waitForVideo: async () => null });
        const r = await sourceDraftMedia({ images: 'stock', videos: 'ai' }, slots, deps);
        assert.ok(r.placements.some((p) => p.sectionId === 'h1' && p.assetId !== 999));
        assert.strictEqual(r.note, null, 'nothing is missing: the section has a picture');
    });

    await check('a slow AI video: the draft stops waiting, says so and leaves the clip for their library', async () => {
        const slots = mediaSlots(FROM_SCRATCH);
        const { deps } = fakeDeps(slots, { waitForVideo: async () => 'late' });
        const r = await sourceDraftMedia({ images: 'none', videos: 'ai' }, slots, deps);
        assert.deepStrictEqual(r.placements, []);
        assert.match(r.note!, /still being made/);
    });

    await check('placing: through the gate, on the sections still there, heroes as cover unless side by side', () => {
        const d = site([{ id: 'home', slug: '', title: 'Home', sections: [hero('h1'), hero('h2', { layout: 'split' }), text('t1'), text('t2')] }]);
        const out = placeMedia(d, [
            { sectionId: 'h1', assetId: 1, alt: 'One' }, { sectionId: 'h2', assetId: 2, alt: 'Two' }, { sectionId: 't1', assetId: 3, alt: 'Three' }, { sectionId: 't2', assetId: 4, alt: 'Four' },
            { sectionId: 'deleted-meanwhile', assetId: 5, alt: 'Gone' },
        ]);
        const by = Object.fromEntries(out.pages[0].sections.map((s) => [s.id, s.props as unknown as { layout?: string; image?: { assetId: number; alt: string }; imageSide?: string }]));
        assert.strictEqual(by.h1.layout, 'cover');
        assert.strictEqual(by.h1.image?.assetId, 1);
        assert.strictEqual(by.h2.layout, 'split');
        assert.deepStrictEqual([by.t1.imageSide, by.t2.imageSide], ['right', 'left']);
    });

    await check('a placed draft really renders: a video behind the headline, pictures beside the words', () => {
        const d = site([{ id: 'home', slug: '', title: 'Home', sections: [hero('h1'), text('t1')] }]);
        const placed = placeMedia(d, [{ sectionId: 'h1', assetId: 1, alt: 'A florist at work' }, { sectionId: 't1', assetId: 2, alt: 'A bouquet' }]);
        const { definition } = markVideos(placed, new Set([1]));   // what verifySiteAssets does on save
        const html = renderSitePage(definition, '/', { origin: 'https://x.invalid', preview: true, reportUrl: '#', creditUrl: null, pagePath: (p: string) => p, assetUrl: (id: number) => `https://x.invalid/a/${id}` } as never).html;
        assert.match(html, /<section class="hero cover"[^>]*><video class="bg" src="https:\/\/x\.invalid\/a\/1"/);
        assert.match(html, /<img[^>]*src="https:\/\/x\.invalid\/a\/2"[^>]*alt="A bouquet"|<img[^>]*alt="A bouquet"[^>]*src="https:\/\/x\.invalid\/a\/2"/);
    });

    await check('the worker\'s media code stays out of what reads a site', () => {
        for (const f of ['src/utils/site-store.ts', 'netlify/functions/sites.ts']) assert.doesNotMatch(read(f), /^import .*site-draft-media-run/m, f);
        assert.ok(read('src/utils/site-store.ts').includes("await import('./site-draft-media-run')"));
    });

    await check('notes: "ready" and "adding" are not failures, a real failure still is', () => {
        assert.strictEqual(draftNoteIsFailure(null), false);
        assert.strictEqual(draftNoteIsFailure(DRAFT_NOTE_ADDING_MEDIA), false);
        assert.strictEqual(draftNoteIsFailure(DRAFT_NOTE_MEDIA_STOPPED), false);
        assert.strictEqual(draftNoteIsFailure(`${DRAFT_NOTE_READY} 1 picture couldn't be found.`), false);
        assert.strictEqual(draftNoteIsFailure('The draft couldn\'t be completed this time — your site is unchanged and nothing was charged. Try again in a few minutes.'), true);
        assert.match(read('src/utils/role-activity.ts'), /else if \(draftNoteIsFailure\(site\.draftNote\)\)/, 'the activity list doesn\'t call a ready draft unfinished');
        assert.match(read('src/components/assistant-site-editor.js'), /site\.draftNoteIsFailure !== false/);
    });

    await check('the writer is told pictures come afterwards, only when they do, and still can\'t place one', () => {
        const brief = { business: { name: 'x', industry: null, description: null, audience: null, websiteUrl: null, email: null }, productsBlock: null, rulesBlock: null, goal: null, pagesWanted: null, style: null, request: null, maxPages: 5 } as DraftBrief;
        assert.doesNotMatch(buildDraftPrompt(brief).user, /Pictures and videos are added/);
        assert.match(buildDraftPrompt({ ...brief, mediaWanted: true }).user, /Pictures and videos are added/);
        assert.ok(siteFromDraftReply({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Hi' } }] }] }, FROM_SCRATCH, 5));
    });

    await check('an imported site has no way in: the import worker and its trigger carry no media', () => {
        const worker = read('netlify/functions/draft-site-background.ts');
        assert.ok(worker.includes('if (isImport) await runSiteImport(getDb(), siteId);'), 'import runs with the site id alone');
        assert.ok(worker.includes('else await runSiteDraft(getDb(), siteId, request, media);'));
        const importStore = read('src/utils/site-import-store.ts');
        assert.doesNotMatch(importStore, /site-draft-media|sourceDraftMedia|placeMedia/);
        const api = read('netlify/functions/sites.ts');
        const importAction = api.slice(api.indexOf("if (action === 'import') {"), api.indexOf("if (action === 'import_accept')"));
        assert.ok(importAction.includes('startSiteImport(') && !importAction.includes('media'), 'the import action sends no media');
        assert.ok(importStore.includes('triggerSiteDraft(site.id, null, { import: true })'), 'nor does its worker\'s trigger');
    });

    await check('words are saved before media, media re-reads the site, and only the library reaches it', () => {
        const store = read('src/utils/site-store.ts');
        const run = store.slice(store.indexOf('export async function runSiteDraft('), store.indexOf('// ── Publishing (step 3a'));
        const save = run.indexOf('DRAFT_NOTE_ADDING_MEDIA');
        const charge = run.indexOf("recordCompletedWork(db, site.organisationId, 'site_draft'");
        const media = run.indexOf('addMediaToDraft(db, site, {');
        assert.ok(save > -1 && save < charge && charge < media, 'saved, charged the 1 task, then media');
        const add = store.slice(store.indexOf('async function addMediaToDraft('), store.indexOf('export async function runSiteDraft('));
        assert.ok(add.includes('definitionOf(now, ctx.maxPages)'), 'placed on the site as it is now');
        assert.ok(add.includes('verifySiteAssets(db, site.organisationId, placed)'), 'library assets only');
        assert.ok(add.includes('endDraft(db, site.id, DRAFT_NOTE_MEDIA_STOPPED)'), 'a crash here still ends the draft');
        const run2 = read('src/utils/site-draft-media-run.ts');
        assert.ok(run2.includes('holdCredits(db, { orgId, amount: IMAGE_CREDIT_COST })') && run2.includes('settleHold('), 'AI images go through the existing metering');
        assert.ok(run2.includes('startAiVideoJob(db,'), 'AI video through the one video path');
        assert.ok(run2.includes('createPexelsAsset(db,'), 'stock through the library');
    });

    await check('the media stage fits inside the claim, and inside the worker\'s ceiling', () => {
        const store = read('src/utils/site-store.ts');
        const run = read('src/utils/site-draft-media-run.ts');
        assert.ok(/DRAFT_MEDIA_BUDGET_MS = 8 \* 60 \* 1000/.test(run), '8 minutes, under the 10-minute claim it renews');
        assert.ok(/DRAFT_TIMEOUT_MS = 10 \* 60 \* 1000/.test(store));
        assert.ok(store.includes('Math.min(Date.now() + DRAFT_MEDIA_BUDGET_MS, ctx.startedAt + WORKER_CEILING_MS)'));
    });

    await check('GUI, chat and set-up questions all reach the same action', () => {
        const editor = read('src/components/assistant-site-editor.js');
        assert.ok(editor.includes("action: 'draft', assistantId: state.assistantId, request: form.querySelector('[data-site-draft-request]').value, media }"));
        assert.ok(read('src/components/chat-session.js').includes("action: 'draft', assistantId, request: d.request || '', media: d.media"));
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("site:draftOptions") && reg.includes('data-sd-images') && reg.includes('data-sd-videos'));
        const schema = read('src/public/assistant-onboarding-schemas.js');
        assert.ok(schema.includes("key: 'sitePictures'") && schema.includes("key: 'siteVideos'"));
        const store = read('src/utils/site-store.ts');
        assert.ok(store.includes("pictures: 'sitePictures', videos: 'siteVideos'"));
        assert.ok(read('src/utils/site-draft-media-options.ts').includes('ctx.sitePictures') && read('src/utils/site-draft-media-options.ts').includes('ctx.siteVideos'), 'the same keys are read');
    });

    await check('the chat prompt asks, quotes only the snapshot\'s costs, and keeps imports out', () => {
        const chat = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(chat.includes('put what they chose in "images" and "videos"'));
        assert.ok(chat.includes('quote costs ONLY from the "Placeholder pictures and videos" line'));
        assert.ok(chat.includes('For a new site NOT brought over, ask what placeholder pictures and videos they want'));
        assert.ok(chat.includes('An imported site keeps its own pictures and never gets placeholders.'));
        assert.ok(read('src/utils/site-store.ts').includes('await draftMediaLine(db, orgId, assistantId),'), 'the line is in the snapshot');
    });

    await check('wantsDraftMedia: only when something was chosen', () => {
        assert.strictEqual(wantsDraftMedia({ images: 'none', videos: 'none' }), false);
        assert.strictEqual(wantsDraftMedia({ images: 'none', videos: 'stock' }), true);
        assert.strictEqual(wantsDraftMedia(null), false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
})();
