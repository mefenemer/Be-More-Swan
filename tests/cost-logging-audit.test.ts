// tests/cost-logging-audit.test.ts
// Every paid provider's call site keeps writing its cost to ai_usage_log WITH the customer's workspace.
//
// WHY THIS EXISTS. Partner commission is worked out after ACTUAL costs (docs/partner-actual-costs-plan.md): the nightly
// sweep sums ai_usage_log.cost_usd for each referred customer's workspaces (partner-costs-db.ts customerCostUsd). A paid
// call with no row, or a row with no workspace, is invisible there — only the 20% minimum covers it, and a heavy user
// costs Be More Swan money. The audit (docs/cost-logging-audit.md, 2026-11-23) found Recall bots, Read Aloud speech,
// Resend outbound email and ~15 Claude calls that were unlogged or unattributed. This file keeps them fixed.
// tests/ai-usage-coverage.test.ts already guards Anthropic SDK calls, fal/Stability media, Serper, Hunter and Voyage.
//
// No database: source scans plus pure cost functions.
// Run:  npx tsx tests/cost-logging-audit.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_LIST_PRICE_USD, SERVICE_UNIT_PRICE_USD, mediaCostUsd, recallBotHours, serviceUnitPriceUsd } from '../src/utils/ai-usage';

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
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(root, dir))) {
        const rel = join(dir, name);
        if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel));
        else if (rel.endsWith('.ts')) out.push(rel);
    }
    return out;
}
const sources = [...walk('netlify/functions'), ...walk('src')].map((p) => relative(root, join(root, p)));

/** The text of every call `name(` in `src`, parentheses balanced. */
function calls(src: string, name: RegExp): string[] {
    const out: string[] = [];
    const re = new RegExp(name.source, 'g');
    for (let m = re.exec(src); m; m = re.exec(src)) {
        let i = m.index + m[0].length, depth = 1;
        while (i < src.length && depth) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
        out.push(src.slice(m.index, i));
    }
    return out;
}

console.log('\nCost audit — every paid provider logs its cost against the workspace');

check('Recall bot: priced per hour (bot + transcript), to the second', () => {
    assert.strictEqual(SERVICE_UNIT_PRICE_USD['recall-bot-hour'].fallback, 0.65, '$0.50/h recording + $0.15/h transcript');
    const t0 = new Date('2026-11-23T10:00:00Z');
    assert.strictEqual(recallBotHours(t0, new Date('2026-11-23T10:30:00Z')), 0.5);
    assert.strictEqual(recallBotHours(t0, new Date('2026-11-23T10:00:00.400Z')), 1 / 3600, 'a part second is billed as a second');
    assert.strictEqual(recallBotHours(null, t0), 0);
    assert.strictEqual(recallBotHours(t0, t0), 0);
});

check('Recall bot: logged once, on the move into done, against the bot\'s workspace', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    const fn = db.slice(db.indexOf('async function applyBotPatch('), db.indexOf('export const botExternalId'));
    assert.ok(fn.length > 0, 'applyBotPatch() is gone');
    assert.ok(/saved\.status === 'done' && row\.status !== 'done' && saved\.joinedAt\)[\s\S]{0,40}await logServiceCost\('recall-bot-hour', recallBotHours\(saved\.joinedAt, saved\.leftAt\)/.test(fn),
        'a finished bot no longer records Recall\'s charge (or records it more than once)');
    assert.ok(/workspaceId: saved\.organisationId/.test(fn), 'the Recall cost lost its workspace');
    // The only Recall caller stays the only one: a new one must log too. (meeting-bot.ts only DEFINES RECALL_HOSTS.)
    const direct = sources.filter((f) => !['src/utils/meeting-bot-recall.ts', 'src/utils/meeting-bot.ts'].includes(f) && /recall\.ai\/api|RECALL_HOSTS/.test(read(f)));
    assert.deepStrictEqual(direct, [], `these call Recall directly:\n    ${direct.join('\n    ')}`);
});

