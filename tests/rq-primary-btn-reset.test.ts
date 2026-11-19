// The Posts/Review-queue "New post" button (#detail-rq-primary-btn). Its HTML says
// onclick="openGeneratePostSheet()", but a property handler overrides that attribute, and a slow
// earlier load can set one on this page's button: open the Meeting Note Taker, move on to Felix
// before its context arrives, and Felix's "New post" opened the "New meeting" form (staging,
// 2026-11-19; reproduced by delaying get-assistant-context?id=66). The render must put the default
// handler back before any role-specific branch sets its own.
// Run: npx tsx tests/rq-primary-btn-reset.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync('assistants.js', 'utf8');
const html = readFileSync('assistant-detail.html', 'utf8');

assert.match(html, /id="detail-rq-primary-btn" onclick="openGeneratePostSheet\(\)"/,
    'the button\'s default action is openGeneratePostSheet()');

const start = js.indexOf("const rqNew = rqIsRecords ? window._detailReviewQueue.newAction : null;");
assert.ok(start > -1, 'records-queue newAction block not found');
const block = js.slice(start, start + 6000);

const reset = block.indexOf('rqPrimaryBtn.onclick = () => window.openGeneratePostSheet?.()');
assert.ok(reset > -1, 'the button\'s default handler is put back on every render');
// `onclick = null` clears the attribute's handler too (same slot): the button then does nothing.
assert.ok(!/rqPrimaryBtn\.onclick = null/.test(block), 'never null — that kills the HTML attribute handler as well');
const meeting = block.indexOf('rqPrimaryBtn.onclick = () => _openRoleForm(rqNew.kind, data)');
assert.ok(meeting > -1, 'a records queue with a newAction still wires its own form');
assert.ok(reset < meeting, 'the reset comes BEFORE the newAction handler, not after it');
assert.ok(!/if \(rqNew\) \{[^}]*rqPrimaryBtn\.onclick = \(\) => window\.openGeneratePostSheet/.test(block), 'the reset is unconditional, not inside the newAction branch');

const blog = block.indexOf('window.openBlogStudio?.({ assistantId: data.id })');
const newsletter = block.indexOf("window.loadView?.('newsletter')");
assert.ok(blog > reset && newsletter > reset, 'blog and newsletter handlers are set after the reset, so they still win on their own roles');
assert.match(block, /setText\('detail-rq-primary-label', cfg\.primaryAction\?\.label \|\| 'New post'\)/,
    'posts queues put the label back ("New post" / the role\'s primary label)');

console.log('rq-primary-btn-reset: all assertions passed');
