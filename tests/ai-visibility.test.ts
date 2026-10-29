// tests/ai-visibility.test.ts
// Admin → Platform → AI Visibility (admin-ai-visibility.ts, ai-visibility-fetch-background.ts,
// src/utils/ai-visibility.ts, db/z-ai-visibility.sql).
//
// The numbers on that page decide where marketing effort goes, and every way they can be wrong is
// quiet: a skipped assistant counted as "not named" drags a rate down, a common word counted as a
// competitor inflates the tally, a fetch that overwrote a hand-typed answer erases the admin's
// judgement. Each check below is aimed at one of those.
//
// Run:  npx tsx tests/ai-visibility.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import {
    ASSISTANTS, AUTO_ASSISTANTS, CATEGORY_KEYS, detectMention, detectCompetitors, summarise, cleanCompetitors,
    AUTO_ANSWER_SYSTEM, type AnswerRow,
} from '../src/utils/ai-visibility';
import { readOpenAiResponse } from '../netlify/functions/ai-visibility-fetch-background';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('Reading an answer');

check('a numbered list: named, with its place among the list items', () => {
    const text = 'Here are some options:\n\n1. **Buffer** – scheduling\n2. **Jasper** – writing\n3. **Be More Swan** – a team of AI assistants\n\nHope that helps.';
    assert.deepStrictEqual(detectMention(text), { mentioned: true, position: 3, link: 'no_link' });
});

check('a bullet list ranks too, when the entry leads with our name; "BeMoreSwan" and odd spacing match', () => {
    assert.strictEqual(detectMention('- Later\n- be more  swan').position, 2);
    assert.strictEqual(detectMention('- **Buffer** — x\n- [BeMoreSwan](https://bemoreswan.com) — y').position, 2);
});

check('a numbered entry keeps its own number, even when the list has gaps or bold numbers', () => {
    assert.strictEqual(detectMention('**4.** **Be More Swan** — assistants').position, 4);
    assert.strictEqual(detectMention('Intro\n\n1. Buffer\n\n   details\n\n2. Be More Swan').position, 2);
});

check('a heading is a section, not a ranking (the "Be More Swan or Buffer" case scored 7 on 2026-10-29)', () => {
    const comparison = '**Short answer: use Buffer if you mainly schedule.**\n\n## Why I\'d pick Buffer\n\n- you know what to post;\n- want a calendar;\n- need TikTok;\n- care about analytics;\n- want a free plan.\n\n## When Be More Swan makes more sense\n\nChoose **Be More Swan** if you:\n\n- want the tool to write the posts for you;\n- also want blog posts.';
    assert.deepStrictEqual(detectMention(comparison), { mentioned: true, position: null, link: 'no_link' });
    assert.strictEqual(detectMention('### Hootsuite\nok\n### BeMoreSwan\nok').position, null);
});

check('a list item that only mentions us mid-sentence is not us being ranked', () => {
    assert.strictEqual(detectMention('1. You choose an assistant in Be More Swan.\n2. You connect your tools.').position, null);
    assert.strictEqual(detectMention('- Tools like Be More Swan can help').position, null);
});

check('bullet places are counted within their own list, restarting after a heading or paragraph', () => {
    assert.strictEqual(detectMention('Schedulers:\n- Buffer\n- Later\n\nWriters:\n- Jasper\n- Be More Swan').position, 2);
});

check('named only in prose: mentioned, but no position (not a ranked recommendation)', () => {
    assert.deepStrictEqual(detectMention('You could also look at Be More Swan, which drafts posts.'), { mentioned: true, position: null, link: 'no_link' });
});

check('a citation to bemoreswan.com is a link to our site, even with no name in the text', () => {
    assert.deepStrictEqual(detectMention('See the pricing page.', ['https://www.bemoreswan.com/pricing']), { mentioned: true, position: null, link: 'our_site' });
    assert.strictEqual(detectMention('Be More Swan', ['https://notbemoreswan.com.evil.example/']).link, 'no_link', 'a lookalike host is not ours');
});

check('not named: nothing to rank or link', () => {
    assert.deepStrictEqual(detectMention('Try Buffer or Hootsuite.'), { mentioned: false, position: null, link: null });
});

check('competitors are matched by name, case-sensitively, so ordinary words are not counted', () => {
    assert.deepStrictEqual(detectCompetitors('Buffer and Sprout Social are popular. Copy.ai writes captions.'), ['Buffer', 'Sprout Social', 'Copy.ai']);
    assert.deepStrictEqual(detectCompetitors("I'll explain later. Add a buffer of time. A starter kit helps."), []);
});

check('an assistant naming itself is not a competitor in its own answer', () => {
    assert.deepStrictEqual(detectCompetitors('You could just use ChatGPT or Jasper.', 'chatgpt'), ['Jasper']);
    assert.deepStrictEqual(detectCompetitors('You could just use ChatGPT or Jasper.', 'claude'), ['Jasper', 'ChatGPT']);
});

