// tests/newsletter-role-live.test.ts
// Going live is where an assistant ships with silent holes. Every registry in this product is keyed
// by roleKey, and a missing entry does not throw — it falls back, usually to the Social Media
// Manager, and the result is a page of confident numbers about the wrong thing.
//
// The four that have actually gone wrong here before:
//
//   1. THE INSERT-ONLY SEED. db/seed-catalog.ts uses onConflictDoNothing on role_key, so flipping
//      `comingSoon: false` changes nothing on any database that already has the row — which is
//      every environment. Without a companion UPDATE the role stays "Coming Soon" in production
//      while the code, the tests and the local seed all say it is live.
//   2. THE MISSING DASHBOARD ENTRY. A role with no registry entry inherits the SOCIAL dashboard:
//      engagement rate, reach growth, CTR — over an endpoint holding none of its data.
//   3. THE MISSING CONNECTION POLICY. connection-map.ts is a SECURITY control. A role that is not
//      listed falls through to a keyword guess and, failing that, is treated as unrestricted.
//   4. COPY THAT PROMISES WHAT THE CODE DOES NOT DO. The catalogue card is marketing, and it is
//      read as a specification by the person paying for it.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHING_ROLE_KEYS } from '../src/utils/notification-prefs';
import { GOAL_METRICS } from '../src/config/goal-metrics';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

/**
 * Source with its comment-only lines and block comments removed.
 *
 * ⚠️ Needed because several checks below assert that a phrase does NOT appear — and the comments
 * in those same files deliberately NAME the thing being avoided ("a card labelled 'Open Rate'…",
 * "Mailchimp is NOT built"). Asserting over raw source makes the warning that prevents the bug
 * indistinguishable from the bug, and the only way to pass would be to delete the explanation.
 * Only whole-line `//` comments are stripped, so a `//` inside a string or URL is left alone.
 */
function withoutComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

const ROLE = 'newsletter_editor';
const CATALOG = read('db/seed-catalog.ts');
const REGISTRY = read('src/components/assistant-dashboard-registry.js');
const AUTOPILOT = read('netlify/functions/draft-newsletter-issues.ts');
const PERF = read('netlify/functions/get-newsletter-performance.ts');
const ASSISTANTS = read('assistants.js');

async function main() {

// ── 1. The go-live flip actually reaches a live database ────────────────────

await check('a role flipped live in the seed has the UPDATE migration that makes it true', () => {
    const entry = CATALOG.slice(landmark(CATALOG, `roleKey: '${ROLE}'`), landmark(CATALOG, `roleKey: '${ROLE}'`) + 900);
    assert.match(entry, /comingSoon: false/, 'the seed should say it is live');
    // …and because that seed is INSERT-ONLY, the UPDATE has to exist as well.
    const migration = read('db/newsletter-role-live.sql');
    assert.match(migration, /UPDATE master_assistants/);
    assert.match(migration, new RegExp(`role_key = '${ROLE}'`));
    assert.match(migration, /coming_soon\s*=\s*false/);
});

await check('the seed is still insert-only, so the migration is not redundant', () => {
    // If this ever changes, the note in db/newsletter-role-live.sql becomes wrong and should go.
    assert.match(CATALOG, /onConflictDoNothing\(\{ target: masterAssistants\.roleKey \}\)/);
});

// ── 2. Every live role has the two entries that fail silently ───────────────

await check('every live role has an explicit connection policy', () => {
    // connection-map is a security control: no entry means a keyword guess, then unrestricted.
    for (const roleKey of liveRoles()) {
        assert.ok(Object.prototype.hasOwnProperty.call(ROLE_CONNECTIONS, roleKey),
            `${roleKey} is live but has no ROLE_CONNECTIONS entry — it would fail OPEN`);
    }
});

await check('every live role has its own dashboard entry', () => {
    for (const roleKey of liveRoles()) {
        assert.ok(REGISTRY.includes(`${roleKey}: {`),
            `${roleKey} is live but has no dashboard registry entry — it inherits the SOCIAL KPIs`);
    }
});

function liveRoles(): string[] {
    // Parsed from the source rather than imported: importing the seed pulls in the db client.
    const out: string[] = [];
    const re = /roleKey: '([a-z0-9_]+)',[\s\S]{0,700}?comingSoon: (true|false)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(CATALOG))) {
        if (m[2] === 'false') out.push(m[1]);
    }
    assert.ok(out.includes(ROLE), 'the newsletter role should be among the live ones');
    assert.ok(out.length >= 3, 'the parse should find every live role, not just one');
    return out;
}

