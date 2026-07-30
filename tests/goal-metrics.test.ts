// tests/goal-metrics.test.ts
// SMART Goals — the metric catalog (src/config/goal-metrics.ts) gates the Goal Builder dropdown
// (AC1.1.2) and connection-validation (AC1.1.3). Lock its behaviour so additions can't break it.
// Run:  npx tsx tests/goal-metrics.test.ts

import assert from 'node:assert';
import {
    GOAL_METRICS,
    getGoalMetric,
    isValidMetricKey,
    availableMetricsForConnections,
    availableMetricsForRole,
    assessGoalRealism,
    objectivesWithMetrics,
    GOAL_OBJECTIVES,
    FUNNEL_DIAGNOSTICS,
    funnelDiagnosticFor,
    strategyChanges,
    TUNABLE_BRIEF_FIELDS,
    connectionDisplayName,
    GOAL_STATUSES,
    isManualMetric,
    staleWindowHoursFor,
    staleStatusFor,
    nextUpdateDue,
    draftingFocusFor,
    RUN_RATE_THRESHOLDS,
    MANUAL_UPDATE_GRACE_DAYS,
} from '../src/config/goal-metrics';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('every metric key is unique', () => {
    const keys = GOAL_METRICS.map(m => m.key);
    assert.equal(new Set(keys).size, keys.length);
});

check('connection metrics declare their required service', () => {
    for (const m of GOAL_METRICS) {
        if (m.source === 'connection') assert.ok(m.connectionService, `${m.key} missing connectionService`);
    }
});

check('getGoalMetric / isValidMetricKey', () => {
    assert.equal(getGoalMetric('instagram_followers')?.label, 'Instagram Followers');
    assert.equal(getGoalMetric('nope'), undefined);
    assert.equal(isValidMetricKey('qualified_leads'), true);
    assert.equal(isValidMetricKey('made_up'), false);
});

check('AC1.1.3 — internal metrics always available, connection metrics gated', () => {
    const none = availableMetricsForConnections([]).map(m => m.key);
    assert.ok(none.includes('qualified_leads'), 'internal metric should always be available');
    assert.ok(!none.includes('instagram_followers'), 'IG metric hidden when not connected');

    const withIg = availableMetricsForConnections(['instagram']).map(m => m.key);
    assert.ok(withIg.includes('instagram_followers'), 'IG metric available once connected');
    assert.ok(withIg.includes('qualified_leads'));

    // case-insensitive service matching
    assert.ok(availableMetricsForConnections(['INSTAGRAM']).map(m => m.key).includes('instagram_reach'));
});

check('role filtering — each assistant only sees metrics for its role', () => {
    // The user-reported metrics (`allRoles`) are offered to EVERY role by design — revenue belongs
    // to the business, not to one assistant — so they're excluded here. This test is about the
    // role-scoped metrics not bleeding across; their universality is asserted separately below.
    const tracked = (role: string | null, services: string[] = []) =>
        availableMetricsForRole(role, services).filter(m => m.source !== 'manual').map(m => m.key).sort();

    // Social Media Manager (and legacy null role) get the marketing metrics, not the role outcomes.
    const smm = tracked('social_media_manager', ['instagram']);
    assert.ok(smm.includes('instagram_followers') && smm.includes('content_published'));
    assert.ok(!smm.includes('invoices_chased') && !smm.includes('qualified_leads'), 'SMM sees no role-scoped metrics');

    assert.ok(tracked(null).includes('content_published'), 'legacy (no roleKey) is treated as social');

    // Accounts Receivable Clerk sees only its outcome metrics — never Instagram, even if connected.
    assert.deepEqual(tracked('accounts_receivable_clerk', ['instagram']), ['cash_recovered', 'invoices_chased']);

    // Lead Generator sees its two lead metrics; Support sees tickets; nobody bleeds across.
    assert.deepEqual(tracked('lead_qualifier'), ['leads_scored', 'qualified_leads']);
    assert.deepEqual(tracked('tier1_support_agent'), ['tickets_resolved']);
    assert.deepEqual(tracked('crm_enricher'), ['records_enriched']);
    assert.deepEqual(tracked('meeting_note_taker'), ['meetings_summarized']);
});

