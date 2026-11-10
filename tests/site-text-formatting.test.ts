// tests/site-text-formatting.test.ts
// Bold, italics and lists on hosted sites (owner, 2026-11-10: "if the user wants to add bullet points,
// how do they do that … it would be handy to have a formatting part like you get in Word").
//   1. The marks (site-rich-text.ts): **bold**, *italics*, "- " bullet and "1. " numbered lines.
//   2. The site draws them (site-render.ts) — escaped, and only in the owner's own words.
//   3. The editor shows the buttons (text-format-bar.js) above the text boxes that draw them.
//   4. Imported list items arrive as bullet lines; the chat and first draft know the marks.
//
// Run:  npx tsx tests/site-text-formatting.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { plainOf } from '../src/utils/site-rich-text';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const ctx = { preview: false, reportUrl: '/report', creditUrl: null } as never;
const site = (body: string): SiteDefinition => {
    const d = starterSite({ name: 'Format Co', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));
    d.pages[0].sections.push({ id: 'sx', type: 'text', props: { heading: 'About', body, image: null, imageSide: 'right' }, look: { background: 'auto', columns: 'auto', menuLabel: null } } as never);
    return normaliseSiteDefinition(d).definition;
};
const textSection = (body: string) => {
    const html = renderSitePage(site(body), '/', ctx).html;
    const at = html.indexOf('id="sx"');
    assert.ok(at > 0, 'text section drawn');
    return html.slice(at, html.indexOf('</section>', at));
};

console.log('1. The marks');
check('plainOf takes off bold, italics and list marks', () => {
    assert.strictEqual(plainOf('We **really** *care*.\n- One\n- Two\n1. First\n### Sub'), 'We really care.\nOne\nTwo\nFirst\nSub');
});

console.log('2. The site draws them');
check('bold and italics', () => {
    const h = textSection('We **really** care about *your* garden.');
    assert.ok(h.includes('We <strong>really</strong> care about <em>your</em> garden.'), h);
});
check('stars that are not formatting stay as typed', () => {
    const h = textSection('Rated 5* by guests, 4* by critics. 2 * 3 = 6. A lone ** pair.');
    assert.ok(!h.includes('<em>') && !h.includes('<strong>'), h);
    assert.ok(h.includes('Rated 5* by guests, 4* by critics.'), h);
});
check('a bullet list, with words before it in the same paragraph', () => {
    const h = textSection('What you get:\n- A **free** visit\n- Fixed prices\n• No call-out fee');
    assert.ok(h.includes('<p>What you get:</p><ul class="rt"><li>A <strong>free</strong> visit</li><li>Fixed prices</li><li>No call-out fee</li></ul>'), h);
});
check('a numbered list keeps its first number', () => {
    assert.ok(textSection('1. Book\n2. We come\n3. Done').includes('<ol class="rt"><li>Book</li><li>We come</li><li>Done</li></ol>'));
    assert.ok(textSection('3. Third\n4. Fourth').includes('<ol class="rt" start="3">'));
});
check('marks are escaped, never HTML', () => {
    const h = textSection('**<b>x</b>**\n- <script>y</script>');
    assert.ok(!h.includes('<b>') && !h.includes('<script>'), h);
    assert.ok(h.includes('<strong>&lt;b&gt;x&lt;/b&gt;</strong>'), h);
});
check('links still work, with bold link words', () => {
    const h = textSection('Read [our **notes**](/) first.');
    assert.ok(h.includes('<a href="/">our <strong>notes</strong></a>'), h);
});
check('the list style is in the page', () => {
    assert.ok(renderSitePage(site('x'), '/', ctx).html.includes('.rt{margin:0 0 1em;padding-left:1.4em}'));
});
check('reviews and social captions are other people\'s words: no formatting read into them', () => {
    const src = read('src/utils/site-render.ts');
    assert.ok(src.includes('<blockquote>${paragraphs(r.body, false)}</blockquote>'));
    assert.ok(src.includes('${paragraphs(post.caption, false)}'));
});

console.log('3. The editor buttons');
const bar = read('src/components/text-format-bar.js');
const editor = read('src/components/assistant-site-editor.js');
check('the bar has bold, italics, both lists, link and (text sections) subheading', () => {
    for (const f of ['bold', 'italic', 'bullets', 'numbers', 'link', 'heading']) assert.ok(bar.includes(`b('${f}'`), f);
    assert.ok(bar.includes("k === 'b' ? 'bold' : 'italic'"), 'Ctrl/⌘+B and +I');
});
check('the bar sits straight before each text box that draws formatting', () => {
    assert.ok(editor.includes("${f.plain ? '' : fmtBar({ heading: !!f.heading })}<textarea name=\"${name}\""));
    assert.ok(editor.includes('${fmtBar()}<textarea data-item-field='));
    assert.ok(editor.includes('${fmtBar()}<textarea data-site-footer'));
    assert.ok(editor.includes("${fmtBar()}<textarea name=\"l-body\""));
    assert.ok(editor.includes("label: 'Line under the headline', plain: true"), 'the hero line is drawn plain');
});
check('the workspace loads the bar before the editor needs it', () => {
    const ws = read('workspace.html');
    const at = ws.indexOf('<script src="/src/components/text-format-bar.js"></script>');
    assert.ok(at > 0);
});

console.log('4. Import, chat and first draft');
check('imported list items become bullet lines', () => {
    assert.ok(read('src/utils/site-import.ts').includes("b.block.kind === 'item' ? `- ${withLinks(b.block)"));
});
check('the chat and first draft are told the marks', () => {
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('**words** is bold and *words* italics'));
    assert.ok(read('src/utils/site-draft.ts').includes('may use **bold** for a few key words and "- " lines'));
});

console.log(`\n${passed}/${total} passed`);
