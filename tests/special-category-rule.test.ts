// tests/special-category-rule.test.ts
// The special-category refusal is in every prompt an assistant actually runs (2026-10-10). The
// go-live check passes for a built role BECAUSE of this test — if a seam stops carrying the rule,
// this fails rather than the Assistants page silently reporting a safeguard that is not there.
//
// Run:  npx tsx tests/special-category-rule.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIAL_CATEGORY_RULE } from '../src/constants/special-category-rule';
import { senderIdentityBlock } from '../src/config/sender-identity';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Comments stripped, so a seam cannot pass on a comment that only mentions the rule. */
const code = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('the rule covers every Article 9 category', () => {
    for (const t of ['health', 'racial or ethnic origin', 'political opinions', 'religious or philosophical beliefs', 'trade-union membership', 'genetic or biometric', 'sex life or sexual orientation']) {
        assert.ok(SPECIAL_CATEGORY_RULE.includes(t), t);
    }
});
check('it is about identifiable PEOPLE, so a pharmacy or a church can still write about their subject', () => {
    assert.ok(/about an identifiable person/.test(SPECIAL_CATEGORY_RULE));
    assert.ok(/information on PEOPLE, not subjects/.test(SPECIAL_CATEGORY_RULE));
});

const SEAMS: Array<[string, number]> = [
    ['netlify/functions/chat-orchestrator.ts', 2],      // both branches of buildSystemPrompt (live + handoff)
    ['netlify/functions/process-content-jobs.ts', 1],
    ['src/utils/blog-generate.ts', 1],
    ['src/utils/newsletter-generate.ts', 2],            // an email, and an email campaign step
    ['src/utils/newsletter-campaign-generate.ts', 1],
];
for (const [file, n] of SEAMS) {
    check(`${file} carries the rule (${n}×)`, () => {
        const uses = (code(file).match(/\$\{SPECIAL_CATEGORY_RULE\}|^\s*SPECIAL_CATEGORY_RULE,$/gm) || []).length;
        assert.ok(uses >= n, `${uses} use(s), expected ${n}`);
    });
}
check('chat: buildSystemPrompt returns the rule on BOTH paths (with and without set-up answers)', () => {
    const fn = code('netlify/functions/chat-orchestrator.ts');
    const body = fn.slice(fn.indexOf('function buildSystemPrompt('), fn.indexOf('const defaultRoute'));
    assert.ok(/if \(entries\.length === 0\) return `\$\{dated\}\\n\\n\$\{SPECIAL_CATEGORY_RULE\}`/.test(body));
    assert.ok(/<\/strict_configuration>\s*\n\s*\n\$\{SPECIAL_CATEGORY_RULE\}`/.test(body));
});
check('outreach: every sender block — named or not — carries the rule', () => {
    assert.ok(senderIdentityBlock({ businessName: 'Crumb & Co' }).includes(SPECIAL_CATEGORY_RULE));
    assert.ok(senderIdentityBlock({ businessName: '' }).includes(SPECIAL_CATEGORY_RULE));
});
check('the over-broad regex filter stays unwired (it would block a pharmacy\'s every message)', () => {
    for (const f of ['netlify/functions/chat-orchestrator.ts', 'netlify/functions/process-content-jobs.ts']) {
        assert.ok(!code(f).includes('sanitisePromptForTransfer'), f);
    }
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
