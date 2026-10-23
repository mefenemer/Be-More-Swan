// tests/owner-fixes-2026-10-23.test.ts
// The owner's list of 2026-10-23: blog categories that multiplied, a blog title printed twice on
// LinkedIn, "| Welcome" beside the logo on the home page, the value hero above the team roster,
// article cards on the Review page that looked unlike post cards, the Calendar's assistant picker,
// Audience ▸ Reviews as a searchable list, and a price on the Refer a Friend claim button.
//
// Run:  npx tsx tests/owner-fixes-2026-10-23.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { menuCategories, MAX_MENU_CATEGORIES } from '../src/utils/blog-list-query';
import { stripLeadingTitleHeading } from '../src/utils/blog-destinations/syndicate';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const slice = (src: string, a: string, b: string) => {
    const i = src.indexOf(a); assert.notStrictEqual(i, -1, `marker gone: ${a}`);
    const j = src.indexOf(b, i); assert.notStrictEqual(j, -1, `marker gone: ${b}`);
    return src.slice(i, j);
};

check('blog categories: the SEO step is shown the categories in use and keeps to three', () => {
    const seo = read('src/utils/blog-seo-generate.ts');
    assert.ok(seo.includes('const existing = await existingCategories(db, organisationId, id);'));
    assert.ok(seo.includes('REUSE one of these existing categories'));
    assert.ok(seo.includes('const MAX_CATEGORIES = 3;') && seo.includes('.slice(0, MAX_CATEGORIES)'));
    assert.ok(!seo.includes('3-6 short lowercase strings'), 'the old "invent 3–6" instruction is gone');
});

check('blog categories: the reader menu keeps shared categories, capped', () => {
    const c = (value: string, count: number) => ({ value, label: value, count });
    assert.deepEqual(menuCategories([c('a', 5), c('b', 2), c('c', 1), c('d', 1)]).map((x) => x.value), ['a', 'b']);
    // A young blog where nothing is shared yet still gets a menu.
    assert.deepEqual(menuCategories([c('a', 1), c('b', 1)]).map((x) => x.value), ['a', 'b']);
    const many = Array.from({ length: 30 }, (_, i) => c(`t${i}`, 3));
    assert.equal(menuCategories(many).length, MAX_MENU_CATEGORIES);
});

check('blog title: a syndicated copy drops only the LEADING H1', () => {
    assert.equal(stripLeadingTitleHeading('# Title\n\nBody'), 'Body');
    assert.equal(stripLeadingTitleHeading('\n# Title\nBody'), 'Body');
    assert.equal(stripLeadingTitleHeading('Intro\n\n# Section\n\nMore'), 'Intro\n\n# Section\n\nMore');
    assert.equal(stripLeadingTitleHeading('## Subhead first\n\nBody'), '## Subhead first\n\nBody');
});

check('blog title: Blog Studio shows the body without its own H1 and adopts it as the title', () => {
    const bs = read('src/components/blog-studio-modal.js');
    const open = slice(bs, 'function openWorkspace(postId, title, md, post) {', 'state.editor = window.MarkdownEditor.mount({');
    assert.ok(open.includes('var split = splitLeadingHeading(md);') && open.includes('md = split.body;'));
    const apply = slice(bs, 'function applyAiDraft(jobId, topic, postId) {', 'state.editor.setMarkdown(md);');
    assert.ok(apply.includes('md = split.body;') && apply.includes('var newTitle = split.heading || topic;'));
});

check('"| Welcome" is not set on the home page (or any page that shares the title map)', () => {
    for (const f of ['index.html', 'dashboard.html', 'dpa.html', 'logout.html', 'terms_of_service.html', 'privacy.html']) {
        assert.ok(!read(f).includes('"Welcome"'), f);
    }
});

check('Dashboard: the value hero sits above Your team', () => {
    const dash = read('dashboard-content.html');
    assert.ok(dash.indexOf('<section id="command-center-hero"') < dash.indexOf('<section id="dash-team"'));
});

check('Review page: an article card wears the same state chip and origin pill as a post card', () => {
    const ws = read('workspace.html');
    const card = slice(ws, 'function rqRenderBlogCard(', 'function _rqEsc(');
    assert.ok(card.includes('const chip = _rqStateChip({ status: post.status });'), 'same chip table → "Needs your review"');
    assert.ok(card.includes('${statusChip}') && card.includes('${statusChipPhone}'), 'chip on both widths');
    assert.ok(card.includes('RQ_ORIGIN_CLS'), 'same origin pill colour');
    assert.match(slice(ws, 'const RQ_STATE_CHIP = {', '};'), /archived:/);
});

check('Calendar: the assistant filter is a picker with colour tile and role, not a <select>', () => {
    const html = read('calendar.html');
    const js = read('calendar.js');
    assert.ok(!/<select id="cal-assistant-filter"/.test(html));
    assert.ok(html.includes('id="cal-assistant-filter-btn"') && html.includes('id="cal-assistant-filter-list"'));
    const paint = slice(js, 'function _paintAssistantPicker() {', 'if (!window._calAssistantPickerDocBound)');
    assert.ok(paint.includes('C.colorFor(a.id, a.avatarColor)') && paint.includes('_escHtml(a.role'), 'colour and role per row');
    assert.ok(js.includes('window._calAssistantPickerDocBound = true;'), 'document listeners bind once');
});

check('Audience ▸ Reviews: a searchable, filterable, groupable list; add and settings behind buttons', () => {
    const aud = read('audience.html');
    const panel = slice(aud, '<div class="hidden" data-aud-panel="reviews">', '</div><!-- /aud panel: reviews -->');
    for (const id of ['rv-q', 'rv-f-rating', 'rv-f-source', 'rv-f-status', 'rv-group', 'rv-sort', 'rv-add-open', 'rv-settings-open']) {
        assert.ok(panel.includes(`id="${id}"`), id);
    }
    assert.ok(panel.includes('>Review Settings</button>'));
    assert.ok(/<div id="rv-modal" data-dialog/.test(panel) && /<div id="rq-modal" data-dialog/.test(panel), 'both are page dialogs');
    assert.ok(/<div id="rv-modal"[\s\S]*<form id="rv-form"/.test(panel), 'the add form lives in the dialog');
});

check('Refer a Friend: the claim button names no price', () => {
    const ref = read('referral-content.html');
    assert.ok(!ref.includes('off your next bill)`'));
    assert.ok(ref.includes("btn.textContent = 'Claim a free month';"));
    assert.ok(!ref.includes('bg-[#00e55c]'), 'buttons use the button system, not a hard-coded green');
});

console.log(`\n${passed} checks passed`);
