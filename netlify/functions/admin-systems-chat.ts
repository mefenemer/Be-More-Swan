// netlify/functions/admin-systems-chat.ts
//
// Admin → Systems & connections ▸ "Ask about systems" (docs/system-map-plan.md, Phase 2). The chat
// path for the System Map: what's down, what costs most, which model a role uses, what a system is
// for — and adding or ending a monthly bill. GUI and chat are one feature (memory
// assistant-gui-chat-parity): it READS through src/utils/system-map-data.ts (the page's own loader)
// and never writes. A bill change comes back as an action card whose button POSTs exactly the body
// the page's own form sends to admin-system-map.ts, which validates and applies it.
//
//   POST { messages: [{ role: 'user'|'assistant', content: string }] } → { reply, cards }
//
// Cookie: aura_session; `view_system_status` (super admin), never during impersonation. Every model
// call is logged to ai_usage_log against the admin.
// ⚠️ Synchronous functions die at 26 s: a wall-clock budget across the tool loop, as in Partner Ops.

import jwt from 'jsonwebtoken';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { logMessageUsage } from '../../src/utils/ai-usage';
import { sanitizeForModel, safeSlice } from '../../src/utils/text-safe';
import { currentDatePromptBlock } from '../../src/utils/current-date-prompt';
import { loadSystemMap } from '../../src/utils/system-map-data';
import { validateFixedCostRequest } from '../../src/utils/system-map';
import { REVIEWABLE_SYSTEMS, validateReviewRequest } from '../../src/utils/system-review';

type SystemMap = Awaited<ReturnType<typeof loadSystemMap>>;

const jwtSecret = process.env.JWT_SECRET;
export const SYSTEMS_CHAT_MODEL = 'claude-opus-5-5';
const FALLBACK_MODEL = 'claude-opus-4-8';
const MAX_TURNS_IN = 20;
const MAX_CHARS = 4000;
const MAX_TOOL_ROUNDS = 4;
const BUDGET_MS = 21_000;

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const tool = (name: string, description: string, properties: Record<string, unknown> = {}): Anthropic.Beta.BetaTool => ({
    name, description, strict: true,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});
const day = { type: 'string', description: 'A date, YYYY-MM-DD.' } as const;

export const SYSTEMS_CHAT_TOOLS: Anthropic.Beta.BetaTool[] = [
    tool('get_overview', 'Totals (spend last 30 days and all time in GBP, tasks used, cost per task, systems down) and one line per system: key, name, group, health, configured, version, 30-day and all-time spend.'),
    tool('system_detail', 'Everything about one system: purpose, env var names (never values), console link, version, health, spend split variable/fixed, its models with the roles that used them, and its monthly bills (with ids).', { systemKey: { type: 'string' } }),
    tool('list_models', 'Every AI model seen in the usage log or chosen for an assistant role: system, 30-day and all-time spend, calls, roles that used it in 30 days, roles it is chosen for.'),
    tool('propose_add_fixed_cost', 'Offer a card adding a monthly bill to a system (a subscription no API call shows, e.g. Netlify Pro). endedOn null = still paying.', {
        systemKey: { type: 'string' }, label: { type: 'string' }, amountMonthly: { type: 'number' },
        currency: { type: 'string', enum: ['GBP', 'USD', 'EUR'] }, startedOn: day, endedOn: { type: ['string', 'null'] }, note: { type: 'string' },
    }),
    tool('propose_end_fixed_cost', 'Offer a card ending a monthly bill on its last paid day (a price change = end the old bill, add the new one).', { id: { type: 'integer' }, endedOn: day }),
    tool('better_options', 'The stored "better options" checks: for each checked system, the latest verdict (keep / consider / switch), summary, alternatives with what each is better for, switching effort, sources, the date checked, any check in progress, and the decisions already taken. systemKey null = every system.', { systemKey: { type: ['string', 'null'] } }),
    tool('propose_check_now', 'Offer a card starting a fresh web check for better options (about two minutes each, Opus 5.5 with web search — costs a little). systemKeys: system keys, or ["all"] for every checked system.', { systemKeys: { type: 'array', items: { type: 'string' } } }),
    tool('propose_add_decision', 'Offer a card recording a decision about a system (e.g. "Turned down Runway: quality worse in our trial"), so later checks respect it and never re-suggest it.', { systemKey: { type: 'string' }, decision: { type: 'string' } }),
    tool('propose_delete_fixed_cost', 'Offer a card deleting a monthly bill entered by mistake. To stop a real bill, END it instead so all-time totals stay right.', { id: { type: 'integer' } }),
];

