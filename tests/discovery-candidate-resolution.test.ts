// tests/discovery-candidate-resolution.test.ts
// Case A: a search hit on the WRONG PAGE of a real company's site should still find the company.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// The worker treats a search result's DOMAIN as the prospect, so a genuine business was thrown
// away whenever it ranked on the wrong URL: alofttrophyclub.com — an actual hotel — was dropped
// because the hit was its "How to Host a Corporate Retreat" blog post, and every blog./careers.
// subdomain was dropped wholesale. In both shapes the company is already in the URL.
//
// ⚠️ SCOPE, and the thing most likely to be misread: this is Case A only — same company, wrong
// page. A hit on a THIRD PARTY that merely mentions a company (a job advert, a Trustpilot review)
// is Case B in docs/discovery-candidate-resolution-plan.md and stays dropped, because stripping
// linkedin.com/jobs/… yields LinkedIn, not the employer. Case A does NOT unblock intent queries.
//
// ⚠️ THE INVARIANTS WORTH DEFENDING:
//
//   1. NEVER strip labels blindly. `foo.co.uk` reduced to its last two labels is `co.uk`. There is
//      no public-suffix list here, and .co.uk is most of the UK SMB market we target, so a naive
//      apex would corrupt the majority of real prospects into a single garbage domain.
//
//   2. A rewritten candidate must be re-tested on its domain ALONE. blog.medium.com must not
//      become a lead for medium.com, and a Digiday article must not become a lead for Digiday.
//
//   3. The rewrite happens BEFORE the dedupe, or a company's blog post and its home page survive
//      as two candidates and collide only at the (campaign_id, domain) unique index.
//
//   4. A rewritten hit must never keep the article's title or snippet — `companyName` is taken
//      from the title, so the Leads tab would fill with headlines and the scorer would judge
//      companies by prose about the market.
//
// Run:  npx tsx tests/discovery-candidate-resolution.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCandidateDomain, classifyCandidate } from '../src/lib/discovery-domain-filter';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const WORKER = stripComments(read('netlify/functions/process-discovery-jobs.ts'));

// ── 1. The .co.uk trap ───────────────────────────────────────────────────────

check('a .co.uk company is never reduced to co.uk', () => {
    // The single most damaging way to get this wrong: every UK SMB collapsing onto one domain.
    const r = resolveCandidateDomain({ domain: 'quendonhall.co.uk', url: 'https://quendonhall.co.uk/', title: 'Quendon Hall' });
    assert.ok(r, 'a plain UK company site was dropped outright');
    assert.equal(r.domain, 'quendonhall.co.uk');
    assert.equal(r.rewritten, false, 'a hit that was already fine must not be marked rewritten');
});

check('a .co.uk blog subdomain strips exactly one label', () => {
    const r = resolveCandidateDomain({ domain: 'blog.quendonhall.co.uk', url: 'https://blog.quendonhall.co.uk/x', title: 'A post' });
    assert.ok(r, 'blog.quendonhall.co.uk resolved to nothing');
    assert.equal(r.domain, 'quendonhall.co.uk', 'stripped the wrong number of labels');
    assert.equal(r.rewritten, true);
});

check('an unknown leading label is NOT treated as a subdomain to strip', () => {
    // `shop.` is not in NON_COMPANY_SUBDOMAINS. Guessing here is how co.uk breakage starts.
    const r = resolveCandidateDomain({ domain: 'shop.quendonhall.co.uk', url: 'https://shop.quendonhall.co.uk/', title: 'Shop' });
    assert.ok(r, 'a non-publishing subdomain should still be a perfectly good lead');
    assert.equal(r.domain, 'shop.quendonhall.co.uk', 'an unrecognised label was stripped — that is the co.uk bug');
});

// ── 2. The two shapes Case A recovers ────────────────────────────────────────

