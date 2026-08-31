// tests/campaign-attribution.test.ts
// The Campaign Assistant's attribution spine: the binding rule, and the guards that stop the
// click ledger from quietly under-counting.
//
// Two halves, the same split as tests/campaign-reconciler.test.ts.
//
//   1. THE DECISIONS ARE PURE, so they are unit-tested directly. `chooseBinding` is the whole
//      model — which click a conversion belongs to — and every other function here shapes its
//      inputs. Getting it wrong is invisible in types and expensive in practice: bind too eagerly
//      and a campaign takes credit for a sale it never touched; bind too timidly and a campaign
//      that worked reads as a campaign that did nothing.
//
//   2. THE PUBLIC ENDPOINT'S INVARIANTS cannot be expressed in types, so they are source-scanned.
//      campaign-link-redirect.ts is unauthenticated and writes to a tenant's ledger; the claim
//      that it never takes an org, campaign or destination from the request is the load-bearing
//      one, and it is exactly the kind of claim a later refactor breaks while every other test
//      stays green. Same for the three ways the counter silently plateaus: a cacheable redirect,
//      a HEAD that counts, and a ledger failure that swallows the click AND the redirect.
//
// No database: pure functions plus source-consistency checks, matching every other file in tests/
// except rls-enforcement.
// Run:  npx tsx tests/campaign-attribution.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    ATTRIBUTION_WINDOW_DAYS, CLICK_REF_PARAM, VISITOR_COOKIE,
    appendClickRef, buildVisitorCookie, chooseBinding, extractNetworkClick, extractUtm,
    isLinkToken, isProbableBot, isSafeDestination, isVisitorId, isWithinAttributionWindow,
    mintClickRef, mintLinkToken, mintVisitorId, readVisitorCookie, refererHost,
    type BindingCandidate,
} from '../src/utils/campaign-attribution';
import { clickRefFromPageUrl } from '../src/utils/campaign-attribution-store';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T12:00:00Z');
const candidate = (over: Partial<BindingCandidate> = {}): BindingCandidate => ({
    clickEventId: 1, campaignId: 10, linkId: 100, organisationId: 5,
    occurredAt: new Date(NOW.getTime() - DAY),
    ...over,
});

console.log('\n──── tokens are unguessable, and validated on the way back in ────');

check('a link token is 64 bits of randomness behind the house prefix', () => {
    const token = mintLinkToken();
    assert.match(token, /^c_[0-9a-f]{16}$/, 'token shape changed — /go/ links in the wild break');
    assert.ok(isLinkToken(token));
});

check('minting twice does not collide', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintLinkToken()));
    assert.equal(seen.size, 500, 'token minting is not random enough to be a unique index key');
});

check('isLinkToken refuses everything that is not one', () => {
    // The redirector calls this BEFORE touching the database. Anything that slips through here is
    // an unfiltered string in a WHERE clause and a row of junk in the click ledger.
    for (const bad of ['', 'c_', 'c_short', 'c_' + 'g'.repeat(16), 'wgt_0123456789abcdef',
        '../../etc/passwd', 'c_0123456789abcdef0', null, undefined, 42, {}]) {
        assert.ok(!isLinkToken(bad as never), `accepted ${JSON.stringify(bad)}`);
    }
});

check('a visitor id read off a cookie is shape-checked, not trusted', () => {
    // A hand-edited cookie must not be able to write an attacker-chosen visitor id into the
    // ledger, where it would later bind someone else's conversion.
    assert.ok(isVisitorId(mintVisitorId()));
    assert.ok(!isVisitorId('short'));
    assert.ok(!isVisitorId('has spaces and punctuation!!'));
    assert.ok(!isVisitorId('a'.repeat(500)));
});

check('click refs are unique — the ledger has a unique index on them', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintClickRef()));
    assert.equal(seen.size, 500);
});

console.log('\n──── the cookie survives the journey it actually has to survive ────');

