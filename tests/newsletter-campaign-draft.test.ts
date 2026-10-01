// tests/newsletter-campaign-draft.test.ts
// Saving a campaign — an ordered series of emails — written in the Email Marketing Assistant's chat.
//
// The single-issue card's failure modes all apply (tests/newsletter-chat-draft.test.ts), and a
// campaign adds four of its own:
//
//   1. TIMING THAT DOES NOT ADD UP. The model writes both "Day 7" and "7 days after the previous
//      email"; delay_days stores the second. Trust it and a Day-7 email lands on Day 11.
//   2. A PROMISE NOTHING KEEPS. Only the `subscribed` trigger can start a sequence. A card, or a
//      prompt, that says a renewal campaign starts by itself is false the moment it is read.
//   3. A HAND-WRITTEN WELCOME SEQUENCE OVERWRITTEN by a chat card, or a LIVE one rewritten under the
//      people part way through it.
//   4. INVENTED LINKS — five emails, five buttons, one real URL.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AUTOMATIC_TRIGGERS, campaignDraftFromUiElement, MAX_CAMPAIGN_EMAILS, NEWSLETTER_CAMPAIGN_DRAFT_TYPE,
} from '../src/utils/newsletter-campaign-chat-draft';
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

const ORCH = read('netlify/functions/chat-orchestrator.ts');
const REGISTRY_UI = read('src/components/disruptive-ui-registry.js');
const SESSION = read('src/components/chat-session.js');
const ISSUES = read('netlify/functions/newsletter-issues.ts');
const SEQUENCES = read('netlify/functions/newsletter-sequences.ts');
const SCHEMA = read('db/schema.ts');
const SEQ_SQL = read('db/newsletter-sequences.sql');

const email = (over: Record<string, unknown> = {}) => ({
    subject: 'Welcome', preheader: 'Glad you are here', role: 'welcome',
    bodyMarkdown: 'Hi {{contact.first_name | "there"}}, welcome aboard.', ...over,
});
const campaign = (newsletters: unknown[], over: Record<string, unknown> = {}) => ({
    type: NEWSLETTER_CAMPAIGN_DRAFT_TYPE,
    stage: 'draft',
    campaign: { name: 'Welcome', campaignType: 'onboarding', trigger: { event: 'subscribed' }, newsletters, ...over },
});

