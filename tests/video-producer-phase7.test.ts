// tests/video-producer-phase7.test.ts
// The Video Producer, Phase 7 (docs/video-producer-plan.md): autopilot, "Make a video version" on a
// post, and the Campaign Assistant's `commission_video` order.
//
// What is pinned, and how each would fail silently:
//   · Autopilot spends nothing: it only starts storyboards (startProject), never a build — making the
//     video stays the owner's click. Off unless the owner chose a number; never stacks up storyboards.
//   · Autopilot never invents a business from its name: no products and no description → no video.
//   · A hand-off goes only to an ACTIVE Video Producer, once per post.
//   · A campaign order never spends either: approving a plan is not "Make the video".
//   · The order's artefact kind is allowed by the database (the widened check) and every map that
//     names an assignee knows the Video Producer (a missing one shows a raw role key).
//   · Every way a video starts goes through ONE function, so the setup defaults apply to all of them.
// No network, no database.
//
// Run:  npx tsx tests/video-producer-phase7.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autopilotDue, autopilotPerWeek, pickAutopilotTopic, spacingDays, MAX_WAITING } from '../src/utils/video-autopilot';
import { briefFromPost, isWorking } from '../src/utils/video-handoff';
import { judgeVideoProject, videoBriefForOrder } from '../src/utils/campaign-video-order';
import { CAMPAIGN_ORDER_ACTIONS, ORDER_ACTION_SPECS } from '../src/config/campaign-vocab';
import { ORCHESTRATABLE_ROLE_KEYS, VIDEO_PRODUCER_ROLE_KEY } from '../src/constants/roles';
import { ORDER_ROLE_LABELS, normalisePlanOrders } from '../src/utils/campaign-plan';
import { POST_ACTIONS, postActionFromUiElement } from '../src/utils/chat-post-action';
import { readBrief, withSetupDefaults } from '../src/utils/video-producer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-04T05:30:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

console.log('\n──── autopilot ────');

check('off unless the owner chose 1–3 a week; anything else is off, never a guess', () => {
    assert.strictEqual(autopilotPerWeek({}), 0);
    assert.strictEqual(autopilotPerWeek({ autopilotPerWeek: '0' }), 0);
    assert.strictEqual(autopilotPerWeek({ autopilotPerWeek: 'lots' }), 0);
    assert.strictEqual(autopilotPerWeek({ autopilotPerWeek: '2' }), 2);
    assert.strictEqual(autopilotPerWeek({ autopilotPerWeek: '9' }), 3);
    assert.strictEqual(autopilotPerWeek(null), 0);
});

check('it spreads the week and keeps to the count', () => {
    assert.deepStrictEqual([1, 2, 3].map(spacingDays), [7, 3, 2]);
    assert.strictEqual(autopilotDue({ perWeek: 1, recent: [], waiting: 0, now }), true, 'first one is due at once');
    assert.strictEqual(autopilotDue({ perWeek: 1, recent: [ago(6)], waiting: 0, now }), false);
    // A daily cron a few minutes late must not slip a weekly video to day 8.
    assert.strictEqual(autopilotDue({ perWeek: 1, recent: [new Date(ago(7).getTime() + 10 * 60 * 1000)], waiting: 0, now }), true);
    assert.strictEqual(autopilotDue({ perWeek: 2, recent: [ago(2)], waiting: 0, now }), false);
    assert.strictEqual(autopilotDue({ perWeek: 2, recent: [ago(3)], waiting: 0, now }), true);
    assert.strictEqual(autopilotDue({ perWeek: 3, recent: [ago(2), ago(4), ago(6)], waiting: 0, now }), false, 'three this week already');
    assert.strictEqual(autopilotDue({ perWeek: 0, recent: [], waiting: 0, now }), false);
});

check('it never stacks up storyboards nobody has looked at', () => {
    assert.strictEqual(autopilotDue({ perWeek: 3, recent: [ago(10)], waiting: MAX_WAITING, now }), false);
    assert.strictEqual(autopilotDue({ perWeek: 3, recent: [ago(10)], waiting: MAX_WAITING - 1, now }), true);
});