check('the visitor cookie is SameSite=None; Secure; HttpOnly', () => {
    // ⚠️ The one that only fails in production. The cookie is SET on our domain and READ on a
    // request from the tenant's site — cross-site. Under the browser default (Lax) it is simply
    // not sent, so cookie binding works flawlessly in same-site local testing and attributes
    // nothing at all once a real tenant embeds a form. Silent: every conversion just reads
    // "unattributed".
    const cookie = buildVisitorCookie(mintVisitorId(), true);
    assert.match(cookie, /SameSite=None/, 'cookie will not survive the cross-site form post');
    assert.match(cookie, /Secure/, 'SameSite=None without Secure is rejected by every browser');
    assert.match(cookie, /HttpOnly/, 'a script-readable cookie is readable by every tag on the page');
    assert.match(cookie, /Path=\//);
});

check('the cookie expires with the attribution window, not after it', () => {
    // A cookie that outlives the window can only produce clicks we then refuse to credit — it
    // cannot improve attribution, and it retains an identifier for no purpose.
    const cookie = buildVisitorCookie(mintVisitorId(), true);
    assert.match(cookie, new RegExp(`Max-Age=${ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60}\\b`));
});

check('a cookie round-trips, and a tampered one comes back null', () => {
    const id = mintVisitorId();
    assert.equal(readVisitorCookie(`${VISITOR_COOKIE}=${id}`), id);
    assert.equal(readVisitorCookie(`other=1; ${VISITOR_COOKIE}=${id}; third=x`), id);
    assert.equal(readVisitorCookie(`${VISITOR_COOKIE}=not-a-valid-id`), null);
    assert.equal(readVisitorCookie('other=1'), null);
    assert.equal(readVisitorCookie(null), null);
});

console.log('\n──── reading the incoming click ────');

check('the network click id is found, and its parameter name is kept', () => {
    // The parameter name IS the network. Storing the id without it leaves a value that can never
    // be reconciled against anyone's reporting.
    const li = extractNetworkClick(new URLSearchParams('li_fat_id=abc123'));
    assert.deepEqual(li, { id: 'abc123', kind: 'li_fat_id' });
    assert.deepEqual(extractNetworkClick(new URLSearchParams('gclid=g1')), { id: 'g1', kind: 'gclid' });
    assert.deepEqual(extractNetworkClick(new URLSearchParams('fbclid=f1')), { id: 'f1', kind: 'fbclid' });
});

check('no network click id is the NORMAL case, not an error', () => {
    // Every organic click lands here. Anything downstream that treats null as a failure would
    // reject the majority of real traffic.
    assert.equal(extractNetworkClick(new URLSearchParams('')), null);
    assert.equal(extractNetworkClick(new URLSearchParams('utm_source=newsletter')), null);
});

check('when a URL carries two click ids, preference order decides', () => {
    // Common when a link has been through two tools. Deterministic beats first-seen.
    const both = extractNetworkClick(new URLSearchParams('gclid=g1&li_fat_id=l1'));
    assert.equal(both?.kind, 'li_fat_id', 'preference order changed');
});

check('an absurdly long click id is dropped, not stored', () => {
    assert.equal(extractNetworkClick(new URLSearchParams(`gclid=${'x'.repeat(600)}`)), null);
});

check('UTMs are captured, capped, and nothing else is', () => {
    const utm = extractUtm(new URLSearchParams(
        'utm_source=linkedin&utm_medium=cpc&utm_campaign=march&secret=leak&password=hunter2'));
    assert.deepEqual(Object.keys(utm).sort(), ['utm_campaign', 'utm_medium', 'utm_source']);
    assert.equal(utm.utm_source, 'linkedin');
    const long = extractUtm(new URLSearchParams(`utm_term=${'x'.repeat(400)}`));
    assert.equal(long.utm_term.length, 256, 'an unbounded caller value reaches the database');
});

check('only the referring HOST is kept — the path is browsing history', () => {
    assert.equal(refererHost('https://News.YCombinator.com/item?id=1'), 'news.ycombinator.com');
    assert.equal(refererHost('not a url'), null);
    assert.equal(refererHost(null), null);
});

check('a missing user-agent is treated as a bot', () => {
    // Real browsers always send one. Nothing else reliably does.
    assert.equal(isProbableBot(null), true);
    assert.equal(isProbableBot(''), true);
    assert.equal(isProbableBot('curl/8.4.0'), true);
    assert.equal(isProbableBot('Slackbot-LinkExpanding 1.0'), true);
    assert.equal(isProbableBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120'), false);
});

console.log('\n──── a link on our domain cannot become a phishing hop ────');

check('only http(s) destinations are accepted', () => {
    assert.ok(isSafeDestination('https://example.com/pricing'));
    assert.ok(isSafeDestination('http://localhost:8888/preview'));
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd',
        'ftp://example.com', 'not a url', '']) {
        assert.ok(!isSafeDestination(bad), `accepted ${JSON.stringify(bad)}`);
    }
});