// ── 3. The newsletter role's own self-audit ─────────────────────────────────

await check('the role appears in every registry the checklist calls mandatory', () => {
    const files: [string, string][] = [
        ['src/utils/connection-map.ts', 'connection policy (security)'],
        ['src/components/assistant-dashboard-registry.js', 'dashboard KPIs'],
        ['src/public/assistant-onboarding-schemas.js', 'onboarding questions'],
        ['src/public/mandate-suggestions.js', 'quick-start chips'],
        ['src/components/assistant-starter-prompts.js', 'chat starter prompts'],
        ['db/seed-assistant-content.ts', 'catalogue card copy (card clickability)'],
    ];
    for (const [file, what] of files) {
        assert.ok(read(file).includes(ROLE), `${ROLE} is missing from ${file} — ${what}`);
    }
});

await check('it is registered as a publishing role, so its notifications exist', () => {
    assert.ok(PUBLISHING_ROLE_KEYS.has(ROLE),
        'without this the draft/publish notification categories are hidden and rejected on write');
});

await check('it has goal metrics of its own, and they are measurable', () => {
    const mine = GOAL_METRICS.filter((m) => (m.roles ?? []).includes(ROLE));
    assert.ok(mine.length >= 2, 'a live role with no target metrics cannot be given a goal');
    for (const m of mine) {
        assert.equal(m.available, true, `${m.key} is offered but marked unavailable — a goal that can never move`);
        assert.ok(m.description && m.description.length > 20, `${m.key} needs a description users can act on`);
    }
});

await check('the onboarding schema has exactly one operational step', () => {
    // The detail page renders `operational: true` steps in Operational Setup and the rest in Setup
    // Answers. Two of them, or none, and the cadence controls land in the wrong place.
    const schemas = read('src/public/assistant-onboarding-schemas.js');
    const start = landmark(schemas, `${ROLE}: [`);
    const block = schemas.slice(start, landmark(schemas, 'blog_writer: ['));
    assert.equal((block.match(/operational: true/g) || []).length, 1);
    // And the voice field must use the key the generator actually reads.
    assert.ok(block.includes("key: 'tone_of_voice'"),
        'newsletter-generate.ts reads onboardingContext.tone_of_voice — a different key silently defaults the voice');
    assert.ok(block.includes("key: 'posting_frequency'"),
        'the autopilot reads posting_frequency through postsPerWeekFor()');
});

// ── 4. The cards describe what the endpoint returns ─────────────────────────

await check('every KPI card has a field behind it', () => {
    // The Blog Writer shipped with four labels over an endpoint that held none of them. Each card
    // title here is checked against something get-newsletter-performance actually returns.
    const start = landmark(REGISTRY, `${ROLE}: {`);
    const block = REGISTRY.slice(start, landmark(REGISTRY, 'blog_writer: {'));
    const expected: [string, string][] = [
        ['Subscribers', 'subscribers'],
        ['Issues Sent', 'issuesSent'],
        ['Open Rate', 'openRate'],
        ['Click Rate', 'clickRate'],
    ];
    for (const [title, field] of expected) {
        assert.ok(block.includes(`title: '${title}'`), `the card "${title}" should be in the registry`);
        assert.ok(PERF.includes(field), `the endpoint must return ${field} for the "${title}" card`);
    }
    assert.match(block, /metricsSource: 'newsletter'/,
        'without this the role reads the social post_insights endpoint, which holds none of its data');
});