check('the OpenAI Responses reply is read from message → output_text, with url_citation links', () => {
    const r = readOpenAiResponse({ output: [
        { type: 'web_search_call', action: { type: 'search' } },
        { type: 'message', content: [{ type: 'output_text', text: 'Try Be More Swan.', annotations: [
            { type: 'url_citation', url: 'https://bemoreswan.com/' }, { type: 'url_citation', url: 'https://bemoreswan.com/' }] }] },
    ] });
    assert.deepStrictEqual(r, { text: 'Try Be More Swan.', urls: ['https://bemoreswan.com/'] });
    assert.deepStrictEqual(readOpenAiResponse({}), { text: '', urls: [] });
});

check('the API prompt gives location only — nothing that steers the answer towards us', () => {
    assert.match(AUTO_ANSWER_SYSTEM, /United Kingdom/);
    assert.doesNotMatch(AUTO_ANSWER_SYSTEM, /swan|small business|marketing/i);
});

console.log('The summary');

const Q = [{ id: 1, category: 'category' }, { id: 2, category: 'category' }, { id: 3, category: 'brand' }];
const row = (questionId: number, assistant: string, mentioned: boolean | null, extra: Partial<AnswerRow> = {}): AnswerRow =>
    ({ questionId, assistant, mentioned, position: null, link: null, accurate: null, competitors: [], ...extra });

check('a skipped or failed cell is not "answered", so it never drags a rate down', () => {
    const s = summarise([row(1, 'claude', true), row(2, 'claude', false), row(1, 'gemini', null)], Q);
    assert.strictEqual(s.overall.answered, 2);
    assert.strictEqual(s.overall.mentionRate, 0.5);
    const gemini = s.byAssistant.find((a) => a.key === 'gemini')!;
    assert.strictEqual(gemini.answered, 0);
    assert.strictEqual(gemini.mentionRate, null, 'no answers = no rate, not 0%');
});

check('"unprompted" leaves out the questions that name us', () => {
    const s = summarise([row(1, 'claude', false), row(2, 'claude', false), row(3, 'claude', true)], Q);
    assert.strictEqual(s.overall.mentionRate, 1 / 3);
    assert.strictEqual(s.unprompted.mentionRate, 0);
    assert.strictEqual(s.byCategory.find((c) => c.key === 'brand')!.mentionRate, 1);
});

check('average place uses only answers that ranked us; accuracy is out of the answers that named us', () => {
    const s = summarise([
        row(1, 'claude', true, { position: 2, accurate: 'yes', link: 'our_site' }),
        row(2, 'claude', true, { position: 4, accurate: 'partly' }),
        row(3, 'claude', true, { accurate: 'yes' }),
        row(1, 'chatgpt', false, { position: 9, accurate: 'yes' }), // stale fields on a "no" are ignored
    ], Q);
    assert.strictEqual(s.overall.avgPosition, 3);
    assert.strictEqual(s.overall.accurate, 2);
    assert.strictEqual(s.overall.accurateRate, 2 / 3);
    assert.strictEqual(s.overall.linkedUs, 1);
});

check('the competitor tally counts across answers, most named first', () => {
    const s = summarise([row(1, 'claude', false, { competitors: ['Buffer', 'Jasper'] }), row(2, 'chatgpt', false, { competitors: ['Buffer'] })], Q);
    assert.deepStrictEqual(s.competitors, [{ name: 'Buffer', count: 2 }, { name: 'Jasper', count: 1 }]);
});

check('typed competitor lists are trimmed and de-duplicated', () => {
    assert.deepStrictEqual(cleanCompetitors(' Jasper, buffer ,Buffer,, '), ['Jasper', 'buffer']);
});

console.log('Database and server');

const sql = read('db/z-ai-visibility.sql');