check("a real company's blog post resolves to the company", () => {
    // The recorded example: a genuine hotel dropped on a how-to article.
    const hit = {
        domain: 'alofttrophyclub.com',
        url: 'https://alofttrophyclub.com/blog/how-to-host-a-corporate-retreat',
        title: 'How to Host a Corporate Retreat',
    };
    assert.ok(classifyCandidate(hit).excluded, 'this fixture no longer reproduces the original drop');
    const r = resolveCandidateDomain(hit);
    assert.ok(r, 'the hotel is still being thrown away');
    assert.equal(r.domain, 'alofttrophyclub.com');
    assert.equal(r.rewritten, true);
});

check('a careers subdomain resolves to the employer', () => {
    const r = resolveCandidateDomain({ domain: 'careers.foo.com', url: 'https://careers.foo.com/jobs/1', title: 'Careers' });
    assert.ok(r, 'careers.foo.com resolved to nothing');
    assert.equal(r.domain, 'foo.com');
});

// ── 3. Re-testing the rewritten domain ───────────────────────────────────────

check('a blocked platform is not laundered by the rewrite', () => {
    // blog.medium.com → medium.com is still Medium. Without the re-test this is how every
    // blocklisted domain would walk back in through the side door.
    assert.equal(resolveCandidateDomain({ domain: 'blog.medium.com', url: 'https://blog.medium.com/p', title: 'A post' }), null);
    assert.equal(resolveCandidateDomain({ domain: 'careers.linkedin.com', url: 'https://careers.linkedin.com/', title: 'Jobs' }), null);
});

check('an article on a media site stays dropped', () => {
    // digiday.com/an-article → digiday.com is still Digiday, not a prospect.
    assert.equal(resolveCandidateDomain({
        domain: 'digiday.com', url: 'https://digiday.com/marketing/dtc-brands/', title: 'How DTC brands are built',
    }), null);
});

check('Case B hits stay dropped — they are not what this resolves', () => {
    // Each of these names a company somewhere in the PAGE. Stripping the URL yields the platform.
    for (const hit of [
        { domain: 'linkedin.com', url: 'https://linkedin.com/jobs/view/123', title: 'Acme is hiring a social media manager' },
        { domain: 'trustpilot.com', url: 'https://trustpilot.com/review/acme.co.uk', title: 'Acme Reviews' },
        { domain: 'startup.jobs', url: 'https://startup.jobs/acme', title: 'Acme jobs' },
        { domain: 'podcasts.apple.com', url: 'https://podcasts.apple.com/x', title: 'DTC POD' },
    ]) {
        assert.equal(resolveCandidateDomain(hit), null, `${hit.domain} should stay dropped — it is Case B`);
    }
});

// ── 5. The blocklist gap this test found ─────────────────────────────────────

check('the 2026-08-08 prod noise is now dropped BEFORE it costs scoring tokens', () => {
    // ⚠️ Written after discovering that NOT ONE of that run's 35 results was caught by the
    // deterministic filter — every drop happened at the scorer, at full token cost, which is the
    // exact opposite of the two-layer design. These are the unambiguous platforms; the vendors
    // below are deliberately still the scorer's call.
    for (const d of [
        'huffingtonpost.co.uk', 'digiday.com', 'marketingbrew.com',
        'podcasts.apple.com', 'anchor.fm', 'feeds.libsyn.com', 'rossbolenpodcast.libsyn.com',
        'startup.jobs', 'builtinnyc.com', 'salehoo.com',
    ]) {
        const v = classifyCandidate({ domain: d, url: `https://${d}/`, title: 'Acme Ltd' });
        assert.ok(v.excluded, `${d} still reaches the scorer — it appeared in the prod run`);
    }
});

check('a per-show podcast subdomain is caught by its host', () => {
    // The suffix match is what makes one libsyn.com entry cover every show that uses it.
    assert.ok(classifyCandidate({ domain: 'feeds.libsyn.com', url: 'https://feeds.libsyn.com/x', title: 'A show' }).excluded);
    assert.ok(classifyCandidate({ domain: 'anythingatall.libsyn.com', url: 'https://anythingatall.libsyn.com/', title: 'A show' }).excluded);
});

