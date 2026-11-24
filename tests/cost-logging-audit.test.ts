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
import { RenderCostMeter } from '../src/utils/render-cost';
import { recallCostDue } from '../src/utils/meeting-bot';
import { untrackedRecallHours } from '../src/utils/meeting-bot-db';
import type { RenderProgress, StartedRender } from '../src/lib/remotion-lambda';
import { MEDIA_LIST_PRICE_USD, SERVICE_UNIT_PRICE_USD, mediaCostUsd, recallBotBilling, recallBotHours, serviceUnitPriceUsd } from '../src/utils/ai-usage';

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

check('Recall bot: recording from the join attempt, transcript only in the call, to the second', () => {
    assert.strictEqual(SERVICE_UNIT_PRICE_USD['recall-bot-hour'].fallback, 0.5, '$0.50/h of recording');
    assert.strictEqual(SERVICE_UNIT_PRICE_USD['recall-transcript-hour'].fallback, 0.15, '$0.15/h transcript');
    const at = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00Z`);
    assert.strictEqual(recallBotHours(at('10:00'), at('10:30')), 0.5);
    assert.strictEqual(recallBotHours(at('10:00'), new Date('2026-11-23T10:00:00.400Z')), 1 / 3600, 'a part second is billed as a second');
    assert.strictEqual(recallBotHours(null, at('10:00')), 0);
    // Waited 10 minutes, admitted, 30 minutes in the call.
    assert.deepStrictEqual(recallBotBilling({ joiningAt: at('10:00'), joinedAt: at('10:10'), leftAt: at('10:40') }), { botHours: 40 / 60, transcriptHours: 0.5 });
    // Never admitted: the waiting room is still billed, no transcript.
    assert.deepStrictEqual(recallBotBilling({ joiningAt: at('10:00'), joinedAt: null, leftAt: at('10:15') }), { botHours: 0.25, transcriptHours: 0 });
    // join_at after admission (clock skew, joined early): never billed from later than admission.
    assert.deepStrictEqual(recallBotBilling({ joiningAt: at('10:05'), joinedAt: at('10:00'), leftAt: at('10:30') }), { botHours: 0.5, transcriptHours: 0.5 });
    // Left "before" it set off (a bot that failed at once): nothing.
    assert.deepStrictEqual(recallBotBilling({ joiningAt: at('10:00'), joinedAt: null, leftAt: at('09:59') }), { botHours: 0, transcriptHours: 0 });
});

check('Recall bot: the charge is due only on the way INTO a final state (runs the rule)', () => {
    // Every real path a bot takes, as (before → after) saved transitions: exactly one is due per bot.
    const paths: Array<string[]> = [
        ['scheduled', 'joining', 'waiting_room', 'in_call', 'ended', 'done'],   // a normal call
        ['joining', 'in_call', 'done'],                                           // sent now, fatal after joining → done
        ['scheduled', 'joining', 'waiting_room', 'not_admitted'],                 // never let in
        ['joining', 'failed'],                                                    // failed before joining
        ['joining', 'waiting_room', 'removed', 'done'],                           // removed, then Recall's 'done' (final → final)
        ['scheduled', 'cancelled'],                                               // we cancelled it
    ];
    for (const path of paths) {
        let due = 0;
        for (let k = 1; k < path.length; k++) if (recallCostDue(path[k - 1], path[k])) due++;
        assert.strictEqual(due, 1, `${path.join(' → ')} logs ${due} times, not once`);
    }
    assert.strictEqual(recallCostDue('done', 'done'), false, 'a repeated done must not log again');
    assert.strictEqual(recallCostDue('in_call', 'in_call'), false);
});

check('Recall bot we can neither follow nor take back: logged at the most it can run', () => {
    // 10 min waiting + 120 min in the call + 2 min alone; transcript for the 120 min.
    assert.deepStrictEqual(untrackedRecallHours(120), { botHours: (600 + 7200 + 120) / 3600, transcriptHours: 2 });
    // The length limit is cleaned the same way as when the bot was sent (5..240 minutes).
    assert.strictEqual(untrackedRecallHours(10_000).transcriptHours, 4);
});

check('Recall bot: every path that ends a bot logs it, against the bot\'s workspace', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    const helper = db.slice(db.indexOf('async function logRecallBotCost('), db.indexOf('export const botExternalId'));
    assert.ok(helper.length > 0, 'logRecallBotCost() is gone');
    assert.ok(/workspaceId: row\.organisationId/.test(helper), 'the Recall cost lost its workspace');
    assert.ok(/recallBotBilling\(\{ joiningAt: row\.joinAt, joinedAt: row\.joinedAt, leftAt \}\)/.test(helper), 'not timed from the join attempt');
    assert.ok(/logServiceCost\('recall-bot-hour', botHours/.test(helper) && /logServiceCost\('recall-transcript-hour', transcriptHours/.test(helper));
    // Recall's events: applyBotPatch logs when the saved change makes it due (the rule above).
    const patch = db.slice(db.indexOf('async function applyBotPatch('), db.indexOf('async function logRecallBotCost('));
    assert.ok(/if \(!saved\) return row\.status as BotStatus;[\s\S]{0,400}if \(recallCostDue\(row\.status, saved\.status\)\) \{\s*await logRecallBotCost\(saved, saved\.leftAt\)/.test(patch),
        'a bot reaching a final state no longer records Recall\'s charge (or not from the SAVED change)');
    // Capped at the most a bot can run, so a long-stale row can't log days of bot time.
    assert.ok(/const max = untrackedRecallHours\(row\.lengthLimitMinutes\);\s*await logRecallHours\(row, Math\.min\(b\.botHours, max\.botHours\), Math\.min\(b\.transcriptHours, max\.transcriptHours\)\)/.test(helper), 'Recall hours are no longer capped');
    // Recall answers 'deleted' only for a bot that never started joining: no charge, so removeMeetingBot logs nothing.
    const remove = db.slice(db.indexOf('export async function removeMeetingBot('), db.indexOf('// ── Recall\'s events'));
    assert.ok(!/logRecallBotCost\(/.test(remove), 'removeMeetingBot logs a bot Recall deleted before it ran');
    // Withdrawn with its assistant and asked to LEAVE: it ran, and our final 'cancelled' hides its later events.
    const withdraw = db.slice(db.indexOf('export async function withdrawMeetingBots('));
    assert.ok(/statusReason: 'assistant_or_workspace_removed'[\s\S]{0,900}if \(saved && how === 'left'\) await logRecallBotCost\(saved, new Date\(\)\)/.test(withdraw), 'a running bot withdrawn with its assistant records nothing');
    // A bot Recall accepted but we couldn't record (id unsaved, or the row closed meanwhile) and couldn't take back.
    const send = db.slice(db.indexOf('export async function sendMeetingBot('), db.indexOf('// ── Listing and removing'));
    assert.ok(/if \(!\(await removeRecallBot\(region, recallBotId, true\)\.catch\(\(\) => null\)\)\) await logUntrackedRecallBot\(row\)/.test(send), 'a bot withdrawn mid-send that Recall kept records nothing');
    assert.ok(/if \(!back\) await logUntrackedRecallBot\(row\)/.test(send), 'a bot whose id never saved records nothing');
    // The only Recall caller stays the only one: a new one must log too. (meeting-bot.ts only DEFINES RECALL_HOSTS.)
    const direct = sources.filter((f) => !['src/utils/meeting-bot-recall.ts', 'src/utils/meeting-bot.ts'].includes(f) && /recall\.ai\/api|RECALL_HOSTS/.test(read(f)));
    assert.deepStrictEqual(direct, [], `these call Recall directly:\n    ${direct.join('\n    ')}`);
});

console.log('\nRemotion renders — logged once, however they end');

async function meterRun(steps: (m: RenderCostMeter) => Promise<void>, progressOf: (r: StartedRender) => Promise<RenderProgress>): Promise<Array<number | null | undefined>> {
    const logged: Array<number | null | undefined> = [];
    const m = new RenderCostMeter({ workspaceId: 7 }, progressOf, async (cost) => { logged.push(cost); });
    await steps(m);
    return logged;
}
const R1: StartedRender = { renderId: 'r1', bucketName: 'b', region: 'eu-west-2' };
const R2: StartedRender = { renderId: 'r2', bucketName: 'b', region: 'eu-west-2' };
const prog = (over: Partial<RenderProgress>): RenderProgress => ({ done: false, progress: 0.5, outputUrl: null, error: null, costUsd: null, ...over });
const asyncChecks: Array<Promise<void>> = [];
function checkAsync(name: string, fn: () => Promise<void>): void {
    asyncChecks.push(fn().then(() => { passed++; console.log(`  ✓ ${name}`); }, (err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }));
}

checkAsync('a finished render is logged once, with Remotion\'s cost', async () => {
    const logged = await meterRun(async (m) => {
        await m.started(R1);
        await m.seen(prog({ costUsd: 0.01 }));
        await m.seen(prog({ done: true, outputUrl: 'x', costUsd: 0.03 }));
        await m.seen(prog({ done: true, outputUrl: 'x', costUsd: 0.03 }));
        await m.abandon();
    }, async () => { throw new Error('not asked'); });
    assert.deepStrictEqual(logged, [0.03]);
});

checkAsync('a fatal error then a retry: both renders logged, once each', async () => {
    const logged = await meterRun(async (m) => {
        await m.started(R1);
        await m.seen(prog({ done: true, error: 'No frame found', costUsd: 0.02 }));
        await m.started(R2);
        await m.seen(prog({ done: true, outputUrl: 'x', costUsd: 0.04 }));
    }, async () => { throw new Error('not asked'); });
    assert.deepStrictEqual(logged, [0.02, 0.04]);
});

checkAsync('an abandoned render (timeout / throw) is logged with what Remotion says it spent', async () => {
    const logged = await meterRun(async (m) => {
        await m.started(R1);
        await m.seen(prog({ costUsd: 0.05 }));
        await m.abandon();
        await m.abandon();
    }, async () => prog({ costUsd: 0.08 }));
    assert.deepStrictEqual(logged, [0.08]);
});

checkAsync('Remotion unreachable on abandon: the last cost we saw', async () => {
    const logged = await meterRun(async (m) => {
        await m.started(R1);
        await m.seen(prog({ costUsd: 0.05 }));
        await m.abandon();
    }, async () => { throw new Error('network'); });
    assert.deepStrictEqual(logged, [0.05]);
});

checkAsync('a render started while another is open logs the first before following the second', async () => {
    const logged = await meterRun(async (m) => {
        await m.started(R1);
        await m.seen(prog({ costUsd: 0.01 }));
        await m.started(R2);
    }, async () => prog({ costUsd: 0.02 }));
    assert.deepStrictEqual(logged, [0.02]);
});

check('both render loops go through the meter: started, every poll, and every way out', () => {
    for (const f of ['src/utils/video-render.ts', 'netlify/functions/render-post-video-background.ts']) {
        const s = read(f);
        assert.ok(!/logRenderCost\(/.test(s), `${f} logs a render cost itself — use RenderCostMeter so it is once per render`);
        assert.strictEqual((s.match(/await startRender\([^)]*\);\s*await meter\.started\(started\);/g) ?? []).length, 2, `${f}: the first render and the retry must both be metered`);
        assert.ok(/const progress = await renderProgress\(started\);[\s\S]{0,120}await meter\.seen\(progress\);/.test(s), `${f}: a poll is not metered`);
        assert.ok(/Date\.now\(\) > deadline\)\s*\{\s*await meter\.abandon\(\);/.test(s), `${f}: a timed-out render logs nothing`);
        assert.ok(/\} catch \(err\) \{\s*await meter\.abandon\(\);/.test(s), `${f}: a render cut short by an error logs nothing`);
    }
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

void Promise.all(asyncChecks).then(() => console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`));
