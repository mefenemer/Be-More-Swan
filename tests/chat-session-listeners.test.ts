// tests/chat-session-listeners.test.ts
// Every listener a chat attaches to its container must be removed by destroy(). The chat modal
// destroys the old session and mounts a new one on the SAME container ("New chat", opening another
// assistant), so a listener destroy() forgets stays attached and every card click runs twice. On
// staging (2026-10-25) the Business Mentor's four card listeners were never removed: a quiet-mode click
// saved twice, and the products card would have added every product twice.
//
// Run:  npx tsx tests/chat-session-listeners.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '../src/components/chat-session.js'), 'utf8');
const pairs = (re: RegExp) => new Set([...src.matchAll(re)].map((m) => `${m[1]} → ${m[2]}`));
const added = pairs(/container\.addEventListener\('([^']+)', (\w+)\)/g);
const removed = pairs(/container\.removeEventListener\('([^']+)', (\w+)\)/g);

const neverRemoved = [...added].filter((p) => !removed.has(p));
const removedButNeverAdded = [...removed].filter((p) => !added.has(p));

assert.ok(added.size >= 40, `only found ${added.size} container listeners — has the pattern changed?`);
assert.deepStrictEqual(neverRemoved, [], 'destroy() must remove these, or "New chat" runs every click twice');
assert.deepStrictEqual(removedButNeverAdded, [], 'destroy() removes a listener mount() never adds (renamed handler?)');
console.log(`  ✓ all ${added.size} container listeners are removed by destroy()\n\n1/1 passed`);