check('vendors are still left to the scorer, not hard-blocked', () => {
    // The two-layer split is deliberate: the deterministic filter is a FLOOR for unambiguous
    // noise, and judgement calls belong to the prompt. Blocking every SaaS vendor by hand is the
    // long tail the scoring prompt exists to handle — and it rated all five cold in prod.
    for (const d of ['adobe.com', 'hubspot.com', 'salesforce.com', 'hootsuite.com', 'shopify.com']) {
        const v = classifyCandidate({ domain: d, url: `https://${d}/`, title: 'Acme' });
        assert.equal(v.excluded, false, `${d} is now hard-blocked — that is the scorer's judgement call, not the filter's`);
    }
});

check('everything the old filter kept, the resolver still keeps', () => {
    // The resolver REPLACED a bare !classifyCandidate().excluded test in the worker. Any candidate
    // that used to pass must still pass, unchanged and unrewritten.
    for (const d of ['quendonhall.co.uk', 'broughtonsanctuary.co.uk', 'tank2create.co.uk', 'makesocial.co.uk']) {
        const hit = { domain: d, url: `https://${d}/services`, title: 'Our services' };
        assert.equal(classifyCandidate(hit).excluded, false, `fixture ${d} is no longer a keep`);
        const r = resolveCandidateDomain(hit);
        assert.ok(r && r.domain === d && !r.rewritten, `${d} changed behaviour under the resolver`);
    }
});

check('a candidate with no resolvable domain is still dropped', () => {
    assert.equal(resolveCandidateDomain({ domain: null, url: 'not a url', title: 'x' }), null);
    assert.equal(resolveCandidateDomain({ domain: '', url: '', title: '' }), null);
});

// ── 4. Wiring: order of operations in the worker ─────────────────────────────

check('the rewrite runs BEFORE the dedupe', () => {
    const iResolve = WORKER.indexOf('resolveCandidateDomain(');
    const iSeen = WORKER.indexOf('!seen.has(r.domain)');
    assert.ok(iResolve !== -1, 'the worker no longer resolves candidates');
    assert.ok(iSeen !== -1, 'the in-slice dedupe is gone');
    assert.ok(iResolve < iSeen,
        'dedupe runs before the rewrite — a company’s blog post and its home page would both survive and collide at the unique index');
});

check('rewritten candidates have their identity re-read before scoring', () => {
    const iIdentity = WORKER.indexOf('resolveIdentities(');
    const iScore = WORKER.indexOf('scoreCandidates(');
    assert.ok(iIdentity !== -1, 'resolveIdentities is gone — the scorer would see article headlines');
    assert.ok(iIdentity < iScore, 'identities must be resolved before scoring, not after');
});

check('a failed identity read names the lead by domain, never by the article', () => {
    const fn = WORKER.slice(WORKER.indexOf('async function resolveIdentities'), WORKER.indexOf('async function loadGuardrails'));
    assert.ok(/hit\.title = hit\.domain/.test(fn),
        'the fallback no longer names the lead by its domain');
    assert.ok(/hit\.snippet = ''/.test(fn),
        'the article snippet is kept on failure — the scorer would judge the company by prose about the market');
    assert.ok(!/hit\.title = hit\.snippet|identity\?\.title \|\| hit\.title/.test(fn),
        'the article title is being used as a fallback — that is the exact bug this avoids');
});

check('only rewritten hits are fetched, and the budget is bounded', () => {
    const fn = WORKER.slice(WORKER.indexOf('async function resolveIdentities'), WORKER.indexOf('async function loadGuardrails'));
    assert.ok(/hits\.filter\(\(h\) => h\.rewrittenFrom\)/.test(fn),
        'every candidate is being fetched — an ordinary hit already carries the company’s own title');
    assert.ok(/IDENTITY_BUDGET_MS/.test(WORKER), 'the slice budget is gone — slow sites would blow the function tick');
    assert.ok(/Promise\.all\(/.test(fn), 'the fetches are sequential; four slow pages already compounded past a tick once');
});

check('the rewrite is recorded on the lead for traceability', () => {
    assert.ok(/rewrittenFrom: c\.rewrittenFrom/.test(WORKER),
        'signals no longer records the original domain — a lead whose sourceUrl is an article would look like a filter failure');
});

console.log(`\n${passed} checks passed.`);