check('embedded credentials are refused — the address-bar spoof', () => {
    // https://bemoreswan.com@evil.example renders as though it points at us.
    assert.ok(!isSafeDestination('https://bemoreswan.com@evil.example/'));
    assert.ok(!isSafeDestination('https://user:pass@evil.example/'));
});

check('a tracked link cannot point at another tracked link', () => {
    // Two hops double-count one click, and a cycle never terminates.
    assert.ok(!isSafeDestination('https://bemoreswan.com/go/c_0123456789abcdef'));
});

console.log('\n──── the click ref reaches the destination intact ────');

check('an existing query string and fragment both survive', () => {
    // Hand-rolled ?/& concatenation corrupts exactly the links tenants care most about.
    const out = new URL(appendClickRef('https://example.com/p?a=1&b=2#section', 'REF123'));
    assert.equal(out.searchParams.get('a'), '1');
    assert.equal(out.searchParams.get('b'), '2');
    assert.equal(out.searchParams.get(CLICK_REF_PARAM), 'REF123');
    assert.equal(out.hash, '#section');
});

check('a stale click ref is replaced, never duplicated', () => {
    // The last redirect is the one that happened. Leaving the old value would bind the conversion
    // to someone else's click.
    const out = appendClickRef(`https://example.com/p?${CLICK_REF_PARAM}=OLD`, 'NEW');
    assert.equal(new URL(out).searchParams.getAll(CLICK_REF_PARAM).length, 1);
    assert.equal(new URL(out).searchParams.get(CLICK_REF_PARAM), 'NEW');
});

console.log('\n──── the binding rule ────');

check('a click_ref match beats a more recent cookie match', () => {
    // Precision beats recency: click_ref names one specific click this person was sent on; a
    // cookie only names a browser, which may have clicked several links since.
    const byRef = candidate({ clickEventId: 1, campaignId: 10, occurredAt: new Date(NOW.getTime() - 5 * DAY) });
    const byCookie = [candidate({ clickEventId: 2, campaignId: 20, occurredAt: new Date(NOW.getTime() - 1000) })];
    const decision = chooseBinding(byRef, byCookie, NOW);
    assert.equal(decision?.candidate.campaignId, 10);
    assert.equal(decision?.boundVia, 'click_ref');
});

check('the most recent cookie-matched click wins when there is no click_ref', () => {
    const decision = chooseBinding(null, [
        candidate({ clickEventId: 1, campaignId: 10, occurredAt: new Date(NOW.getTime() - 10 * DAY) }),
        candidate({ clickEventId: 2, campaignId: 20, occurredAt: new Date(NOW.getTime() - 1 * DAY) }),
        candidate({ clickEventId: 3, campaignId: 30, occurredAt: new Date(NOW.getTime() - 5 * DAY) }),
    ], NOW);
    assert.equal(decision?.candidate.campaignId, 20, 'last click at capture is the stated rule');
    assert.equal(decision?.boundVia, 'cookie');
});

check('an expired click_ref falls through to the cookie rather than winning', () => {
    // Precision only beats recency INSIDE the window. Outside it, a click_ref is a different
    // journey, and letting it win would hand a finished campaign a sale months later.
    const stale = candidate({ campaignId: 10, occurredAt: new Date(NOW.getTime() - (ATTRIBUTION_WINDOW_DAYS + 1) * DAY) });
    const fresh = [candidate({ campaignId: 20, occurredAt: new Date(NOW.getTime() - DAY) })];
    const decision = chooseBinding(stale, fresh, NOW);
    assert.equal(decision?.candidate.campaignId, 20);
    assert.equal(decision?.boundVia, 'cookie');
});