check('topics rotate through the owner\'s own products, least recently featured first', () => {
    const products = [
        { kind: 'product', name: 'Oat Latte', benefits: 'Creamy and dairy-free' },
        { kind: 'service', name: 'Barista Training', description: 'Two-hour class' },
    ];
    const first = pickAutopilotTopic({ products, recentMessages: [], businessName: 'Bean', businessDescription: null })!;
    assert.match(first.message, /Oat Latte/);
    assert.match(first.message, /Creamy and dairy-free/);
    const second = pickAutopilotTopic({ products, recentMessages: [first.message], businessName: 'Bean', businessDescription: null })!;
    assert.match(second.message, /Barista Training/, 'the one featured last waits its turn');
    assert.match(second.message, /our service/);
    // Both featured: the one featured longest ago (later in a newest-first list) comes next.
    const third = pickAutopilotTopic({ products, recentMessages: ['Spotlight Barista Training', 'Spotlight Oat Latte'], businessName: 'Bean', businessDescription: null })!;
    assert.match(third.message, /Oat Latte/);
});

check('with nothing real to say, there is no video — never one invented from the name', () => {
    assert.strictEqual(pickAutopilotTopic({ products: [], recentMessages: [], businessName: 'DMV Vital Roots', businessDescription: null }), null);
    assert.strictEqual(pickAutopilotTopic({ products: [], recentMessages: [], businessName: 'X', businessDescription: 'Coaching.' }), null);
    const tip = pickAutopilotTopic({ products: [], recentMessages: [], businessName: 'X', businessDescription: 'Emotional-state coaching for busy founders, online and in person.' })!;
    assert.strictEqual(tip.purpose, 'tip');
    assert.match(tip.message, /Emotional-state coaching/);
});