const SYSTEM = `You are the Systems assistant on Be More Swan's admin screen Admin → Systems & connections, beside the System Map. You help a Be More Swan super admin understand the external systems the product runs on: whether each is up, what version we use, what it costs, which AI models are used by which assistant roles, and how many tasks customers used.

How the numbers work:
- All money is GBP, converted from USD at the rate in the overview (fx.usdToGbp). Say so when a figure matters.
- Variable spend comes from the usage log (every AI call, image, video, voice, search, render). Fixed spend is the monthly bills the admin entered. "All time" only goes back to "since" — the first logged cost — never imply more.
- Tasks are the work customers were charged for (task ledger). Cost per task = spend in 30 days ÷ tasks in 30 days.
- Health: ok = its check passed, error = check failed, n/a = no free check exists. configured false = its keys are missing in this environment. The map shows THIS deployment only.
- "unmappedModels" is spend the map couldn't place under a system — mention it if it's not empty.

What you can do:
- Answer by calling the read tools. Never guess a number — fetch it.
- Change a monthly bill ONLY with a propose_* tool. That puts a card under your reply; the admin clicks Confirm. Never say a change has been made.
- The same controls are on the screen: click a system on the map → "Monthly bills".
- Better alternatives: answer from the stored checks (better_options) — each is a dated web-search opinion with sources; give the date and say prices may have moved. If a system has no check, or it is old, offer a fresh one with propose_check_now. Only these systems are checked: ${REVIEWABLE_SYSTEMS.join(', ')}. Without a stored check, any view you give is general knowledge: label it so.
- When the admin says they decided against something or chose something on purpose, offer propose_add_decision so the checks respect it.

Be concise: short paragraphs or a compact list, plain British English.`;

