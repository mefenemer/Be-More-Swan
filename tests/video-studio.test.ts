// tests/video-studio.test.ts
// The Video Producer as a studio (docs/video-producer-studio-plan.md, Phases 1–2): a finished video is
// rendered to My Content, never made into a post; it has a shape, not platforms.
//
// Run:  npx tsx tests/video-studio.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { VIDEO_SHAPES, isVideoShape, shapeFrame, shapeOrientation, storyboardUserPrompt, type VideoBrief } from '../src/lib/storyboard';
import { readBrief, withSetupDefaults, buildTasks, stillToMake } from '../src/utils/video-producer';
import { outputName, containsAi } from '../src/utils/video-render';
import { judgeVideoProject } from '../src/utils/campaign-video-order';
import { videoFormatFor } from '../src/utils/video-post-media';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const vp = read('src/utils/video-producer.ts');
const build = vp.slice(vp.indexOf('export async function buildProject'), vp.indexOf('export const STUCK_AFTER_MS'));

check('the build saves a timeline and renders the project — no post, ever', () => {
    assert.ok(!build.includes('insert(scheduledPosts)'));
    assert.ok(build.includes("await save({ status: 'rendering', timeline"));
    assert.ok(build.includes('wakeRenderWorker(projectId)'));
    assert.ok(!build.includes('pending_approval'));
});

check('the render worker claims once, renders through the post resolvers, saves to My Content', () => {
    const r = read('src/utils/video-render.ts');
    assert.ok(r.includes("eq(videoProjects.status, 'rendering'), isNull(videoProjects.renderId)"), 'a duplicate wake starts nothing');
    assert.ok(r.includes('resolveEditClips(') && r.includes('resolveCaptionTrack(') && r.includes('resolveAudioTracks('));
    assert.ok(r.includes("status: 'ready', outputAssetId: asset.id"));
    assert.ok(r.includes("status: 'render_failed'"));
    assert.ok(!r.includes('scheduledPosts'), 'the post render path is untouched');
    assert.ok(read('netlify/functions/render-video-project-background.ts').includes('renderProject(getDb(), projectId)'));
});

check('a stuck render becomes render_failed (paid for, only the file is missing), not failed', () => {
    const sweep = vp.slice(vp.indexOf('export async function sweepStuckProjects'));
    assert.ok(sweep.indexOf("status: 'render_failed'") < sweep.indexOf("['reviewing', 'planning', 'building']"));
});

check('"Try the render again" re-renders the saved timeline, free', () => {
    const ep = read('netlify/functions/video-projects.ts');
    const rr = ep.slice(ep.indexOf("action === 'rerender'"), ep.indexOf("action === 'cancel'"));
    assert.ok(rr.includes("row.status !== 'render_failed'") && rr.includes('wakeRenderWorker(row.id'));
    assert.ok(!rr.includes('holdBuild'), 'no charge');
});

check('shapes: three, each with its frame and stock orientation', () => {
    assert.deepStrictEqual([...VIDEO_SHAPES], ['9:16', '1:1', '16:9']);
    assert.deepStrictEqual(shapeFrame('16:9'), { width: 1920, height: 1080 });
    assert.deepStrictEqual(shapeFrame('1:1'), { width: 1080, height: 1080 });
    assert.deepStrictEqual(shapeFrame(undefined), { width: 1080, height: 1920 });
    assert.strictEqual(shapeOrientation('1:1'), 'square');
    assert.ok(!isVideoShape('4:3'));
});

check('a brief has a shape (default vertical; setup can choose), never platforms', () => {
    const b = readBrief({ message: 'Our autumn menu is here' });
    assert.ok('brief' in b && b.brief.shape === '9:16');
    const w = readBrief({ message: 'Our autumn menu is here', shape: '16:9' });
    assert.ok('brief' in w && w.brief.shape === '16:9');
    assert.strictEqual(withSetupDefaults({}, { defaultShape: '1:1' }).shape, '1:1');
    assert.strictEqual(withSetupDefaults({ shape: '16:9' }, { defaultShape: '1:1' }).shape, '16:9');
});

check('every scene is made in the video\'s shape', () => {
    assert.ok(vp.includes('aspectRatio: shape, orgName'));
    assert.ok(vp.includes("generateAndPersistImage(db, { orgId, userId, prompt: scene.prompt || context, aspectRatio: shape })"));
    assert.ok(vp.includes('startImageUrl: frameUrl, aspectRatio: shape'));
    assert.ok(vp.includes('{ ...opts, orientation }'));
    assert.ok(build.includes('targetRatio: shape, ...frame') && build.includes('const frame = shapeFrame(shape)'));
    const brief: VideoBrief = { purpose: 'promo', lengthS: 30, message: 'x', voiceover: true, allowAi: 'stock_only', shape: '16:9' };
    assert.ok(/SHAPE: the video is wide \(16:9\)/.test(storyboardUserPrompt({ brief, businessName: 'B', businessFacts: '', library: [], today: '2026-11-09' })));
});