check('AC: realism — blocks the egregiously impossible, allows the ambitious', () => {
    // The user's example: +10,000,000 followers in 1 day → blocked.
    const absurd = assessGoalRealism({ metricKey: 'instagram_followers', targetValue: 10_000_000, targetDate: inDays(1) });
    assert.equal(absurd.ok, false, 'impossible follower target should be blocked');
    assert.ok(absurd.reason && absurd.suggestion, 'blocked verdict must explain + suggest a fix');
    assert.ok(typeof absurd.attainableTarget === 'number' && absurd.attainableTarget > 0);

    // Ambitious-but-plausible: 50k followers over 90 days → allowed.
    assert.equal(assessGoalRealism({ metricKey: 'instagram_followers', targetValue: 50_000, targetDate: inDays(90) }).ok, true);

    // A known baseline lets a large account set a proportionally bigger target.
    assert.equal(
        assessGoalRealism({ metricKey: 'instagram_followers', targetValue: 130_000, targetDate: inDays(30), baseline: 100_000 }).ok,
        true,
        'baseline-relative growth should be allowed for large accounts',
    );

    // Engagement rate is a percentage — it can't exceed 100%.
    assert.equal(assessGoalRealism({ metricKey: 'instagram_engagement_rate', targetValue: 150, targetDate: inDays(30) }).ok, false);
    assert.equal(assessGoalRealism({ metricKey: 'instagram_engagement_rate', targetValue: 8, targetDate: inDays(30) }).ok, true);

    // Metrics without a realism config (none today) or non-growth targets never block.
    assert.equal(assessGoalRealism({ metricKey: 'content_published', targetValue: 100, targetDate: inDays(90) }).ok, true);
});

check('US-01 AC1.1/AC1.2 — every metric maps to a defined objective', () => {
    const validObjectives = new Set(GOAL_OBJECTIVES.map(o => o.key));
    // awareness / engagement / action (social funnel) + outcome (non-social role results).
    assert.equal(GOAL_OBJECTIVES.length, 4);
    for (const m of GOAL_METRICS) assert.ok(validObjectives.has(m.objective), `${m.key} has invalid objective`);
});

check('US-01 AC1.2 — objective→metric filtering respects connections', () => {
    // With Instagram connected, the engagement objective surfaces the IG engagement metric.
    const ig = availableMetricsForConnections(['instagram']);
    assert.ok(ig.some(m => m.objective === 'engagement' && m.key === 'instagram_engagement_rate'));
    // With nothing connected, only internal metrics remain — so only their objectives are offered.
    // qualified_leads + the role-outcome metrics are internal 'outcome' metrics; content_published
    // is an internal 'awareness' metric. Engagement is IG-only, so it drops when IG is absent.
    const offline = objectivesWithMetrics([]);
    assert.ok(offline.includes('outcome'), 'internal outcome metrics keep the outcome objective available');
    assert.ok(!offline.includes('engagement'), 'engagement has no internal metric, so it drops when IG is absent');
});

check('US-02 AC2.2–2.4 — funnel diagnostics steer fixes by the metric\'s funnel stage', () => {
    // Every objective has a playbook, and each metric resolves to the right stage.
    for (const o of GOAL_OBJECTIVES) {
        const fd = FUNNEL_DIAGNOSTICS[o.key];
        assert.ok(fd && fd.stage && fd.focus.length, `${o.key} missing funnel diagnostic`);
    }
    // AC2.2 — an Awareness metric (reach) → top-of-funnel levers (Reels / hooks).
    const reach = funnelDiagnosticFor('instagram_reach')!;
    assert.ok(/Awareness/.test(reach.stage));
    assert.ok(reach.focus.join(' ').match(/Reels|hook/i), 'awareness should mention format/hook levers');
    // AC2.3 — an Interaction metric (engagement rate) → conversational / utility levers.
    assert.ok(/Interaction/.test(funnelDiagnosticFor('instagram_engagement_rate')!.stage));
    // AC2.4 — a Traffic/Action metric (link clicks) → CTA / lead-magnet levers.
    const clicks = funnelDiagnosticFor('content_published')!;
    assert.ok(/Awareness/.test(clicks.stage), 'content_published is an awareness metric');
    // Business-outcome metric (qualified_leads is now an outcome metric) → throughput levers.
    const leads = funnelDiagnosticFor('qualified_leads')!;
    assert.ok(/outcome/i.test(leads.stage));
    assert.ok(leads.focus.join(' ').match(/queue|volume|throughput|import/i), 'outcome should mention throughput/queue levers');
    // Unknown metric → no diagnostic (graceful).
    assert.equal(funnelDiagnosticFor('made_up'), undefined);
});

