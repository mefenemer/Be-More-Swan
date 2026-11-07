// What every assistant shares (src/constants/assistant-shared-prompts.ts), and the two Activity gaps closed on
// 2026-11-07. Run: npx tsx tests/assistant-shared-prompts.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASSISTANT_PAGE_LAYOUT, OUTSIDE_PRODUCTS_RULE } from '../src/constants/assistant-shared-prompts';
import { roleActivityItems } from '../src/utils/role-activity';
import { mentorJobs, mentorProposals, mentorReviews, videoProjects } from '../db/schema';

const read = (f: string) => readFileSync(f, 'utf8');
const t = (iso: string) => new Date(iso);

function fakeDb(fixtures: Map<unknown, unknown[]>) {
    return { select() {
        let rows: unknown[] = [];
        const chain: any = {
            from(table: unknown) { rows = fixtures.get(table) ?? []; return chain; },
            where() { return chain; }, orderBy() { return chain; }, limit() { return chain; }, innerJoin() { return chain; },
            catch() { return chain; },
            then(res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve(rows).then(res, rej); },
        };
        return chain;
    } } as any;
}

(async () => {
    // Every chat turn reads both, last so they win; the background advice reads the rule too.
    const orch = read('netlify/functions/chat-orchestrator.ts');
    const line = orch.slice(orch.indexOf('const promptWithRules = ['), orch.indexOf('\n', orch.indexOf('const promptWithRules = [')));
    assert.ok(line.includes('offersOwnCards ? SUPPORT_REQUEST_PROMPT : null, ASSISTANT_PAGE_LAYOUT, OUTSIDE_PRODUCTS_RULE]'), 'every turn reads both');
    for (const f of ['src/utils/mentor-review.ts', 'src/utils/mentor-jobs.ts', 'src/utils/site-audit-prompts.ts']) assert.ok(read(f).includes('OUTSIDE_PRODUCTS_RULE'), f);

    // It handles the moment, and doesn't stop assistants talking about what the user already uses.
    assert.match(OUTSIDE_PRODUCTS_RULE, /Never recommend, suggest or send the user to another company's product/);
    assert.match(OUTSIDE_PRODUCTS_RULE, /Offer the closest thing you can do here/);
    assert.match(OUTSIDE_PRODUCTS_RULE, /don't say it can't/);
    assert.match(OUTSIDE_PRODUCTS_RULE, /a product they name or already use/);

    // The page as it is now, and none of the old wording left behind.
    for (const words of ['"Assistant Settings" is the menu down the right', '"Full screen"', '"Team Chat"']) assert.ok(ASSISTANT_PAGE_LAYOUT.includes(words), words);
    assert.ok(!orch.includes('"Assistant Settings" button (top of the page)'));
    assert.ok(!orch.includes('from the "Chat" button at the top'));

    // Drizzle drops the table name from a column in a single-table select's sql`` field: a bare id here would be the option's.
    const calendar = read('netlify/functions/brand-briefs.ts');
    assert.ok(calendar.includes('o.brief_id = visual_briefs.id') && !calendar.includes('o.brief_id = ${visualBriefs.id}'));

    // The Mentor's Activity: suggestions, what became of them, reviews and jobs.
    const mentor = await roleActivityItems(fakeDb(new Map<unknown, unknown[]>([
        [mentorProposals, [
            { id: 1, title: 'Add your opening hours', status: 'shown', shownAt: t('2026-11-01T09:00:00Z'), decidedAt: null },
            { id: 2, title: 'Write a welcome email', status: 'accepted', shownAt: t('2026-11-02T09:00:00Z'), decidedAt: t('2026-11-03T09:00:00Z') },
        ]],
        [mentorReviews, [
            { id: 3, status: 'done', outcome: 'reviewed', createdAt: t('2026-11-04T09:00:00Z'), finishedAt: t('2026-11-04T09:05:00Z') },
            { id: 4, status: 'queued', outcome: null, createdAt: t('2026-11-05T09:00:00Z'), finishedAt: null },
        ]],
        [mentorJobs, [{ id: 5, kind: 'research', status: 'failed', createdAt: t('2026-11-06T09:00:00Z'), finishedAt: null }]],
    ])), { orgId: 1, assistantId: 2, roleKey: 'business_mentor', cutoff: null, limit: 50 });
    const byType = (list: typeof mentor, type: string) => list.filter((i) => i.type === type);
    assert.equal(byType(mentor, 'mentor_suggestion').length, 2);
    assert.equal(byType(mentor, 'mentor_suggestion')[0].status, 'needs_input');
    assert.match(byType(mentor, 'mentor_decision')[0].description, /You accepted a suggestion: Write a welcome email/);
    assert.equal(byType(mentor, 'mentor_review').length, 1, 'a review still running is not listed as done');
    assert.equal(byType(mentor, 'mentor_job')[0].status, 'failed');

    // The Video Producer's: the work before there is a post.
    const video = await roleActivityItems(fakeDb(new Map<unknown, unknown[]>([[videoProjects, [
        { id: 7, title: 'Opening hours', status: 'planned', createdAt: t('2026-11-01T09:00:00Z'), updatedAt: t('2026-11-01T09:02:00Z') },
        { id: 8, title: 'Summer offer', status: 'failed', createdAt: t('2026-11-02T09:00:00Z'), updatedAt: t('2026-11-02T09:02:00Z') },
    ]]])), { orgId: 1, assistantId: 2, roleKey: 'video_producer', cutoff: null, limit: 50 });
    assert.equal(byType(video, 'video_project').length, 2);
    assert.equal(byType(video, 'video_planned')[0].status, 'needs_input');
    assert.equal(byType(video, 'video_failed')[0].status, 'failed');

    // Icons the Activity tab can draw.
    const draws = read('assistants.js');
    for (const i of [...mentor, ...video]) assert.ok(draws.includes(`${i.icon}:`) || draws.includes(`'${i.icon}'`), `${i.icon} is drawn`);
    console.log('assistant-shared-prompts: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