check('nothing in the window means UNATTRIBUTED, and that is a real answer', () => {
    // The whole honesty claim rests here. null must stay reachable and must stay null — a future
    // "helpful" fallback that picks the campaign's most recent click for an unmatched visitor
    // would silently attribute strangers.
    const stale = [candidate({ occurredAt: new Date(NOW.getTime() - 200 * DAY) })];
    assert.equal(chooseBinding(null, stale, NOW), null);
    assert.equal(chooseBinding(null, [], NOW), null);
});

check('the window boundary is inclusive, and a future click is refused', () => {
    const exact = new Date(NOW.getTime() - ATTRIBUTION_WINDOW_DAYS * DAY);
    assert.equal(isWithinAttributionWindow(exact, NOW), true);
    assert.equal(isWithinAttributionWindow(new Date(exact.getTime() - 1), NOW), false);
    // A click timestamped after "now" is a clock problem. Crediting it would be inventing history.
    assert.equal(isWithinAttributionWindow(new Date(NOW.getTime() + DAY), NOW), false);
});

console.log('\n──── the public endpoint cannot be steered by its caller ────');

const redirector = read('netlify/functions/campaign-link-redirect.ts');

check('org, campaign and destination all come from the resolved link row', () => {
    // The safety property of an unauthenticated writer. If any of these ever reads a query
    // parameter instead, a stranger can write clicks into any tenant's ledger.
    const insert = redirector.slice(
        landmark(redirector, 'db.insert(campaignClickEvents)'),
        landmark(redirector, '} catch (err) {'),
    );
    assert.match(insert, /organisationId: link\.organisationId/);
    assert.match(insert, /campaignId: link\.campaignId/);
    assert.match(insert, /linkId: link\.id/);
    assert.ok(!/organisationId:.*searchParams/.test(insert), 'org id is being read off the request');
});

check('the token is shape-checked before it reaches the database', () => {
    assert.ok(
        landmark(redirector, 'if (!isLinkToken(token))') < landmark(redirector, 'db\n        .select('),
        'the database is queried before the token is validated',
    );
});

check('archived links stop redirecting', () => {
    // A link is soft-deleted so its click history survives; the lookup must still exclude it, or
    // "archive" is a no-op the user believes worked.
    assert.match(redirector, /isNull\(campaignLinks\.archivedAt\)/);
});

console.log('\n──── the three ways this silently stops counting ────');

check('every response is no-store — a cached 302 records nothing', () => {
    // The counter would plateau at roughly one hit per CDN edge and read as an ad that stopped
    // working. There is no error anywhere; the clicks simply never arrive.
    // Checked per redirect rather than by counting: a total that happens to match tells you
    // nothing about WHICH response is missing the header.
    const parts = redirector.split('statusCode: 302').slice(1);
    assert.ok(parts.length >= 3, 'expected the fallback, HEAD and success redirects');
    parts.forEach((after, i) => {
        assert.match(
            after.slice(0, 400), /'Cache-Control': 'no-store/,
            `302 #${i + 1} is missing its no-store — that path will be served from cache and never counted`,
        );
    });
});

check('HEAD redirects without writing a click', () => {
    // Mail scanners, Slack unfurls and antivirus proxies fetch every URL in a message.
    // audience-public.ts has the mirror-image rule (a GET must not confirm) for the same reason.
    const headBranch = redirector.slice(
        landmark(redirector, "if (event.httpMethod === 'HEAD')"),
        landmark(redirector, 'Guard 3:'),
    );
    assert.ok(!headBranch.includes('db.insert'), 'HEAD is counting machine traffic as clicks');
    assert.ok(!headBranch.includes('Set-Cookie'), 'HEAD is setting a cookie on a scanner');
    assert.ok(
        landmark(redirector, "if (event.httpMethod === 'HEAD')") < landmark(redirector, 'db.insert(campaignClickEvents)'),
        'the HEAD short-circuit moved below the insert, so scanners are now counted',
    );
});

