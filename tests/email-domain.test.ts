// tests/email-domain.test.ts
// Business-domain detection for org grouping (src/utils/email-domain.ts).
// Run:  npx tsx tests/email-domain.test.ts

import assert from 'node:assert';
import { domainOf, isPublicEmailDomain, businessDomainOf } from '../src/utils/email-domain';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('domainOf extracts the lowercased host', () => {
    assert.equal(domainOf('Jane@Acme.CO.uk'), 'acme.co.uk');
    assert.equal(domainOf('  bob@example.com  '), 'example.com');
});

check('domainOf returns null for non-emails', () => {
    assert.equal(domainOf('notanemail'), null);
    assert.equal(domainOf('a@nodot'), null);
    assert.equal(domainOf(''), null);
    assert.equal(domainOf(null), null);
});

check('public providers are detected', () => {
    for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.com', 'icloud.com', 'proton.me'])
        assert.equal(isPublicEmailDomain(d), true, d);
});

check('business domains are not public', () => {
    for (const d of ['acme.com', 'bemoreswan.com', 'my-startup.io'])
        assert.equal(isPublicEmailDomain(d), false, d);
});

check('unknown/null domain is treated as public (never group)', () => {
    assert.equal(isPublicEmailDomain(null), true);
    assert.equal(isPublicEmailDomain(''), true);
});

check('businessDomainOf returns the host only for business emails', () => {
    assert.equal(businessDomainOf('jane@acme.com'), 'acme.com');
    assert.equal(businessDomainOf('jane@gmail.com'), null);   // public → no grouping
    assert.equal(businessDomainOf('notanemail'), null);
});

console.log(`\n${passed} checks passed.`);
