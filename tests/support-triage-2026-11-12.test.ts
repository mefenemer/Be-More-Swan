// tests/support-triage-2026-11-12.test.ts
// The 2026-11-12 support batch: the direct route for security and billing, article suggestions in
// Contact us, 7-day auto-close for support tickets, severity + plan on issues with a paying-customer
// alert, revenue behind feature requests, and the "Report an Issue" → Issues rename.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { isDirectTopic, topicPriority, inboxSubject, confirmationLine } from '../src/utils/support-priority';
import { canReopenClosedTicket, TICKET_AUTO_CLOSE_DAYS, TICKET_REOPEN_DAYS, TICKET_AUTO_CLOSE_NOTE } from '../src/utils/ticket-auto-close';
import { needsPayingAlert, isIssueSeverity } from '../src/utils/issue-severity';
import { planValue } from '../src/utils/org-plan-value';
import { sumFeatureRevenue } from '../src/utils/feature-revenue';
import { mentorCardFromUiElement } from '../src/utils/mentor-cards';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('support-triage-2026-11-12');

// ── Direct route ────────────────────────────────────────────────────────────────────────────────
check('security → urgent, billing → high, others default; inbox subject stands out', () => {
    assert.strictEqual(topicPriority('security'), 'urgent');
    assert.strictEqual(topicPriority('billing'), 'high');
    assert.strictEqual(topicPriority('technical'), null);
    assert.ok(isDirectTopic('security') && isDirectTopic('billing') && !isDirectTopic('other'));
    assert.match(inboxSubject(7, 'security', 'Odd login'), /🚨 SECURITY/);
    assert.match(inboxSubject(7, 'billing', 'Charged twice'), /💳 Billing/);
    assert.match(confirmationLine('billing'), /straight to a person/);
    assert.match(confirmationLine('technical'), /1–2 business days/);
});

check('Contact us offers the security topic, says it goes to a person, and skips suggestions for both', () => {
    const html = read('help-content.html');
    assert.ok(html.includes('<option value="security">Security, privacy or my data</option>'));
    assert.ok(html.includes('id="cu-direct-note"'));
    const js = read('help.js');
    assert.ok(js.includes("const direct = topic === 'security' || topic === 'billing';"));
    assert.ok(js.includes("if (topic === 'security' || topic === 'billing' || text.trim().length < 12)"));
});

check('support-tickets.ts uses the direct route for priority, alert and confirmation', () => {
    const t = read('netlify/functions/support-tickets.ts');
    assert.ok(t.includes('topicPriority(category) ? { priority: topicPriority(category)! }'));
    assert.ok(t.includes('inboxSubject(newTicket.id, newTicket.category, newTicket.subject)'));
    assert.ok(t.includes('confirmationLine(newTicket.category)'));
});

check('chat card: topic billing/security only on support messages, posted as the ticket category', () => {
    const card = (u: any) => mentorCardFromUiElement({ type: 'mentor_support_request', summary: 's', subject: 'x', description: 'y', ...u }, 1) as any;
    assert.strictEqual(card({ destination: 'support', topic: 'billing' }).topic, 'billing');
    assert.strictEqual(card({ destination: 'support', topic: 'security' }).topic, 'security');
    assert.strictEqual(card({ destination: 'support', topic: 'refunds' }).topic, undefined);
    assert.strictEqual(card({ destination: 'issue', topic: 'security' }).topic, undefined);
    assert.ok(read('src/components/mentor-apply.js').includes("const category = d.topic === 'billing' || d.topic === 'security' ? d.topic : (d.from || 'Business Mentor');"));
});

// ── Article suggestions ─────────────────────────────────────────────────────────────────────────
check('article scoring: title words beat body words, needs 2+ real words and 2+ points', () => {
    const js = read('help.js');
    const code = js.slice(js.indexOf('// HELP-SUGGEST-SCORE-START'), js.indexOf('// HELP-SUGGEST-SCORE-END'));
    const ctx: any = {}; vm.createContext(ctx);
    vm.runInContext(`${code}; this.scoreArticles = scoreArticles;`, ctx);
    const arts = [
        { title: 'Connecting Instagram', contentMd: 'Link your account from Connections.' },
        { title: 'Billing and invoices', contentMd: 'Download invoices from My Account.' },
        { title: 'Your calendar', contentMd: 'Instagram posts appear here once scheduled.' },
    ];
    const hits = ctx.scoreArticles('My Instagram account will not connect', arts).map((a: any) => a.title);
    assert.strictEqual(hits[0], 'Connecting Instagram');
    assert.strictEqual(ctx.scoreArticles('help please', arts).length, 0, 'stop words only → nothing');
    assert.strictEqual(ctx.scoreArticles('zebra quantum', arts).length, 0, 'no match → nothing');
});

check('suggestions never block Send, and open the article in place', () => {
    const js = read('help.js');
    assert.ok(js.includes("window.openHelpArticle?.(b.getAttribute('data-suggest-title'))"));
    assert.ok(js.includes('Still need us? Send as normal.'));
    assert.ok(read('help-content.html').includes('id="cu-suggest"'));
});