check('the migration seeds 25 questions, every one with a known type, and never overwrites on re-run', () => {
    const rows = [...sql.matchAll(/^\s*\('(category|industry|comparison|brand)',\s*'/gm)];
    assert.strictEqual(rows.length, 25);
    assert.ok(rows.every((m) => CATEGORY_KEYS.includes(m[1])));
    assert.match(sql, /ON CONFLICT \(text\) DO NOTHING/);
});

check('the SQL allows exactly the assistants the code knows, and one answer per cell', () => {
    const allowed = sql.match(/assistant IN \(([^)]+)\)/)![1].match(/'([a-z_]+)'/g)!.map((s) => s.replace(/'/g, ''));
    assert.deepStrictEqual(allowed.sort(), ASSISTANTS.map((a) => a.key).sort());
    assert.match(sql, /UNIQUE \(run_id, question_id, assistant\)/);
});

check('the SQL is safe to paste into the Neon editor: no DO blocks, idempotent creates', () => {
    assert.doesNotMatch(sql, /\$\$/, 'dollar-quoted bodies break the editor\'s statement splitter');
    assert.strictEqual((sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
});

check('only Claude and ChatGPT are fetched automatically', () => {
    assert.deepStrictEqual([...AUTO_ASSISTANTS].sort(), ['chatgpt', 'claude']);
});

check('Claude calls get a real budget, not the gateway\'s 24 s per-attempt default (22 of 25 timed out)', () => {
    const src = read('netlify/functions/ai-visibility-fetch-background.ts');
    assert.match(src, /deadlineMs: CLAUDE_BUDGET_MS/);
    const budget = Number(src.match(/const CLAUDE_BUDGET_MS = ([\d_]+);/)![1].replace(/_/g, ''));
    const stopAfter = src.match(/const STOP_STARTING_AFTER_MS = (\d+) \* 60 \* 1000;/)!;
    assert.ok(budget >= 120_000, 'a web-search answer takes ~45 s; leave room for searches and a pause_turn resume');
    assert.ok(Number(stopAfter[1]) * 60_000 + budget <= 15 * 60_000, 'the last call started must finish inside the 15-minute background limit');
});

check('the fetcher never replaces an answer an admin typed in, even mid-run', () => {
    const src = read('netlify/functions/ai-visibility-fetch-background.ts');
    assert.match(src, /if \(prev\?\.source === 'manual'\) continue;/);
    assert.match(src, /if \(row\?\.source === 'manual'\) return;/);
    assert.match(src, /auth\.replace\(\/\^Bearer\\s\+\/i, ''\)\.trim\(\) !== secret/, 'internal trigger only');
});

check('the admin API is gated on platform_config and reports a missing table as "not set up"', () => {
    const src = read('netlify/functions/admin-ai-visibility.ts');
    assert.match(src, /hasPermission\(row\?\.role, 'platform_config'\)/);
    assert.match(src, /if \(isMissingTable\(err\)\) return json\(200, \{ setUp: false \}\)/);
});

console.log('Admin page');

const html = read('admin.html');
const $ = cheerio.load(html);

check('the nav entry sits under Platform → Insights with the permission the API enforces', () => {
    assert.match(html, /\{ view: 'ai-visibility',\s+icon: '🔎', label: 'AI Visibility',\s+perm: 'platform_config',\s+group: 'Insights' \}/);
    assert.match(html, /if \(view === 'ai-visibility'\)\s+loadAiVisibility\(\);/);
    assert.match(html, /'ai-visibility': 'AI Visibility'/);
});

check('the section exists and the answer form is NOT inside any .admin-view (it would never open)', () => {
    assert.strictEqual($('#view-ai-visibility.admin-view').length, 1);
    assert.strictEqual($('#aiv-modal').length, 1);
    assert.strictEqual($('#aiv-modal').parents('.admin-view').length, 0);
});

check('every element id the script reads exists in the page', () => {
    const start = html.indexOf("const AIV_API = '/.netlify/functions/admin-ai-visibility';");
    assert.ok(start > 0, 'script landmark missing');
    const script = html.slice(start, html.indexOf("const COUPONS_API = '/.netlify/functions/admin-coupons';", start));
    const ids = [...new Set([...script.matchAll(/getElementById\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
    const missing = ids.filter((id) => $(`#${id}`).length === 0);
    assert.deepStrictEqual(missing, []);
});

check('the hand-filled assistants are reachable from the top, not only from the grid 2,400px down', () => {
    const body = $('#aiv-run-body').html() || '';
    assert.ok($('#aiv-fill').length === 1, 'fill-in buttons host missing');
    assert.ok(body.indexOf('id="aiv-fill"') < body.indexOf('id="aiv-grid"'), 'fill-in buttons must come before the grid');
    assert.ok(body.indexOf('id="aiv-grid"') < body.indexOf('id="aiv-by-assistant"'), 'the grid must come before the breakdown tables');
    assert.match(html, /function aivStartColumn\(assistant\)/);
    assert.match(html, /\+ Add<\/span>/, 'an empty cell must look clickable');
});

check('the form walks a column: Save & next, Previous, and the buttons stay pinned in view', () => {
    assert.match(html, /onclick="aivSaveAnswer\(true\)"/);
    assert.match(html, /onclick="aivStep\(-1\)"/);
    assert.ok($('#aiv-m-next').closest('.sticky').length === 1, 'the action buttons must be sticky inside the form');
});

check('the page uses the styled dialogs, never native confirm/prompt', () => {
    const start = html.indexOf("const AIV_API = '/.netlify/functions/admin-ai-visibility';");
    const script = html.slice(start, html.indexOf("const COUPONS_API", start));
    assert.doesNotMatch(script, /[^.]\b(confirm|prompt|alert)\(/);
    assert.match(script, /window\.confirmModal\(/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
