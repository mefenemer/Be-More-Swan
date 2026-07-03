// netlify/functions/get-wizard-state.ts
// Endpoint for the Frictionless Onboarding Wizard — the persistent right-hand slide-over
// companion checklist. Reports the 8-step journey with live `done` flags, the next
// incomplete step (resume focus, US2 AC5), and aggregate completion + dismissed signals
// that drive auto-open / go-live behaviour.
//
// The step computation now lives in src/utils/onboarding-progress so the Swan Command Bar
// ("Ask your team anything") can share the exact same source of truth. The drawer owns NO
// form data — each step deep-links to the real page, whose existing auto-save persists the
// input. This endpoint only reports aggregate state. Read-only.

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { computeOnboardingProgress } from '../../src/utils/onboarding-progress';
import { computeAssistantReadiness } from './get-assistant-readiness';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    // ── Secondary-onboarding scoping (US8 AC3) ──────────────────────────────
    // When a user adds another assistant, steps 6-8 must track only THAT new assistant.
    // The client passes mode=new plus a monotonic baseline (max assistant/draft id captured
    // the moment "Add New Assistant" was clicked). Ids survive the full-page hop to the
    // standalone onboarding wizard (carried in sessionStorage) and are immune to clock skew.
    const qs = event.queryStringParameters || {};
    const progress = await computeOnboardingProgress(db, orgId, userId, {
        isNewMode: qs.mode === 'new',
        sinceAssistantId: Number(qs.sinceAssistantId || 0),
        sinceDraftId: Number(qs.sinceDraftId || 0),
    });

    // Hydrate the "Preparing your assistant" step with the Board Room readiness checklist so the
    // wizard surfaces every outstanding kick-off item (tools, AI disclosure, ToS/DPA, guardrails…)
    // as in-drawer sub-tasks — and can fire the inline Kick Off once they're all green. Best-effort:
    // any failure (e.g. table not yet migrated) just leaves the step without sub-tasks.
    const steps = progress.steps as (typeof progress.steps[number] & {
        subSteps?: unknown; subStepsAllRequiredDone?: boolean; subStepsReady?: boolean;
    })[];
    const preparing = steps.find(s => s.key === 'preparing');
    if (preparing && progress.primaryAssistantId) {
        try {
            const readiness = await computeAssistantReadiness(db, orgId, progress.primaryAssistantId);
            if (readiness) {
                preparing.subSteps = readiness.items;
                preparing.subStepsAllRequiredDone = readiness.allRequiredDone;
                // The inline Kick Off may fire only once the assistant is actually kick-off-able:
                // provisioning complete (ready_for_work), every required readiness item green, and
                // not already live. Otherwise kickoff-assistant would 409/422.
                preparing.subStepsReady = readiness.status === 'complete'
                    && readiness.allRequiredDone === true && readiness.working !== true;
            }
        } catch (err) {
            console.warn('[get-wizard-state] readiness sub-tasks unavailable (non-blocking):', err);
        }
    }

    return json(200, {
        steps,
        currentStep: progress.currentStep,
        allDone: progress.allDone,
        completedCount: progress.completedCount,
        total: progress.total,
        // Auto-open is driven by the wizard's OWN 9-step completion (allDone), NOT the legacy
        // 3-step `onboarding_completed` flag (which flips after only a subset of these steps).
        // `allDone` + the go-live celebration already hide the drawer permanently for finished
        // users, and per-session collapse handles "not now", so no separate dismissal signal.
        dismissed: false,
        // Baseline anchors for the next "add assistant" journey (US8 AC3).
        maxAssistantId: progress.maxAssistantId,
        maxDraftId: progress.maxDraftId,
        // The assistant the "Preparing your assistant" step (and its sub-tasks) deep-links into.
        primaryAssistantId: progress.primaryAssistantId,
    });
};
