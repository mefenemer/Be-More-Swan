// tests/blog-job-failure-message.test.ts
// Issue #40: a Blog drafting incident read "failed query: insert into ( id" — drizzle's wrapper
// message, with the table name scrubbed and the real Postgres error (on `cause`) never recorded.
// The blog worker now records the cause, so the job row and the incident name the actual fault.
//
// Run:  npx tsx tests/blog-job-failure-message.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorClass, failureMessage } from '../src/utils/platform-incident';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function drizzleError(code: string, causeMessage: string): Error {
    const cause = Object.assign(new Error(causeMessage), { code });
    return Object.assign(
        new Error('Failed query: insert into "blog_posts" ("id", "organisation_id") values (default, $1)\nparams: 5'),
        { cause },
    );
}

console.log('blog job failure message');

test('a wrapped query error reports the Postgres cause and its SQLSTATE', () => {
    const msg = failureMessage(drizzleError('42703', 'column "pillar_id" of relation "blog_posts" does not exist'));
    assert.equal(msg, 'Database error 42703: column "pillar_id" of relation "blog_posts" does not exist');
    assert.ok(!/Failed query/.test(msg));
    assert.ok(!/params:/.test(msg), 'the bound values never reach the job row');
});

test('the incident class names the fault, not the wrapper', () => {
    const cls = errorClass(failureMessage(drizzleError('23503', 'insert or update on table "blog_posts" violates foreign key constraint "blog_posts_pillar_id_fkey"')));
    assert.ok(!/failed query/.test(cls), cls);
    assert.match(cls, /^database error #: insert or update on table/);
});

test('ordinary errors and non-errors are unchanged', () => {
    assert.equal(failureMessage(new Error('Could not ground a topic')), 'Could not ground a topic');
    assert.equal(failureMessage('plain'), 'plain');
    assert.equal(failureMessage(Object.assign(new Error('Failed query: select 1'), { cause: undefined })), 'Failed query: select 1');
});

test('process-blog-jobs records failureMessage(err), not err.message', () => {
    const src = readFileSync(path.join(root, 'netlify/functions/process-blog-jobs.ts'), 'utf8');
    assert.match(src, /const message = failureMessage\(err\);/);
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
