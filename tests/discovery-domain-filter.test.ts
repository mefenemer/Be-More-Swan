// tests/discovery-domain-filter.test.ts
// Pre-scoring non-prospect filter (src/lib/discovery-domain-filter.ts).
// The EXCLUDE fixtures are the real domains a staging run (campaign 5, 2026-07-18)
// qualified as hot/warm leads — directories, a social platform and vendor blogs that no
// contact enrichment could ever make emailable. The KEEP fixtures are the genuine
// businesses from the same run, and they matter more: a false positive here silently
// deletes a real customer, which is far worse than letting one directory through.
// Run:  npx tsx tests/discovery-domain-filter.test.ts

import assert from 'node:assert';
import { classifyCandidate, BLOCKED_DOMAIN_COUNT } from '../src/lib/discovery-domain-filter';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const drop = (c: Parameters<typeof classifyCandidate>[0], why: string) => {
    const v = classifyCandidate(c);
    assert.equal(v.excluded, true, `${why}: expected exclusion, got KEEP`);
};
const keep = (c: Parameters<typeof classifyCandidate>[0], why: string) => {
    const v = classifyCandidate(c);
    assert.equal(v.excluded, false, `${why}: wrongly excluded as ${v.category} — ${v.reason}`);
};

// ── Real staging false positives, by name ─────────────────────────────────────

check('drops the social platform that scored warm (tiktok.com)', () => {
    drop({ domain: 'tiktok.com', url: 'https://tiktok.com/@cliffhotel', title: 'Cliff Hotel & Spa Cardigan Bay: Meal & Wedding Venue' }, 'tiktok');
});

check('drops the event marketplace (cvent.com)', () => {
    drop({ domain: 'cvent.com', url: 'https://cvent.com/venues/flames', title: 'Flames of the Forest - Cvent' }, 'cvent');
});

check('drops publishing subdomains (blog. / members.)', () => {
    drop({ domain: 'blog.healthcarecouncil.com', url: 'https://blog.healthcarecouncil.com/x', title: 'Nashville Sessions' }, 'blog subdomain');
    drop({ domain: 'members.hhnetwork.org', url: 'https://members.hhnetwork.org/dir', title: 'Directories - Healthcare Hospitality Network' }, 'members subdomain');
});

check('drops the PDF prospectus', () => {
    drop({ domain: 'somesite.com', url: 'https://somesite.com/x', title: '[PDF] 2024 Sessions Prospectus_WEBSITE - Nashville' }, 'pdf title');
});

check('drops vendor content marketing (guide / template titles)', () => {
    drop({ domain: 'tcpsoftware.com', url: 'https://tcpsoftware.com/blog/x', title: 'The Guide to Employee Scheduling in Hospitality' }, 'guide');
    drop({ domain: 'oxmaint.com', url: 'https://oxmaint.com/x', title: 'Hotel Preventive Maintenance Schedule Template (Excel)' }, 'template');
});

check('drops the magazine and brand directory that reached the scorer (2026-08-12 prod run)', () => {
    // Both scored 0, so the verdict was right — it just cost a scoring slot to reach. Neither has
    // an article path or a listicle title on its landing page, so the domain is the only handle.
    drop({ domain: 'countryandtownhouse.com', url: 'https://countryandtownhouse.com/', title: 'Country & Town House' }, 'C&TH magazine');
    drop({ domain: 'makeitbritish.co.uk', url: 'https://makeitbritish.co.uk/', title: 'Make it British | Buy British Made Products' }, 'brand directory');
});

// ── The 2026-08-12 prod harvest ───────────────────────────────────────────────
// Once every lead in prod campaign 2 carried a prospectType, the shape of the waste was legible:
// 51 of 65 companies found were never prospects, and 18 of those were content pages. These are the
// real domains and titles, and each one cost a full scoring slot before being thrown away.