await check('the open rate never claims to be a measurement', () => {
    // Opens are a 1x1 image and Apple Mail Privacy Protection pre-fetches it whether or not a human
    // looks. The number is a trend; a card presenting it as readership is a lie with a decimal point
    // on it, so the caveat is asserted rather than left to a future edit's discretion.
    const start = landmark(REGISTRY, `${ROLE}: {`);
    const block = REGISTRY.slice(start, landmark(REGISTRY, 'blog_writer: {'));
    const desc = block.slice(landmark(block, "title: 'Open Rate'"), landmark(block, "title: 'Click Rate'"));
    assert.match(desc, /Indicative only/i, 'the card description must carry the caveat');
    assert.match(desc, /Apple Mail/i, 'and name the specific reason, not just hedge');
});

await check('an unmeasurable send reports that, rather than 0%', () => {
    // An issue sent from a connected mailbox rewrites no links and embeds no pixel, so a 0% open
    // rate there is a statement about our instrumentation dressed up as one about the reader.
    assert.match(PERF, /engagementMeasurable/);
    assert.match(PERF, /FILTER \(WHERE \$\{newsletterIssues\.engagementTracked\}\)/,
        'untracked issues must leave the denominator, not just the numerator');
    assert.match(ASSISTANTS, /Not measurable on these sends/);
    assert.match(read('newsletter.js'), /were not measurable on this send/);
});

await check('opens count PEOPLE, not events', () => {
    // One subscriber opening five times is one person. Counting events would push the rate past
    // 100% the first time somebody scrolled back to an issue.
    const hook = read('netlify/functions/newsletter-webhook.ts');
    const branch = hook.slice(landmark(hook, "type === 'email.opened'"));
    assert.match(branch, /isNull\(newsletterSends\.openedAt\)/, 'first touch only');
    assert.match(branch, /isNull\(newsletterSends\.clickedAt\)/);
    assert.match(branch, /if \(first\)/, 'and only a first touch may increment the issue');
});

await check('the ROI strip has real hours behind it', () => {
    // roiSource re-reveals the Time Saved / Money Saved strip. Setting it while roi-activity.ts
    // priced nothing would have shown a confident, permanent zero.
    const start = landmark(REGISTRY, `${ROLE}: {`);
    const block = REGISTRY.slice(start, landmark(REGISTRY, 'blog_writer: {'));
    assert.match(block, /roiSource: 'newsletter'/);

    const roi = read('src/utils/roi-activity.ts');
    assert.match(roi, /newsletterIssues/, 'the module must actually count issues');
    // Counted in BOTH passes — org-wide and the per-assistant grouping. With only one, the hero
    // strip and the itemised modal disagree about the same window.
    assert.equal((roi.match(/mult\.newsletter_drafted/g) || []).length, 2);
    assert.match(read('src/utils/platform-config.ts'), /newsletter_drafted: \d+/);
});

await check('a failed send is still priced as work done', () => {
    // The draft happened. Pricing it at zero would tell a customer their assistant did nothing on
    // the week their sending domain lapsed.
    const roi = read('src/utils/roi-activity.ts');
    const at = landmark(roi, 'export const DISCARDED_NEWSLETTER_STATUSES');
    assert.ok(!roi.slice(at, at + 120).includes("'failed'"),
        'a failed send must not be treated as discarded work');
});

