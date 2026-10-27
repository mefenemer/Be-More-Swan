// tests/email-preheader-merge.test.ts
// The inbox preview line (preheader) was handed to renderMasterTemplate without going through the
// merge engine, so the Business Mentor's weekly email showed
// `{{review.proposals | "Your week, compared with your plan"}}` as its preview text (prod, Oct 2026).
// Every catalog preheader must come out of the merge with no `{{` left, filled or with its default.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTemplateParts, renderMasterTemplate } from '../src/utils/email-template';
import { TEMPLATE_DEFAULTS, getTemplateDefault } from '../src/utils/email-templates-catalog';
import { mentorReviewLink } from '../src/utils/mentor-review';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

function preheaderHtml(html: string): string {
    return html.match(/<div style="display:none;max-height:0;overflow:hidden;opacity:0;">([^<]*)<\/div>/)?.[1] ?? '';
}

check('mentor weekly review: preheader uses its default when no proposals line is given', () => {
    const t = getTemplateDefault('mentor_weekly_review')!;
    const { body, preheader } = mergeTemplateParts(t, {});
    assert.strictEqual(preheader, 'Your week, compared with your plan');
    const shown = preheaderHtml(renderMasterTemplate(body, { preheader }));
    assert.ok(!shown.includes('{{'), `preheader rendered with a raw merge tag: ${shown}`);
});

check('mentor weekly review: preheader is filled from review.proposals', () => {
    const t = getTemplateDefault('mentor_weekly_review')!;
    const { preheader } = mergeTemplateParts(t, { review: { proposals: '2 suggestions to look at' } });
    assert.strictEqual(preheader, '2 suggestions to look at');
});

check('no catalog preheader leaves a {{ in the rendered email', () => {
    for (const t of TEMPLATE_DEFAULTS) {
        if (!t.preheader) continue;
        const { body, preheader } = mergeTemplateParts(t, {});
        const shown = preheaderHtml(renderMasterTemplate(body, { preheader }));
        assert.ok(!shown.includes('{{'), `${t.triggerKey}: preheader rendered as "${shown}"`);
    }
});

check('renderTemplate wraps the MERGED preheader, not the raw template one', () => {
    const src = readFileSync(join(root, 'src/utils/email.ts'), 'utf8');
    assert.ok(!/renderMasterTemplate\([^)]*src\?\.preheader/.test(src), 'renderTemplate passes the unmerged src.preheader to the wrapper');
});

check('"Open my review" opens the Mentor with its review chat, not the bare dashboard', () => {
    assert.strictEqual(mentorReviewLink('https://bms.test', 7, 42), 'https://bms.test/workspace.html?view=assistant-detail&assistantId=7&chatSessionId=42');
    assert.strictEqual(mentorReviewLink('https://bms.test', 7, null), 'https://bms.test/workspace.html?view=assistant-detail&assistantId=7');
    const ws = readFileSync(join(root, 'workspace.html'), 'utf8');
    assert.ok(ws.includes("qs.get('chatSessionId')"), 'workspace.html no longer reads ?chatSessionId= on the assistant-detail deep link');
});

console.log(`\n${passed} passed`);
