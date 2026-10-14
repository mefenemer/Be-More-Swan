// tests/site-audit-pipeline.test.ts
// The Mystery Shopper's run pipeline (src/utils/site-audit.ts runAuditCore), its prompts
// (src/utils/site-audit-prompts.ts) and the API's guarantees (netlify/functions/site-audits.ts).
// docs/mystery-shopper-plan.md §4.4.
//
// Run:  npx tsx tests/site-audit-pipeline.test.ts
//
// The core is driven with fake page fetches and a fake model, so every money rule is checked
// without a network or a database:
//   · nothing changed → no model call, no capacity check, free
//   · unreadable page / failed fetch / every lens failed → free
//   · out of tasks → refused BEFORE any model call
//   · only grounded fixes survive, and the summary may not invent numbers

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    runAuditCore, fixesNowDone, mergeSecondary, normaliseSiteUrl, sameSite, SITE_KEY,
    type AuditDeps, type AuditInput, type FetchResult,
} from '../src/utils/site-audit';
import {
    buildLensPrompt, buildSummaryPrompt, sanitiseSummary, fallbackSummary, summaryNumbersAreKnown, allowedSummaryNumbers,
    HANDOFF_TARGETS, type AuditBrief,
} from '../src/utils/site-audit-prompts';
import { extractSitePage, siteContentHash, type SitePage } from '../src/utils/site-extract';
import { rubricFor, scoreAudit, type Lens } from '../src/utils/site-score';
import { SPECIAL_CATEGORY_RULE } from '../src/constants/special-category-rule';
import { TASK_LIMIT_MESSAGE } from '../src/utils/work-metering';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'site-pages', `${name}.html`), 'utf8');

const SITE = 'https://northgate-consulting.example/';
const RIVAL = 'https://ledgerly.example/';
const RIVAL_PRICING = 'https://ledgerly.example/pricing/';
const DEAD = 'https://gone.example/';

// Long enough to be read (a page under 60 words is treated as unreadable — site-extract THIN_WORDS).
const PRICING_PAGE = `<html><body><h1>Pricing for agencies</h1><p>Enterprise £899/month — over 50 staff.</p>
<p>Every plan includes a named accountant, a weekly cash report and a quarterly review with a partner, so you always know where you stand and what is coming next.</p>
<p>Annual billing saves two months. Switching from your current bookkeeper takes about two weeks, and we handle the handover with them directly so nothing falls through the gaps.</p></body></html>`;

function pages(overrides: Record<string, string | null> = {}): Record<string, string | null> {
    return { [SITE]: fixture('squarespace-weak'), [RIVAL]: fixture('wordpress-strong'), [RIVAL_PRICING]: PRICING_PAGE, [DEAD]: null, ...overrides };
}

const brief: AuditBrief = {
    url: SITE,
    icp: 'Founders of 10–50 person service firms',
    conversionGoal: 'Book a discovery call',
    productsBlock: null,
};

type ModelReply = string | Error;
interface Fake { deps: AuditDeps; calls: { fetch: string[]; model: string[]; capacity: number }; }

/** Which call is this? Read off the system prompt each prompt builder writes. */
function whichCall(system: string): Lens | 'summary' {
    if (system.startsWith('You are the Mystery Shopper')) return 'summary';
    if (system.includes('five seconds')) return 'clarity';
    if (system.includes('competitors in open browser tabs')) return 'compete';
    if (system.includes('simulating how an AI assistant')) return 'ai';
    throw new Error('unrecognised prompt');
}

const goodLensReply = (lens: Lens, fixes: unknown[] = []) => JSON.stringify({
    answers: rubricFor(lens).map((q) => ({ id: q.id, yes: q.goodAnswer, evidence: '' })),
    fixes,
});

const H1_FIX = {
    location: 'Headline', problem: 'Says nothing about who it is for or what it does.',
    currentText: "Empowering Tomorrow's Digital Synergy Today",
    suggestedText: 'Operations consulting for 10–50 person service firms',
};
const INVENTED_FIX = { location: 'Proof', problem: 'Vague.', currentText: 'Award-winning since 1990', suggestedText: 'Something' };

