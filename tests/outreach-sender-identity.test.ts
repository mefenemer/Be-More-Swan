// tests/outreach-sender-identity.test.ts
// Every AI-written outreach email must know which business it is FROM.
//
// This exists because approved drafts for a Restorative Futures lead campaign went out signed
// "Be More Swan". No brand string was wrong — the drafting prompts simply never carried the
// sender's identity. Each one opened with `for "${assistant.name}", a business using Be More Swan`,
// which names the ASSISTANT (workspace furniture the prospect has never heard of) and the PLATFORM,
// so the only company-shaped noun in the model's context was ours and it signed off with it.
// Meanwhile the compliance footer had always read organisations.name, so a single email could be
// signed by one company and footed by another.
//
// Same shape as tests/outreach-subject-rules.test.ts, and for the same reason: FOUR seams draft
// prospect-facing prose, and a rule added to one and not the others is the failure mode. Static
// source analysis on purpose — an LLM round trip would be slow and flaky, and what regresses is a
// seam quietly dropping the injection.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENDER_IDENTITY_RULE, senderIdentityBlock } from '../src/config/sender-identity';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nOutreach sender identity\n');

// ── The seams that write something a prospect reads ────────────────────────────────────────────
const SEAMS: Array<{ file: string; label: string }> = [
    { file: 'src/lib/discovery-scoring.ts', label: 'discovery scoring (writes the draft on every discovered lead)' },
    { file: 'netlify/functions/lead-generation.ts', label: 'manual lead scoring + send-time generation' },
    { file: 'netlify/functions/process-sequence-sends.ts', label: 'sequence follow-up drafting' },
    { file: 'netlify/functions/chat-orchestrator.ts', label: 'the lead_qualifier chat route' },
];

for (const seam of SEAMS) {
    check(`${seam.label} carries the sender-identity rule`, () => {
        assert.ok(
            read(seam.file).includes('${SENDER_IDENTITY_RULE}'),
            `${seam.file} must interpolate SENDER_IDENTITY_RULE into its prompt`,
        );
    });
}

check('discovery-scoring.ts injects the rule into BOTH prompts that write a draft', () => {
    // scoreCandidates writes the draft when a lead is first found; rescoreWithIntel REWRITES it
    // after deep enrichment. Missing the second would mean "Look again" quietly reinstated the old
    // sign-off on a lead whose draft had already been fixed.
    const uses = read('src/lib/discovery-scoring.ts').match(/\$\{SENDER_IDENTITY_RULE\}/g) ?? [];
    assert.strictEqual(uses.length, 2, `expected 2 interpolations, found ${uses.length}`);
});

check('lead-generation.ts injects the rule into BOTH of its drafting prompts', () => {
    // One scores a manual lead and emits an outreachDraft; the other generates at send time when no
    // draft was stored. Exactly the split that tests/outreach-subject-rules.test.ts pins.
    const uses = read('netlify/functions/lead-generation.ts').match(/\$\{SENDER_IDENTITY_RULE\}/g) ?? [];
    assert.strictEqual(uses.length, 2, `expected 2 interpolations, found ${uses.length}`);
});

for (const seam of SEAMS.filter((s) => s.file !== 'netlify/functions/chat-orchestrator.ts')) {
    check(`${seam.label} renders the identity block, not just the rule`, () => {
        // The rule says "the only business you may name is the one identified above". Without the
        // block there is no "above", and the prohibition has nothing to point at.
        assert.ok(
            read(seam.file).includes('${senderIdentityBlock('),
            `${seam.file} must render senderIdentityBlock() alongside the rule`,
        );
    });
}

check('the chat route names the business from the org row', () => {
    // Chat resolves the business itself (rc.business, grounded in organisations — issue #199), so
    // it needs the rule but not the block. What it must NOT do is leave the sign-off unstated.
    const src = read('netlify/functions/chat-orchestrator.ts');
    assert.match(src, /signed off as \$\{rc\.business\.name\}/, 'the lead_qualifier prompt must name the sign-off explicitly');
});

// ── No seam may reintroduce the old identity line ──────────────────────────────────────────────