check('drops the trade press and consumer titles that ranked for DTC queries', () => {
    drop({ domain: 'businessoffashion.com', url: 'https://businessoffashion.com/', title: 'Direct-to-Consumer - The Business of Fashion' }, 'BoF');
    drop({ domain: 'glossy.co', url: 'https://glossy.co/', title: "Why community is beauty's next big growth channel" }, 'Glossy');
    drop({ domain: 'vogue.com', url: 'https://vogue.com/', title: 'Vogue' }, 'Vogue');
    drop({ domain: 'fashionista.com', url: 'https://fashionista.com/', title: 'Fashionista' }, 'Fashionista');
    drop({ domain: 'sheerluxe.com', url: 'https://sheerluxe.com/', title: 'SheerLuxe' }, 'SheerLuxe');
    drop({ domain: 'yougov.com', url: 'https://yougov.com/', title: 'YouGov' }, 'YouGov');
});

check('drops numbered brand listicles by TITLE, whatever the domain', () => {
    // The generalising half of the fix: a domain block catches one publisher, this catches the
    // shape wherever it appears next.
    drop({ domain: 'someblog.co.uk', url: 'https://someblog.co.uk/x', title: '21 UK Beauty Brands That Need to Be on Your Radar' }, 'numbered brands');
    drop({ domain: 'someblog.co.uk', url: 'https://someblog.co.uk/x', title: '9 Small Interiors Brands We Love' }, 'numbered brands');
    drop({ domain: 'someblog.co.uk', url: 'https://someblog.co.uk/x', title: '40+ Direct-to-Consumer Fashion Brands' }, 'plus-suffixed count');
    drop({ domain: 'someblog.co.uk', url: 'https://someblog.co.uk/x', title: '10 Small Business Home Decor Shops That Will Make You Smile' }, 'numbered shops');
    drop({ domain: 'someblog.co.uk', url: 'https://someblog.co.uk/x', title: 'Meet 9 Indie Beauty Brands Refreshing the Body-Care Aisle' }, 'meet N brands');
});

check('a NUMBER in a real company name is not a listicle', () => {
    // The expensive mistake this pattern could have made. Anchoring is what prevents it.
    keep({ domain: 'acmegroup.com', url: 'https://acmegroup.com/brands', title: 'Our 3 Brands' }, 'parent company');
    keep({ domain: '4handsbrewing.com', url: 'https://4handsbrewing.com', title: '4 Hands Brewing Co' }, 'number in name');
    keep({ domain: '100acrewood.co.uk', url: 'https://100acrewood.co.uk', title: '100 Acre Wood Farm Shop' }, 'number in name');
});

check('an ICP-relative verdict is left to the scorer, not hardcoded here', () => {
    // The scorer called all four `aggregator`, correctly, for a DTC-brand ICP — they retail many
    // brands rather than being one. They are still real trading companies, and this list applies to
    // every tenant, so blocking them would silently delete prospects for a user selling to
    // multi-brand retailers. Same for suppliers: treyd.io is a real fintech.
    keep({ domain: 'credobeauty.com', url: 'https://credobeauty.com', title: 'Credo Beauty' }, 'multi-brand retailer');
    keep({ domain: 'dermstore.com', url: 'https://dermstore.com', title: 'Dermstore' }, 'multi-brand retailer');
    keep({ domain: 'sostter.com', url: 'https://sostter.com', title: 'Sostter' }, 'marketplace');
    keep({ domain: 'treyd.io', url: 'https://treyd.io', title: 'Treyd' }, 'supplier to the ICP');
    keep({ domain: 'bigblue.co', url: 'https://bigblue.co', title: 'Bigblue' }, 'supplier to the ICP');
});