check('a ledger failure loses the row, never the visitor', () => {
    // revenue-ledger.ts settled this contract: the ledger observes the journey, it never
    // participates in it. The person clicked an advert and is entitled to arrive.
    const guarded = redirector.slice(
        landmark(redirector, 'try {', landmark(redirector, 'Guard 3:')),
        landmark(redirector, "console.error('[campaign-link-redirect]"),
    );
    assert.ok(guarded.includes('db.insert(campaignClickEvents)'), 'the insert escaped its try/catch');
    // …and the redirect is issued after the catch, not inside the try.
    assert.ok(
        landmark(redirector, "console.error('[campaign-link-redirect]") < landmark(redirector, 'Location: destination,\n            // Guard 1'),
        'the success redirect moved inside the try — a ledger failure now 500s the click',
    );
});

console.log('\n──── the schema says what the module says ────');

const ddl = read('db/campaign-attribution.sql');

check('one attribution per subject is enforced by the database, not by hope', () => {
    // Someone who clicks three ads and signs up once is ONE outcome. Without this index every
    // multi-touch journey double-counts and the funnel reports more subscribers than exist.
    assert.match(ddl, /CREATE UNIQUE INDEX IF NOT EXISTS campaign_attributions_subject_uidx\s*\n\s*ON campaign_attributions \(subject_type, subject_id\);/);
});

check('the polymorphic key carries its type column', () => {
    // vector_embeddings taught this: a polymorphic id without subject_type silently joins the
    // wrong table's row with the same id.
    assert.match(ddl, /subject_type\s+TEXT NOT NULL/);
    assert.match(ddl, /campaign_attributions_subject_check[\s\S]{0,200}audience_contact/);
});

check('the click ledger stores no raw IP', () => {
    // Personal data in a table retained indefinitely as an audit ledger.
    assert.match(ddl, /ip_prefix/);
    assert.ok(!/\bip_address\b/.test(ddl), 'a raw IP column appeared in the click ledger');
    assert.match(redirector, /pseudonymiseIp\(getClientIp\(headers\)\)/);
});

check('this file unlocks no money — the three paid guards are untouched', () => {
    // A spend column here would be a fourth, unguarded place for paid to leak in. The money
    // ledger already exists as campaign_spend_events with currency='money'.
    assert.ok(!/gbp|max_spend|budget/i.test(ddl.replace(/--[^\n]*/g, '')),
        'a money column was added to the attribution tables');
    const vocab = read('src/config/campaign-vocab.ts');
    assert.match(vocab, /CREATABLE_CAMPAIGN_MODES[^=]*=\s*\['organic'\]/,
        'paid campaigns became creatable as a side effect of the attribution build');
});

check('the mirror in schema.ts matches the SQL', () => {
    // ⚠️ These drift silently and the loser is the DDL: a later drizzle-kit push reverts whatever
    // the mirror does not know about.
    const schema = read('db/schema.ts');
    for (const name of ['campaign_links', 'campaign_click_events', 'campaign_attributions']) {
        assert.ok(schema.includes(`pgTable("${name}"`), `${name} is missing from db/schema.ts`);
    }
    for (const constraint of ['campaign_links_medium_check', 'campaign_links_paid_network_check',
        'campaign_attributions_subject_check', 'campaign_attributions_bound_via_check']) {
        assert.ok(ddl.includes(constraint), `${constraint} missing from the SQL`);
        assert.ok(schema.includes(constraint), `${constraint} missing from the drizzle mirror`);
    }
});

check('the /go/* rewrite is a 200, not a 302', () => {
    // A `status = 302` rule sends the browser straight to the destination and the function never
    // runs — no click, no cookie, and nothing to indicate anything is wrong.
    const toml = read('netlify.toml');
    const rule = toml.slice(landmark(toml, 'from = "/go/*"'), landmark(toml, 'from = "/go/*"') + 200);
    assert.match(rule, /to = "\/\.netlify\/functions\/campaign-link-redirect"/);
    assert.match(rule, /status = 200/);
});

console.log('\n──── the click ref arrives on its own, with no client change ────');

check('the click ref is read off the page URL the form already reports', () => {
    // subscribe.js and the hosted page both post `url: location.href`, and the redirector already
    // appends ?bmsc= to the destination. That is the whole delivery mechanism — no widget change,
    // no new field, and it works for every embed already in the wild.
    assert.equal(clickRefFromPageUrl('https://acme.example/pricing?bmsc=REF123'), 'REF123');
    assert.equal(clickRefFromPageUrl('https://acme.example/p?a=1&bmsc=REF123#x'), 'REF123');
});

