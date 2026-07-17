// tests/safe-fetch.test.ts
// SSRF guards for user-supplied URLs (src/utils/safe-fetch.ts).
//
// Run:  npx tsx tests/safe-fetch.test.ts
//
// Security-critical: the Inspo tab lets users hand us URLs that the SERVER fetches, which
// hands them our Lambda's network position. A miss here means cloud-metadata credential
// theft (169.254.169.254) or reaching VPC-internal services. These assertions are the
// feature's actual security boundary.
//
// COVERAGE NOTE: address classification + URL validation are pure and covered exhaustively
// below. Redirect-chain re-validation, the streamed byte cap and the timeout are NOT covered
// here — exercising them needs a reachable endpoint on a PUBLIC address, and any server this
// test could bind (127.0.0.1) is one the guard is supposed to refuse. Deliberately not
// weakened with a test-only bypass: a backdoor through the check would be a worse bug than
// the coverage gap. The redirect loop re-runs resolveToPublicAddresses() per hop, so it
// inherits the classification guarantees proven here.

import assert from 'node:assert';
import { isPublicIp, safeFetchText, SafeFetchError } from '../src/utils/safe-fetch';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/** Assert safeFetchText rejects, and for the stated reason (not some incidental failure). */
async function rejects(url: string, reason: string): Promise<void> {
    try {
        await safeFetchText(url, { timeoutMs: 2000 });
    } catch (err) {
        assert.ok(err instanceof SafeFetchError, `expected SafeFetchError, got ${(err as Error).name}`);
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}'`);
        return;
    }
    assert.fail(`expected ${url} to be rejected (${reason}) but it resolved`);
}

console.log('\nsafe-fetch: address classification');

check('cloud metadata address is not public', () => {
    // The one that matters most: reaching this on AWS returns IAM credentials.
    assert.equal(isPublicIp('169.254.169.254'), false);
});

check('loopback is not public', () => {
    assert.equal(isPublicIp('127.0.0.1'), false);
    assert.equal(isPublicIp('127.255.255.254'), false);
});

check('RFC1918 private ranges are not public', () => {
    assert.equal(isPublicIp('10.0.0.1'), false);
    assert.equal(isPublicIp('10.255.255.255'), false);
    assert.equal(isPublicIp('172.16.0.1'), false);
    assert.equal(isPublicIp('172.31.255.255'), false);
    assert.equal(isPublicIp('192.168.1.1'), false);
});

check('addresses just OUTSIDE 172.16/12 are public (mask maths)', () => {
    // 172.16.0.0/12 spans 172.16–172.31. An off-by-one mask would wrongly swallow these,
    // which would be a silent availability bug rather than a security one — still wrong.
    assert.equal(isPublicIp('172.15.255.255'), true);
    assert.equal(isPublicIp('172.32.0.0'), true);
});

check('other reserved ranges are not public', () => {
    assert.equal(isPublicIp('0.0.0.0'), false);
    assert.equal(isPublicIp('100.64.0.1'), false);      // CGNAT
    assert.equal(isPublicIp('224.0.0.1'), false);       // multicast
    assert.equal(isPublicIp('255.255.255.255'), false); // broadcast (inside 240/4)
});

check('ordinary public addresses are public', () => {
    assert.equal(isPublicIp('8.8.8.8'), true);
    assert.equal(isPublicIp('1.1.1.1'), true);
    assert.equal(isPublicIp('93.184.216.34'), true);
});

check('IPv6 loopback / unspecified / ULA / link-local are not public', () => {
    assert.equal(isPublicIp('::1'), false);
    assert.equal(isPublicIp('::'), false);
    assert.equal(isPublicIp('fc00::1'), false);
    assert.equal(isPublicIp('fd12:3456::1'), false);
    assert.equal(isPublicIp('fe80::1'), false);
    assert.equal(isPublicIp('ff02::1'), false);
});

check('IPv4-mapped IPv6 cannot smuggle a private address', () => {
    // The bypass this exists to stop: a v6-shaped string wrapping the metadata IP.
    assert.equal(isPublicIp('::ffff:169.254.169.254'), false);
    assert.equal(isPublicIp('::ffff:127.0.0.1'), false);
    assert.equal(isPublicIp('::ffff:10.0.0.1'), false);
    // Same thing in hex form (::ffff:a9fe:a9fe === ::ffff:169.254.169.254).
    assert.equal(isPublicIp('::ffff:a9fe:a9fe'), false);
    assert.equal(isPublicIp('::ffff:7f00:1'), false);
});

check('NAT64-embedded private address is not public', () => {
    assert.equal(isPublicIp('64:ff9b::169.254.169.254'), false);
    assert.equal(isPublicIp('64:ff9b::a9fe:a9fe'), false);
});

check('IPv4-mapped PUBLIC address stays public', () => {
    assert.equal(isPublicIp('::ffff:8.8.8.8'), true);
});

check('public IPv6 is public', () => {
    assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

check('garbage is not treated as public', () => {
    assert.equal(isPublicIp('not-an-ip'), false);
    assert.equal(isPublicIp(''), false);
});

(async () => {
    console.log('\nsafe-fetch: URL validation');

    await checkAsync('file:// scheme rejected', () => rejects('file:///etc/passwd', 'bad_scheme'));
    await checkAsync('gopher:// scheme rejected', () => rejects('gopher://example.com/', 'bad_scheme'));
    await checkAsync('data: URI rejected', () => rejects('data:text/html,<b>hi</b>', 'bad_scheme'));
    await checkAsync('malformed URL rejected', () => rejects('http://[not a url', 'invalid_url'));

    await checkAsync('embedded credentials rejected', () =>
        // Classic laundering trick: the real host is after the @.
        rejects('http://user:pass@169.254.169.254/latest/meta-data/', 'embedded_credentials'));

    console.log('\nsafe-fetch: private targets refused (no egress — DNS/literals only)');

    await checkAsync('metadata IP literal refused', () =>
        rejects('http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'private_address'));

    await checkAsync('loopback literal refused', () => rejects('http://127.0.0.1:8888/', 'private_address'));
    await checkAsync('private literal refused', () => rejects('http://10.0.0.5/admin', 'private_address'));
    await checkAsync('192.168 literal refused', () => rejects('https://192.168.1.1/', 'private_address'));

    await checkAsync('IPv6 loopback literal refused', () => rejects('http://[::1]:9000/', 'private_address'));
    await checkAsync('IPv4-mapped metadata literal refused', () =>
        rejects('http://[::ffff:169.254.169.254]/', 'private_address'));

    await checkAsync('hostname RESOLVING to loopback refused', () =>
        // Not a literal — this is the DNS path, and the same thing an attacker's own
        // domain pointed at 127.0.0.1 would do.
        rejects('http://localhost:8888/', 'private_address'));

    console.log(`\n${passed} passed`);
})();