await check('the catalogue copy promises only what the pipeline does', () => {
    const content = withoutComments(read('db/seed-assistant-content.ts'));
    const start = landmark(content, `roleKey: '${ROLE}'`);
    // Bounded by the NEXT entry, not by a character count — an entry that grows would otherwise
    // start reading its neighbour's integrations and fail for the wrong reason.
    const block = content.slice(start, landmark(content, 'roleKey:', start + 10));
    // Mailchimp was listed as an integration and has never existed in this codebase.
    assert.ok(!/Mailchimp/i.test(block), 'Mailchimp is not built — listing it is a promise we cannot keep');
    // "Curated industry round-ups" implied research the assistant does not perform; its own prompt
    // forbids inventing facts it was not given.
    assert.ok(!/round-up/i.test(block), 'the assistant writes from the tenant\'s brief, it does not curate industry news');
});

await check('the copy migration and the content seed do not disagree', () => {
    // Two sources now hold this role's copy: db/newsletter-role-copy.sql (what production ran) and
    // db/seed-assistant-content.ts (what a full seed would write). If they drift, the next seed run
    // silently reverts production to the older wording — the failure mode that made a targeted
    // migration the right call in the first place.
    const sql = read('db/newsletter-role-copy.sql');
    const seed = withoutComments(read('db/seed-assistant-content.ts'));
    const start = landmark(seed, `roleKey: '${ROLE}'`);
    const block = seed.slice(start, landmark(seed, 'roleKey:', start + 10));

    const tagline = block.match(/tagline: '([^']+)'/)?.[1];
    assert.ok(tagline, 'the seed entry should carry a tagline');
    assert.ok(sql.includes(tagline!), 'the migration and the seed must state the SAME tagline');

    for (const feature of block.match(/keyFeatures: \[([^\]]+)\]/)?.[1].split(',') ?? []) {
        const text = feature.trim().replace(/^'|'$/g, '');
        if (text) assert.ok(sql.includes(text), `key feature "${text}" is in the seed but not the migration`);
    }
});

await check('the metrics loader is actually routed, not just written', () => {
    assert.match(ASSISTANTS, /source === 'newsletter'/, 'the registry value needs a branch that reads it');
    assert.match(ASSISTANTS, /_loadNewsletterMetrics/);
    // And the primary action reaches the Studio.
    const pa = ASSISTANTS.slice(landmark(ASSISTANTS, "data.roleKey === 'newsletter_editor'"));
    assert.match(pa.slice(0, 900), /loadView\?\.\('newsletter'\)/);
});

// ── 5. The autopilot drafts, and only drafts ────────────────────────────────

await check('the autopilot never sends', () => {
    // "You approve every issue" is a claim on the catalogue card. It has to be structurally true.
    for (const forbidden of ['newsletterSends', 'sendDueIssues', "status: 'scheduled'", "status: 'sent'"]) {
        assert.ok(!AUTOPILOT.includes(forbidden),
            `the autopilot must not touch ${forbidden} — approval is a human's decision`);
    }
    assert.match(AUTOPILOT, /status: 'pending_approval'/, 'it leaves the issue waiting for a person');
});

await check('a cadence of "on demand" produces nothing', () => {
    const loop = AUTOPILOT.slice(landmark(AUTOPILOT, 'const perWeek = postsPerWeekFor'));
    assert.match(loop.slice(0, 400), /if \(!perWeek\)/, 'the user said they start each issue themselves');
});

await check('it never stacks up unapproved drafts', () => {
    // A tenant who goes on holiday should come back to one draft and a decision, not eight.
    assert.match(AUTOPILOT, /AWAITING_HUMAN/);
    assert.match(AUTOPILOT, /draft_already_waiting/);
    const guard = AUTOPILOT.slice(landmark(AUTOPILOT, 'const [outstanding]'), landmark(AUTOPILOT, 'const [latest]'));
    assert.match(guard, /continue;/, 'an outstanding draft must skip this assistant entirely');
});

