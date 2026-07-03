// netlify/functions/assistant-command.ts
// US-DASH-3 (AC3): the omnipresent command bar's brain. Takes a free-text command,
// interprets intent with an LLM, and returns a friendly reply plus a STRUCTURED action
// the client executes against existing endpoints (no new execution surface here):
//
//  POST { command: string }
//   → { type: 'navigate'|'delegate'|'answer', reply, view?, assistantId?, platform?, brief? }
//
// Interpretation only — the client performs navigation (loadView), delegation
// (generate-post), or simply shows the answer. Auth: aura_session + active org.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { computeOnboardingProgress } from '../../src/utils/onboarding-progress';
import { provisioningBlockInfo } from '../../src/utils/assistant-lifecycle';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// The workspace views the bar is allowed to route to (mirrors workspace.html routes).
// `assets` (Business Information) is included so the bar can route a user to the setup
// step that lives there when they ask about their onboarding progress.
const VIEWS = ['dashboard', 'assistants', 'review-queue', 'calendar', 'my-content', 'catalog', 'billing', 'settings', 'notifications', 'help', 'referral', 'assets'] as const;

// Light per-instance rate limit to keep the bar cheap (matches social-troubleshoot-chat style).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const rate = new Map<number, { count: number; start: number }>();
function allow(userId: number): boolean {
    const now = Date.now();
    const e = rate.get(userId);
    if (!e || now - e.start > RATE_WINDOW_MS) { rate.set(userId, { count: 1, start: now }); return true; }
    if (e.count >= RATE_MAX) return false;
    e.count++; return true;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    if (!allow(userId)) {
        return { statusCode: 429, body: JSON.stringify({ type: 'answer', reply: 'You are sending commands very quickly — give me a moment and try again.' }) };
    }

    let body: { command?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const command = (body.command || '').trim();
    if (!command) return { statusCode: 400, body: JSON.stringify({ error: 'command is required' }) };
    if (command.length > 600) return { statusCode: 400, body: JSON.stringify({ type: 'answer', reply: 'That is a bit long for the command bar — try a shorter instruction.' }) };

    // All non-archived assistants (with live status) so the bar can both route/delegate AND
    // actually answer "why isn't X working" questions instead of vaguely promising to look into
    // it — every assistant's real lifecycle/provisioning state is given to the LLM below.
    const [allAssistants, progress] = await Promise.all([
        db.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            lifecycleStatus: aiAssistants.lifecycleStatus,
            provisioningStatus: aiAssistants.provisioningStatus,
            provisioningBlockedReason: aiAssistants.provisioningBlockedReason,
        })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.organisationId, orgId), inArray(aiAssistants.lifecycleStatus, ['provisioning', 'ready_for_work', 'working', 'paused', 'system_paused']))),
        computeOnboardingProgress(db, orgId, userId),
    ]);

    // Delegation only makes sense for assistants that can actually pick up work.
    const assistants = allAssistants.filter(a => ['working', 'ready_for_work', 'paused'].includes(a.lifecycleStatus));

    // Plain-English status per assistant so the LLM can give a real, specific answer instead of
    // deflecting to "let me look into it" with nothing to actually check.
    function describeStatus(a: typeof allAssistants[number]): string {
        switch (a.lifecycleStatus) {
            case 'working': return 'active and running normally';
            case 'ready_for_work': return 'set up and ready, but not yet started';
            case 'paused': return 'paused by a user — resume it from the Assistants page to continue';
            case 'system_paused': return 'automatically paused by the system (e.g. an expired/broken connection) — check its Overview tab for the reason, or reconnect the affected account';
            case 'provisioning':
                if (a.provisioningStatus === 'blocked') return `blocked during setup: ${provisioningBlockInfo(a.provisioningBlockedReason).message}`;
                if (a.provisioningStatus === 'failed') return 'setup failed — try retrying setup from the Assistants page';
                return 'still being set up';
            default: return a.lifecycleStatus;
        }
    }

    const assistantList = allAssistants.length
        ? allAssistants.map(a => `  - id ${a.id}: "${a.name}" (${a.role || 'assistant'}) — status: ${describeStatus(a)}`).join('\n')
        : '  (none active yet)';

    // A compact, LLM-readable view of where the user is in the 9-step setup journey. Each
    // step shows whether it's done, and the next incomplete step (if any) names the view the
    // user should be routed to — so "what's left?" / "what next?" get accurate, actionable
    // answers rather than a generic guess.
    const nextStep = progress.allDone ? null : progress.steps[progress.currentStep - 1];
    const setupSummary = progress.allDone
        ? 'The user has COMPLETED all setup steps — onboarding is finished. Do not nudge them through setup.'
        : [
            `The user is part-way through setup: ${progress.completedCount} of ${progress.total} steps done (currently on step ${progress.currentStep}).`,
            'Steps:',
            ...progress.steps.map((s, i) => `  ${i + 1}. [${s.done ? 'x' : ' '}] ${s.label}${s.view ? ` (view: ${s.view})` : ''}`),
            nextStep
                ? `Next incomplete step: "${nextStep.label}" — ${nextStep.benefit}${nextStep.view ? ` The view that handles it is "${nextStep.view}".` : ''}`
                : '',
        ].filter(Boolean).join('\n');

    const system = `You are the command interpreter for "Be More Swan", a digital-assistant platform for small businesses.
The user typed a quick command into a Spotlight-style command bar. Decide the single best action and reply in JSON only.

Available workspace views and what each one can actually do (use the exact key on the left):
- dashboard: home overview — key metrics, recent activity, and a "Customize" tray to add/remove/rearrange dashboard WIDGETS (layout only; it does NOT change colours, themes, or appearance).
- assistants: view and manage the user's hired AI assistants (pause, resume, configure, open an assistant's detail/guardrails).
- review-queue: approve, edit, request changes to, or schedule content drafts awaiting approval.
- calendar: the content calendar of scheduled and published posts.
- my-content: the content library / uploaded and created assets.
- catalog: hire (add) new assistants.
- billing: subscription, plan tier, and payment details.
- settings: profile information, notification preferences, sound toggles, agency attribution, and the AI disclosure footer. (There are NO appearance, theme, colour, or dark-mode settings here.)
- notifications: the user's notifications list.
- help: help articles and support tickets.
- referral: refer-and-earn / invite others.
- assets: Business Information — the user's business profile (industry, description, target audience) and brand details used during setup.

The platform has a FIXED visual theme. There is no feature anywhere to change colours, themes, fonts, accent colours, dark mode, or general appearance of the dashboard or workspace.

The user's assistants and their REAL current status (this is the only information you have about them — you cannot inspect logs or run any further checks):
${assistantList}

The user's setup progress (use this to answer "what's left to do?", "what should I do next?", "how do I get started?", or to tailor any guidance to where they actually are — never assume they're fully set up):
${setupSummary}

Return STRICT JSON (no markdown, no prose) with this shape:
{
  "type": "navigate" | "delegate" | "answer",
  "reply": "one short, warm first-person sentence confirming what you're doing",
  "view": "<one view key>",          // only for navigate
  "assistantId": <number|null>,       // only for delegate; pick the most relevant active assistant, else null
  "platform": "instagram|facebook|linkedin|x|null",  // only for delegate, if a social platform is named/implied
  "brief": "<concise brief of what to create>",       // only for delegate
  "suggestView": "<one view key|null>",              // only for answer; the view where the user can do what they asked about
  "suggestReportIssue": <true|false>                  // only for answer; true when you cannot fully resolve a "not working" question from the status data given
}

Rules:
- "navigate" when the user wants to go somewhere or see something (e.g. "show my review queue", "open calendar", "what needs approval").
- "delegate" when the user wants the team to CREATE or DO something (e.g. "draft a LinkedIn post about our sale", "write an Instagram caption"). Choose the most relevant assistant id; if none fits, set assistantId null and still give a brief.
- "answer" for questions you can answer briefly, greetings, or anything that doesn't map to a view or a delegation.
- For "why isn't <assistant> working" / "what's wrong with <assistant>" / "<assistant> isn't posting" style questions, use type "answer" and give a REAL, specific diagnosis straight from that assistant's status line above (e.g. name the actual paused/blocked/provisioning reason and the concrete fix). NEVER reply with a vague promise like "let me look into that" or "I'll help you diagnose this" — you have no way to investigate further than the status already given, so either state the concrete cause now or immediately say you can't tell from here.
- If the assistant's status above already looks healthy ("active and running normally") but the user insists something is wrong, OR the status data doesn't explain the specific problem they describe, say plainly that you can't identify the cause from here and set "suggestReportIssue" to true so they can report it to be looked into — do not just say you'll look into it yourself and stop.
- For setup/onboarding questions ("what's left to set up?", "what should I do next?", "how do I get started?", "am I done?"), use type "answer", base the reply on the setup-progress data above, and set "suggestView" to the next incomplete step's view (if any) so the user gets a "Take me there →" button to the right next step. If all steps are done, say so and do not push them through setup.
- For "how do I / where do I / where can I" questions whose answer lives in a workspace view (e.g. "how do I change my settings", "where do I update billing"), use type "answer" AND set "suggestView" to that view key. The client will show a "Take me there →" button, so the reply should name the place (e.g. "You can change that under Settings — I'll add a button to take you there.") and must NOT claim you have already navigated.
- Only promise to take the user somewhere when you actually set "view" (navigate) or "suggestView" (answer). Never say "I'll point you there" or "taking you there" without one of those set.
- ONLY set "view" or "suggestView" to a view that genuinely supports what the user asked, per the capability list above. If NO view supports the request (e.g. "change the dashboard colour", "turn on dark mode", "change the theme/font"), DO NOT navigate or set suggestView. Instead return type "answer", suggestView null, and say plainly that the feature isn't available — mention the closest real capability if there is one (e.g. "The dashboard's colours aren't customisable, but you can rearrange its widgets with the Customize button on the dashboard."). Never route the user to a view that can't do the thing they asked.
- Keep "reply" under 22 words, friendly, first person ("On it — ...", "Opening ...", "Here's ...").
- Never invent assistant ids or view keys.`;

    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 300,
            system,
            messages: [{ role: 'user', content: command }],
        });

        const raw = (response.content[0] as { text: string }).text.trim();
        // Defensive parse: strip any accidental code fences.
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let parsed: any;
        try { parsed = JSON.parse(jsonText); } catch {
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'answer', reply: raw.slice(0, 240) || "Sorry, I didn't quite catch that — try rephrasing." }) };
        }

        // Validate / sanitise the action so the client can trust it.
        const type = ['navigate', 'delegate', 'answer'].includes(parsed.type) ? parsed.type : 'answer';
        const out: any = { type, reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : 'Done.' };

        if (type === 'navigate') {
            out.view = (VIEWS as readonly string[]).includes(parsed.view) ? parsed.view : 'dashboard';
        } else if (type === 'answer') {
            // "how do I / where do I" questions: surface a "Take me there →" button.
            if ((VIEWS as readonly string[]).includes(parsed.suggestView)) out.suggestView = parsed.suggestView;
            // "why isn't X working" questions the LLM couldn't fully resolve: surface a
            // "Report an issue →" button instead of leaving the user with a dead-end promise.
            if (parsed.suggestReportIssue === true) out.suggestReportIssue = true;
        } else if (type === 'delegate') {
            const validId = assistants.find(a => a.id === Number(parsed.assistantId));
            out.assistantId = validId ? validId.id : null;
            out.platform = ['instagram', 'facebook', 'linkedin', 'x'].includes((parsed.platform || '').toLowerCase()) ? parsed.platform.toLowerCase() : null;
            out.brief = typeof parsed.brief === 'string' ? parsed.brief.slice(0, 500) : command;
            // If we have no assistant to delegate to, soften to guidance.
            if (!out.assistantId) {
                out.type = 'answer';
                out.reply = assistants.length
                    ? `I couldn't tell which assistant should handle that — open Assistants and I'll help you pick.`
                    : `You don't have an active assistant for that yet — let's hire one from the catalog.`;
                out.suggestView = assistants.length ? 'assistants' : 'catalog';
            }
        }

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
    } catch (err) {
        console.error('[assistant-command] LLM error:', err);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'answer', reply: "I'm having trouble right now — please try again in a moment." }) };
    }
};
