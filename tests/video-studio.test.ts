// tests/video-studio.test.ts
// The Video Producer as a studio (docs/video-producer-studio-plan.md, Phases 1–2): a finished video is
// rendered to My Content, never made into a post; it has a shape, not platforms.
//
// Run:  npx tsx tests/video-studio.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { VIDEO_SHAPES, isVideoShape, shapeFrame, shapeOrientation, storyboardUserPrompt, type VideoBrief } from '../src/lib/storyboard';
import { readBrief, withSetupDefaults } from '../src/utils/video-producer';
import { outputName, containsAi } from '../src/utils/video-render';
import { judgeVideoProject } from '../src/utils/campaign-video-order';

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
    assert.ok(build.includes('targetRatio: shape, ...shapeFrame(shape)'));
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

console.log(`\nvideo studio: ${passed} passed`);
