// tests/campaign-email-orders.test.ts
// §9.7 of docs/campaign-orchestrator-plan.md: a campaign can brief the Email Marketing Assistant.
//
// WHY THIS EXISTS. "If a lead capture form works, what nurtures that lead?" The answer existed —
// the Email Marketing Assistant — but a campaign could not ask for it. This suite pins the new path
// end to end, and above all the one property that matters most: A CAMPAIGN NEVER SENDS AN EMAIL.
// A form follow-up is saved switched off and draft emails are saved as drafts; turning either on is
// a human act in Email Studio. An orchestrator that could reach a stranger's inbox on the strength
// of a plan approval would be the largest blast radius in the product.
//
// Also pinned: the drafting runs in the BACKGROUND (one model call per email would blow the ~26s
// budget of the plan-approval request), its wake-up is awaited, a lost wake-up is re-sent by the
// reconciler, and two wake-ups cannot draft the same campaign twice.
//
// Run:  npx tsx tests/campaign-email-orders.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEmailPlan } from '../src/utils/campaign-email-order';
import { normalisePlanOrders, planWorkItems, ORDER_ROLE_LABELS } from '../src/utils/campaign-plan';
import { ORDER_ACTION_SPECS, CAMPAIGN_ORDER_ACTIONS } from '../src/config/campaign-vocab';
import { ORCHESTRATABLE_ROLE_KEYS, NEWSLETTER_ROLE_KEY } from '../src/constants/roles';
import { cadenceFor } from '../src/config/email-campaign-cadences';
import { MAX_CAMPAIGN_EMAILS } from '../src/utils/newsletter-campaign-chat-draft';

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
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone.`);
    return text.slice(a, b);
}

const worker = code(read('src/utils/campaign-email-order.ts'));

console.log('\n──── a campaign never sends an email ────');

check('a form follow-up is saved without ever touching is_enabled', () => {
    assert.ok(!/isEnabled|is_enabled|enabledAt|enabledBy/.test(worker),
        'The worker must leave newsletter_sequences.is_enabled at its default (false). Switching a follow-up on '
        + 'is the user\'s act in Email Studio — never a side effect of approving a campaign plan.');
});

check('draft emails are saved as drafts — no status, schedule or send', () => {
    const insert = span(worker, 'tx.insert(newsletterIssues)', '.returning(', 'the email insert');
    assert.ok(!/status|scheduledFor|sendingStartedAt|sentAt/.test(insert),
        'An email inserted with any status other than the default draft would be one step from a stranger\'s inbox.');
    assert.ok(!/newsletter-send|sendDueIssues|resolveSendRoute|process-newsletter-sends/.test(worker),
        'The drafting worker must not import or call anything that sends.');
});

check('the chat and the card both say nothing is sent', () => {
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /nothing is sent until the user turns the follow-up on, or sends each email/);
    const card = code(read('src/components/disruptive-ui-registry.js'));
    assert.match(card, /saved switched off/);
});

console.log('\n──── the plan the emails are written against ────');

check('the stage chooses kind and recipient when the brief does not', () => {
    const conv = resolveEmailPlan({ quantity: 4 }, 'conversion');
    assert.strictEqual(conv.trigger, 'form', 'A conversion campaign captures people; its emails follow them up.');
    assert.strictEqual(conv.campaignType, 'onboarding');
    const ret = resolveEmailPlan({ quantity: 4 }, 'retention');
    assert.strictEqual(ret.trigger, 'custom', 'A retention campaign writes to a list the business already has.');
    assert.strictEqual(ret.campaignType, 'reengagement');
});

check('an explicit kind and recipient win; junk falls back', () => {
    const p = resolveEmailPlan({ emailKind: 'winback', emailTrigger: 'custom', quantity: 2 }, 'conversion');
    assert.strictEqual(p.campaignType, 'winback');
    assert.strictEqual(p.trigger, 'custom');
    const junk = resolveEmailPlan({ emailKind: 'spam', emailTrigger: 'everyone' }, 'awareness');
    assert.strictEqual(junk.campaignType, 'launch');
    assert.strictEqual(junk.trigger, 'custom');
});

check('the steps are the kind\'s own cadence, trimmed or extended to what was priced', () => {
    const cadence = cadenceFor('onboarding').steps;
    const two = resolveEmailPlan({ quantity: 2 }, 'conversion');
    assert.deepStrictEqual(two.steps, cadence.slice(0, 2).map((s) => ({ day: s.day, role: s.role })));
    const six = resolveEmailPlan({ quantity: 6 }, 'conversion');
    assert.strictEqual(six.steps.length, 6, 'Six were priced, so six are written.');
    for (let i = 1; i < six.steps.length; i++) {
        assert.ok(six.steps[i].day > six.steps[i - 1].day, 'Days must keep moving forward.');
    }
    assert.strictEqual(resolveEmailPlan({ quantity: 99 }, 'conversion').steps.length, MAX_CAMPAIGN_EMAILS);
});

check('an email order with no quantity is four emails, priced as four', () => {
    const [o] = normalisePlanOrders([{ action: 'draft_email_campaign' }]);
    assert.strictEqual(o.quantity, 4, 'One email is not a campaign — default to the Studio\'s usual length.');
    assert.strictEqual(planWorkItems([o]), 4 * ORDER_ACTION_SPECS.draft_email_campaign.workItemsPerUnit);
    assert.strictEqual(ORDER_ACTION_SPECS.draft_email_campaign.maxQuantity, MAX_CAMPAIGN_EMAILS,
        'Pricing more emails than the generator will write charges for emails nobody gets.');
});

check('the brief keeps email fields from closed vocabularies only, and the facts', () => {
    const [o] = normalisePlanOrders([{
        action: 'draft_email_campaign', emailKind: 'launch', emailTrigger: 'form',
        facts: 'Book: https://x.co/book', junk: 'dropped',
    }]);
    assert.deepStrictEqual(o.brief, { facts: 'Book: https://x.co/book', emailKind: 'launch', emailTrigger: 'form' });
    const [bad] = normalisePlanOrders([{ action: 'draft_email_campaign', emailKind: 'spam', emailTrigger: 'everyone' }]);
    assert.deepStrictEqual(bad.brief, {});
});

check('the chat card prices a missing quantity exactly as the server does', () => {
    // Found in the browser: the card priced an email order with no quantity as ONE email while
    // the server committed four — the user would approve 8 fewer tasks than they were spending.
    const card = code(read('src/components/disruptive-ui-registry.js'));
    const fn = span(card, 'function renderCampaignStrategyProposalCard', '\n  register(', 'the proposal card');
    assert.match(fn, /spec\.defaultQuantity \|\| 1/);
});

console.log('\n──── the background job ────');

check('the executor wakes the worker and never drafts inline', () => {
    const orders = code(read('src/utils/campaign-orders.ts'));
    const exec = span(orders, 'draft_email_campaign: async', '\n    },\n};', 'the email executor');
    assert.match(exec, /await triggerCampaignEmailDraft\(orderId/,
        'The wake-up must be AWAITED — an un-awaited fetch is frozen with the lambda and never sent.');
    assert.ok(!/draftCampaignEmails|draftEmailCampaignForOrder/.test(exec),
        'Drafting inline would run one model call per email inside the plan-approval request (~26s budget).');
    assert.ok(!/terminal:\s*true/.test(exec), 'The order is not finished on issue — the emails do not exist yet.');
});

check('the wake-up is awaited, capped, and never throws', () => {
    const t = code(read('src/utils/trigger-campaign-email-draft.ts'));
    assert.match(t, /await fetch\(/);
    assert.match(t, /AbortController/);
    assert.match(t, /draft-campaign-emails-background/);
});

check('two wake-ups cannot draft the same campaign twice', () => {
    const claim = span(worker, 'async function claimOrder', '\n}', 'the claim');
    assert.match(claim, /db\.update\(campaignOrders\)/, 'The claim must be one UPDATE … RETURNING, not a read then a write.');
    assert.match(claim, /draftingStartedAt' IS NULL/);
    assert.match(claim, /artefactId\} IS NULL/, 'An order whose emails already exist must never be claimed again.');
});

check('the worker fails closed without its secret, and settles real failures', () => {
    const fn = code(read('netlify/functions/draft-campaign-emails-background.ts'));
    assert.match(fn, /if \(!secret\)[\s\S]{0,200}statusCode: 503/);
    assert.match(fn, /settleOrderAsFailed\(db, orderId, outcome\.message\)/);
});

check('a lost wake-up is re-sent by the reconciler', () => {
    const rec = code(read('src/utils/campaign-reconciler.ts'));
    assert.match(rec, /findStrandedEmailOrders\(db\)/);
    assert.match(rec, /triggerCampaignEmailDraft\(id, 'reconciler'\)/);
});

check('a failed draft is cancelled and refunded through the ONE settlement path, at most once', () => {
    const rec = code(read('src/utils/campaign-reconciler.ts'));
    const fn = span(rec, 'export async function settleOrderAsFailed', '\n}', 'settleOrderAsFailed');
    assert.match(fn, /\['issued', 'in_review'\]\.includes\(order\.status\)/,
        'Forward only — re-settling a settled order would refund it twice.');
    assert.match(fn, /settleOrder\(db, order, \{ kind: 'failed'/);
});

check('the reconciler follows an email order after drafting', () => {
    const rec = code(read('src/utils/campaign-reconciler.ts'));
    const fn = span(rec, 'async function judgeEmailOrder', '\n}\n', 'judgeEmailOrder');
    assert.match(fn, /seq\.isEnabled/, 'Switched on = delivered.');
    assert.match(fn, /eq\(newsletterIssues\.campaignOrderId, order\.id\)/);
    assert.match(rec, /order\.action === EMAIL_ORDER_ACTION/);
});

console.log('\n──── the boundary and the database ────');

check('the Email Marketing Assistant is orchestratable, named everywhere it is shown', () => {
    assert.ok(ORCHESTRATABLE_ROLE_KEYS.includes(NEWSLETTER_ROLE_KEY));
    assert.strictEqual(ORDER_ACTION_SPECS.draft_email_campaign.roleKey, NEWSLETTER_ROLE_KEY);
    for (const r of ORCHESTRATABLE_ROLE_KEYS) {
        assert.ok(ORDER_ROLE_LABELS[r], `ORDER_ROLE_LABELS has no name for "${r}" — a decision card would show the raw key.`);
    }
    const card = read('src/components/disruptive-ui-registry.js');
    assert.match(card, /newsletter_editor: 'Email Marketing Assistant'/,
        'The chat card hides orders whose role it cannot name — without this the email order would vanish from the card.');
    assert.ok((CAMPAIGN_ORDER_ACTIONS as readonly string[]).includes('draft_email_campaign'));
});

check('the migration traces emails to their order and widens the artefact check as a superset', () => {
    const sql = read('db/z-campaign-email-orders.sql');
    assert.match(sql, /ALTER TABLE newsletter_issues\s+ADD COLUMN IF NOT EXISTS campaign_order_id INTEGER REFERENCES campaign_orders\(id\) ON DELETE SET NULL/);
    assert.match(sql, /ALTER TABLE newsletter_sequences\s+ADD COLUMN IF NOT EXISTS campaign_order_id INTEGER REFERENCES campaign_orders\(id\) ON DELETE SET NULL/);
    const check = span(sql, 'ADD CONSTRAINT campaign_orders_artefact_check', ';', 'the widened check');
    for (const k of ['scheduled_post', 'blog_post', 'discovery_campaign', 'assistant_record', 'newsletter_sequence', 'newsletter_issue']) {
        assert.ok(check.includes(`'${k}'`), `The widened check drops '${k}' — an existing row would fail it.`);
    }
    assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('DROP CONSTRAINT') && sql.indexOf('ADD CONSTRAINT') < sql.indexOf('COMMIT;'),
        'The DROP and ADD must sit inside one transaction, so the file cannot half-apply.');
    const schema = read('db/schema.ts');
    assert.ok((schema.match(/campaignOrderId: integer\("campaign_order_id"\)\.references\(\(\): AnyPgColumn => campaignOrders\.id/g) ?? []).length >= 2,
        'Both newsletter tables need the drizzle mirror, or a future drizzle-kit push drops the columns.');
});

check('email engagement counts distinct people, from positive signals only', () => {
    const out = code(read('src/utils/campaign-outcomes.ts'));
    const q = span(out, "case 'email_engagement':", "case 'clicks':", 'the email engagement query');
    assert.match(q, /count\(DISTINCT lower\(x\.email\)\)/);
    assert.match(q, /opened_at IS NOT NULL OR s\.clicked_at IS NOT NULL/);
    assert.match(q, /newsletter_sequence_sends/);
    assert.ok(!/opened_at IS NULL/.test(q), '"Unopened" must never be inferred — a mailbox-sent email reports no opens at all.');
});

console.log('\n──── GUI and chat both reach it (§9.0) ────');

check('Add work offers the email order with its own choices', () => {
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /function emailFields/);
    for (const field of ['emailTrigger', 'emailKind', 'facts']) {
        assert.match(tab, new RegExp(`brief\\.${field} = `), `Add work never sends ${field}.`);
    }
    assert.match(tab, /spec\.defaultQuantity/, 'The quantity box must start at the email default, not 1.');
});

check('the chat wire shape carries the email fields', () => {
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /"emailTrigger": "form" \| "custom"/);
    assert.match(orch, /"emailKind":/);
    assert.match(orch, /Email Marketing Assistant — a short series of emails/);
});

console.log(`\n${passed} checks passed.`);
