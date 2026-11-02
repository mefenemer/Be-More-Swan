// tests/redraft-upcoming.test.ts
// "Redraft upcoming posts" (src/utils/redraft-upcoming.ts). Love Cat Studio changed their pillars on
// 2026-11-02 and every post to 23 November had already been drafted with the old ones, so "What I post
// about" looked broken. The rule that decides what may be redrafted is pinned here — the dangerous
// direction is redrafting something a person approved, wrote or asked for — plus the wiring on every
// surface (profile, set-up answer cards, Social chat) and the pillar fragment warning.
//
// Run:  npx tsx tests/redraft-upcoming.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { MIN_LEAD_HOURS, TOPIC_SETUP_KEYS, pickRedraftSlots } from '../src/utils/redraft-upcoming';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pillars = require('../src/public/content-pillars.js');

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(p, 'utf8');

const now = new Date('2026-11-02T15:00:00Z');
const day = (d: number, h = 9) => new Date(Date.UTC(2026, 10, d, h));
const row = (id: number, over: Partial<Parameters<typeof pickRedraftSlots>[0][number]> = {}) => ({
    id, status: 'pending_approval', publishDate: day(10), crosspostGroupId: null, jobId: `job-${id}`,
    isRevised: false, campaign: null, triggerType: 'scheduled', claimedIdea: false, ...over,
});

check('a scheduled AI draft nobody has touched is redrafted, the whole cross-post together', () => {
    const { slots } = pickRedraftSlots([row(1, { crosspostGroupId: 'g1' }), row(2, { crosspostGroupId: 'g1' })], now);
    assert.strictEqual(slots.length, 1);
    assert.deepStrictEqual(slots[0].postIds.sort(), [1, 2]);
});

check('a slot with ANY approved or scheduled copy is kept whole', () => {
    const { slots, kept } = pickRedraftSlots([row(1, { crosspostGroupId: 'g1' }), row(2, { crosspostGroupId: 'g1', status: 'scheduled' })], now);
    assert.strictEqual(slots.length, 0);
    assert.strictEqual(kept.approved, 1);
});

check(`a slot going out within ${MIN_LEAD_HOURS} hours is kept`, () => {
    const { slots, kept } = pickRedraftSlots([row(1, { publishDate: new Date(now.getTime() + 60 * 60 * 1000) })], now);
    assert.strictEqual(slots.length, 0);
    assert.strictEqual(kept.soon, 1);
});

check('hand-written, asked-for, revised and campaign posts are never redrafted', () => {
    const { slots, kept } = pickRedraftSlots([
        row(1, { jobId: null }),                 // written by hand
        row(2, { claimedIdea: true }),            // drafted from a queued idea
        row(3, { isRevised: true }),              // a revision answering the owner's feedback
        row(4, { campaign: 'Spring' }),           // a campaign's post
        row(5, { triggerType: 'on_demand' }),     // asked for in chat or Create a Post
    ], now);
    assert.strictEqual(slots.length, 0);
    assert.strictEqual(kept.handWritten, 5);
});

check('slots come back in date order', () => {
    const { slots } = pickRedraftSlots([row(1, { publishDate: day(20) }), row(2, { publishDate: day(5) })], now);
    assert.deepStrictEqual(slots.map((s) => s.postIds[0]), [2, 1]);
});

check('the apply only cancels posts STILL waiting, refuses past the allowance, and refills with gap-fill', () => {
    const src = read('src/utils/redraft-upcoming.ts');
    assert.match(src, /eq\(scheduledPosts\.status, 'pending_approval'\)\)\)\s*\.returning/);
    assert.match(src, /usage\.remaining < tasks/);
    assert.ok(src.indexOf('usage.remaining < tasks') < src.indexOf('.set({ status: \'cancelled\''), 'the allowance is checked before anything is cancelled');
    assert.match(src, /await enqueueScheduleGapFill\(db, \{/);
});

check('the topic keys match on server and browser', () => {
    const js = read('src/components/redraft-upcoming.js');
    const m = js.match(/const TOPIC_KEYS = \[([^\]]*)\]/);
    assert.ok(m);
    assert.deepStrictEqual(m![1].split(',').map((x) => x.trim().replace(/'/g, '')), [...TOPIC_SETUP_KEYS]);
});

check('offered on every surface: profile save, set-up answer cards, and the Social chat card', () => {
    assert.match(read('assistants.js'), /if \(topicChanged\) window\.offerRedraftUpcoming\?\.\(parseInt\(assistantId\)\);/);
    assert.match(read('src/components/redraft-upcoming.js'), /addEventListener\('assistant:settingsChanged'/);
    for (const page of ['workspace.html', 'assistant-chat.html']) {
        assert.ok(read(page).includes('<script src="/src/components/redraft-upcoming.js"></script>'), `${page} doesn't load the offer`);
    }
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('redraft_upcoming_proposal'"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /\{ "type": "redraft_upcoming_proposal", "summary":/);
    assert.match(orch, /type === 'redraft_upcoming_proposal'\) \{\s*uiElement = route === ROUTES\.social_media_manager/);
});

check('a pillar that is the tail of another is warned about', () => {
    const w: string[] = pillars.pillarWarnings(['A little time to pause: workshops on Syros', 'with behind the scenes', 'connect with nature']);
    assert.ok(w.some((x) => x.includes('"with behind the scenes" looks like the end of the pillar before it')));
    assert.deepStrictEqual(pillars.pillarWarnings(['crafts', 'nature walks', 'calm mind']), []);
});

console.log(`\n${passed}/${total} passed`);