check('US-03 AC3.3/AC3.4 — strategyChanges returns only the genuinely changed strategy fields', () => {
    const keys = Object.keys(TUNABLE_BRIEF_FIELDS);
    assert.ok(keys.length, 'there should be tunable brief fields to diff');
    const [first, second] = keys;

    const current = { [first]: 'Old voice', [second]: 'Same audience' };
    const suggested = { [first]: 'New punchy voice', [second]: 'Same audience' };
    const changes = strategyChanges(current, suggested);
    // Only the field that actually changed is surfaced (unchanged second field is dropped).
    assert.equal(changes.length, 1);
    assert.equal(changes[0].field, first);
    assert.equal(changes[0].current, 'Old voice');
    assert.equal(changes[0].suggested, 'New punchy voice');
    assert.equal(changes[0].label, TUNABLE_BRIEF_FIELDS[first]);

    // Whitespace-only deltas don't count as a change; an empty suggestion is never offered.
    assert.equal(strategyChanges({ [first]: 'Voice' }, { [first]: '  Voice  ' }).length, 0);
    assert.equal(strategyChanges({ [first]: 'Voice' }, { [first]: '' }).length, 0);
    // A field unset on the current side but suggested → surfaced as a change from ''.
    const filled = strategyChanges({}, { [first]: 'Fresh voice' });
    assert.equal(filled.length, 1);
    assert.equal(filled[0].current, '');
    // No suggestion object at all → nothing to apply (graceful).
    assert.equal(strategyChanges(current, null).length, 0);
});

check('US-04 — LinkedIn followers stays in the catalog but is NOT offered (no org scopes)', () => {
    const li = getGoalMetric('linkedin_followers');
    assert.ok(li, 'linkedin_followers should be in the catalog');
    assert.equal(li!.source, 'connection');
    assert.equal(li!.connectionService, 'linkedin');
    assert.equal(li!.objective, 'awareness');

    // This assertion was inverted until 2026-07-30. It read "must be pollable now that the LinkedIn
    // poller exists" — but a poller existing is not the same as a poller working. The poller calls
    // /v2/organizationAcls + /v2/networkSizes, which need LinkedIn ORGANISATION scopes; the app is
    // approved for member-only posting and requests just `openid profile email w_member_social`
    // (social-oauth-callback.ts), so every call 403s. The metric was offered, accepted, and the
    // resulting goal sat at 'pending' until it rotted to 'data_disconnected'.
    // Flip this back only if organisation scopes are actually approved.
    assert.equal(li!.available, false, 'not measurable with member-only LinkedIn scopes');

    // Being unavailable, it must be hidden even when LinkedIn IS connected — the connection is not
    // the blocker, the scope grant is.
    assert.ok(!availableMetricsForConnections([]).some(m => m.key === 'linkedin_followers'));
    assert.ok(!availableMetricsForConnections(['linkedin']).some(m => m.key === 'linkedin_followers'));
    assert.ok(!availableMetricsForConnections(['LinkedIn']).some(m => m.key === 'linkedin_followers'));

    // Connection-gating itself still works, proven on a metric that IS measurable.
    assert.ok(!availableMetricsForConnections([]).some(m => m.key === 'instagram_followers'));
    assert.ok(availableMetricsForConnections(['instagram']).some(m => m.key === 'instagram_followers'));
    // case-insensitive service matching.
    assert.ok(availableMetricsForConnections(['Instagram']).some(m => m.key === 'instagram_followers'));

    // The diagnostic mapping is unaffected by availability.
    assert.ok(/Awareness/.test(funnelDiagnosticFor('linkedin_followers')!.stage));

    // The disconnect alert uses a properly-cased service name ("LinkedIn", not "Linkedin").
    assert.equal(connectionDisplayName('linkedin'), 'LinkedIn');
    assert.equal(connectionDisplayName('instagram'), 'Instagram');
    assert.equal(connectionDisplayName('shopify'), 'Shopify');   // fallback capitalisation
    assert.equal(connectionDisplayName(null), undefined);
});

check('Blog Writer has a role-scoped outcome metric and does not inherit social ones', () => {
    // No connected services: an internal-source metric must still be available on its own.
    const forBlog = availableMetricsForRole('blog_writer', []);
    const posts = forBlog.find(m => m.key === 'posts_published');
    assert.ok(posts, 'blog_writer must expose posts_published');
    assert.equal(posts!.objective, 'outcome', 'non-social roles use the Business Outcome objective');
    assert.equal(posts!.available, true);
    // Social-only metrics are gated by their own roles list — a blog role must not pick them up.
    assert.ok(!forBlog.some(m => m.key === 'linkedin_followers'));
});

check('status model includes the four tracked states + pending', () => {
    for (const s of ['pending', 'on_track', 'at_risk', 'off_track', 'data_disconnected', 'awaiting_update'])
        assert.ok(GOAL_STATUSES.includes(s as any), s);
});

