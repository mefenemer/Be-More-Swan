// tests/review-queue-excerpt-and-pager.test.ts
// Two Review Queue fixes from SwanJira (2026-11-01):
//   SWAN-2 — a blog card's excerpt printed Blog Studio's container directives
//            ("::::columns{cols=2} :::column Column one. ::: …") instead of the words.
//   SWAN-3 — "Show more · Showing 10 of 83" pages the SOCIAL posts but was appended after every
//            group, so it sat under all 39 blog posts and stayed visible with the posts collapsed.
//
// Run:  npx tsx tests/review-queue-excerpt-and-pager.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const assistantsJs = readFileSync('assistants.js', 'utf8');
const start = assistantsJs.indexOf('function _rqBlogExcerpt(');
assert.ok(start !== -1, '_rqBlogExcerpt is missing from assistants.js');
const end = assistantsJs.indexOf('\n}\n', start);
// eslint-disable-next-line no-new-func
const excerpt = new Function(`${assistantsJs.slice(start, end + 2)}; return _rqBlogExcerpt;`)() as (s: string) => string;

check('SWAN-2: column directives are stripped, the prose stays', () => {
    const src = '::::columns{cols=2}\n:::column\nColumn one.\n:::\n:::column\nColumn two.\n:::\n::::';
    assert.equal(excerpt(src), 'Column one. Column two.');
});

check('SWAN-2: ordinary Markdown still reads as before', () => {
    assert.equal(excerpt('# Title\n\nSome **bold** words and a [link](https://x.test).'), 'Some bold words and a link.');
});

check('SWAN-2: a colon in a sentence is not a directive', () => {
    assert.equal(excerpt('Three things: price, speed, care.'), 'Three things: price, speed, care.');
});

const html = readFileSync('workspace.html', 'utf8');
const fnBody = (name: string) => {
    const i = html.indexOf(`function ${name}(`);
    assert.ok(i !== -1, `${name} not found`);
    return html.slice(i, html.indexOf('\n}\n', i));
};

check('SWAN-3: the pager is rendered inside the Social media posts group only', () => {
    assert.match(fnBody('rqGroupSection'), /g\.key === 'posts' \? rqMoreButton\(statusKey\) : ''/);
});

check('SWAN-3: rqRenderGroups no longer appends the pager after every group', () => {
    assert.ok(!/\.join\(''\)\s*\+\s*rqMoreButton\(statusKey\)/.test(fnBody('rqRenderGroups')));
});

check('SWAN-3: loading the next page repaints the pager inside the posts group', () => {
    assert.match(fnBody('rqRepaintPostsGroup'), /\.join\(''\)\}<\/div>` \+ rqMoreButton\(statusKey\)/);
});

console.log(`\n${passed} passed`);
