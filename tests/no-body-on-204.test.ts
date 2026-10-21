// tests/no-body-on-204.test.ts
// A 204 must carry NO body — not even ''.
//
// @netlify/aws-lambda-compat (withLambda) turns `{ statusCode, body }` into `new Response(body, …)`,
// and only a null/undefined body is left out. `body: ''` reaches the constructor, which throws
// "Invalid response status code 204", so the function answers 502. Found 2026-10-21 on prod, where
// it had been true since the functions moved onto withLambda (2026-08-19):
//   · every CORS preflight (OPTIONS) on audience-public, audience-api and widget-api failed — an
//     embedded sign-up form on a customer's own site could not subscribe anyone;
//   · every blog-widget and Swan Index read beacon answered 502 (the write had already happened).
//
// Run:  npx tsx tests/no-body-on-204.test.ts

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'netlify', 'functions');
/** The object literal enclosing `at`: from its `{` to the matching `}`, nested braces included. */
function enclosingObject(src: string, at: number): string {
    let depth = 0, start = at;
    for (let i = at; i >= 0; i--) {
        if (src[i] === '}') depth++;
        else if (src[i] === '{') { if (depth === 0) { start = i; break; } depth--; }
    }
    depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return src.slice(start);
}

const offenders: string[] = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/statusCode:\s*(204|205|304)\b/g)) {
        // Only TOP-level keys of that object: strip nested objects (headers) before looking.
        const obj = enclosingObject(src, m.index!).slice(1, -1).replace(/\{[^{}]*\}/g, '{}');
        if (/\bbody\s*:/.test(obj)) offenders.push(`${f}:${src.slice(0, m.index!).split('\n').length}`);
    }
}
assert.deepStrictEqual(offenders, [], `204/205/304 with a body (502s under withLambda): ${offenders.join(', ')}`);
console.log('  ✓ no function returns a body with a 204, 205 or 304');
