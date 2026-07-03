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
    assessGoalRealism,
    objectivesWithMetrics,
    GOAL_OBJECTIVES,
    FUNNEL_DIAGNOSTICS,
    funnelDiagnosticFor,
    strategyChanges,
    TUNABLE_BRIEF_FIELDS,
    connectionDisplayName,
    GOAL_STATUSES,
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

check('US-01 AC1.1/AC1.2 — every metric maps to one of the three objectives', () => {
    const validObjectives = new Set(GOAL_OBJECTIVES.map(o => o.key));
    assert.equal(GOAL_OBJECTIVES.length, 3);
    for (const m of GOAL_METRICS) assert.ok(validObjectives.has(m.objective), `${m.key} has invalid objective`);
});

check('US-01 AC1.2 — objective→metric filtering respects connections', () => {
    // With Instagram connected, the engagement objective surfaces the IG engagement metric.
    const ig = availableMetricsForConnections(['instagram']);
    assert.ok(ig.some(m => m.objective === 'engagement' && m.key === 'instagram_engagement_rate'));
    // With nothing connected, only internal metrics remain — so only their objectives are offered.
    const offline = objectivesWithMetrics([]);
    assert.ok(offline.includes('action'), 'qualified_leads (internal) keeps the action objective available');
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
    // AC2.4 — a Traffic/Action metric (leads) → CTA / lead-magnet levers.
    const leads = funnelDiagnosticFor('qualified_leads')!;
    assert.ok(/Action/.test(leads.stage));
    assert.ok(leads.focus.join(' ').match(/call-to-action|lead-magnet/i), 'action should mention CTA/lead-magnet levers');
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

check('US-04 — LinkedIn followers is a connection-gated awareness metric the poller can fetch', () => {
    const li = getGoalMetric('linkedin_followers');
    assert.ok(li, 'linkedin_followers should be in the catalog');
    assert.equal(li!.source, 'connection');
    assert.equal(li!.connectionService, 'linkedin');
    assert.equal(li!.objective, 'awareness');
    assert.equal(li!.available, true, 'metric must be pollable now that the LinkedIn poller exists');

    // Gated by the LinkedIn connection — hidden until connected, shown once connected.
    assert.ok(!availableMetricsForConnections([]).some(m => m.key === 'linkedin_followers'));
    assert.ok(availableMetricsForConnections(['linkedin']).some(m => m.key === 'linkedin_followers'));
    // case-insensitive service matching, like the IG path.
    assert.ok(availableMetricsForConnections(['LinkedIn']).some(m => m.key === 'linkedin_followers'));

    // It resolves to a top-of-funnel diagnostic, so off-track fixes draw on awareness levers.
    assert.ok(/Awareness/.test(funnelDiagnosticFor('linkedin_followers')!.stage));

    // The disconnect alert uses a properly-cased service name ("LinkedIn", not "Linkedin").
    assert.equal(connectionDisplayName('linkedin'), 'LinkedIn');
    assert.equal(connectionDisplayName('instagram'), 'Instagram');
    assert.equal(connectionDisplayName('shopify'), 'Shopify');   // fallback capitalisation
    assert.equal(connectionDisplayName(null), undefined);
});

check('status model includes the four tracked states + pending', () => {
    for (const s of ['pending', 'on_track', 'at_risk', 'off_track', 'data_disconnected'])
        assert.ok(GOAL_STATUSES.includes(s as any), s);
});

console.log(`\n${passed} checks passed.`);