// ── User-reported (manual) metrics ───────────────────────────────────────────────
// The gap these close: a business whose real objective is revenue or subscription uptake had
// nothing to set a goal against, because nothing we can reach measures either. The rules below are
// what keep that from turning into a lie about what the assistant is achieving.

check('every manual metric declares an update cadence and is offered to all roles', () => {
    const manual = GOAL_METRICS.filter(m => m.source === 'manual');
    assert.ok(manual.length > 0, 'the catalog must offer at least one user-reported metric');
    for (const m of manual) {
        // Without a cadence, staleWindowHoursFor falls back to a 30-day default and the "update due"
        // nudge silently fires on the wrong schedule for a weekly metric.
        assert.ok(
            typeof m.updateCadenceDays === 'number' && m.updateCadenceDays > 0,
            `${m.key} must declare updateCadenceDays`,
        );
        // Revenue is not a social-media metric. Without allRoles these would be filtered down to the
        // Social Media Manager by the default role rule and invisible to every other assistant.
        assert.equal(m.allRoles, true, `${m.key} must be offered to every role`);
        assert.equal(m.available, true, `${m.key} is measured by the user, so it is always available`);
    }
});

check('a manual metric can never occupy a funnel objective', () => {
    // THE RULE THIS PROTECTS: a user-typed figure must not be able to satisfy a funnel objective,
    // and specifically must not close the Social Media Manager's open 'action' coverage gap. That
    // gap is waiting on evidence from goal-metric-selftest.ts that instagram_profile_views works —
    // not on a metric the user fills in by hand, which would measure nothing about the content.
    for (const m of GOAL_METRICS.filter(x => x.source === 'manual')) {
        assert.equal(m.objective, 'outcome', `${m.key} must be a Business Outcome, not a funnel metric`);
    }
});

check('manual metrics are stale on their own cadence, not the 48h connection rule', () => {
    // The collision this prevents: 48h would rot a monthly revenue figure on day three of every
    // month and fire the critical "reconnect your account" alert about a connection that never existed.
    const monthly = staleWindowHoursFor('manual_revenue');
    assert.ok(monthly > RUN_RATE_THRESHOLDS.staleDataHours, 'a monthly figure must outlive the 48h rule');
    assert.equal(monthly, (30 + MANUAL_UPDATE_GRACE_DAYS) * 24);
    // A weekly metric gets a shorter window than a monthly one — the cadence is actually read.
    assert.ok(staleWindowHoursFor('manual_enquiries') < monthly);
    // Polled metrics are untouched.
    assert.equal(staleWindowHoursFor('instagram_followers'), RUN_RATE_THRESHOLDS.staleDataHours);

    // …and they become a different status, because the fix is different: type a number, versus
    // re-authenticate an integration.
    assert.equal(staleStatusFor('manual_revenue'), 'awaiting_update');
    assert.equal(staleStatusFor('instagram_followers'), 'data_disconnected');
});

check('a manual metric offers no per-post drafting levers', () => {
    // draftingFocusFor is what a drafting prompt is told to pull from. There is no honest per-post
    // lever for revenue, and a model told to move one anyway invents an offer to do it with — the
    // exact failure the DRAFTING_FOCUS/FUNNEL_DIAGNOSTICS split was created to stop.
    assert.deepEqual(draftingFocusFor('manual_revenue'), []);
    // The 'outcome' levers still exist for the role that genuinely owns them.
    assert.ok(draftingFocusFor('posts_published').length > 0);
});

check('next update due is derived from the metric cadence', () => {
    const last = new Date('2026-07-01T00:00:00Z');
    const due = nextUpdateDue('manual_revenue', last)!;
    assert.equal(due.toISOString().slice(0, 10), '2026-07-31');
    assert.equal(nextUpdateDue('instagram_followers', last), null, 'polled metrics are never "due"');
    assert.equal(nextUpdateDue('manual_revenue', null), null, 'nothing entered yet ⇒ nothing overdue');
});

check('every role can set a user-reported goal, with nothing connected', () => {
    for (const role of ['social_media_manager', 'blog_writer', 'accounts_receivable_clerk', null]) {
        const keys = availableMetricsForRole(role, []).map(m => m.key);
        assert.ok(keys.includes('manual_revenue'), `${role ?? 'legacy'} must be able to track revenue`);
    }
    assert.ok(isManualMetric('manual_revenue'));
    assert.ok(!isManualMetric('content_published'));
});

console.log(`\n${passed} checks passed.`);