await check('the cadence period is measured from the last issue CREATED, not sent', () => {
    // Measuring from sends drafts continuously for the tenant who drafts and never sends — exactly
    // the person this feature is supposed to help.
    const window = AUTOPILOT.slice(landmark(AUTOPILOT, 'const [latest]'), landmark(AUTOPILOT, 'const [issue]'));
    assert.match(window, /createdAt: newsletterIssues\.createdAt/);
    assert.ok(!window.includes('sentAt'), 'the window must not key on sentAt');
});

await check('the autopilot draft carries its own generation reason', () => {
    // generateIssueBody COALESCEs, so the more specific reason has to be stamped first or it is
    // replaced by the generic assistant_draft marker and the Review Queue cannot tell them apart.
    const insert = AUTOPILOT.slice(landmark(AUTOPILOT, 'await db.insert(newsletterIssues)'), landmark(AUTOPILOT, 'await generateIssueBody'));
    assert.match(insert, /generationReason: 'newsletter_autopilot'/);
    assert.match(insert, /isAutonomous: true/);
});

// ── 6. The surfaces the go-live audit turned up ─────────────────────────────

await check('the Review Queue has a renderer of its own, not the social fallback', () => {
    // The dispatch tests kind === 'records', then source === 'blog_posts', then falls through to
    // the SOCIAL posts renderer. A registry entry naming a source nothing dispatches on would show
    // an empty queue under a tab that looked like it worked.
    assert.match(ASSISTANTS, /source === 'newsletter_issues'\) return _detailRqRenderNewsletter/,
        'the render dispatch must know this source');
    assert.match(ASSISTANTS, /async function _detailRqRenderNewsletter/);
    assert.match(ASSISTANTS, /newsletter-issues\?assistantId=/, 'and read the newsletter endpoint, not get-social-drafts');
});

await check('the approved column is shown for issues, unlike posts', () => {
    // approve-post.ts schedules a post immediately, so 'approved' is never a resting state there.
    // An approved ISSUE waits for Send now or its scheduled time — hiding the column would hide
    // every issue sitting in exactly that state.
    assert.match(ASSISTANTS, /toggle\('detail-rq-col-approved', rqIsRecords \|\| rqIsNewsletter\)/);
});

await check('the review copy says SENT, not scheduled', () => {
    const sub = ASSISTANTS.slice(landmark(ASSISTANTS, 'rqIsNewsletter'), landmark(ASSISTANTS, 'rqIsNewsletter') + 2500);
    assert.match(sub, /sent to your subscribers/,
        'approving an issue is the decision to email real people — the copy over the button should say so');
});

await check('the chat knows what it is, and what it cannot do', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('newsletter_editor: {'), 'without a route it falls through to the generic one');
    const route = chat.slice(landmark(chat, 'newsletter_editor: {'), landmark(chat, 'blog_writer: {'));
    // The three things a chat can get catastrophically wrong for this role. ⚠️ The first is about
    // SENDING, which the chat can never do — distinct from saving, which it now can (via the card,
    // pressed by a human). tests/newsletter-chat-draft.test.ts covers the save contract itself.
    assert.match(route, /NEVER say the issue has been saved/i, 'the card is an offer, not a filing');
    // ⚠️ SENDING is still never available; SCHEDULING now is, but only as a proposal the model
    // makes and a human presses. The distinction is the whole safety property: a button on a card
    // under an issue somebody has just read is a human decision, and the server still refuses
    // approval to anyone who is not an owner or an admin.
    assert.match(route, /You still cannot SEND anything/i, 'sending is never available here');
    assert.match(route, /you cannot approve or schedule on your own/i,
        'and the model must not believe it schedules anything by itself');
    assert.match(route, /Only propose a time when they have actually asked for one/i,
        'an unasked-for send time is a button that gets pressed by accident');
    assert.match(route, /"sendAt"/, 'the wire shape has to be in the contract or it never arrives');
    assert.match(route, /WHAT YOU CANNOT SEE/, 'it cannot see the audience or past issues');
    assert.match(route, /do not write an unsubscribe line/i, 'the footer is appended in code — writing it twice is the failure');
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