check('My Content name, version and "Contains AI"', () => {
    assert.strictEqual(outputName('Autumn menu', 1), 'Autumn menu');
    assert.strictEqual(outputName('Autumn menu', 2), 'Autumn menu (version 2)');
    assert.ok(containsAi({ title: '', caption: '', scenes: [{ id: 's1', beat: 'hook', voiceover: '', source: 'ai_video', targetS: 3 }] }));
    assert.ok(!containsAi({ title: '', caption: '', scenes: [{ id: 's1', beat: 'hook', voiceover: '', source: 'stock_video', targetS: 3 }] }));
});

check('a campaign video order is delivered when the video is ready', () => {
    const base = { storyboard: {}, creditsSpent: 0, scheduledPostId: null, note: null };
    assert.strictEqual(judgeVideoProject({ ...base, status: 'ready' }, []).kind, 'delivered');
    assert.strictEqual(judgeVideoProject({ ...base, status: 'rendering' }, []).kind, 'in_review');
    assert.strictEqual(judgeVideoProject({ ...base, status: 'render_failed' }, []).kind, 'in_review');
});

check('the Videos tab asks for a shape, plays the finished video and downloads it', () => {
    const t = read('src/components/assistant-videos.js');
    assert.ok(!t.includes('Post it as') && !t.includes('name="platforms"'));
    assert.ok(t.includes('name="shape"'));
    assert.ok(t.includes('content-asset-download?assetId='));
    assert.ok(t.includes("data-vid-act=\"rerender\""));
    assert.ok(t.includes("{ key: 'made', label: 'Ready', statuses: ['ready', 'built'] }"));
});

check('the chat is a studio too: shapes, My Content, never posts', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(o.includes('"shape": "9:16" | "1:1" | "16:9"'));
    assert.ok(!o.includes('"platforms": ["instagram", "youtube", "facebook"]'));
    assert.ok(o.includes('you never post, schedule or publish anything'));
    const card = read('src/components/disruptive-ui-registry.js');
    assert.ok(card.includes("shape: SHAPES[ui.shape] ? ui.shape : '9:16'"));
});