check('a malformed or absent page URL is a null, not a throw', () => {
    // body.url is caller-supplied and arrives malformed regularly. A throw here would 500 a
    // sign-up over an analytics detail.
    for (const bad of ['', 'not a url', 'javascript:x', null, undefined]) {
        assert.equal(clickRefFromPageUrl(bad as never), null, `threw or matched on ${JSON.stringify(bad)}`);
    }
    assert.equal(clickRefFromPageUrl('https://acme.example/no-ref'), null);
});

check('an oversized click ref is dropped before it reaches a WHERE clause', () => {
    assert.equal(clickRefFromPageUrl(`https://acme.example/?bmsc=${'x'.repeat(200)}`), null);
});

console.log('\n──── the writer cannot be used to attribute across tenants ────');

const store = read('src/utils/campaign-attribution-store.ts');

check('both click lookups are scoped to the subject\'s organisation', () => {
    // ⚠️ Both keys are attacker-supplied: a click ref is visible in the address bar and a cookie
    // can be replayed. Without the org scope, pasting another tenant's bmsc onto a sign-up form
    // would attach your conversion to their campaign.
    const body = store.slice(landmark(store, 'const [byClickRef]'), landmark(store, 'const decision ='));
    const scopes = body.match(/eq\(campaignClickEvents\.organisationId, input\.organisationId\)/g) || [];
    assert.equal(scopes.length, 2, 'a click lookup lost its organisation scope');
});

check('the cookie lookup is bounded, in both rows and time', () => {
    // An unbounded scan over one visitor's whole history is a slow query on the sign-up path.
    const body = store.slice(landmark(store, 'const byCookie'), landmark(store, 'const decision ='));
    assert.match(body, /gte\(campaignClickEvents\.occurredAt, windowStart\)/, 'the window is not applied in SQL');
    assert.match(body, /limit\(MAX_COOKIE_CANDIDATES\)/);
});

check('first binding wins — a re-submission cannot re-attribute an existing contact', () => {
    // Otherwise anyone could type a known address into a form with their own bmsc on the URL and
    // move that contact onto a campaign of their choosing.
    assert.match(store, /\.onConflictDoNothing\(\)/, 'the insert can now overwrite an existing attribution');
});

check('nothing to go on returns BEFORE any query', () => {
    assert.ok(
        landmark(store, 'if (!clickRef && !visitorId) return null;') < landmark(store, 'db.select(columns)'),
        'an unattributed sign-up now costs two database round-trips',
    );
});

