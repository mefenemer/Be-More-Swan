// tests/prod-review-fixes-2026-10-27.test.ts
// Four prod reports from one review session on an iPad, 2026-10-27. No network or DB.
// Run:  npx tsx tests/prod-review-fixes-2026-10-27.test.ts
//
//  1. "Pick the time myself" on a post that was already scheduled → "Post is already in 'scheduled'
//     state and cannot be approved." A scheduled post that has not gone out can still be moved.
//  2. Font colour / background transparency would not change on a text box.
//  3. Dragging a text box on a touchscreen scrolled the picture with it.
//  4. The compliance check flagged our own AI-disclosure footer as an undeclared third-party product.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isAboutDisclosureFooter, readCachedReview, hashCaption, type QualityReview } from '../src/utils/post-quality-review';
import { withoutDisclosureLines } from '../src/utils/platform-caption';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const root = path.join(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

console.log('\n1. Rescheduling a scheduled post');
const approve = read('netlify/functions/approve-post.ts');
check('a scheduled post is not refused outright', () => {
    assert.match(approve, /const alreadyScheduled = post\.status === 'scheduled';/);
    assert.match(approve, /!\['draft', 'in_review', 'pending_approval'\]\.includes\(post\.status\) && !alreadyScheduled/);
});
check('a plain re-approve of a scheduled post is a no-op, never a re-pick of its slot', () => {
    const i = approve.indexOf('if (alreadyScheduled && action === \'approve\')');
    assert.ok(i > 0);
    assert.ok(i < approve.indexOf('pickOptimalSlot(db, assistant, post, now)'));
});
check('the update cannot drag a post back out of publishing', () => {
    assert.match(approve, /eq\(scheduledPosts\.status, post\.status\)\)\)\s*\.returning\(\);\s*if \(!updated\)/);
});
check('"Schedule it" ignores a second tap while the first is approving', () => {
    const ws = read('workspace.html');
    const fn = ws.slice(ws.indexOf('async function rqReviewScheduleMyself()'));
    assert.ok(fn.slice(0, 600).includes('if (_rqCommitBusyDepth > 0) return;'));
});

console.log('\n2–3. Text box controls and touch drag');
const ioe = read('src/components/image-overlay-editor.js');
check('colour pickers apply their value on change, not only on input', () => {
    assert.match(ioe, /col\.addEventListener\('change', \(e\) => \{ apply\(e\); committed\(\); \}\)/);
    assert.match(ioe, /fill\.addEventListener\('change', \(e\) => \{ apply\(e\); committed\(\); \}\)/);
});
check('the transparency slider is never disabled', () => {
    assert.ok(!/data-f="transparency"[^>]*disabled/.test(ioe));
    assert.ok(ioe.includes('.ioe-swatchoff{opacity:.35}'), 'an off swatch must still take taps');
});
check('a text box claims touch for itself, so a drag is not a scroll', () => {
    const fn = ioe.slice(ioe.indexOf('function attachPositionDrag'));
    assert.ok(fn.slice(0, 900).includes("node.style.touchAction = 'none';"));
});

console.log('\n4. The AI-disclosure footer is not a compliance finding');
const footer = "Composed with athena, our Be More Swan AI Digital Assistant. What's yours called 😉?";
check('the reviewer is shown the caption without the footer', () => {
    assert.strictEqual(withoutDisclosureLines(`Spring is here 🌷\n\n${footer}`), 'Spring is here 🌷');
    assert.strictEqual(withoutDisclosureLines('No footer here.'), 'No footer here.');
});
check('a stored warning about the footer is dropped on read; others are kept', () => {
    const caption = `Spring is here\n\n${footer}`;
    const w = `The caption states the post was "Composed with athena, our Be More Swan AI Digital Assistant" — this implies a named third-party AI product.`;
    const other = 'The price of £40 is not among the declared facts.';
    const review = { brandVoiceScore: 80, complianceWarnings: [w, other], suggestions: [], captionHash: hashCaption(caption) } as unknown as QualityReview;
    assert.ok(isAboutDisclosureFooter(w));
    assert.ok(!isAboutDisclosureFooter(other));
    assert.deepStrictEqual(readCachedReview(review, caption)!.complianceWarnings, [other]);
});
check('a stored warning that PARAPHRASES the footer is dropped too (staging, 2026-10-31)', () => {
    const w = "Rule 16 flags content 'not relevant to our business' on X. The Felix / Be More Swan AI assistant mention is unrelated to the film business and may trigger this rule.";
    assert.ok(isAboutDisclosureFooter(w));
    assert.ok(!isAboutDisclosureFooter('Rule 16 flags content not relevant to our business: the post is about cooking classes.'));
    assert.ok(!isAboutDisclosureFooter('The claim "award-winning" has no source.'));
});

console.log(`\n${passed} passed, 0 failed\n`);
