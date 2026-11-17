// tests/review-tiers.test.ts
// Risk tiers by file (owner, 2026-11-17; src/config/review-tiers.ts, docs/review-tiers-plan.md) and the PR
// evidence block (src/utils/pr-evidence.ts).
// Pins: the owner's high-tier areas (incl. own-domain connect and Stripe Connect payouts, D1), no function or
// util is ever silently LOW, SQL is judged on what it adds, the highest file wins, every rule still names real
// files, and the evidence block can't be left as the template or claim a lower tier than the files give.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { TIER_RULES, tierForChange, tierForFile, tierSummary } from '../src/config/review-tiers';
import { checkEvidence, evidenceTemplate, parseUnifiedDiff, tierForDiff } from '../src/utils/pr-evidence';

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

check('owner high-tier areas are high', () => {
    const high: Record<string, string> = {
        'netlify/functions/stripe-webhook.ts': 'billing',
        'netlify/functions/billing-upgrade.ts': 'billing',
        'src/utils/task-costs.ts': 'billing',
        'src/config/task-weights.ts': 'billing',
        'netlify/functions/admin-coupons.ts': 'billing',
        'netlify/functions/stripe-connect-webhook.ts': 'payouts',
        'src/utils/partner-payouts.ts': 'payouts',
        'netlify/functions/shop.ts': 'payouts',
        'netlify/functions/accept-invite.ts': 'auth',
        'netlify/functions/manage-members.ts': 'auth',
        'src/utils/tenant.ts': 'auth',
        'netlify/functions/admin-impersonate.ts': 'auth',
        'src/utils/vault.ts': 'tokens',
        'netlify/functions/meta-oauth.ts': 'tokens',
        'netlify/functions/social-oauth-callback.ts': 'tokens',
        'netlify/functions/publish-social-posts.ts': 'publish-send',
        'netlify/functions/send-outbound-email.ts': 'publish-send',
        'src/utils/mailbox-actions.ts': 'publish-send',
        'netlify/functions/account-delete-execute.ts': 'data',
        'netlify/functions/data-export.ts': 'data',
        'src/utils/site-domains.ts': 'own-domain',
        'netlify/functions/check-site-domains.ts': 'own-domain',
        'netlify.toml': 'platform',
        '.github/workflows/ci.yml': 'platform',
        'db/rls/R1-crown-jewels.sql': 'platform',
        // a PR must not be able to lower its own tier
        'src/config/review-tiers.ts': 'platform',
        'src/utils/pr-evidence.ts': 'platform',
        'src/utils/issue-sql.ts': 'platform',
        'src/utils/pr-review.ts': 'platform',
        'scripts/pr-review-gate.ts': 'platform',
        '.claude/agents/code-reviewer.md': 'platform',
        'scripts/fix-tickets.ts': 'platform',
        'scripts/feature-requests.ts': 'platform',
        'netlify/functions/admin-issue-reports.ts': 'platform',
        'netlify/functions/admin-feature-requests.ts': 'platform',
    };
    for (const [p, key] of Object.entries(high)) {
        const t = tierForFile(p);
        assert.strictEqual(t.tier, 'high', `${p} should be high, got ${t.tier}`);
        assert.strictEqual(t.key, key, `${p} should match ${key}, got ${t.key}`);
    }
});

check('no Netlify function or util is ever LOW (unknown code defaults to medium)', () => {
    const low = tracked.filter((p) => /^(?:netlify\/functions|src\/utils|src\/lib|src\/config)\/.+\.(?:ts|js)$/.test(p)).filter((p) => tierForFile(p).tier === 'low');
    assert.deepStrictEqual(low, []);
    assert.strictEqual(tierForFile('netlify/functions/brand-new-thing.ts').tier, 'medium');
    assert.strictEqual(tierForFile('workspace.html').tier, 'medium');
});

check('docs, tests, styles and media are low', () => {
    for (const p of ['docs/review-tiers-plan.md', 'tests/foo.test.ts', 'e2e/smoke.spec.ts', 'style.css', 'locales/en.json', 'images/swan.png', 'README.md'])
        assert.strictEqual(tierForFile(p).tier, 'low', p);
});

check('a high rule beats a low one (a .md under .github is still high)', () => {
    assert.strictEqual(tierForFile('.github/PULL_REQUEST_TEMPLATE.md').tier, 'high');
});

check('SQL: additive = medium, anything else or unknown = high', () => {
    assert.strictEqual(tierForFile('db/z-new.sql', 'ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar text;').tier, 'medium');
    assert.strictEqual(tierForFile('db/z-new.sql', 'CREATE TABLE IF NOT EXISTS foo (id int);').tier, 'medium');
    const drop = tierForFile('db/z-new.sql', 'ALTER TABLE foo DROP COLUMN bar;');
    assert.strictEqual(drop.tier, 'high');
    assert.ok(drop.note);
    assert.strictEqual(tierForFile('db/z-new.sql', "UPDATE foo SET bar = 'x';").tier, 'high');
    assert.strictEqual(tierForFile('db/z-new.sql', null).tier, 'high');
    assert.strictEqual(tierForFile('db/z-task-costs.sql', 'CREATE TABLE IF NOT EXISTS t (id int);').tier, 'high', 'task costs stay high whatever the SQL');
});

