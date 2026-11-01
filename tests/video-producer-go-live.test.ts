// tests/video-producer-go-live.test.ts
// The Video Producer's go-live copy (docs/video-producer-plan.md §7.5): help articles, website page,
// pricing row, FAQ, Mentor and Ask Your Team — every figure the copy states matching the code. The
// pricing row and FAQ went live 2026-10-31; the help articles stay unpublished until the role is Live.
//
// What goes wrong silently if these drift:
//   · copy quoting credits while the hold takes tasks (the Videos tab did, until 2026-10-31)
//   · the help articles published while the role is Hidden (Ask Your Team would describe an assistant
//     nobody can hire)
//   · the pricing row applied by a routine migrate pass before go-live
//   · an article naming a button that isn't on the page
// No network, no database.
//
// Run:  npx tsx tests/video-producer-go-live.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_WEIGHTS } from '../src/config/task-weights';
import { MAX_AI_CLIPS, MAX_SCENES, MIN_SCENES, VIDEO_LENGTHS } from '../src/lib/storyboard';
import { spacingDays, MAX_WAITING, MAX_PER_WEEK } from '../src/utils/video-autopilot';
import { ORDER_ACTION_SPECS } from '../src/config/campaign-vocab';
import { recommendHires } from '../src/utils/mentor-hire';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const HELP = read('db/help-articles-2026-12zzzzzzzzzzzzzz-video-producer.sql');
const bodies = [...HELP.matchAll(/\$\$([\s\S]*?)\$\$, (TRUE|FALSE)\)/g)];
const helpText = bodies.map(([, b]) => b).join('\n');

console.log('\n──── help articles ────');

check('three bodies, safe to paste into a web SQL editor', () => {
    assert.strictEqual(bodies.length, 3);
    for (const [, b] of bodies) {
        assert.ok(!b.includes(';'), 'a semicolon inside a body is where a web SQL editor cuts the file');
        assert.ok(!b.includes("''"), 'apostrophes inside $$ bodies are literal — never doubled');
    }
});

check('inserted unpublished, and a re-run never touches is_published', () => {
    for (const [, , published] of bodies) assert.strictEqual(published, 'FALSE');
    const onConflict = HELP.slice(HELP.indexOf('ON CONFLICT (title) DO UPDATE SET'), HELP.indexOf('COMMIT;'));
    assert.ok(onConflict.length > 0);
    assert.doesNotMatch(onConflict, /is_published/);
    assert.match(HELP, /-- UPDATE help_articles SET is_published = TRUE/, 'the publish statement is at the foot, commented out');
});

