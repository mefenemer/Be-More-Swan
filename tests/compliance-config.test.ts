// tests/compliance-config.test.ts
// AC4.1 — modular compliance layer (src/config/compliance.ts) is now load-bearing across
// register.ts, onboarding.ts, workspace-ai-disclosure.ts, provision-assistant-async.ts and
// manage-risk-assessment.ts. These checks lock its behaviour so a refactor can't silently drift.
// Run:  npx tsx tests/compliance-config.test.ts

import assert from 'node:assert';
import {
    EU_MEMBER_STATES,
    isEuCountry,
    classifyRiskByKeywords,
    suggestsHighRisk,
    isPublicInterestText,
    DISCLOSURE,
} from '../src/config/compliance';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('EU jurisdiction is the 27 member states', () => {
    assert.equal(EU_MEMBER_STATES.length, 27);
    assert.equal(new Set(EU_MEMBER_STATES).size, 27, 'no duplicates');
});

check('isEuCountry is case-insensitive and rejects non-members', () => {
    assert.equal(isEuCountry('de'), true);
    assert.equal(isEuCountry('FR'), true);
    assert.equal(isEuCountry('  ie  '), true);
    assert.equal(isEuCountry('US'), false);
    assert.equal(isEuCountry('GB'), false);   // post-Brexit — not in scope
    assert.equal(isEuCountry(null), false);
    assert.equal(isEuCountry(''), false);
});

check('classifyRiskByKeywords tiers prohibited > high_risk > limited', () => {
    assert.equal(classifyRiskByKeywords('Social Scoring Agent', 'gov'), 'prohibited');
    assert.equal(classifyRiskByKeywords('Lead Screener', 'sales'), 'high_risk');
    assert.equal(classifyRiskByKeywords('Credit Scoring', 'finance'), 'high_risk');
    assert.equal(classifyRiskByKeywords('Social Media Manager', 'marketing'), 'limited');
});

check('suggestsHighRisk is true for high_risk and prohibited only', () => {
    assert.equal(suggestsHighRisk('HR Assistant', 'recruitment'), true);
    assert.equal(suggestsHighRisk('Predictive Policing', 'gov'), true);
    assert.equal(suggestsHighRisk('Content Writer', 'blog'), false);
});

check('isPublicInterestText flags AC1.3 trigger topics', () => {
    assert.equal(isPublicInterestText('Get out and VOTE in the election'), true);
    assert.equal(isPublicInterestText('Our new vaccine information page'), true);
    assert.equal(isPublicInterestText('Buy our summer sneakers'), false);
    assert.equal(isPublicInterestText(null), false);
});

check('disclosure defaults are non-empty and mention AI', () => {
    for (const [k, v] of Object.entries(DISCLOSURE)) {
        assert.ok(v && v.length > 0, `${k} non-empty`);
        assert.ok(/ai\b/i.test(v), `${k} mentions AI`);
    }
});

console.log(`\n${passed} checks passed.`);