// ── Ticket auto-close ───────────────────────────────────────────────────────────────────────────
check('tickets close after 7 quiet days and can be reopened by a reply for 30 days', () => {
    assert.strictEqual(TICKET_AUTO_CLOSE_DAYS, 7);
    assert.strictEqual(TICKET_REOPEN_DAYS, 30);
    const now = Date.now();
    assert.ok(canReopenClosedTicket(new Date(now - 29 * 864e5), now));
    assert.ok(!canReopenClosedTicket(new Date(now - 31 * 864e5), now));
    assert.ok(!canReopenClosedTicket(null, now));
    assert.match(TICKET_AUTO_CLOSE_NOTE, /reply here within 30 days/);
    const src = read('src/utils/ticket-auto-close.ts');
    assert.ok(src.includes("WHERE s.status IN ('pending_customer', 'resolved')"));
    assert.ok(src.includes("AND t.status IN ('pending_customer', 'resolved')\n            RETURNING"), 'compare-and-swap');
    const tickets = read('netlify/functions/support-tickets.ts');
    assert.ok(tickets.includes("ticket.status === 'closed' && !canReopenClosedTicket(ticket.closedAt)"));
    assert.ok(read('netlify/functions/check-fixes-live.ts').includes('await autoCloseQuietTickets(db)'));
    assert.ok(read('src/utils/notification-templates-catalog.ts').includes("templateKey: 'ticket_auto_closed'"));
});

// ── Severity + plan ─────────────────────────────────────────────────────────────────────────────
check('paying-customer alert only for critical/high from a paying workspace', () => {
    assert.ok(needsPayingAlert('critical', true) && needsPayingAlert('high', true));
    assert.ok(!needsPayingAlert('normal', true) && !needsPayingAlert('critical', false));
    assert.ok(isIssueSeverity('low') && !isIssueSeverity('urgent'));
});

check('plan value: beta/trial and non-billing states pay nothing', () => {
    assert.deepStrictEqual(planValue({ planName: 'Pro', planType: 'subscription', monthlyPriceGbp: '79.00', status: 'active' }), { planName: 'Pro', monthlyGbp: 79, paying: true });
    assert.strictEqual(planValue({ planName: 'Pro', planType: 'beta', monthlyPriceGbp: '349.00', status: 'active' }).paying, false);
    assert.strictEqual(planValue({ planName: 'Pro', planType: 'trial', monthlyPriceGbp: '79.00', status: 'active' }).monthlyGbp, 0);
    assert.strictEqual(planValue({ planName: 'Pro', planType: 'subscription', monthlyPriceGbp: '79.00', status: 'cancelled' }).paying, false);
});

check('severity reaches the form, the API, the admin list, the panel and the board', () => {
    assert.ok(read('help-content.html').includes('<select id="ri-severity"'));
    assert.ok(read('help.js').includes("severity: document.getElementById('ri-severity')?.value || 'normal'"));
    const create = read('netlify/functions/issue-reports.ts');
    assert.ok(create.includes("if (severity !== 'normal') await setIssueSeverity(db, created.id, severity);"));
    assert.ok(create.includes('const urgent = needsPayingAlert(triage.severity, !!plan?.paying);'));
    const admin = read('netlify/functions/admin-issue-reports.ts');
    assert.ok(admin.includes("severity: severities.get(r.id) ?? 'normal',") && admin.includes('paying: r.organisationId != null'));
    assert.ok(admin.includes("if (!isIssueSeverity(body.severity)) return json(400"));
    const html = read('admin.html');
    assert.ok(html.includes('onchange="irSetSeverity(${i.id}, this.value)"'));
    assert.ok(html.includes("{ key: 'urgent', label: 'Most urgent'"));
    assert.ok(html.includes("label: 'Paying customers'"));
    assert.ok(read('db/z-issue-severity.sql').includes("CHECK (severity IN ('critical', 'high', 'normal', 'low'))"));
});

// ── Revenue behind feature requests ─────────────────────────────────────────────────────────────
check('feature revenue counts each paying workspace once per request', () => {
    const values = new Map([
        [1, { planName: 'Pro', monthlyGbp: 79, paying: true }],
        [2, { planName: 'Scale', monthlyGbp: 149, paying: true }],
        [3, { planName: 'Trial', monthlyGbp: 0, paying: false }],
    ]);
    const r = sumFeatureRevenue(new Map([[10, new Set([1, 2, 3])], [11, new Set([3])], [12, new Set<number>()]]), values);
    assert.deepStrictEqual(r.get(10), { monthlyGbp: 228, payingWorkspaces: 2 });
    assert.deepStrictEqual(r.get(11), { monthlyGbp: 0, payingWorkspaces: 0 });
    assert.deepStrictEqual(r.get(12), { monthlyGbp: 0, payingWorkspaces: 0 });
});

check('Feature requests board shows revenue, sorts and filters by it', () => {
    assert.ok(read('netlify/functions/admin-feature-requests.ts').includes('revenueGbp: revenue.get(r.id)?.monthlyGbp ?? 0'));
    const html = read('admin.html');
    assert.ok(html.includes("{ key: 'revenue', label: 'Most revenue'"));
    assert.ok(html.includes("label: 'From paying customers'"));
});

// ── Rename ──────────────────────────────────────────────────────────────────────────────────────
check('customers no longer see "Report an Issue" or "reported problem"', () => {
    for (const p of ['src/components/disruptive-ui-registry.js', 'src/utils/support-inbox.ts', 'help-content.html']) {
        const s = read(p).split('\n').filter((l) => !/^\s*(\/\/|<!--|\*|-)/.test(l.trim()) && !l.trim().startsWith('//')).join('\n');
        assert.ok(!/Help & Support ▸ Report an Issue|reported problem #/.test(s), p);
    }
    const sql = read('db/help-articles-getting-help-2026-11-12.sql');
    assert.ok(sql.includes("'Getting Help: Issues, Tickets and Feature Requests'"));
    const body = sql.slice(sql.indexOf("$$\n# Getting Help"), sql.indexOf("$$, TRUE)"));
    assert.ok(!body.includes("''"), 'apostrophes are not doubled inside $$');
    assert.ok(!/Report an Issue|Support Tickets/.test(body));
});

console.log(`\n${passed} passed`);