function overview(map: SystemMap) {
    return {
        environment: map.environment,
        fx: map.fx,
        roleNames: map.roleNames,   // role key → assistant name; say the name to the admin
        totals: map.totals,
        unmappedModels: map.unmappedModels.map((m) => ({ model: m.model, spend30Gbp: m.spend30Gbp, spendAllGbp: m.spendAllGbp })),
        systems: map.systems.map((s) => ({
            key: s.key, name: s.name, category: s.category, tier: s.tier, health: s.health, configured: s.configured,
            version: (s as { version?: unknown }).version ?? null,
            spend30Gbp: s.spend.total30Gbp, spendAllGbp: s.spend.totalAllGbp, since: s.spend.since,
        })),
    };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });
    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return json(401, { error: 'Not authenticated.' });
    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number; scope?: string };
        if (tok.scope === 'impersonate') return json(403, { error: 'Action blocked during impersonation session.' });
        adminId = tok.userId;
    } catch { return json(401, { error: 'Invalid session.' }); }
    const db = getDb();
    const [admin] = await db.select({ role: users.role }).from(users).where(eq(users.id, adminId)).limit(1);
    const denied = requirePermission(admin?.role, 'view_system_status');
    if (denied) return denied;
    if (!process.env.ANTHROPIC_API_KEY) return json(503, { error: 'The AI assistant is not configured on this deployment.' });

    let body: { messages?: Array<{ role?: unknown; content?: unknown }> };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
    const history: Anthropic.Beta.BetaMessageParam[] = (Array.isArray(body.messages) ? body.messages : [])
        .slice(-MAX_TURNS_IN)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: sanitizeForModel(safeSlice(String(m.content), MAX_CHARS)) }));
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') return json(400, { error: 'Ask a question first.' });

    const host = event.headers?.host || event.headers?.['x-forwarded-host'];
    let mapCache: SystemMap | null = null;
    const map = async () => (mapCache ??= await loadSystemMap(db, host));
    const cards: Array<{ kind: string; title: string; summary: string; request: Record<string, unknown> }> = [];

    async function runTool(name: string, input: Record<string, any>): Promise<unknown> {
        switch (name) {
            case 'get_overview': return overview(await map());
            case 'system_detail': {
                const s = (await map()).systems.find((x) => x.key === String(input.systemKey));
                return s ?? { error: `No system "${input.systemKey}". Call get_overview for the keys.` };
            }
            case 'list_models': {
                const m = await map();
                return { roleNames: m.roleNames, models: [...m.systems.flatMap((s) => s.models), ...m.unmappedModels] };
            }
            case 'better_options': {
                const m = await map();
                const pick = (x: SystemMap['systems'][number]) => ({ key: x.key, name: x.name, reviewable: x.reviewable, review: x.review, checkInProgress: x.reviewAttempt, decisions: x.decisions });
                if (input.systemKey) {
                    const x = m.systems.find((y) => y.key === String(input.systemKey));
                    return x ? pick(x) : { error: `No system "${input.systemKey}".` };
                }
                return m.systems.filter((x) => x.reviewable).map(pick);
            }
            case 'propose_check_now':
            case 'propose_add_decision': {
                const m = await map();
                const body = name === 'propose_check_now'
                    ? { action: 'check_now', systemKeys: Array.isArray(input.systemKeys) && input.systemKeys.includes('all') ? 'all' : input.systemKeys }
                    : { action: 'add_decision', systemKey: input.systemKey, decision: input.decision };
                const v = validateReviewRequest(body, m.systems.map((x) => x.key));
                if ('error' in v) return { offered: false, problem: v.error };
                const req = v.ok;
                const nameOf = (k: string) => m.systems.find((x) => x.key === k)?.name ?? k;
                if (req.action === 'check_now') {
                    const all = body.systemKeys === 'all';
                    cards.push({ kind: 'check_now', title: all ? 'Check every paid system for better options' : `Check ${req.systemKeys.map(nameOf).join(', ')} for better options`,
                        summary: `${req.systemKeys.length} web-search check${req.systemKeys.length === 1 ? '' : 's'} on Opus 5.5, about two minutes each. Costs are logged.`,
                        request: { action: 'check_now', systemKeys: all ? 'all' : req.systemKeys, via: 'chat' } });
                    return { offered: true };
                }
                if (req.action === 'add_decision') {
                    cards.push({ kind: 'add_decision', title: `Record a decision for ${nameOf(req.systemKey)}`, summary: req.decision, request: req as unknown as Record<string, unknown> });
                    return { offered: true };
                }
                return { offered: false, problem: 'Not offered.' };
            }
            case 'propose_add_fixed_cost':
            case 'propose_end_fixed_cost':
            case 'propose_delete_fixed_cost': {
                const m = await map();
                const action = name === 'propose_add_fixed_cost' ? 'add_fixed' : name === 'propose_end_fixed_cost' ? 'end_fixed' : 'delete_fixed';
                const v = validateFixedCostRequest({ ...input, action }, m.systems.map((s) => s.key));
                if ('error' in v) return { offered: false, problem: v.error };
                const req = v.ok;
                const bill = 'id' in req ? m.systems.flatMap((s) => s.fixedCosts).find((b) => b.id === req.id) : null;
                if ('id' in req && !bill) return { offered: false, problem: 'No bill with that id. Call system_detail to see the bills.' };
                const sys = (key: string) => m.systems.find((s) => s.key === key)?.name ?? key;
                const card = req.action === 'add_fixed'
                    ? { title: `Add a monthly bill to ${sys(req.systemKey)}`, summary: `${req.label || 'Monthly bill'}: ${req.currency} ${req.amountMonthly.toFixed(2)} a month from ${req.startedOn}${req.endedOn ? ` to ${req.endedOn}` : ''}.` }
                    : req.action === 'end_fixed'
                        ? { title: `End a ${sys(bill!.systemKey)} bill`, summary: `${bill!.label || 'Monthly bill'} (${bill!.currency} ${bill!.amountMonthly.toFixed(2)}) — last day paid ${req.endedOn}.` }
                        : { title: `Delete a ${sys(bill!.systemKey)} bill`, summary: `${bill!.label || 'Monthly bill'} (${bill!.currency} ${bill!.amountMonthly.toFixed(2)} from ${bill!.startedOn}). This removes it from all totals.` };
                cards.push({ kind: req.action, ...card, request: req as unknown as Record<string, unknown> });
                return { offered: true, card: card.title };
            }
            default: throw new Error(`Unknown tool ${name}`);
        }
    }

    const client = new Anthropic();
    const started = Date.now();
    const messages: Anthropic.Beta.BetaMessageParam[] = [...history];
    const system = `${SYSTEM}\n\n${currentDatePromptBlock({ timezone: 'Europe/London' })}`;
    let reply = '';
    try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const remaining = BUDGET_MS - (Date.now() - started);
            if (remaining < 4_000) { reply ||= 'That needed more steps than I can fit in one go. Try asking about one thing at a time.'; break; }
            const response = await client.beta.messages.create({
                model: SYSTEMS_CHAT_MODEL,
                max_tokens: 8000,
                thinking: { type: 'adaptive' },
                output_config: { effort: 'low' },
                betas: ['server-side-fallback-2026-06-01'],
                fallbacks: [{ model: FALLBACK_MODEL }],
                system,
                tools: SYSTEMS_CHAT_TOOLS,
                ...(round === MAX_TOOL_ROUNDS ? { tool_choice: { type: 'none' as const } } : {}),
                messages,
            }, { timeout: remaining, maxRetries: 0 });
            const served = String(response.model || '').startsWith(FALLBACK_MODEL) ? FALLBACK_MODEL : SYSTEMS_CHAT_MODEL;
            await logMessageUsage(response, served, { userId: adminId, dataCategories: ['business_context'] });

            if (response.stop_reason === 'refusal') { reply = "I can't help with that one."; break; }
            const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
            const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
            if (response.stop_reason !== 'tool_use' || !toolUses.length) {
                reply = text || (response.stop_reason === 'max_tokens' ? 'My answer ran too long — ask for a shorter version.' : '');
                break;
            }
            messages.push({ role: 'assistant', content: response.content });
            const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
            for (const use of toolUses) {
                try {
                    const out = await runTool(use.name, (use.input ?? {}) as Record<string, any>);
                    results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) });
                } catch (err) {
                    console.error('[admin-systems-chat] tool failed', use.name, err);
                    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'That lookup failed. Tell the admin it could not be loaded.' });
                }
            }
            messages.push({ role: 'user', content: results });
        }
    } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) reply = 'That took too long to work out. Try asking about one thing at a time.';
        else if (err instanceof Anthropic.RateLimitError) return json(429, { error: 'The AI service is busy. Try again in a moment.' });
        else if (err instanceof Anthropic.APIError) {
            console.error('[admin-systems-chat] Anthropic error', err.status, err.message);
            return json(502, { error: 'The AI service could not answer just now. Try again.' });
        } else throw err;
    }
    if (!reply && cards.length) reply = cards.length === 1 ? "I've put a card below for you to confirm." : "I've put cards below for you to confirm.";
    return json(200, { reply: reply || 'Sorry, I could not come up with an answer.', cards });
});