check('the figures match the code', () => {
    assert.match(helpText, new RegExp(`Each AI clip \\(at most ${MAX_AI_CLIPS} in a video\\) \\| ${TASK_WEIGHTS.ai_video} \\|`));
    assert.match(helpText, new RegExp(`Each AI picture \\| ${TASK_WEIGHTS.ai_image} \\|`));
    assert.match(helpText, new RegExp(`The voiceover \\| ${TASK_WEIGHTS.ai_voiceover} \\|`));
    assert.match(helpText, new RegExp(`${MIN_SCENES} to ${MAX_SCENES} scenes`));
    assert.match(helpText, new RegExp(VIDEO_LENGTHS.join(', ').replace(/, (\d+)$/, ' or $1') + ' seconds'));
    assert.deepStrictEqual([1, 2, 3].map(spacingDays), [7, 3, 2]);
    assert.match(helpText, /One a week waits a week between storyboards, two a week waits three days, three a week waits two days/);
    assert.strictEqual(MAX_WAITING, 2);
    assert.match(helpText, /while two of its storyboards are still waiting/);
    assert.strictEqual(MAX_PER_WEEK, 3);
    assert.strictEqual(ORDER_ACTION_SPECS.commission_video.workItemsPerUnit, 2);
    assert.match(helpText, /using 2 of the campaign's tasks/);
    assert.match(read('src/utils/video-producer.ts'), /STUCK_AFTER_MS = 20 \* 60 \* 1000/);
    assert.match(helpText, /longer than 20 minutes/);
});

check('every button and label it names is on the page', () => {
    const videos = read('src/components/assistant-videos.js');
    for (const s of ['New video', 'Plan this video', 'Plan it again', 'Make the video', 'Change', 'What should it say?', 'Post it as', 'Pictures from']) {
        assert.ok(videos.includes(s), `Videos tab has "${s}"`);
        assert.ok(helpText.includes(s), `article names "${s}"`);
    }
    for (const s of ['Planned by autopilot', 'From one of your posts', 'For a campaign']) assert.ok(videos.includes(s) && helpText.includes(s), s);
    const ws = read('workspace.html');
    for (const s of ['Make a video version', 'Show captions']) assert.ok(ws.includes(s) && helpText.includes(s), s);
    assert.ok(read('src/public/assistant-onboarding-schemas.js').includes('Should it plan videos for you each week?'));
    assert.ok(helpText.includes('Should it plan videos for you each week?'));
    assert.ok(read('src/config/goal-metrics.ts').includes("label: 'Videos Published'") && helpText.includes('Videos Published'));
    assert.ok(read('src/config/campaign-vocab.ts').includes("label: 'Commission a video'") && helpText.includes('Commission a video'));
});

check('it promises nothing §9 rules out', () => {
    assert.match(helpText, /doesn't watch footage you give it/);
    assert.match(helpText, /doesn't post to TikTok/);
    assert.doesNotMatch(helpText, /\b(the first|the only|unique|replaces)\b/i, 'no claim the competitor check would have to back');
    assert.doesNotMatch(helpText, /credit/i, 'costs are in tasks');
});

console.log('\n──── costs are shown in tasks ────');

check('the Videos tab shows the figure the hold takes, in the workspace\'s unit', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /export async function buildEstimate\(/);
    assert.match(vp, /\? \{ estimate: buildTasks\(storyboard, brief\), unit: 'tasks' \}/);
    assert.match(vp, /holdCredits\(db, \{ orgId, amount: credits, tasks: buildTasks\(storyboard, brief\)/, 'the hold takes buildTasks under task metering');
    assert.match(read('src/components/assistant-videos.js'), /const unit = v\.unit === 'credits' \? 'credit' : 'task';/);
});

check('no Video Producer surface quotes credits any more', () => {
    const schema = read('src/public/assistant-onboarding-schemas.js');
    const vpSchema = schema.slice(schema.indexOf('video_producer: ['), schema.indexOf('lead_qualifier: ['));
    assert.doesNotMatch(vpSchema, /credit/i);
    assert.match(vpSchema, new RegExp(`an AI clip ${TASK_WEIGHTS.ai_video}`));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    const route = chat.slice(chat.indexOf('    video_producer: {'), chat.indexOf('    website_assistant: {'));
    assert.match(route, /AI clips \(\$\{TASK_WEIGHTS\.ai_video\} each/);
    assert.doesNotMatch(route.replace(/\/\/.*$/gm, ''), /\bcredits?\b/i);
    assert.doesNotMatch(read('src/config/campaign-vocab.ts').match(/commission_video: \{[\s\S]*?\n    \},/)![0], /credit/i);
    assert.doesNotMatch(read('src/utils/team-messages.ts').match(/case 'commission_video':[\s\S]*?label: 'Open the video'/)![0], /credit/i);
});

console.log('\n──── held back until go-live ────');

check('the website page exists, and only renders for a Live role', () => {
    const show = JSON.parse(read('db/assistant-showcases.json'));
    assert.ok(show.video_producer, 'showcase entry');
    const text = JSON.stringify(show.video_producer);
    assert.match(text, new RegExp(`${TASK_WEIGHTS.ai_video} tasks for an AI clip`));
    assert.doesNotMatch(text, /credit/i);
    assert.ok(read('db/z-assistant-showcases.sql').includes("'video_producer'"), 'node scripts/build-showcase-sql.mjs');
    assert.match(read('netlify/functions/master-assistants.ts'), /\.where\(eq\(masterAssistants\.isActive, true\)\)/);
});

check('the pricing row (live 2026-10-31) is in the migrations and the seed, on the plans that make video', () => {
    assert.ok(!existsSync(join(root, 'db/_go-live-video-producer-plan-feature.sql')), 'renamed at go-live');
    const sql = read('db/z-video-producer-plan-feature.sql');
    assert.match(sql, /tier_key IN \('buster', 'employee'\)/);
    assert.match(read('src/utils/ai-credits.ts'), /VIDEO_TIERS = \['buster', 'employee'\]/);
    assert.match(sql, /AND NOT EXISTS \(SELECT 1 FROM plan_features WHERE key = 'video_producer'\)/, 'a re-run shifts nothing');
    const seed = read('db/seed-plan-features.ts');
    assert.match(seed, /key: 'video_producer'[\s\S]{0,400}values: \{ saver: DASH, buster: CHECK, employee: CHECK \}/);
    const faq = read('faq.html');
    assert.ok(faq.includes('What does the Video Producer make?') && faq.includes('Does making a video use my tasks?'));
    assert.match(faq, new RegExp(`${TASK_WEIGHTS.ai_video} tasks for an AI clip \\(at most ${MAX_AI_CLIPS} in a video\\)`));
});

check('the Mentor recommends it only when Live, on a plan with video, with someone posting', () => {
    const base = {
        team: [{ id: 1, name: 'Felix', role: 'Social', state: 'active', roleKey: 'social_media_manager' }],
        catalogue: [{ roleKey: 'video_producer', name: 'Video Producer', description: null, status: 'live' }],
        business: { website: null }, products: [], productCount: 0, offerKinds: [],
        plan: { status: 'active', freeSlots: 3, canMakeVideo: true },
    } as any;
    const pick = (d: any) => recommendHires(d).picks.find((p) => p.roleKey === 'video_producer');
    assert.ok(pick(base), 'Live + video plan + a Social Media Assistant');
    assert.ok(!pick({ ...base, plan: { ...base.plan, canMakeVideo: false } }), 'not on a plan without video');
    assert.ok(!pick({ ...base, catalogue: [{ ...base.catalogue[0], status: 'hidden' }] }), 'not while Hidden');
    assert.ok(!pick({ ...base, team: [{ id: 2, name: 'Mira', role: 'Blog', state: 'active', roleKey: 'blog_writer' }] }), 'not without someone posting');
});

check('Ask Your Team names it only when it is on the team', () => {
    const cmd = read('netlify/functions/assistant-command.ts');
    assert.match(cmd, /a video or Reel — the Video Producer, if one is in the list/);
    assert.match(cmd, /never name an assistant that is not in the list/);
});

check('its website page has its swan, and does not say "Included in every plan"', () => {
    const page = read('assistant.html');
    assert.match(page, /video_producer: \{ src: '\/images\/assistants\/video_producer\/swan\.jpg'/);
    assert.ok(existsSync(join(root, 'images/assistants/video_producer/swan.jpg')));
    const note = "PLAN_NOTES = { video_producer: 'On the Busywork Buster plan' }";
    assert.ok(page.includes(note), 'assistant.html');
    assert.ok(read('scripts/seo/ai-readability.mjs').includes(note), 'the crawler copy says the same');
    assert.match(read('src/utils/ai-credits.ts'), /VIDEO_TIERS = \['buster', 'employee'\]/);
});

check('its sample videos are real files, for made-up businesses, with a poster each', () => {
    const page = read('assistant.html');
    const block = page.slice(page.indexOf('const SAMPLE_VIDEOS = {'), page.indexOf('function render('));
    const files = [...block.matchAll(/(?:src|poster): '(\/videos\/samples\/video_producer\/[\w-]+\.(?:mp4|jpg))'/g)].map((m) => m[1]);
    assert.ok(files.length >= 4, 'at least two videos, each with a poster');
    for (const f of files) assert.ok(existsSync(join(root, f)), f);
    assert.doesNotMatch(block, /__\w+_META__/, 'every card has its real length and voice');
    assert.doesNotMatch(block, /Marmalade/, 'never the staging workspace the samples were made in');
});

console.log(`\n${passed} checks passed`);
