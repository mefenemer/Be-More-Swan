// Blog keywords (2026-11-14): blog_posts.tags were written only by the AI SEO step and nobody could
// change them. A customer whose blog moved from employee wellness to women approaching retirement
// was left with the old keywords, and every new article was told to reuse them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanKeyword, normalizeKeywords, MAX_KEYWORDS, KEYWORD_MAX_LENGTH } from '../src/utils/blog-keywords';
import { keywordRule } from '../src/utils/blog-seo-generate';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const studio = read('src/components/blog-studio-modal.js');

test('a keyword is stored trimmed, lowercase and single-spaced', () => {
    assert.equal(cleanKeyword('  Retirement   Planning, '), 'retirement planning');
    assert.equal(cleanKeyword('#Wellbeing'), 'wellbeing');
    assert.equal(cleanKeyword('x'.repeat(60)).length, KEYWORD_MAX_LENGTH);
    assert.equal(cleanKeyword(null), '');
});

test('an article keeps at most 3, no duplicates, first one wins', () => {
    assert.deepEqual(normalizeKeywords(['Retirement', 'retirement ', 'Money', '', 'Health', 'Travel']), ['retirement', 'money', 'health']);
    assert.deepEqual(normalizeKeywords('retirement, money'), ['retirement', 'money'], 'a comma-separated string works');
    assert.deepEqual(normalizeKeywords(undefined), []);
    assert.equal(MAX_KEYWORDS, 3);
});

test('Blog Studio cleans keywords exactly as the server does', () => {
    const m = studio.match(/function cleanKeyword\(v\) \{\s*return (.+?);\s*\}/s);
    assert.ok(m, 'browser cleanKeyword found');
    // eslint-disable-next-line no-new-func
    const browserClean = new Function('v', 'var KW_LEN = 40; return ' + m![1] + ';') as (v: unknown) => string;
    for (const v of ['  Retirement   Planning, ', '#Wellbeing', 'A;', 'x'.repeat(60), '', 'Money.']) {
        assert.equal(browserClean(v), cleanKeyword(v), JSON.stringify(v));
    }
    assert.ok(studio.includes('var KW_MAX = 3, KW_LEN = 40;'));
});

test('every writer stores keywords through normalizeKeywords', () => {
    assert.ok(read('netlify/functions/save-blog-draft.ts').includes('updates.tags = normalizeKeywords(body.tags)'));
    assert.ok(read('netlify/functions/blog-posts.ts').includes('const tags = normalizeKeywords('));
    assert.ok(read('src/utils/blog-seo-generate.ts').includes('const tags = normalizeKeywords('));
});

test('the SEO step puts the blog\'s current topics first and never reuses a keyword just because it exists', () => {
    const r = keywordRule(['employee engagement', 'staff retention'], ['Retirement planning', 'Life after work']);
    assert.ok(r.indexOf('"Retirement planning"') < r.indexOf('"employee engagement"'), 'topics before old keywords');
    assert.match(r, /THIS post/);
    assert.match(r, /never just because it exists/);
    assert.doesNotMatch(keywordRule([], []), /current topics|already used/);
    const src = read('src/utils/blog-seo-generate.ts');
    assert.ok(src.includes("AND p.status NOT IN ('archived', 'rejected')"), 'old archived articles don\'t steer');
    assert.ok(src.includes('ORDER BY max(coalesce(p.published_at, p.updated_at)) DESC'), 'most recent first, not most used');
});

test('the endpoint lists, renames (merging) and removes, and every change is workspace-scoped', () => {
    const fn = read('netlify/functions/blog-keywords.ts');
    assert.ok(fn.includes('requireTenant(event, db)'));
    assert.ok(fn.includes("body.action === 'rename'") && fn.includes("body.action === 'remove'"));
    const util = read('src/utils/blog-keywords.ts');
    const writes = util.split('UPDATE blog_posts').slice(1);
    assert.equal(writes.length, 2);
    for (const w of writes) assert.ok(w.includes('p.organisation_id = ${organisationId}'), 'scoped to the workspace');
    assert.ok(util.includes("p.status <> 'archived'"), 'the list leaves archived articles out');
});

test('an article shows its keywords and saves each change straight away', () => {
    assert.ok(studio.includes('id="bs-kw-input"') && studio.includes('id="bs-kw-list"'));
    assert.ok(studio.includes("JSON.stringify({ id: id, tags: state.keywords })"));
    assert.ok(studio.includes('setKeywords(post && post.tags);'), 'filled from the article');
    assert.ok(studio.includes('if (Array.isArray(res.body.tags)) { setKeywords(res.body.tags);'), 'Regenerate SEO shows the new keywords');
    assert.ok(studio.includes('aria-label="Remove keyword '), 'remove buttons are labelled');
    assert.ok(studio.includes('Keywords, SEO &amp; social preview'), 'the section says it holds keywords');
});

test('Blog setup has a Keywords section that renames, merges and removes on every article', () => {
    assert.ok(studio.includes('data-bs-sec="keywords"'));
    assert.ok(studio.includes(':not([data-bs-sec=keywords])'), 'shown in Blog setup');
    assert.ok(studio.includes('#bms-blog-backdrop:not(.bs-setup) [data-bs-sec=keywords]{display:none;}'), 'hidden in an article');
    assert.ok(studio.includes('setupTab.sections = [keywords, search, widget];'), 'moved into the Blogs tab\'s Blog setup');
    assert.ok(studio.includes("btn.textContent = target ? 'Merge' : 'Save';"), 'says Merge before the click');
    assert.ok(studio.includes("{ action: 'remove', keyword: row.keyword }"));
    assert.ok(studio.includes("{ action: 'rename', from: row.keyword, to: to }"));
    assert.ok(studio.includes('Topics &amp; themes'), 'points to where new articles\' subjects are set');
});