check('a real company whose ARTICLE ranked keeps its domain', () => {
    // resolveCandidateDomain's job. planetorganic.com and mi-elskincare.com are real retailers
    // whose blog posts surfaced; blocking the domain because one page was editorial would be the
    // expensive mistake.
    keep({ domain: 'planetorganic.com', url: 'https://planetorganic.com', title: 'Planet Organic' }, 'real retailer');
    keep({ domain: 'mi-elskincare.com', url: 'https://mi-elskincare.com', title: 'Mi-el Skincare' }, 'real brand');
    keep({ domain: 'vervaunt.com', url: 'https://vervaunt.com', title: 'Vervaunt' }, 'real consultancy');
});

check('drops directory-titled pages', () => {
    drop({ domain: 'example.org', url: 'https://example.org/x', title: 'Directories - Healthcare Hospitality Network' }, 'directory');
});

// ── Real staging TRUE positives must survive ──────────────────────────────────

check('KEEPS the genuine venues the same run found', () => {
    keep({ domain: 'elmleynaturereserve.co.uk', url: 'https://elmleynaturereserve.co.uk/contact', title: 'Corporate Event Venue in Kent - Elmley Nature Reserve' }, 'Elmley');
    keep({ domain: 'artesianlakes.com', url: 'https://artesianlakes.com/contact', title: 'Conference Center – The Retreat at Artesian Lakes' }, 'Artesian Lakes');
    keep({ domain: 'rochesterregional.org', url: 'https://rochesterregional.org/contact', title: 'Unity Hospital | Rochester Regional Health' }, 'Unity Hospital');
});

// ── False-positive guards: the expensive mistakes ─────────────────────────────

check('does not drop a company whose NAME contains a blocked word', () => {
    keep({ domain: 'mediumroastcoffee.co.uk', url: 'https://mediumroastcoffee.co.uk', title: 'Medium Roast Coffee' }, 'medium* prefix');
    keep({ domain: 'yellowdoorvenue.com', url: 'https://yellowdoorvenue.com', title: 'Yellow Door Venue' }, 'yell* prefix');
});

check('does not drop a legitimate tour-guide or travel business', () => {
    // "guide" alone must never exclude — only article-shaped phrasing does.
    keep({ domain: 'edinburghtourguides.co.uk', url: 'https://edinburghtourguides.co.uk', title: 'Edinburgh Tour Guides — Private City Tours' }, 'tour guides');
});

check('does not drop a company on a normal marketing path', () => {
    keep({ domain: 'acmevenues.co.uk', url: 'https://acmevenues.co.uk/about', title: 'About Us — Acme Venues' }, '/about');
    keep({ domain: 'acmevenues.co.uk', url: 'https://acmevenues.co.uk/contact', title: 'Contact — Acme Venues' }, '/contact');
    keep({ domain: 'acmevenues.co.uk', url: 'https://acmevenues.co.uk/services', title: 'Our Services' }, '/services');
});

check('does not drop www. or a plain root domain', () => {
    keep({ domain: 'www.acmevenues.co.uk', url: 'https://www.acmevenues.co.uk', title: 'Acme Venues' }, 'www');
});

// ── Mechanics ─────────────────────────────────────────────────────────────────

check('matches subdomains of a blocked registrable domain', () => {
    drop({ domain: 'uk.tripadvisor.com', url: 'https://uk.tripadvisor.com/x', title: 'Hotels' }, 'tripadvisor subdomain');
});

check('a candidate with no domain is dropped', () => {
    drop({ domain: null, url: null, title: 'Something' }, 'no domain');
});

check('every verdict carries a traceable reason', () => {
    const v = classifyCandidate({ domain: 'tiktok.com', url: '', title: '' });
    assert.ok(v.reason.length > 0, 'exclusions must explain themselves');
    assert.ok(v.category, 'exclusions must carry a category');
});

check('blocklist is populated', () => {
    assert.ok(BLOCKED_DOMAIN_COUNT > 80, `expected a substantial blocklist, got ${BLOCKED_DOMAIN_COUNT}`);
});

console.log(`\n${passed} checks passed.`);
