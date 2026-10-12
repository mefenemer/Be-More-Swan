// tests/email-merge-escaping.test.ts
// Templated emails (sendTemplatedEmail → renderTemplate → mergeTemplateParts) merge
// user-controlled values — first names, workspace and assistant names — into three parts with
// different formats. The HTML body must escape them or a name renders as markup; the subject
// and plain-text part must NOT, or the recipient reads a literal "&lt;b&gt;".

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTemplateParts } from '../src/utils/email-template';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const vars = {
    user: { first_name: '<b>x</b>' },
    link: { action_url: 'https://app.example.com/download?token=abc&kind=full' },
};
const template = {
    subject: 'Hi {{user.first_name | "there"}}',
    bodyHtml: '<p>Hi {{user.first_name | "there"}},</p><p><a href="{{link.action_url}}">Download</a></p>',
};

check('first_name is HTML-escaped in the html body', () => {
    const { body } = mergeTemplateParts(template, vars);
    assert.ok(body.includes('Hi &lt;b&gt;x&lt;/b&gt;,'), body);
    assert.ok(!body.includes('<b>x</b>'), body);
});

check('first_name is verbatim in the subject', () => {
    assert.strictEqual(mergeTemplateParts(template, vars).subject, 'Hi <b>x</b>');
});

check('first_name is verbatim in the derived plain-text part', () => {
    const { text } = mergeTemplateParts(template, vars);
    assert.ok(text.includes('Hi <b>x</b>,'), text);
    assert.ok(!text.includes('&lt;'), text);
});

check('first_name is verbatim in an admin-supplied plain-text part', () => {
    const { text } = mergeTemplateParts({ ...template, bodyText: 'Hi {{user.first_name}}' }, vars);
    assert.strictEqual(text, 'Hi <b>x</b>');
});

check('a URL var in href is attribute-encoded in html, raw in text', () => {
    const { body, text } = mergeTemplateParts(template, vars);
    assert.ok(body.includes('href="https://app.example.com/download?token=abc&amp;kind=full"'), body);
    assert.ok(text.includes('(https://app.example.com/download?token=abc&kind=full)'), text);
});

check('renderTemplate merges through mergeTemplateParts, not its own renderMergeVars calls', () => {
    const src = readFileSync(join(root, 'src/utils/email.ts'), 'utf8');
    assert.ok(src.includes('mergeTemplateParts('), 'renderTemplate no longer calls mergeTemplateParts');
    assert.ok(!src.includes('renderMergeVars('), 'email.ts merges vars itself again — escaping can drift');
});

console.log(`\n${passed} passed`);