check('Read Aloud: a fresh reading logs its speech cost against the workspace', () => {
    const f = read('netlify/functions/read-aloud.ts');
    assert.ok(/await speakVoiceover\(text, voice\);[\s\S]{0,600}await logAiUsage\(\{[\s\S]{0,80}workspaceId: orgId/.test(f), 'read-aloud speaks without logging');
    assert.ok(/provider === 'elevenlabs' \? elevenLabsSpeechCostUsd\(text\.length\) : speechCostFromTextUsd\(text\)/.test(f), 'priced by who spoke it');
});

check('every speech / transcription call site logs its cost', () => {
    // Callers of tts.ts that speak or transcribe — each must log in the same file.
    const callers = sources.filter((f) => f !== 'src/lib/tts.ts' && /\b(speakVoiceover|synthesizeElevenLabs|synthesizeSpeech|transcribeWords|transcribeAudio|transcribeScribe|transcribeWhisper)\(/.test(read(f)));
    assert.ok(callers.length >= 5, `expected the voiceover, own-voice, footage-review, tour and read-aloud callers, found ${callers.join(', ')}`);
    const silent = callers.filter((f) => !/logAiUsage\(|logTranscriptionCost\(/.test(read(f)));
    assert.deepStrictEqual(silent, [], `these speak or transcribe and record nothing:\n    ${silent.join('\n    ')}`);
    // Nothing reaches ElevenLabs or OpenAI audio around tts.ts.
    const direct = sources.filter((f) => !['src/lib/tts.ts', 'src/utils/provider-balance.ts', 'src/utils/system-registry.ts'].includes(f)
        && /api\.elevenlabs\.io|api\.openai\.com\/v1\/audio/.test(read(f)));
    assert.deepStrictEqual(direct, [], `these call ElevenLabs / OpenAI audio directly:\n    ${direct.join('\n    ')}`);
});

check('fal background removal has a price (fal lists $0) and the AI presenter is logged', () => {
    assert.ok(MEDIA_LIST_PRICE_USD['fal-ai/birefnet/v2'], 'birefnet is unpriced');
    assert.strictEqual(mediaCostUsd('fal-ai/birefnet/v2', { images: [{ width: 1024, height: 1024 }] }), '0.000000');
    assert.ok(/logMediaCost\(PRESENTER_MODEL, \{ durationSeconds: seconds \}, \{ workspaceId: args\.orgId/.test(read('src/utils/video-producer.ts')), 'the AI presenter records nothing');
});

check('Resend outbound email logs one email against the workspace', () => {
    assert.strictEqual(SERVICE_UNIT_PRICE_USD['resend-email'].fallback, 0.0009, '$0.90 per 1,000 (Resend Pro overage)');
    assert.ok(/emailId = \(result as any\)\?\.data\?\.id \?\? null;\s*\/\/[^\n]*\n\s*if \(emailId\) await logServiceCost\('resend-email', 1, \{ workspaceId: orgId/.test(read('netlify/functions/send-outbound-email.ts')),
        'send-outbound-email no longer logs the Resend send');
    const prev = process.env.RESEND_COST_USD_PER_EMAIL;
    process.env.RESEND_COST_USD_PER_EMAIL = '0.0004';
    assert.strictEqual(serviceUnitPriceUsd('resend-email'), 0.0004);
    if (prev === undefined) delete process.env.RESEND_COST_USD_PER_EMAIL; else process.env.RESEND_COST_USD_PER_EMAIL = prev;
});

/**
 * Gateway calls that name no workspace ON PURPOSE — there is no customer workspace behind them. Everything else must
 * pass `usage` with a workspaceId, or its cost is charged to nobody.
 */
const UNATTRIBUTED_GATEWAY_CALLS: Record<string, string> = {
    'src/utils/site-audit.ts': 'the public site taster (a visitor, before any workspace)',
    'netlify/functions/translate.ts': 'UI microcopy, translated once into a shared cache for every user',
    'netlify/functions/admin-assistants.ts': 'admin catalogue copy',
    'netlify/functions/admin-test-generate-background.ts': 'admin test generation',
    'netlify/functions/ai-visibility-fetch-background.ts': 'the monthly AI Visibility check of Be More Swan itself',
    'src/lib/ai-visibility-accuracy.ts': 'the same AI Visibility check',
    'src/utils/assistant-model.ts': 'a doc comment, not a call',
};

check('every customer gateway call says whose workspace it is', () => {
    const missing: string[] = [];
    for (const f of sources) {
        if (f === 'src/lib/ai-gateway.ts' || UNATTRIBUTED_GATEWAY_CALLS[f]) continue;
        const s = read(f);
        for (const c of calls(s, /gatewayGenerate(?:Grounded)?\(/)) {
            if (!/usage|workspaceId|organisationId|orgId/.test(c)) missing.push(`${f}: ${c.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
    }
    assert.deepStrictEqual(missing, [], `pass usage: { workspaceId, … } to these, or list them in UNATTRIBUTED_GATEWAY_CALLS with why:\n    ${missing.join('\n    ')}`);
});

check('the helpers fixed in the audit pass the workspace through to the gateway', () => {
    assert.ok(/chooseAccentWithModel\(signals, websiteUrl, opts\.usage\)/.test(read('src/lib/brand-extract-fetch.ts')));
    assert.ok(/readWebsiteBrand\(org\.websiteUrl, \{ now, usage: \{ workspaceId: orgId/.test(read('src/lib/brand-extract-fetch.ts')));
    assert.ok(/readWebsiteBrand\(org\.websiteUrl, \{ now, usage: \{ workspaceId: ctx\.organisationId/.test(read('netlify/functions/brand-kit.ts')));
    assert.strictEqual((read('src/utils/pexels.ts').match(/generateImageKeywords\(context, \{ workspaceId: orgId/g) ?? []).length, 2, 'stock keyword calls lost the workspace');
    for (const f of ['netlify/functions/reschedule-post-chat.ts', 'netlify/functions/retry-failed-post.ts']) {
        assert.ok(/parseScheduleInstruction\([^;]*\{ workspaceId: organisationId/.test(read(f)), `${f} reschedules without a workspace`);
    }
    assert.ok(/runWarningVerification\(\{[\s\S]{0,200}usage: \{ workspaceId: post\.organisationId/.test(read('netlify/functions/verify-compliance-warning-background.ts')), 'the grounded fact-check (and its web searches) lost the workspace');
    assert.ok(/\}\), \{ workspaceId: a\.organisationId, assistantId: a\.id, sessionId: 'autonomous-draft' \}\)/.test(read('netlify/functions/autonomous-media-suggestions.ts')), 'autonomous drafts lost the workspace');
    assert.strictEqual((read('netlify/functions/goal-ai.ts').match(/usage: \{ workspaceId: orgId/g) ?? []).length, 4, 'a Goals AI call lost the workspace');
});

check('direct Claude calls in lead generation and troubleshooting log the workspace', () => {
    assert.ok(/logMessageUsage\(resp, MODEL, \{ workspaceId: workspaceId \?\? null, sessionId: 'market-enumerability' \}\)/.test(read('src/lib/market-enumerability.ts')));
    assert.ok(/logMessageUsage\(resp, MODEL, \{ workspaceId: workspaceId \?\? null, sessionId: 'territory-split' \}\)/.test(read('src/lib/territory-split.ts')));
    assert.ok(/logMessageUsage\(resp, MODEL, \{ workspaceId: workspaceId \?\? null, sessionId: 'halt-tightening' \}\)/.test(read('src/utils/halt-tightening.ts')));
    assert.ok(/rewrite\(search\.idea, cold, organisationId\)/.test(read('src/utils/halt-tightening.ts')));
    const dc = read('netlify/functions/discovery-campaigns.ts');
    assert.ok(/assessMarket\([^;]*, orgId\);/.test(dc), 'assessMarket lost the workspace');
    assert.strictEqual((dc.match(/splitTerritories\([\s\S]{0,120}?orgId,?\s*\)/g) ?? []).length, 2, 'splitTerritories lost the workspace');
    assert.ok(/logMessageUsage\(response, MODEL, \{ userId, workspaceId: org\?\.organisationId/.test(read('netlify/functions/social-troubleshoot-chat.ts')));
});

check('direct log calls with no workspace are only system work', () => {
    // A log call naming neither a workspace nor an assistant (which ai-usage.ts resolves to one) is unattributed.
    const SYSTEM: Record<string, string> = {
        'src/utils/search-trends.ts': 'the weekly Google Trends refresh, shared by every workspace tracking a term',
        'netlify/functions/admin-partners-chat.ts': 'admin chat',
        'netlify/functions/admin-systems-chat.ts': 'admin chat',
        'netlify/functions/tour-narration.ts': 'the product tour, spoken once into a shared cache',
    };
    const bare: string[] = [];
    for (const f of sources) {
        if (f === 'src/utils/ai-usage.ts' || SYSTEM[f]) continue;
        for (const c of calls(read(f), /(?<!function )\b(?:logAiUsage|logMessageUsage|logMediaCost|logServiceCost|logRenderCost|logTranscriptionCost)\(/)) {
            if (!/workspaceId|assistantId|\.\.\.|usage|ctx\b|opts\b/.test(c)) bare.push(`${f}: ${c.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
    }
    assert.deepStrictEqual(bare, [], `these log a cost charged to nobody — pass workspaceId:\n    ${bare.join('\n    ')}`);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