async function main() {

// ── 1. The normaliser ───────────────────────────────────────────────────────

await check('nothing to show is refused outright', () => {
    assert.equal(campaignDraftFromUiElement(null), null);
    assert.equal(campaignDraftFromUiElement({ type: 'newsletter_issue_draft', newsletters: [email()] }), null);
    assert.equal(campaignDraftFromUiElement(campaign([])), null);
});

await check('the delay is recomputed from the days, never trusted', () => {
    // The model's delays here are all wrong in the way a model gets them wrong: it copied the day.
    const d = campaignDraftFromUiElement(campaign([1, 3, 7, 14].map((day) => email({ sendDay: day, delayDaysAfterPrevious: day }))))!;
    assert.deepEqual(d.newsletters.map((n) => n.sendDay), [1, 3, 7, 14]);
    assert.deepEqual(d.newsletters.map((n) => n.delayDaysAfterPrevious), [0, 2, 4, 7]);
});

await check('a missing day is rebuilt from the delay', () => {
    const d = campaignDraftFromUiElement(campaign([email({ delayDaysAfterPrevious: 0 }), email({ delayDaysAfterPrevious: 3 })]))!;
    assert.deepEqual(d.newsletters.map((n) => n.sendDay), [1, 4]);
});

await check('emails are put in order, and a day that goes backwards is held, not obeyed', () => {
    const d = campaignDraftFromUiElement(campaign([
        email({ sequenceOrder: 2, sendDay: 5, subject: 'Second' }),
        email({ sequenceOrder: 1, sendDay: 1, subject: 'First' }),
        email({ sequenceOrder: 3, sendDay: 2, subject: 'Third' }),
    ]))!;
    assert.deepEqual(d.newsletters.map((n) => n.subject), ['First', 'Second', 'Third']);
    assert.deepEqual(d.newsletters.map((n) => n.sequenceOrder), [1, 2, 3]);
    assert.deepEqual(d.newsletters.map((n) => n.sendDay), [1, 5, 5]);
    assert.ok(d.warnings.some((w) => /out of order/.test(w)), 'and the card says so');
});

await check('no gap can exceed what a sequence step can store', () => {
    const d = campaignDraftFromUiElement(campaign([email({ sendDay: 1 }), email({ sendDay: 400 })]))!;
    assert.equal(d.newsletters[1].delayDaysAfterPrevious, 90);
    assert.equal(d.newsletters[1].sendDay, 91);
});

await check(`a campaign is capped at ${MAX_CAMPAIGN_EMAILS} emails, with a warning`, () => {
    const d = campaignDraftFromUiElement(campaign(Array.from({ length: 10 }, (_, i) => email({ sendDay: i + 1 }))))!;
    assert.equal(d.newsletters.length, MAX_CAMPAIGN_EMAILS);
    assert.ok(d.warnings.some((w) => /at most/.test(w)));
});

await check('"starts by itself" is derived from the trigger, never read from the model', () => {
    const renewal = campaignDraftFromUiElement(campaign([email()], {
        campaignType: 'renewal', trigger: { event: 'renewal_due', startsAutomatically: true },
    }))!;
    assert.equal(renewal.trigger.event, 'custom');
    assert.equal(renewal.trigger.startsAutomatically, false);
    const welcome = campaignDraftFromUiElement(campaign([email()], { trigger: { event: 'subscribed', startsAutomatically: false } }))!;
    assert.equal(welcome.trigger.startsAutomatically, true);
});

await check('a link nobody supplied is removed, from the button and from the copy', () => {
    const ui = campaign([email({
        bodyMarkdown: 'See [our pricing](https://example.com/pricing) and [the guide](https://real.example/guide).',
        callToAction: { label: 'Book a call', url: 'https://example.com/book' },
    })]);
    const d = campaignDraftFromUiElement(ui, 'Use https://real.example/guide please')!;
    assert.equal(d.newsletters[0].callToAction?.url, null, 'the button survives, with no link');
    assert.equal(d.newsletters[0].callToAction?.label, 'Book a call');
    assert.ok(!d.newsletters[0].bodyMarkdown.includes('example.com/pricing'));
    assert.ok(d.newsletters[0].bodyMarkdown.includes('https://real.example/guide'), 'a supplied link is kept');

    const kept = campaignDraftFromUiElement(ui, 'book at https://example.com/book')!;
    assert.equal(kept.newsletters[0].callToAction?.url, 'https://example.com/book');
});

await check('an unresolvable merge tag never reaches the card', () => {
    const d = campaignDraftFromUiElement(campaign([email({ subject: 'Hi {{first_name}}', bodyMarkdown: 'Hello {{first_name}}.' })]))!;
    assert.ok(!d.newsletters[0].subject.includes('{{first_name}}'));
    assert.ok(!d.newsletters[0].bodyMarkdown.includes('{{first_name}}'));
    assert.ok(d.warnings.length > 0);
});

await check('the stage is derived: "draft" with a missing email is still a plan', () => {
    const partial = campaignDraftFromUiElement(campaign([email(), email({ bodyMarkdown: '' })]))!;
    assert.equal(partial.stage, 'plan', 'saving it would file an empty email');
    assert.ok(partial.warnings.some((w) => /without their copy/.test(w)));
    const plan = campaignDraftFromUiElement({ ...campaign([email({ bodyMarkdown: '' })]), stage: 'plan' })!;
    assert.equal(plan.stage, 'plan');
    assert.equal(campaignDraftFromUiElement(campaign([email(), email()]))!.stage, 'draft');
});

await check('a campaign without its wrapper is still read', () => {
    const flat = { type: NEWSLETTER_CAMPAIGN_DRAFT_TYPE, name: 'Flat', newsletters: [email()] };
    assert.equal(campaignDraftFromUiElement(flat)?.name, 'Flat');
});

// ── 2. The trigger list is ONE list ─────────────────────────────────────────

await check('AUTOMATIC_TRIGGERS matches the database check, in the schema and the migration', () => {
    const fromCheck = (src: string, re: RegExp) => {
        const m = src.match(re);
        assert.ok(m, 'the trigger check constraint was not found');
        return m![1].split(',').map((t) => t.trim().replace(/'/g, '')).sort();
    };
    assert.deepEqual(fromCheck(SCHEMA, /newsletter_sequences_trigger_check", sql`\$\{t\.triggerEvent\} IN \(([^)]*)\)/), [...AUTOMATIC_TRIGGERS].sort(), 'db/schema.ts disagrees');
    assert.deepEqual(fromCheck(SEQ_SQL, /CHECK \(trigger_event IN \(([^)]*)\)\)/), [...AUTOMATIC_TRIGGERS].sort(), 'db/newsletter-sequences.sql disagrees');
});

await check('the prompt names exactly those triggers as the ones that start by themselves', () => {
    // Widen the trigger and the assistant must stop saying it cannot start — and the reverse.
    const m = ORCH.match(/TRIGGERS THAT START BY THEMSELVES: ([^\n.]*)\./);
    assert.ok(m, 'the prompt line is gone');
    assert.deepEqual(m![1].split(',').map((t) => t.trim()).sort(), [...AUTOMATIC_TRIGGERS].sort());
});

// ── 3. The turn ─────────────────────────────────────────────────────────────

await check('the route offers campaigns, writes nothing, and has room for one', () => {
    const route = ORCH.slice(landmark(ORCH, 'newsletter_editor: {'), landmark(ORCH, '    blog_writer: {'));
    assert.match(route, /newsletter_campaign_draft/);
    assert.match(route, /newsletter_issue_draft/, 'single issues still work');
    assert.match(route, /maxTokens: 8192/, 'a truncated campaign never parses and the whole thing is lost');
    assert.ok(!route.includes('db.insert'));
    assert.match(route, /does NOT save anything/);
    assert.match(route, /Never promise the emails stop once they act/,
        'a sequence halts on unsubscribe and bounce, never on the goal being reached');
});

await check('the campaign is normalised before it is persisted, with links grounded in what the human wrote', () => {
    const block = ORCH.slice(landmark(ORCH, 'const campaignDraft = route === ROUTES.newsletter_editor'), landmark(ORCH, '// ── Reply ↔ persistence reconciliation'));
    assert.match(block, /campaignDraftFromUiElement\(uiElement, \[/);
    assert.match(block, /m\.role === 'user'/, 'grounded against the USER\'s turns, not the model\'s');
    assert.match(block, /campaignDraft \? \{ type: NEWSLETTER_CAMPAIGN_DRAFT_TYPE, \.\.\.campaignDraft \}/);
});

await check('a reply that carries a campaign is not mistaken for an unbacked claim', () => {
    assert.match(ORCH, /route === ROUTES\.newsletter_editor && !newsletterDraft && !campaignDraft && replyClaimsPostSaved/);
});

await check('the model can see the plan it proposed — the latest newsletter card is restated in history', () => {
    // Prod 2026-10-01: history carried reply TEXT only, so "write it" was answered with a second,
    // different plan and a reply claiming the emails were written.
    assert.match(ORCH, /uiElementJson: chatMessages\.uiElementJson, createdAt: chatMessages\.createdAt/);
    const block = ORCH.slice(landmark(ORCH, 'const latestCardIdx = route === ROUTES.newsletter_editor'), landmark(ORCH, "{ role: 'user' as const, content: recordContext"));
    assert.match(block, /lastIndexOf\(1\)/, 'only the LATEST card, not every redraft');
    assert.match(block, /i === latestCardIdx \? /);
    const helper = ORCH.slice(landmark(ORCH, 'function onScreenCardBlock'), landmark(ORCH, 'function parseStructuredReply'));
    assert.match(helper, /NEWSLETTER_CAMPAIGN_DRAFT_TYPE/);
    assert.match(helper, /return null/, 'other routes keep text-only history');
    assert.match(ORCH, /Never answer "write it" with another plan/);
});

await check('"draft" with no copy at all says so instead of silently showing a plan', () => {
    const d = campaignDraftFromUiElement(campaign([email({ bodyMarkdown: '' }), email({ bodyMarkdown: '' })]))!;
    assert.equal(d.stage, 'plan');
    assert.ok(d.warnings.some((w) => /came back without their copy, so this is still the plan/.test(w)));
    const plan = campaignDraftFromUiElement({ ...campaign([email({ bodyMarkdown: '' })]), stage: 'plan' })!;
    assert.equal(plan.warnings.length, 0, 'an honest plan carries no warning');
});

// ── 4. The card ─────────────────────────────────────────────────────────────

const CARD = REGISTRY_UI.slice(landmark(REGISTRY_UI, 'function renderNewsletterCampaignDraftCard'), landmark(REGISTRY_UI, "register('newsletter_campaign_draft'"));

await check('a plan has no Save button', () => {
    // An outline saved would be five empty emails.
    assert.match(CARD, /\$\{isDraft \? `<div class="flex flex-wrap items-center gap-2" data-ncd-actions>/);
    assert.ok(landmark(CARD, 'if (!isDraft) return el;') < landmark(CARD, "el.addEventListener('click'"),
        'the plan card returns before any handler is bound');
});

await check('the card says where Save goes before it is pressed, and that nothing is sent', () => {
    assert.match(CARD, /Save as welcome sequence/);
    assert.match(CARD, /draft \$\{n === 1 \? 'email' : 'emails'\}/);
    assert.match(CARD, /stays switched off until you turn it on/);
    assert.match(CARD, /Nothing is sent to anyone/);
    assert.match(CARD, /Won’t start by itself/);
});

await check('replacing a welcome sequence that has emails needs an explicit yes', () => {
    assert.match(CARD, /code === 'SEQUENCE_HAS_STEPS' && !replace/);
    assert.match(CARD, /window\.confirmModal/);
    assert.match(CARD, /dispatchSave\(true\)/);
    assert.match(CARD, /setBusy\(false\)/, 'a failure must not strand the only copy behind dead buttons');
});

// ── 5. The client ───────────────────────────────────────────────────────────

await check('the client routes by trigger and keeps the 409 question intact', () => {
    const h = SESSION.slice(landmark(SESSION, 'function onNewsletterCampaignCreate'), landmark(SESSION, 'The composer does not exist in read-only mode'));
    assert.match(h, /action: 'importCampaign'/);
    assert.match(h, /action: 'createCampaign'/);
    assert.match(h, /d\.trigger && d\.trigger\.event === 'subscribed'/);
    assert.match(h, /res\.status === 409 && data\.code/);
    assert.match(h, /if \(!assistantId\)/);
    assert.match(SESSION, /addEventListener\('newsletter:createCampaign'/);
    assert.match(SESSION, /removeEventListener\('newsletter:createCampaign'/);
});

// ── 6. The writes ───────────────────────────────────────────────────────────

const IMPORT = SEQUENCES.slice(landmark(SEQUENCES, "if (action === 'importCampaign')"), landmark(SEQUENCES, "if (action === 'saveStep')"));

await check('a LIVE welcome sequence is never replaced from a chat card', () => {
    assert.ok(landmark(IMPORT, "code: 'SEQUENCE_ENABLED'") < landmark(IMPORT, 'db.transaction'),
        'the refusal has to come before the write');
    assert.ok(landmark(IMPORT, "code: 'SEQUENCE_HAS_STEPS'") < landmark(IMPORT, 'db.transaction'));
    assert.match(IMPORT, /body\.replace !== true/);
});

await check('importing never switches the sequence on', () => {
    assert.ok(!/isEnabled:\s*true/.test(IMPORT), 'enabling stays owner/admin only, in the Studio');
    assert.ok(!/enabledAt/.test(IMPORT));
});

await check('importing the same campaign twice is a no-op, and a re-import replaces rather than merges', () => {
    assert.match(IMPORT, /deduped: true/);
    assert.match(IMPORT, /tx\.delete\(newsletterSequenceSteps\)/);
    assert.match(IMPORT, /renderedPayload: rendered\[i\]/, 'the worker sends the snapshot, so it must be built at save');
    assert.match(IMPORT, /scrubMergeTags/);
});

await check('campaign issues are all-or-nothing, deduped, and stamped as machine-written', () => {
    const create = ISSUES.slice(landmark(ISSUES, "if (action === 'createCampaign')"), landmark(ISSUES, "const id = Number(body.id"));
    assert.match(create, /db\.transaction/);
    assert.match(create, /eq\(newsletterIssues\.subject, e\.subject\)/);
    assert.match(create, /eq\(newsletterIssues\.bodyMarkdown, e\.bodyMarkdown\)/);
    assert.match(create, /generationReason: NEWSLETTER_DRAFT_REASON/);
    assert.match(create, /scrubMergeTags/);
    assert.ok(!/status: '(approved|scheduled)'/.test(create), 'saving a campaign must never schedule anything');
});

console.log(`\n${passed} checks passed.`);
}

main();