check('the SQL adds the studio columns and statuses; Drizzle mirrors them', () => {
    const sql = read('db/z-video-producer-studio.sql');
    for (const c of ['timeline', 'output_asset_id', 'version', 'parent_project_id', 'render_id']) assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${c}`), c);
    assert.ok(/'rendering', 'ready',\s*'render_failed'/.test(sql) && sql.includes("'archived'"));
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('outputAssetId: integer("output_asset_id")') && schema.includes('timeline: jsonb()'));
});

// ── Phase 3: versions ───────────────────────────────────────────────────────────────────────────

check('Change it makes a new version that keeps what was made; the finished one is never changed', () => {
    const nv = vp.slice(vp.indexOf('export async function newVersion'));
    assert.ok(nv.includes('version: (row.version ?? 1) + 1, parentProjectId: row.id'));
    assert.ok(nv.includes('sceneAssets: row.sceneAssets, voiceoverAssetId: row.voiceoverAssetId'));
    assert.ok(nv.includes("status: opts.status ?? 'planned'"));
    const ep = read('netlify/functions/video-projects.ts');
    assert.ok(ep.includes("if (action === 'change')") && ep.includes("row.status !== 'ready'"));
    assert.ok(ep.includes("(action === 'replan' || action === 'edit_scene' || action === 'rewrite_script' || action === 'set_options' || action === 'approve_script') && row.status === 'ready'") && ep.includes('row = await newVersion(db, row)'), 'chat replans and scene edits on a ready video make a version first');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes("['planned', 'failed', 'ready'].includes(project.status)"));
});

check('only what is still to be made is estimated and held', () => {
    const sb = { title: 'T', caption: '', scenes: [
        { id: 's1', beat: 'hook' as const, voiceover: 'a b c', source: 'ai_image' as const, targetS: 3 },
        { id: 's2', beat: 'cta' as const, voiceover: 'd e f', source: 'ai_image' as const, targetS: 3 },
    ] };
    const brief: VideoBrief = { purpose: 'promo', lengthS: 15, message: 'x', voiceover: true, allowAi: 'stock_and_ai' };
    const all = buildTasks(sb, brief);
    assert.strictEqual(buildTasks(sb, brief, { sceneAssets: { s1: 5 }, voiceoverAssetId: 9 }), all - 1 - 1, 'one picture and the voiceover are already made');
    assert.deepStrictEqual(stillToMake(sb, { sceneAssets: { s1: 5, s2: 6 } }).scenes, []);
    assert.ok(read('netlify/functions/video-projects.ts').includes('holdBuild(db, orgId, row.storyboard as Storyboard, row.brief as VideoBrief, row)'));
});

check('the Videos tab offers Change it and shows the version', () => {
    const t = read('src/components/assistant-videos.js');
    assert.ok(t.includes('data-vid-act="change"') && t.includes("call('POST', { action: 'change', id })"));
    assert.ok(t.includes('Version ${esc(v.version)}'));
});

// ── Phase 4: hand-offs ──────────────────────────────────────────────────────────────────────────

check('hand-offs go only to ACTIVE teammates, looked up by role', () => {
    const h = read('src/utils/video-handoff.ts');
    assert.ok(h.includes('export async function activeAssistantInRole') && h.includes('isWorking(r.lifecycleStatus, r.provisioningStatus)'));
    const ep = read('netlify/functions/video-projects.ts');
    assert.ok(ep.includes("activeAssistantInRole(db, orgId, 'social_media_manager')") && ep.includes("activeAssistantInRole(db, orgId, 'blog_writer')"));
    const t = read('src/components/assistant-videos.js');
    assert.ok(t.includes('${tm.social ? `<button type="button" data-vid-act="use-post"') && t.includes('${tm.blog ? `<button type="button" data-vid-act="use-blog"'));
});

check('"Use in a post" uses the Social Media Manager\'s own new-post flow, with video formats for the shape', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes('window.pceStartPostWithVideo = async function (assistantId, video)'));
    assert.ok(ws.includes('await pceOpenDestinationsForCreate(assistantId);'));
    assert.ok(ws.includes("f.a === 'live' && (f.m === 'video' || f.m === 'mixed')"));
    assert.ok(ws.includes('...(withVideo ? { caption: withVideo.caption, contentAssetIds: [withVideo.assetId] } : { blank: true })'), 'a real draft with the video, into the Review Queue');
    const close = ws.slice(ws.indexOf('function pceCloseDestinations()'));
    assert.ok(close.slice(0, 600).includes('_pceCreateWith = null;'), 'a cancelled hand-off never attaches its video to the next post');
});

check('"Use in a blog post" opens a new Blog Writer draft with the video in it', () => {
    const b = read('src/components/blog-studio-modal.js');
    assert.ok(b.includes('state.pendingVideo = opts.withVideo && opts.withVideo.assetId ? opts.withVideo : null;'));
    assert.ok(b.includes('if (video) attachInline({ assetId: Number(video.assetId) });'));
});

check('the chat has the same hand-off, as a card that opens the flow (never posts)', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('video_handover_proposal'"));
    const card = reg.slice(reg.indexOf('function renderVideoHandoverProposalCard'), reg.indexOf("register('video_handover_proposal'"));
    assert.ok(card.includes('window.pceStartPostWithVideo(') && card.includes('window.openBlogStudio(') && !card.includes('create-manual-post'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"type": "video_handover_proposal"'));
});

check('words-only scene edits keep the clip; a branded card or a new picture is made again', () => {
    const ep = read('netlify/functions/video-projects.ts');
    // The rule moved to video-producer.ts sceneLooks (shared with the script rewrite and notes).
    assert.ok(read('src/utils/video-producer.ts').includes("s.source === 'brand_card' ? (s.onScreenText ?? '') : ''"));
    assert.ok(ep.includes('const looks = sceneLooks;'));
    assert.ok(ep.includes('if (!after || looks(after) !== before) delete assets[scene.id];'));
});

check('a ready or rendering video has no "Plan it again" / "Cancel" row — it has Change it', () => {
    assert.ok(read('src/components/assistant-videos.js').includes("!['cancelled', 'built', 'planning', 'building', 'reviewing', 'rendering', 'ready'].includes(v.status)"));
});

// ── Phase 5: back to the post it was made for ───────────────────────────────────────────────────

check('a video format per platform and shape: Reel / Short for vertical, YouTube video for wide, none for Threads', () => {
    assert.strictEqual(videoFormatFor('instagram', '9:16')?.key, 'ig_reel');
    assert.strictEqual(videoFormatFor('youtube', '9:16')?.key, 'yt_short');
    assert.strictEqual(videoFormatFor('youtube', '16:9')?.key, 'yt_vod');
    assert.ok(videoFormatFor('linkedin', '1:1'));
    assert.ok(videoFormatFor('threads', '9:16') === null || videoFormatFor('threads', '9:16')!.media !== 'image');
});

check('the video goes onto its post only when that is safe, else a new draft beside it', () => {
    const m = read('src/utils/video-post-media.ts');
    const a = m.slice(m.indexOf('export async function attachVideoToSourcePost'), m.indexOf('export async function placeVideoOnCampaignPost'));
    assert.ok(a.includes('isMediaEditable(post.status) && fmt && !hasOverlays(post.imageOverlays)'), 'only an editable post on a video platform with no text on its picture');
    assert.ok(a.includes("status: 'pending_approval'") && a.includes("return 'new_draft'"), 'otherwise a draft beside it — nothing the owner made is replaced');
    assert.ok(!a.includes("status: 'scheduled'"));
    const c = m.slice(m.indexOf('export async function placeVideoOnCampaignPost'));
    assert.ok(c.includes('carriesOnlyItsOwnPick(db, id, t.auto)'), 'a campaign video never replaces a picture the user chose');
});

check('the render puts a finished video back where it was made for, and says so', () => {
    const r = read('src/utils/video-render.ts');
    assert.ok(r.indexOf('attachVideoToSourcePost(db,') < r.indexOf("status: 'ready', outputAssetId: asset.id"));
    assert.ok(r.includes('placeVideoOnCampaignPost(db,'));
    assert.ok(read('src/utils/video-handoff.ts').includes("shape: '9:16',"));
});

console.log(`\nvideo studio: ${passed} passed`);
