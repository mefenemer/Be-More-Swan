// tests/stored-ips-truncated.test.ts
// The privacy policy (privacy.html) promises IP addresses are truncated before they are stored.
// Every writer of an agreement or sign-in IP must run it through pseudonymiseIp first.
// (2026-10-20: accept-tos and accept-dpa stored the full address.)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pseudonymiseIp } from '../src/utils/ip-pseudonymise';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const writers: Array<[string, RegExp]> = [
    ['netlify/functions/accept-tos.ts', /const ipAddress = pseudonymiseIp\(/],
    ['netlify/functions/accept-dpa.ts', /const ipAddress = pseudonymiseIp\(/],
    ['src/utils/login-events.ts', /const ip = pseudonymiseIp\(/],
];
for (const [file, pattern] of writers) {
    assert.ok(pattern.test(read(file)), `${file} must truncate the IP with pseudonymiseIp before storing it`);
}

// The helper itself, so the promise in the policy is what actually lands in the column.
assert.strictEqual(pseudonymiseIp('203.0.113.9'), '203.0.113.x');
assert.strictEqual(pseudonymiseIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:8d3:x:x:x:x');
assert.strictEqual(pseudonymiseIp(undefined), null);
assert.strictEqual(pseudonymiseIp('not-an-ip'), null);

console.log('stored-ips-truncated: all checks passed');
