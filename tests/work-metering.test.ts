// tests/work-metering.test.ts
// Background work counts against the monthly task allowance (src/utils/work-metering.ts).
//
// Until 2026-10-11 only chat and six editor buttons spent tasks, so the allowance the pricing page
// sells measured almost none of what assistants do. These checks pin the contract: every worker
// that delivers a piece of work ASKS before starting and RECORDS once it is delivered — and the
// recording happens after the success latch, so a failure or retry is never charged.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const METERING = read('src/utils/work-metering.ts');

const WORKERS: Array<[string, string, string]> = [
    // [file, kind, the success marker the record must come AFTER]
    ['netlify/functions/process-content-jobs.ts', 'social_post', 'jobCompleted = true;'],
    ['netlify/functions/process-blog-jobs.ts', 'blog_article', 'jobCompleted = true;'],
    ['netlify/functions/process-discovery-jobs.ts', 'lead_search', 'if (claimed.length === 0) return; // already published by an earlier tick'],
    ['netlify/functions/draft-newsletter-issues.ts', 'email_issue', ".set({ status: 'pending_approval', updatedAt: new Date() })"],
    ['src/utils/campaign-email-order.ts', 'email_campaign', 'const customKeys = await loadCustomFieldKeys'],
    // The Mystery Shopper: only a run that re-scored is charged, after the done+charged latch.
    ['src/utils/site-audit.ts', 'site_audit', 'if (!latched) return;'],
    // The Website Assistant's whole-site draft: charged after the draft is saved under its claim.
    ['src/utils/site-store.ts', 'site_draft', 'if (!saved) return;'],
    // "Add your own words": charged once a proposal exists (nothing saved yet — the owner applies it).
    ['src/utils/site-store.ts', 'site_words', "if ('error' in proposal) return"],
];

for (const [file, kind, marker] of WORKERS) {
    const src = read(file);
    check(`${file} asks for capacity before starting`, () => {
        assert.match(src, /hasTaskCapacity\(|hasCapacity\(/);
    });
    check(`${file} records '${kind}' only after the work is delivered`, () => {
        const rec = src.indexOf(`, '${kind}'`);   // the charge's argument, not a failure report's kind: '…'
        const ok = src.indexOf(marker);
        assert.ok(rec > -1, `no recordCompletedWork(..., '${kind}') call`);
        assert.ok(ok > -1, `success marker not found: ${marker}`);
        assert.ok(rec > ok, `the '${kind}' charge comes before the success marker — a failure would be billed`);
    });
}

check('the schedulers enqueue nothing for an org that is out of tasks', () => {
    for (const f of ['netlify/functions/draft-horizon-fill.ts', 'netlify/functions/blog-horizon-fill.ts']) {
        assert.match(read(f), /capacityMemo\(db\)/, f);
    }
});

check('metering fails OPEN — a fault must never be what stops scheduled work', () => {
    assert.match(METERING, /fail open/i);
    assert.match(METERING, /if \(!usage\.hasPlan \|\| usage\.remaining === null\) return true;/);
});

check('the record is an unconditional upsert on the UTC month the cap reads', () => {
    assert.match(METERING, /ON CONFLICT \(organisation_id, period_start\)/);
    assert.match(METERING, /getPeriodStart\(\)/);
});

check('Email Studio drafts and rewrites are metered, charged after the model returns', () => {
    const src = read('netlify/functions/newsletter-issues.ts');
    const gen = src.indexOf("if (action === 'generate')");
    assert.ok(src.indexOf('hasTaskCapacity(db, orgId)', gen) > gen, 'generate does not ask for capacity');
    assert.ok(src.indexOf("recordCompletedWork(db, orgId, 'email_issue'", gen) > src.indexOf('await generateIssueBody(db', gen),
        'generate charges before the draft exists');
});

check('charges are credited to the assistant that did the work', () => {
    const credited: Array<[string, RegExp]> = [
        ['src/utils/visual-briefs.ts', /mediaType: 'image', userId: outcome\.userId \?\? null, assistantId: row\.ai_assistant_id/],
        ['src/utils/visual-briefs.ts', /mediaType: 'video', userId: outcome\.userId \?\? null, assistantId: row\.ai_assistant_id/],
        ['src/utils/flyer-words.ts', /'flyer_words', \{.*assistantId: brief\.aiAssistantId/],
        ['src/utils/design-options.ts', /'background_removal', \{.*assistantId:/],
        ['netlify/functions/process-discovery-jobs.ts', /'lead_search', \{[^}]*assistantId:/],
        ['netlify/functions/draft-newsletter-issues.ts', /'email_issue', \{[^}]*assistantId: a\.id/],
        ['netlify/functions/newsletter-issues.ts', /'email_issue', \{[^}]*assistantId: issue\.assistantId/],
        ['src/utils/campaign-email-order.ts', /'email_campaign', \{[^}]*assistantId: target\.id/],
        ['src/utils/site-audit.ts', /'site_audit', \{[^}]*assistantId: audit\.aiAssistantId/],
        ['src/utils/site-import-store.ts', /'site_draft', \{[^}]*assistantId: site\.aiAssistantId/],
        ['src/utils/site-store.ts', /'site_draft', \{[^}]*assistantId: site\.aiAssistantId/],
        ['src/utils/site-store.ts', /'site_words', \{[^}]*assistantId: site\.aiAssistantId/],
        ['netlify/functions/regenerate-post-media.ts', /success: true, mediaType: 'image', userId, assistantId: post\.assistantId/],
        ['src/utils/blog-add-images.ts', /success: true, mediaType: 'image', userId: opts\.userId, assistantId: post\.assistantId/],
        ['netlify/functions/generate-voiceover.ts', /mediaType: 'voiceover', userId, jobId: made\.jobId, assistantId:/],
    ];
    for (const [file, pattern] of credited) assert.match(read(file), pattern, file);
});

check('admin test generations are never charged to the tenant', () => {
    assert.match(read('netlify/functions/process-content-jobs.ts'), /if \(!isAdminTest\) await recordCompletedWork/);
});

console.log(`\n${passed} checks passed.`);