check('the highest file wins; an empty change is medium', () => {
    const t = tierForChange([{ path: 'docs/a.md' }, { path: 'src/utils/foo.ts' }, { path: 'src/utils/stripe.ts' }]);
    assert.strictEqual(t.tier, 'high');
    assert.deepStrictEqual(t.reasons.map((r) => r.path), ['src/utils/stripe.ts']);
    assert.match(tierSummary(t), /^High \(billing.*src\/utils\/stripe\.ts\)$/);
    assert.strictEqual(tierForChange([{ path: 'docs/a.md' }, { path: 'tests/b.test.ts' }]).tier, 'low');
    assert.strictEqual(tierForChange([]).tier, 'medium');
});

check('every rule still names at least one real file (no stale rules)', () => {
    const allowedEmpty = new Set<string>();
    for (const r of TIER_RULES) {
        if (allowedEmpty.has(r.key)) continue;
        assert.ok(tracked.some((p) => r.match.some((re) => re.test(p))), `rule ${r.key} matches no tracked file`);
    }
});

const DIFF = [
    'diff --git a/src/utils/foo.ts b/src/utils/foo.ts',
    'index 1..2 100644',
    '--- a/src/utils/foo.ts',
    '+++ b/src/utils/foo.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/db/z-x.sql b/db/z-x.sql',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/db/z-x.sql',
    '@@ -0,0 +1 @@',
    '+ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar text;',
    'diff --git a/db/z-old.sql b/db/z-old.sql',
    'deleted file mode 100644',
    '--- a/db/z-old.sql',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-DROP TABLE foo;',
].join('\n');

check('a unified diff gives each file and the lines it adds', () => {
    const files = parseUnifiedDiff(DIFF);
    assert.deepStrictEqual(files.map((f) => f.path), ['src/utils/foo.ts', 'db/z-x.sql', 'db/z-old.sql']);
    assert.strictEqual(files[0].added, 'new');
    assert.strictEqual(files[2].deleted, true);
    assert.strictEqual(files[2].added, '');
    const t = tierForDiff(DIFF);
    assert.strictEqual(t.tier, 'medium', 'additive SQL + a util + a removed SQL file = medium');
});

check('renames are tiered by BOTH paths; quoted and spaced paths are read; an unreadable header is high', () => {
    const rename = [
        'diff --git a/src/utils/stripe.ts b/src/utils/money.ts',
        'similarity index 100%',
        'rename from src/utils/stripe.ts',
        'rename to src/utils/money.ts',
    ].join('\n');
    const r = parseUnifiedDiff(rename);
    assert.deepStrictEqual([r[0].path, r[0].oldPath], ['src/utils/money.ts', 'src/utils/stripe.ts']);
    assert.strictEqual(tierForDiff(rename).tier, 'high', 'moving stripe.ts out of its name must stay high');
    const quoted = 'diff --git "a/src/utils/caf\\303\\251.ts" "b/src/utils/caf\\303\\251.ts"\n--- a/x\n+++ b/x\n+hi';
    assert.deepStrictEqual(parseUnifiedDiff(quoted).map((f) => [f.path, !!f.unparsed]), [['src/utils/café.ts', false]]);
    const spaced = 'diff --git a/docs/my notes.md b/docs/my notes.md\n+x';
    assert.deepStrictEqual(parseUnifiedDiff(spaced).map((f) => f.path), ['docs/my notes.md']);
    assert.strictEqual(tierForDiff(spaced).tier, 'low');
    const odd = 'diff --git a/one two b/three four\n+x';
    const t = tierForDiff(odd);
    assert.strictEqual(t.tier, 'high');
    assert.strictEqual(t.reasons[0].key, 'unreadable');
});

check('the template fills tier + SQL and is NOT accepted until filled in', () => {
    const t = tierForDiff(DIFF);
    const tpl = evidenceTemplate(t);
    assert.match(tpl, /^Tier: Medium/m);
    assert.match(tpl, /^SQL: additive \(db\/z-x\.sql, db\/z-old\.sql\)/m);
    const c = checkEvidence(`Summary\n\n${tpl}`, 'medium');
    assert.strictEqual(c.found, true);
    assert.deepStrictEqual(c.missing, ['What changed + why', 'Proof', 'Risk if wrong', 'Rollback']);
});

check('a filled block passes; a missing block or a lower tier is caught', () => {
    const body = [
        '---EVIDENCE---',
        'Tier: Medium (additive SQL — db/z-x.sql)',
        'What changed + why: Adds bar to foo so the board can show it.',
        'Root cause: n/a (feature)',
        'Proof: tests/foo.test.ts',
        'SQL: additive (db/z-x.sql) — staging ✅',
        'Review: Pass — reviewer run on abc123',
        'Risk if wrong: the board shows a blank column; nobody loses data.',
        'Rollback: revert the PR',
        '---END-EVIDENCE---',
    ].join('\n');
    const ok = checkEvidence(body, 'medium');
    assert.deepStrictEqual(ok.missing, []);
    assert.strictEqual(ok.declaredTier, 'medium');
    assert.strictEqual(ok.tierTooLow, false);
    assert.strictEqual(checkEvidence(body, 'high').tierTooLow, true);
    const none = checkEvidence('just a description', 'low');
    assert.strictEqual(none.found, false);
    assert.ok(none.missing.length > 0);
});

console.log(`\nreview-tiers: ${passed} passed`);