function fake(opts: {
    html?: Record<string, string | null>;
    capacity?: boolean;
    replies?: Partial<Record<Lens | 'summary', ModelReply>>;
} = {}): Fake {
    const html = opts.html ?? pages();
    const calls = { fetch: [] as string[], model: [] as string[], capacity: 0 };
    const deps: AuditDeps = {
        async fetchPage(url): Promise<FetchResult> {
            calls.fetch.push(url);
            const h = html[url];
            if (h === undefined || h === null) return { ok: false, message: 'That link returned an error (404).' };
            return { ok: true, page: extractSitePage(h, url) };
        },
        async callModel(req) {
            const which = whichCall(req.system);
            calls.model.push(which);
            const reply = opts.replies?.[which];
            if (reply instanceof Error) throw reply;
            if (typeof reply === 'string') return reply;
            if (which === 'summary') return JSON.stringify({ summary: 'Clear next step: fix the headline.', priorities: [{ fix: 0, whyItMatters: 'First thing every visitor reads.', impact: 'high' }], handoffs: [] });
            return goodLensReply(which, which === 'clarity' ? [H1_FIX, INVENTED_FIX] : []);
        },
        async hasCapacity() { calls.capacity++; return opts.capacity ?? true; },
    };
    return { deps, calls };
}

const baseInput = (over: Partial<AuditInput> = {}): AuditInput => ({
    kind: 'baseline', brief, competitorUrls: [RIVAL], lastHashes: {}, previousPages: {}, previousScore: null, ...over,
});

/** The hashes and pages a first run would have stored. */
async function firstRun() {
    const f = fake();
    const out = await runAuditCore(baseInput(), f.deps);
    assert.strictEqual(out.status, 'done');
    if (out.status !== 'done') throw new Error('unreachable');
    return out;
}