check('autopilot only ever plans — no build, no hold, no spend — and skips paused assistants and plans without video', () => {
    const src = read('src/utils/video-autopilot.ts');
    assert.ok(!/buildProject|holdBuild|holdCredits|action: 'build'/.test(src), 'autopilot must never make a video');
    assert.match(src, /origin: 'autopilot'/);
    assert.match(src, /isWorking\(a\.lifecycleStatus, a\.provisioningStatus\)/);
    assert.match(src, /tierCanGenerateVideo\(/);
    assert.match(src, /orgHasAssistantFeature\(db, a\.organisationId, 'ai_video_generation'\)/);
    assert.match(src, /hasCapacity\(a\.organisationId\)/);
    assert.match(read('netlify.toml'), /\[functions\.video-autopilot\]\n  schedule = "30 5 \* \* \*"/);
});

check('the setup question exists, defaults to off, and its key is the one the autopilot reads', () => {
    const schemas = read('src/public/assistant-onboarding-schemas.js');
    const vp = schemas.slice(schemas.indexOf('video_producer: ['), schemas.indexOf('lead_qualifier: ['));
    assert.ok(vp.includes("key: 'autopilotPerWeek'"));
    for (const v of ["value: '0'", "value: '1'", "value: '2'", "value: '3'"]) assert.ok(vp.includes(v), v);
    assert.match(vp, /key: 'autopilotPerWeek',[\s\S]{0,200}required: false/, 'unanswered = off');
});

console.log('\n──── one way in ────');

check('every way a video starts goes through startProject (setup defaults apply to all)', () => {
    const endpoint = read('netlify/functions/video-projects.ts');
    assert.ok(!endpoint.includes('db.insert(videoProjects)'), 'the endpoint must not insert projects itself');
    assert.match(endpoint, /startProject\(db, \{[\s\S]*origin: 'user'/);
    for (const f of ['src/utils/video-autopilot.ts', 'src/utils/video-handoff.ts', 'src/utils/campaign-video-order.ts']) {
        assert.match(read(f), /startProject\(db, \{/, f);
    }
    const parsed = readBrief(withSetupDefaults({ message: 'A spotlight on our oat latte' }, { defaultLength: '15', defaultCta: 'Pop in today' }));
    assert.ok(!('error' in parsed));
    if (!('error' in parsed)) { assert.strictEqual(parsed.brief.lengthS, 15); assert.strictEqual(parsed.brief.cta, 'Pop in today'); }
});

console.log('\n──── "Make a video version" ────');

check('a post becomes a brief in its own words, on its own platform when that takes video', () => {
    const ig = briefFromPost({ caption: 'Our autumn menu is here — pumpkin spice is back!', platform: 'instagram' })!;
    assert.match(String(ig.message), /pumpkin spice is back/);
    assert.deepStrictEqual(ig.platforms, ['instagram']);
    assert.deepStrictEqual(briefFromPost({ caption: 'Hiring a new barista this month', platform: 'linkedin' })!.platforms, ['instagram'],
        'LinkedIn takes no vertical video here — the Videos tab default');
    assert.deepStrictEqual(briefFromPost({ caption: 'Hiring a new barista this month', platform: 'youtube' })!.platforms, ['youtube']);
    assert.strictEqual(briefFromPost({ caption: 'Hi', platform: 'instagram' }), null);
    assert.strictEqual(briefFromPost({ caption: null, platform: 'instagram' }), null);
});

check('only a working, unpaused Video Producer gets the work', () => {
    assert.strictEqual(isWorking('working', 'active'), true);
    assert.strictEqual(isWorking('paused', 'active'), false);
    assert.strictEqual(isWorking('working', 'paused_quota'), false);
    assert.strictEqual(isWorking('working', 'paused_payment'), false);
    assert.strictEqual(isWorking('provisioning', null), false);
    assert.strictEqual(isWorking('archived', null), false);
});

check('one live video per post, held by the database; a post that IS a video is refused', () => {
    const sql = read('db/z-video-producer-phase7.sql');
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS video_projects_source_post_uniq[\s\S]*WHERE source_post_id IS NOT NULL AND status <> 'cancelled'/);
    const h = read('src/utils/video-handoff.ts');
    assert.match(h, /eq\(videoProjects\.scheduledPostId, post\.id\)/);
    assert.match(h, /origin: 'handoff', sourcePostId: post\.id/);
});

check('the chat can propose it (same server action), and only ever as a card', () => {
    assert.ok((POST_ACTIONS as readonly string[]).includes('video_version'));
    assert.deepStrictEqual(postActionFromUiElement({ type: 'post_action_proposal', action: 'video_version', postId: '#12' })?.postId, 12);
    assert.match(read('src/components/chat-session.js'), /d\.action === 'video_version'[\s\S]{0,300}postActionCall\('video-projects', \{ action: 'from_post', postId: d\.postId \}\)/);
    assert.match(read('src/components/disruptive-ui-registry.js'), /video_version: \{ head: 'Make a video version'/);
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /"shorter" \| "longer" \| "video_version",/);
    assert.match(read('src/utils/chat-post-action.ts'), /activeVideoProducer\(db, organisationId\)/, 'no card for a Video Producer that is not there');
});

check('the Review Queue button asks first, and never shows on a post that is already a video', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes('id="post-review-video"'));
    assert.match(ws, /_rqMediaIsVideo\(post\)/);
    assert.match(ws, /video-projects\?producer=1/);
    assert.match(ws, /action: 'from_post', postId/);
    assert.match(read('netlify/functions/video-projects.ts'), /queryStringParameters\?\.producer[\s\S]{0,300}tierCanGenerateVideo/);
});

console.log('\n──── commission_video ────');

check('the order is admissible: one Video Producer project per order, priced, orchestratable', () => {
    assert.ok((CAMPAIGN_ORDER_ACTIONS as readonly string[]).includes('commission_video'));
    const spec = ORDER_ACTION_SPECS.commission_video;
    assert.strictEqual(spec.roleKey, VIDEO_PRODUCER_ROLE_KEY);
    assert.strictEqual(spec.artefactKind, 'video_project');
    assert.strictEqual(spec.takesQuantity, false);
    assert.strictEqual(spec.maxQuantity, 1);
    assert.ok(ORCHESTRATABLE_ROLE_KEYS.includes(VIDEO_PRODUCER_ROLE_KEY));
});

check('every map that names an assignee knows the Video Producer', () => {
    assert.strictEqual(ORDER_ROLE_LABELS.video_producer, 'Video Producer');
    for (const f of ['src/utils/campaign-mirror.ts', 'src/components/disruptive-ui-registry.js', 'src/components/team-feed.js']) {
        assert.match(read(f), /video_producer: 'Video Producer'/, f);
    }
    assert.match(read('src/utils/campaign-work-state.ts'), /video_project: \{ tab: 'videos'/);
    assert.match(read('src/utils/team-messages.ts'), /commission_video: \{ tab: 'videos'/);
    assert.ok(read('src/generated/platform-constants.js').includes('"key":"commission_video"'), 'npm run gen:constants');
});

check('the database allows its artefact — the widened list is a superset of the last one', () => {
    const prior = read('db/z-campaign-visuals.sql').match(/artefact_kind IN \(([\s\S]*?)\)\)/)![1].replace(/\s/g, '').split(',');
    const sql = read('db/z-video-producer-phase7.sql');
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
    const next = sql.match(/artefact_kind IN \(([\s\S]*?)\)\)/)![1].replace(/\s/g, '').split(',');
    for (const k of prior) assert.ok(next.includes(k), `${k} was dropped — existing orders would fail the re-added check`);
    assert.ok(next.includes("'video_project'"));
    assert.ok(read('db/schema.ts').includes(",'visual_brief','video_project')`)"));
});

check('a plan carries what the video says; the length survives as a number from a model', () => {
    const [o] = normalisePlanOrders([{ action: 'commission_video', assignedRole: 'video_producer', videoMessage: 'Our autumn menu, in 30 seconds', cta: 'Book a table', videoLength: 30 }] as unknown[]) as any;
    assert.ok(o, 'the order survives normalising');
    assert.strictEqual(o.brief.videoMessage, 'Our autumn menu, in 30 seconds');
    assert.strictEqual(o.brief.cta, 'Book a table');
    assert.strictEqual(o.brief.videoLength, '30');
    const b = videoBriefForOrder(o.brief, { objective: 'More autumn bookings', tone: 'warm' });
    assert.match(String(b.message), /^Our autumn menu, in 30 seconds Tone: warm\./);
    assert.strictEqual(b.cta, 'Book a table');
    assert.strictEqual(b.lengthS, 30);
    // Without words of its own, the campaign's objective is the message.
    assert.match(String(videoBriefForOrder({}, { objective: 'More autumn bookings', tone: null }).message), /^More autumn bookings$/);
});

check('placing the order never spends: it starts a storyboard and nothing else', () => {
    const order = read('src/utils/campaign-video-order.ts');
    assert.ok(!/buildProject|holdBuild|holdCredits/.test(order));
    assert.match(order, /origin: 'campaign', campaignId: ctx\.campaignId, campaignOrderId: orderId/);
    assert.ok(!/campaign-reconciler|campaign-orders/.test(order.split('\n').filter((l) => l.startsWith('import')).join('\n')), 'no import cycle');
    assert.match(read('src/utils/campaign-reconciler.ts'), /order\.action === 'commission_video'\s*\? await judgeVideoOrder\(db, order\)/);
});

check('the judge: delivered only once the finished video is approved; refunded only when nothing was made', () => {
    const p = (status: string, extra: Partial<{ storyboard: unknown; creditsSpent: number; scheduledPostId: number | null }> = {}) =>
        ({ status, storyboard: { scenes: [] }, creditsSpent: 0, scheduledPostId: null, note: null, ...extra });
    assert.deepStrictEqual(judgeVideoProject(p('planning'), []), { kind: 'pending' });
    assert.strictEqual(judgeVideoProject(p('planned'), []).kind, 'in_review');
    assert.strictEqual(judgeVideoProject(p('building'), []).kind, 'in_review');
    assert.strictEqual(judgeVideoProject(p('failed'), []).kind, 'in_review', 'a part-way stop can be made again');
    assert.strictEqual(judgeVideoProject(p('failed', { storyboard: null }), []).kind, 'failed');
    assert.strictEqual(judgeVideoProject(p('cancelled'), []).kind, 'failed', 'nothing made — refunded');
    assert.strictEqual(judgeVideoProject(p('cancelled', { creditsSpent: 3 }), []).kind, 'rejected');
    assert.strictEqual(judgeVideoProject(p('built', { scheduledPostId: 9 }), ['pending_approval']).kind, 'in_review');
    assert.strictEqual(judgeVideoProject(p('built', { scheduledPostId: 9 }), ['pending_approval', 'scheduled']).kind, 'delivered');
    assert.strictEqual(judgeVideoProject(p('built', { scheduledPostId: 9 }), ['rejected', 'cancelled']).kind, 'rejected');
    assert.strictEqual(judgeVideoProject(null, []).kind, 'rejected');
});

check('the Campaign Assistant is told it is free to plan and a click to make, and the chat may name it', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.match(chat, /- Video Producer \("commission_video"\)/);
    assert.match(chat, /\| "commission_visuals" \| "commission_video",/);
    assert.match(chat, /\| "brand_designer" \| "video_producer" \| "human",/);
    assert.match(chat, /AUTOPILOT\. \$\{perWeek > 0/);
});

console.log(`\n${passed} checks passed`);