check('the writer swallows its own failures and returns null', () => {
    // Attribution observes the journey; it never participates. revenue-ledger.ts settled this.
    assert.match(store, /catch \(err\) \{[\s\S]{0,300}console\.error\('\[campaign-attribution\][\s\S]{0,200}return null;/);
    const tryAt = landmark(store, '    try {');
    assert.ok(tryAt < landmark(store, 'db.select(columns)'), 'the queries escaped the try block');
    assert.ok(tryAt < landmark(store, 'db.insert(campaignAttributions)'), 'the insert escaped the try block');
});

console.log('\n──── the sign-up path binds without being able to break ────');

const subscribe = read('netlify/functions/audience-public.ts');

check('the binding is awaited, not fired and forgotten', () => {
    // ⚠️ An un-awaited promise is killed the moment the handler returns its response, so the
    // binding would land only when the function happened to stay warm — working locally and
    // attributing a random subset in production.
    assert.match(subscribe, /await bindConversion\(db, \{/, 'bindConversion is not awaited');
});

check('BOTH opt-in paths bind — the call sits above the doubleOptIn branch', () => {
    // A double opt-in contact who never confirms still came from somewhere, and the confirmation
    // request carries neither a page URL nor a cookie, so binding there would lose the signal.
    const callAt = landmark(subscribe, 'await bindConversion(db, {');
    assert.ok(callAt > landmark(subscribe, 'await recordConsentEvent(db, {'),
        'binding now runs before the consent record, which is the load-bearing write');
    assert.ok(callAt < landmark(subscribe, 'if (!form.doubleOptIn) {'),
        'binding moved inside a branch — one of the two opt-in paths now attributes nothing');
});

check('a terminal-state or returning address is never bound', () => {
    // Those paths return the silent success body before a contact id exists. Binding them would
    // attribute a conversion that did not happen.
    const callAt = landmark(subscribe, 'await bindConversion(db, {');
    assert.ok(landmark(subscribe, "existing.status === 'bounced'") < callAt);
    assert.ok(landmark(subscribe, 'if (returning && !form.doubleOptIn) {') < callAt);
});

check('the URL parsed for the click ref is capped longer than the consent copy', () => {
    // ⚠️ The bmsc parameter sits at the END of the query string. Reusing sourceUrl's 500-char cap
    // would truncate it away on exactly the pages carrying the most tracking parameters — a
    // campaign that mysteriously attributes nothing, with no error anywhere.
    assert.match(subscribe, /const sourceUrl = String\(body\.url \|\| ''\)\.slice\(0, 500\)/);
    assert.match(subscribe, /const pageUrl = String\(body\.url \|\| ''\)\.slice\(0, 2000\)/);
    const call = subscribe.slice(landmark(subscribe, 'await bindConversion(db, {'), landmark(subscribe, 'await bindConversion(db, {') + 400);
    assert.match(call, /pageUrl,/, 'the binding is reading the truncated consent URL');
});

check('the form callers still send the page URL the binding depends on', () => {
    // The delivery mechanism is `url: location.href` in two independent callers. If either stops
    // sending it, click_ref binding goes dark for that surface and only the cookie path survives.
    assert.match(read('subscribe.js'), /url: location\.href/, 'the embeddable widget stopped sending the page URL');
    assert.match(subscribe, /url: location\.href/, 'the hosted sign-up page stopped sending the page URL');
});

console.log('\n──── minting a link cannot mint an open redirector ────');

const api = read('netlify/functions/campaigns.ts');
const createLink = api.slice(landmark(api, "if (action === 'create_link')"), landmark(api, "if (action === 'list_links')"));

check('the destination is validated BEFORE the row is written', () => {
    // A link on our domain that forwards anywhere is a phishing gift with our credibility attached.
    // Checking at redirect time instead would leave a bad destination sitting in the database
    // looking legitimate until someone clicked it.
    assert.ok(
        landmark(createLink, 'isSafeDestination(destinationUrl)') < landmark(createLink, 'db.insert(campaignLinks)'),
        'a link is inserted before its destination is checked',
    );
});

check('minting is IDOR-guarded, and the row is stamped with the SESSION org', () => {
    // Not with an organisationId from the body — that is the whole IDOR class.
    assert.match(createLink, /await requireCampaign\(Number\(body\.campaignId\)\)/);
    assert.match(createLink, /organisationId: orgId,/);
    assert.ok(!/organisationId: (Number\(body|body)/.test(createLink), 'the org id is being read off the request');
});

check('a paid link must name its network, matching the DB constraint', () => {
    // Enforced in both places on purpose: the constraint is the guarantee, this is the sentence.
    assert.match(createLink, /medium === 'paid' && !network/);
    assert.match(ddl, /campaign_links_paid_network_check/);
});

check('links per campaign are bounded', () => {
    assert.match(createLink, /existing >= MAX_LINKS_PER_CAMPAIGN/);
    assert.match(api, /const MAX_LINKS_PER_CAMPAIGN = \d+;/);
});

check('an unresolvable base URL returns null, never a guessed host', () => {
    // A tracked link with the wrong origin gets pasted into an advert and cannot be recalled. The
    // caller has to be able to tell "we could not build this" from "here it is".
    assert.match(createLink, /url: base \? `\$\{base\}\/go\/\$\{token\}` : null/);
});

console.log('\n──── listing links tells the truth, in one query each ────');

const listLinks = api.slice(landmark(api, "if (action === 'list_links')"), landmark(api, "if (action === 'archive_link')"));

check('counts are aggregated in two grouped queries, not two per link', () => {
    // countRoiActivityByAssistant settled this shape. The N+1 version is invisible until a tenant
    // has thirty links and the tab takes a second.
    assert.equal((listLinks.match(/\.groupBy\(/g) || []).length, 2, 'the grouped-count shape changed');
    assert.ok(!/links\.map\(async/.test(listLinks), 'a per-link await appeared — this is now N+1');
});

check('counts are cast to int, not returned as strings', () => {
    // ⚠️ postgres-js hands back a bigint count as a STRING, and "12" + 1 is "121" in any
    // arithmetic the UI does with it.
    const casts = listLinks.match(/count\(\*\)[^`]*::int/g) || [];
    assert.equal(casts.length, 3, 'a count lost its ::int cast');
});

check('bot traffic is reported separately, never folded into the headline', () => {
    // Adding scanners to `clicks` inflates every click-through rate in the product; hiding them
    // entirely leaves a tenant unable to explain why the ad platform's number is higher.
    assert.match(listLinks, /clicks: clicksBy\.get\(l\.id\)\?\.clicks \?\? 0,/);
    assert.match(listLinks, /botClicks: clicksBy\.get\(l\.id\)\?\.botClicks \?\? 0,/);
});

console.log('\n──── archiving stops the redirect and keeps the history ────');

const archiveLink = api.slice(landmark(api, "if (action === 'archive_link')"), landmark(api, "if (action === 'list_decisions')"));

check('archive is a soft delete — the clicks survive it', () => {
    // The clicks recorded against this link are history the funnel counts. A hard delete cascades
    // them away and silently reduces a PAST campaign's results.
    assert.match(archiveLink, /\.set\(\{ archivedAt: new Date\(\)/);
    assert.ok(!/db\.delete\(/.test(archiveLink), 'archive became a hard delete — past results will drop');
});

check('archive is scoped to the caller\'s organisation', () => {
    assert.match(archiveLink, /eq\(campaignLinks\.organisationId, orgId\)/);
});

check('an archived link stops redirecting, closing the loop', () => {
    // Archive is only meaningful if the redirector honours it — otherwise it is a flag the user
    // believes worked while the link keeps sending traffic.
    assert.match(redirector, /isNull\(campaignLinks\.archivedAt\)/);
});

console.log('\n──── the link medium agrees in all three places ────');

check('vocabulary, SQL constraint and drizzle mirror carry the same values', () => {
    // ⚠️ The ONLY three-way check in the campaign vocabularies — see the note at the top of
    // campaign-vocab.ts. Everywhere else, a value added in one place and forgotten in another
    // fails at runtime as a constraint violation rather than in CI.
    const vocabSrc = read('src/config/campaign-vocab.ts');
    const listed = vocabSrc
        .slice(landmark(vocabSrc, 'export const CAMPAIGN_LINK_MEDIUMS'), landmark(vocabSrc, 'export type CampaignLinkMedium'))
        .match(/'([a-z_]+)'/g)!.map((s) => s.replace(/'/g, ''));
    assert.deepEqual([...listed].sort(), ['email', 'organic', 'other', 'paid', 'social']);

    const fromSql = ddl
        .slice(landmark(ddl, 'campaign_links_medium_check'), landmark(ddl, 'campaign_links_paid_network_check'))
        .match(/'([a-z_]+)'/g)!.map((s) => s.replace(/'/g, ''));
    assert.deepEqual([...fromSql].sort(), [...listed].sort(), 'the SQL CHECK and the vocabulary disagree');

    const schemaSrc = read('db/schema.ts');
    const fromSchema = schemaSrc
        .slice(landmark(schemaSrc, 'campaign_links_medium_check'), landmark(schemaSrc, 'campaign_links_paid_network_check'))
        .match(/'([a-z_]+)'/g)!.map((s) => s.replace(/'/g, ''));
    assert.deepEqual([...fromSchema].sort(), [...listed].sort(), 'the drizzle mirror and the vocabulary disagree');
});

check('paid links are taggable even though paid CAMPAIGNS are refused', () => {
    // Deliberate, not a leak. A tenant already running ads by hand on their own account gets real
    // cost-per-outcome today; the mode lock governs whether WE spend money, which stays shut.
    assert.match(read('src/config/campaign-vocab.ts'), /CREATABLE_CAMPAIGN_MODES[^=]*=\s*\['organic'\]/);
    assert.ok(read('src/config/campaign-vocab.ts').includes("CAMPAIGN_LINK_MEDIUMS = ['organic', 'paid'"));
});

console.log(`\n${passed} checks passed.\n`);