(async () => {
    console.log('\nThe run');

    await check('baseline with a competitor: 3 lens calls + 1 summary, scored, competitor pricing page read and merged', async () => {
        const f = fake();
        const out = await runAuditCore(baseInput(), f.deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        assert.deepStrictEqual([...f.calls.model].sort(), ['ai', 'clarity', 'compete', 'summary']);
        assert.strictEqual(f.calls.capacity, 1);
        assert.ok(f.calls.fetch.includes(RIVAL_PRICING), 'the competitor\'s pricing page was read');
        assert.ok(out.pages[RIVAL].structure.pricingSignals.some((p) => p.includes('£899')), 'and merged into its read');
        assert.notStrictEqual(out.score.overall, null);
        assert.notStrictEqual(out.score.lenses.compete.score, null);
        assert.deepStrictEqual(out.report.partialLenses, []);
    });

    await check('only grounded fixes survive; the dropped one is counted', async () => {
        const out = await firstRun();
        assert.deepStrictEqual(out.fixes.map((x) => x.currentText), [H1_FIX.currentText]);
        assert.strictEqual(out.groundingDropped, 1);
        assert.strictEqual(out.report.priorities[0].fix, 0);
    });

    await check('weekly, nothing changed: unchanged — NO capacity check and NO model call', async () => {
        const first = await firstRun();
        const f = fake();
        const out = await runAuditCore(baseInput({
            kind: 'weekly', lastHashes: first.hashes, previousPages: first.pages, previousScore: first.score.overall,
        }), f.deps);
        assert.strictEqual(out.status, 'unchanged');
        assert.deepStrictEqual(f.calls.model, []);
        assert.strictEqual(f.calls.capacity, 0);
    });

    await check('a manual re-check with nothing changed is also unchanged and free', async () => {
        const first = await firstRun();
        const f = fake();
        const out = await runAuditCore(baseInput({ kind: 'manual', lastHashes: first.hashes, previousScore: first.score.overall }), f.deps);
        assert.strictEqual(out.status, 'unchanged');
        assert.deepStrictEqual(f.calls.model, []);
    });

    await check('a baseline always re-scores, even with matching hashes', async () => {
        const first = await firstRun();
        const out = await runAuditCore(baseInput({ lastHashes: first.hashes, previousScore: first.score.overall }), fake().deps);
        assert.strictEqual(out.status, 'done');
    });

    await check('a competitor we could not read this time is never "unchanged" — it re-scores', async () => {
        const first = await firstRun();
        const out = await runAuditCore(baseInput({
            kind: 'weekly', lastHashes: first.hashes, previousScore: first.score.overall,
        }), fake({ html: pages({ [RIVAL]: null }) }).deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        assert.strictEqual(out.report.competitorsUnread[0].url, RIVAL);
        assert.strictEqual(out.score.lenses.compete.score, null, 'no readable competitor → no compete lens');
    });

    await check('a competitor change is described and handed to the compete lens', async () => {
        const first = await firstRun();
        let competePrompt = '';
        const changed = fixture('wordpress-strong').replace('Bookkeeping for UK creative agencies, done for you every month', 'Agency bookkeeping — or your first month free');
        const f = fake({ html: pages({ [RIVAL]: changed }) });
        const inner = f.deps.callModel;
        f.deps.callModel = async (req) => { if (whichCall(req.system) === 'compete') competePrompt = req.user; return inner(req); };
        const out = await runAuditCore(baseInput({
            kind: 'weekly', lastHashes: first.hashes, previousPages: first.pages, previousScore: first.score.overall,
        }), f.deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        const lines = out.report.competitorChanges.find((c) => c.url === RIVAL)!.changes;
        assert.ok(lines.some((l) => l.startsWith('Headline changed from')), lines.join('\n'));
        assert.match(competePrompt, /Changed since our last look/);
    });

    await check('a JavaScript-only site is unreadable: no capacity check, no model call', async () => {
        const f = fake({ html: pages({ [SITE]: fixture('spa-shell') }) });
        const out = await runAuditCore(baseInput(), f.deps);
        assert.strictEqual(out.status, 'unreadable');
        assert.deepStrictEqual(f.calls.model, []);
        assert.strictEqual(f.calls.capacity, 0);
    });

    await check('our own site failing to load fails the run with the fetcher\'s message', async () => {
        const out = await runAuditCore(baseInput(), fake({ html: pages({ [SITE]: null }) }).deps);
        assert.deepStrictEqual(out, { status: 'failed', error: 'That link returned an error (404).' });
    });

    await check('out of tasks: refused before ANY model call', async () => {
        const f = fake({ capacity: false });
        const out = await runAuditCore(baseInput(), f.deps);
        assert.deepStrictEqual(out, { status: 'failed', error: TASK_LIMIT_MESSAGE });
        assert.deepStrictEqual(f.calls.model, []);
    });

    await check('every lens failing fails the run (free) — never a code-only score passed off as a review', async () => {
        const boom = new Error('529 overloaded');
        const out = await runAuditCore(baseInput(), fake({ replies: { clarity: boom, compete: 'not json', ai: boom } }).deps);
        assert.strictEqual(out.status, 'failed');
    });

    await check('one lens failing: done, scored, that lens flagged partial', async () => {
        const out = await runAuditCore(baseInput(), fake({ replies: { ai: new Error('timeout') } }).deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        assert.deepStrictEqual(out.report.partialLenses, ['ai']);
        assert.strictEqual(out.score.lenses.ai.partial, true);
    });

    await check('a lens reply with no usable answers counts as failed, not as "all no"', async () => {
        const bogus = JSON.stringify({ answers: [{ id: 'nope', yes: true }], fixes: [] });
        const out = await runAuditCore(baseInput(), fake({ replies: { clarity: bogus } }).deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        assert.ok(out.report.partialLenses.includes('clarity'));
    });

    await check('summary call failing falls back to the plain summary — the run still completes', async () => {
        const out = await runAuditCore(baseInput(), fake({ replies: { summary: new Error('down') } }).deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        assert.match(out.report.summary, /^Your site scores \d+ out of 100 on its first check\./);
    });

    await check('a summary that invents a number is replaced', async () => {
        const invented = JSON.stringify({ summary: 'Fixing this will lift conversions by 37%.', priorities: [], handoffs: [] });
        const out = await runAuditCore(baseInput(), fake({ replies: { summary: invented } }).deps);
        assert.strictEqual(out.status, 'done');
        if (out.status !== 'done') return;
        assert.ok(!out.report.summary.includes('37'), out.report.summary);
    });

    await check('no competitors: two lens calls, no compete prompt', async () => {
        const f = fake();
        const out = await runAuditCore(baseInput({ competitorUrls: [] }), f.deps);
        assert.strictEqual(out.status, 'done');
        assert.deepStrictEqual([...f.calls.model].sort(), ['ai', 'clarity', 'summary']);
    });

    await check('at most 3 competitors are read', async () => {
        const f = fake();
        await runAuditCore(baseInput({ competitorUrls: [RIVAL, 'https://a.example/', 'https://b.example/', 'https://c.example/'] }), f.deps);
        assert.ok(!f.calls.fetch.includes('https://c.example/'));
    });

    console.log('\nFix verification');

    await check('a fix is done when its old text has gone from the page; a thin read proves nothing', () => {
        const before = extractSitePage(fixture('squarespace-weak'), SITE);
        const after = extractSitePage(fixture('squarespace-weak').replace("Empowering Tomorrow's Digital Synergy Today", 'Operations consulting for 10–50 person firms'), SITE);
        const open = [{ id: 1, beforeText: "Empowering Tomorrow's Digital Synergy Today" }, { id: 2, beforeText: 'Learn More' }];
        assert.deepStrictEqual(fixesNowDone(open, before), []);
        assert.deepStrictEqual(fixesNowDone(open, after), [1]);
        assert.deepStrictEqual(fixesNowDone(open, extractSitePage(fixture('spa-shell'), SITE)), []);
    });

    await check('merging competitor pages adds pricing/proof/FAQ without duplicates', () => {
        const home = extractSitePage(fixture('wordpress-strong'), RIVAL);
        const merged = mergeSecondary(home, [extractSitePage(PRICING_PAGE, RIVAL_PRICING), home]);
        assert.strictEqual(merged.structure.pricingSignals.length, home.structure.pricingSignals.length + 1);
        assert.ok(merged.structure.pricingSignals.includes('Enterprise £899/month — over 50 staff.'));
        assert.deepStrictEqual(merged.hero, home.hero, 'the homepage hero is untouched');
        assert.strictEqual(siteContentHash(mergeSecondary(home, [])), siteContentHash(home));
    });

    console.log('\nURLs');

    await check('normaliseSiteUrl adds https, refuses junk and credentials, drops the fragment', () => {
        assert.strictEqual(normaliseSiteUrl('yourbusiness.co.uk'), 'https://yourbusiness.co.uk/');
        assert.strictEqual(normaliseSiteUrl(' http://x.example/a#top '), 'http://x.example/a');
        for (const bad of ['', 'localhost', 'ftp://x.example', 'https://user:pw@x.example', 'not a url', 42, null]) {
            assert.strictEqual(normaliseSiteUrl(bad), null, String(bad));
        }
    });

    await check('sameSite ignores scheme and www', () => {
        assert.ok(sameSite('https://www.acme.example/', 'http://acme.example/about'));
        assert.ok(!sameSite('https://acme.example/', 'https://acme-rival.example/'));
    });

    console.log('\nPrompts');

    const weak = extractSitePage(fixture('squarespace-weak'), SITE);

    await check('each lens prompt asks every one of its rubric questions, with the brief and the page', () => {
        for (const lens of ['clarity', 'compete', 'ai'] as Lens[]) {
            const p = buildLensPrompt(lens, brief, weak, [{ page: extractSitePage(fixture('wordpress-strong'), RIVAL), changes: [] }]);
            for (const q of rubricFor(lens)) assert.ok(p.user.includes(`- ${q.id}: `), `${lens}: ${q.id}`);
            assert.ok(p.user.includes(brief.icp!));
            assert.ok(p.user.includes("Empowering Tomorrow's Digital Synergy Today"));
            assert.ok(p.system.includes(SPECIAL_CATEGORY_RULE.trim().slice(0, 40)), 'special-category rule present');
            assert.match(p.system, /Today's date|today/i);
            assert.strictEqual(p.user.includes('<competitor'), lens === 'compete', 'competitors only in the compete lens');
        }
    });

    await check('the AI-search lens says it is a simulation, not a real assistant', () => {
        assert.match(buildLensPrompt('ai', brief, weak).system, /You are NOT that assistant/);
    });

    await check('rewrites must use placeholders instead of invented facts', () => {
        assert.match(buildLensPrompt('clarity', brief, weak).user, /placeholder in square brackets/);
    });

    console.log('\nSummary checks');

    const score = scoreAudit(weak, [], {});
    const fixes = [{ lens: 'clarity' as Lens, location: 'Headline', problem: 'Generic.', currentText: 'x', suggestedText: 'y' }];

    await check('only scores we gave may appear as numbers', () => {
        const allowed = allowedSummaryNumbers(score, 40);
        assert.ok(summaryNumbersAreKnown(`Your site scores ${score.overall}, up from 40.`, allowed));
        assert.ok(!summaryNumbersAreKnown('This will add 30% more leads.', allowed));
    });

    await check('priorities must point at real fixes, once each; unknown hand-off targets dropped', () => {
        const out = sanitiseSummary({
            summary: 'Fix the headline first.',
            priorities: [{ fix: 0, impact: 'high', whyItMatters: 'w' }, { fix: 0 }, { fix: 9 }, { fix: -1 }],
            handoffs: [{ target: 'blog_writer', title: 'Write an FAQ post', brief: 'b' }, { target: 'crm_enricher', title: 't', brief: 'b' }],
        }, { brief, score, previousScore: null, fixes, competitorChanges: [] });
        assert.deepStrictEqual(out.priorities.map((p) => p.fix), [0]);
        assert.deepStrictEqual(out.handoffs.map((h) => h.target), ['blog_writer']);
    });

    await check('hand-off targets are roles that exist in the catalogue', () => {
        const catalog = readFileSync(join(root, 'db', 'seed-catalog.ts'), 'utf8');
        for (const t of HANDOFF_TARGETS) assert.ok(catalog.includes(`roleKey: '${t}'`), t);
    });

    await check('fallback summary names the top failure and picks fixes across lenses', () => {
        const out = fallbackSummary({ brief, score, previousScore: null, fixes, competitorChanges: [] });
        assert.match(out.summary, /The most important thing to fix: /);
        assert.deepStrictEqual(out.priorities.map((p) => p.fix), [0]);
    });

    await check('the summary prompt lists the fixes by index and the allowed hand-off targets', () => {
        const p = buildSummaryPrompt({ brief, score, previousScore: 40, fixes, competitorChanges: [] });
        assert.match(p.user, /\[0\] \(First impression, Headline\)/);
        assert.match(p.user, /last time: 40/);
        for (const t of HANDOFF_TARGETS) assert.ok(p.user.includes(`"${t}"`));
    });

    console.log('\nAPI + worker guarantees (source)');

    const api = readFileSync(join(root, 'netlify', 'functions', 'site-audits.ts'), 'utf8');
    const worker = readFileSync(join(root, 'netlify', 'functions', 'run-site-audit-background.ts'), 'utf8');
    const pipeline = readFileSync(join(root, 'src', 'utils', 'site-audit.ts'), 'utf8');

    await check('a user can never mark a fix "done" — only a later check can', () => {
        assert.match(api, /const USER_FIX_STATUSES = \['accepted', 'dismissed', 'open'\] as const;/);
    });

    await check('the API is tenant-scoped and role-guarded', () => {
        assert.match(api, /requireTenant\(event, db\)/);
        assert.match(api, /'type'\) = \$\{MYSTERY_SHOPPER_ROLE_KEY\}/);
    });

    await check('the wake-up is awaited, and a failed wake-up ends the run free', () => {
        assert.match(api, /!\(await triggerSiteAudit\(runId\)\)/);
        assert.match(api, /await failAuditRun\(db, runId, 'The check couldn\\'t be started/);
    });

    await check('the worker fails CLOSED without its secret', () => {
        assert.match(worker, /if \(!secret\)[\s\S]{0,200}statusCode: 503/);
    });

    await check('the charge is latched: done + charged in one update, only from running', () => {
        assert.match(pipeline, /status: 'done',\s*charged: true,/);
        assert.match(pipeline, /eq\(siteAuditRuns\.status, 'running'\)\)\)\.returning/);
        assert.ok(pipeline.indexOf('if (!latched) return;') < pipeline.indexOf("recordCompletedWork(db, orgId, 'site_audit'"));
    });

    await check('the notification passes its category and assistantId explicitly', () => {
        const at = pipeline.indexOf("createNotification(db, 'site_audit_ready'");
        assert.ok(at > -1);
        const call = pipeline.slice(at, at + 900);
        assert.match(call, /category: 'state_change'/);
        assert.match(call, /metadata: \{ assistantId: assistant\.id/);
        assert.match(call, /\}\)\.catch\(/, 'never fatal to the run');
    });

    console.log(`\n${passed}/${total} passed`);
})();