check('no drafting prompt describes the sender as "a business using Be More Swan"', () => {
    for (const seam of SEAMS) {
        assert.ok(
            !read(seam.file).includes('using Be More Swan'),
            `${seam.file} still tells the model the sender is "a business using Be More Swan"`,
        );
    }
});

check('no drafting prompt passes the ASSISTANT name as the sender', () => {
    // assistant.name is "Lead Generator", not a company. Passing it here is how the bug started.
    for (const file of ['src/lib/discovery-scoring.ts', 'netlify/functions/process-sequence-sends.ts']) {
        const src = read(file);
        assert.ok(
            !/assistantName: string/.test(src),
            `${file} still takes an assistantName as its sender identity`,
        );
    }
});

// ── The rule itself ────────────────────────────────────────────────────────────────────────────

check('the rule names the two names that must never be signed', () => {
    for (const phrase of ['Be More Swan', 'assistant']) {
        assert.ok(SENDER_IDENTITY_RULE.includes(phrase), `expected the rule to forbid naming "${phrase}"`);
    }
});

check('the rule covers the sign-off, not just the body', () => {
    assert.match(SENDER_IDENTITY_RULE, /sign-off/, 'the sign-off is where the wrong name actually appeared');
});

// ── The block ──────────────────────────────────────────────────────────────────────────────────

check('a named sender is stated as the sender, twice over', () => {
    const block = senderIdentityBlock({ businessName: 'Restorative Futures' });
    assert.match(block, /on behalf of Restorative Futures/);
    assert.match(block, /sign off as Restorative Futures/);
    assert.ok(!block.includes('Be More Swan'), 'the block must never name the platform');
});

check('optional org fields are rendered when present and omitted when not', () => {
    const full = senderIdentityBlock({
        businessName: 'Restorative Futures',
        businessDescription: 'Restorative practice training for schools',
        industry: 'Education',
        websiteUrl: 'https://example.org',
    });
    for (const fragment of ['Restorative practice training for schools', 'Education', 'https://example.org']) {
        assert.ok(full.includes(fragment), `expected the block to carry "${fragment}"`);
    }
    const bare = senderIdentityBlock({ businessName: 'Restorative Futures' });
    assert.strictEqual(bare.split('\n').length, 1, 'an org with no profile fields must render one line, not empty ones');
});

check('an UNNAMED sender is told not to guess', () => {
    // ⚠️ The important half. A fallback to the assistant name or the platform is what shipped; a
    // draft ending in an obvious blank is a draft a reviewer fixes, a confidently wrong sign-off
    // is one they approve.
    const block = senderIdentityBlock({ businessName: '   ' });
    assert.match(block, /not been named/i);
    assert.match(block, /Do NOT guess/);
    assert.ok(!block.includes('Be More Swan'), 'the no-name branch must not fall back to the platform');
});

// ── The footer already read the org row; the body now reads the same one ───────────────────────

check('body and footer resolve the sender from the same source', () => {
    // buildOutreachFooter has always used organisations.name. The bug was that nothing else did.
    const loader = read('src/utils/sender-identity.ts');
    assert.match(loader, /organisations\.name/, 'loadSenderIdentity must read organisations.name');
    assert.match(loader, /catch/, 'a failed org read must degrade to an unnamed sender, not throw mid-send');
});

check('every drafting seam resolves the sender from the org, not the assistant', () => {
    for (const file of ['netlify/functions/lead-generation.ts', 'netlify/functions/process-discovery-jobs.ts', 'netlify/functions/process-sequence-sends.ts']) {
        assert.match(read(file), /loadSenderIdentity\(/, `${file} must resolve the sender via loadSenderIdentity`);
    }
    // The sweep joins the org row instead — it spans many orgs in one run, so a per-lead lookup
    // would be twenty-five round trips for a row it is already selecting beside.
    assert.match(read('netlify/functions/lead-enrichment-sweep.ts'), /orgName: organisations\.name/,
        'the enrichment sweep must carry the org identity on its candidate rows');
});

console.log(`\n${passed} checks passed\n`);
