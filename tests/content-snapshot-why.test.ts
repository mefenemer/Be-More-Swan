// tests/content-snapshot-why.test.ts
// "Why did my post fail?" must be answerable from the chat's own post, article and email lists.
//
// WHY THIS EXISTS. The content snapshots listed a failed post as "failed to publish" and nothing
// more, so the chat could see THAT it failed but not why — and the prompt forbids guessing. The
// Posts tab's Needs attention card shows a diagnosis, approve-post stops on open compliance
// warnings, and emails store their own failure reason; none of it reached the chat. These checks pin
// the "↳" lines that carry it, and that they use the same words as the card.
//
// No database: the pure note builders plus the renderer.
// Run:  npx tsx tests/content-snapshot-why.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blogNotes, emailNotes, postNotes, renderContentSnapshot } from '../src/utils/content-snapshot';
import { diagnosePostFailure } from '../src/utils/post-failure-diagnosis';
import { hashCaption } from '../src/utils/post-quality-review';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTION = 'Our autumn menu starts Monday — the cheapest lunch in town.';
const review = (warnings: string[], dispositions: Record<string, unknown> = {}, caption = CAPTION) => ({
    brandVoiceScore: 80, complianceWarnings: warnings, suggestions: [], cachedAt: '2026-10-22T09:00:00Z',
    captionHash: hashCaption(caption), dispositions,
});

console.log('\nPosts');

check('a failed post carries the same diagnosis the Needs attention card shows', () => {
    const reason = { httpStatus: 400, errorCode: 190, errorMessage: 'Error validating access token', isRetryable: false };
    const notes = postNotes({ platform: 'instagram', status: 'failed', caption: CAPTION, failureReason: reason });
    const d = diagnosePostFailure(reason, 'Instagram');
    assert.equal(d.kind, 'connection');
    assert.equal(notes.length, 1, notes.join('\n'));
    assert.ok(notes[0].includes(d.title) && notes[0].includes(d.remedy), notes[0]);
    assert.ok(!notes[0].includes('Error validating access token'), 'a classified failure needs no raw platform text');
});

check('an unclassified failure quotes the platform, and a missing one says nothing was recorded', () => {
    const odd = postNotes({ platform: 'instagram', status: 'failed', caption: CAPTION, failureReason: { errorMessage: 'Something nobody has seen before' } });
    assert.ok(odd[0].includes('said: "Something nobody has seen before"'), odd[0]);
    const none = postNotes({ platform: 'instagram', status: 'failed', caption: CAPTION, failureReason: null });
    assert.ok(none[0].includes('no reason was recorded'), none[0]);
});

check('a reconnect pause adds nothing; an X-allowance pause with a reason explains it', () => {
    assert.deepEqual(postNotes({ platform: 'instagram', status: 'paused', caption: CAPTION, failureReason: null }), []);
    const x = postNotes({ platform: 'twitter', status: 'paused_credits', caption: CAPTION, failureReason: { httpStatus: 429, errorMessage: 'Too Many Requests' } });
    assert.equal(x.length, 1);
    assert.ok(x[0].startsWith('Why it stopped:'), x[0]);
});

check('open compliance warnings are listed; settled ones are not', () => {
    const notes = postNotes({
        platform: 'instagram', status: 'pending_approval', caption: CAPTION,
        qualityReview: review(['"cheapest lunch in town" is an unverifiable price claim', 'Mentions a date'], { 'Mentions a date': { kind: 'not_applicable' } }),
    });
    assert.equal(notes.length, 1, notes.join('\n'));
    assert.ok(notes[0].startsWith('1 open compliance warning:'), notes[0]);
    assert.ok(notes[0].includes('unverifiable price claim') && !notes[0].includes('Mentions a date'), notes[0]);
});

check('warnings computed on an older caption are ignored, as approve-post ignores them', () => {
    const notes = postNotes({ platform: 'instagram', status: 'pending_approval', caption: CAPTION, qualityReview: review(['Old warning'], {}, 'an earlier caption') });
    assert.deepEqual(notes, []);
});

check('a long warning list is capped and counted', () => {
    const notes = postNotes({ platform: 'instagram', status: 'in_review', caption: CAPTION, qualityReview: review(['a', 'b', 'c', 'd', 'e']) });
    assert.ok(notes[0].startsWith('5 open compliance warnings:') && notes[0].includes('and 2 more'), notes[0]);
});

check('a deleted picture is flagged', () => {
    const notes = postNotes({ platform: 'instagram', status: 'scheduled', caption: CAPTION, mediaMissing: true, mediaMissingNote: 'autumn-menu.jpg' });
    assert.ok(notes.some((n) => n.includes('deleted from My Content') && n.includes('autumn-menu.jpg')), notes.join('\n'));
});

console.log('\nArticles and emails');

check('a failed article is honest about having no recorded reason, except an empty body', () => {
    assert.deepEqual(blogNotes({ status: 'scheduled', hasBody: true }), []);
    assert.ok(blogNotes({ status: 'failed', hasBody: true })[0].startsWith('No reason was recorded'));
    assert.ok(blogNotes({ status: 'failed', hasBody: false })[0].includes('no body text'));
});

check('a failed email carries its stored reason, or admits there is none', () => {
    assert.deepEqual(emailNotes({ status: 'sent', failureReason: null }), []);
    assert.equal(emailNotes({ status: 'failed', failureReason: 'Nobody in this audience is subscribed, so there was nobody to send to.' })[0],
        'Why it stopped: Nobody in this audience is subscribed, so there was nobody to send to.');
    assert.equal(emailNotes({ status: 'failed', failureReason: '  ' })[0], 'No reason was recorded for this failure.');
});

console.log('\nRendering and prompt');

check('notes render as "↳" lines under their item, and the header says how to use them', () => {
    const text = renderContentSnapshot({
        noun: 'emails', tab: 'Emails', stateWords: { failed: 'failed to send' },
        sections: [{ title: 'Needs attention', total: 1, items: [{ ref: 9, when: null, where: '', status: 'failed', text: 'October news', notes: ['Why it stopped: nobody subscribed'] }] }],
    });
    assert.ok(text.includes('- #9 · no date yet · failed to send · "October news"\n  ↳ Why it stopped: nobody subscribed'), text);
    assert.ok(text.includes('never guess a cause'), 'header must forbid guessing a reason');
});

check('the social prompt says the approve card cannot accept warnings for the user', () => {
    const src = readFileSync(join(root, 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    assert.ok(src.includes('the card cannot accept warnings for the user'));
    // …which is true only while the chat's approve click never sends acknowledgeWarnings.
    const session = readFileSync(join(root, 'src/components/chat-session.js'), 'utf8');
    assert.ok(!session.includes('acknowledgeWarnings'), 'chat-session.js must not acknowledge warnings on the user\'s behalf');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
