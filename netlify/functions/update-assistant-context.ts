import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, auditLogs, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { enqueueScheduleGapFill } from '../../src/utils/schedule-gap-fill';
import { enqueueBlogGapFill } from '../../src/utils/blog-gap-fill';
import { BLOG_WRITER_ROLE_KEYS, SMM_ROLE_KEYS } from '../../src/constants/roles';
import { MIN_HORIZON_DAYS, MAX_HORIZON_DAYS } from '../../src/config/posting-cadence';
import { normaliseAssistantColor } from '../../src/config/assistant-colors';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Everything the post-save gap-fill needs, captured from inside the write transaction. */
interface GapFillTarget {
    id: number;
    userId: number;
    organisationId: number;
    name: string;
    onboardingContext: Record<string, unknown>;
    draftHorizonDays: number;
    configuration: unknown;
    roleKey: string;
    isActive: boolean;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'PUT') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // 1. Auth + resolve the active organisation (member-shared assistant ownership).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId: currentUserId, organisationId: orgId } = ctx;

    // 2. Payload Extraction
    const { assistantId, newContext, newConfiguration, newName, appliedDefaults, disclosureText, avatarColor } = JSON.parse(event.body || '{}');

    if (!assistantId || !newContext) return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters.' }) };

    // Captured inside the transaction so the post-commit gap-fill below works from the values that
    // were actually written, not a re-read that could race another save.
    let fillTarget: GapFillTarget | null = null;

    try {
        // RLS-enforced: the whole unit of work runs under withTenant (app_user + app.current_org).
        await withTenant(orgId, async (tx) => {
            // Fetch Previous State
            const [existingAssistant] = await tx.select()
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);

            if (!existingAssistant) throw new Error("Assistant not found.");

            // US-GOV-3.1.1: Reject save if trying to clear disclosure on an active assistant
            if (disclosureText !== undefined && !disclosureText?.trim() && existingAssistant.isActive) {
                throw new Error('DISCLOSURE_REQUIRED: AI disclosure text cannot be removed from an active assistant (EU AI Act Art. 52).');
            }

            // This endpoint REPLACES onboardingContext wholesale, so any caller that doesn't
            // round-trip a key silently drops it. That's tolerable for descriptive fields, but
            // publishPolicy governs whether posts publish without human review — the onboarding
            // wizard (assistant-onboarding-shell.js) sends only its own answers, so re-running
            // setup would quietly reset a deployer's auto-publish choice. Carry it across when the
            // caller didn't mention it; an explicit value (even {}) still wins.
            // trigger_type/content_source are carried for the same reason: they are asked once, in
            // the social wizard's Operational Setup step, and the blueprint reads them from here —
            // so a partial save from any other surface must not erase them.
            const CARRY_ACROSS = ['publishPolicy', 'trigger_type', 'content_source'];
            const mergedContext = { ...newContext };
            const existingCtx = (existingAssistant.onboardingContext as Record<string, unknown> | null) ?? {};
            for (const key of CARRY_ACROSS) {
                if (!Object.prototype.hasOwnProperty.call(mergedContext, key)
                    && Object.prototype.hasOwnProperty.call(existingCtx, key)) {
                    mergedContext[key] = existingCtx[key];
                }
            }

            // Perform the Update
            const updatePayload: any = { onboardingContext: mergedContext, updatedAt: new Date() };
            if (newConfiguration) updatePayload.configuration = newConfiguration;
            if (newName) updatePayload.name = newName;
            if (disclosureText !== undefined) updatePayload.disclosureText = disclosureText;

            // The wizard's "How far ahead to schedule" answer lands in onboarding_context, but every
            // reader resolves the horizon from the `draft_horizon_days` COLUMN (see
            // DEFAULT_HORIZON_DAYS in posting-cadence.ts). Promote the answer to the column so the
            // choice actually takes effect — otherwise picking "1 month ahead" is a no-op and the
            // assistant keeps filling the default 7-day window. Clamped to the same 1–30 range
            // set-draft-horizon.ts enforces. A caller that doesn't send the key leaves the column
            // untouched (Number(undefined) is NaN), so partial saves can't reset it.
            const answeredHorizon = Number(mergedContext.draft_horizon_days);
            if (Number.isFinite(answeredHorizon)) {
                const clamped = Math.max(MIN_HORIZON_DAYS, Math.min(MAX_HORIZON_DAYS, Math.round(answeredHorizon)));
                updatePayload.draftHorizonDays = clamped;
                // Keep the legacy jsonb echo equal to the column. It is never read, but callers
                // spread the existing context back in on partial saves, so a stale copy left here
                // would be promoted over a newer value set via set-draft-horizon.ts.
                mergedContext.draft_horizon_days = clamped;
            }
            const existingConfig = (existingAssistant.configuration as any) || {};
            if (appliedDefaults !== undefined) {
                // Merge appliedDefaults into existing configuration rather than overwrite
                updatePayload.configuration = {
                    ...existingConfig,
                    ...(newConfiguration || {}),
                    appliedDefaults: {
                        ...(existingConfig.appliedDefaults || {}),
                        ...appliedDefaults,
                    },
                };
            }

            // ── The assistant's icon colour ────────────────────────────────────────────────────
            // Lives in `configuration.avatarColor`, which means it shares the fate of a field this
            // endpoint REPLACES wholesale: every caller that builds a fresh `newConfiguration` from
            // its own form (the detail page's autosave, the onboarding wizard, integrations.js)
            // would silently wipe the user's colour on the next unrelated save. So the colour is
            // carried across whenever the caller didn't mention it, the same way publishPolicy is
            // carried across in onboardingContext above.
            //
            // An EXPLICIT null is a reset to the automatic id-derived colour, and is honoured;
            // anything outside the palette is dropped rather than stored, because the value is
            // interpolated straight into a style attribute on the surfaces that render it.
            if (avatarColor !== undefined) {
                const chosen = normaliseAssistantColor(avatarColor);
                const base = updatePayload.configuration ?? newConfiguration ?? existingConfig;
                const next = { ...(base as any) };
                if (chosen) next.avatarColor = chosen; else delete next.avatarColor;
                updatePayload.configuration = next;
            } else if (
                Object.prototype.hasOwnProperty.call(existingConfig, 'avatarColor')
                && updatePayload.configuration
                && !Object.prototype.hasOwnProperty.call(updatePayload.configuration, 'avatarColor')
            ) {
                updatePayload.configuration = {
                    ...updatePayload.configuration,
                    avatarColor: existingConfig.avatarColor,
                };
            }
            await tx.update(aiAssistants)
                .set(updatePayload)
                .where(eq(aiAssistants.id, assistantId));

            // Which autopilot engine owns this assistant. Blog and social keep separate queues and
            // separate draft tables, so the post-commit top-up below has to route on the role the
            // same way set-draft-horizon.ts does.
            const [master] = await tx.select({ roleKey: masterAssistants.roleKey })
                .from(masterAssistants)
                .where(eq(masterAssistants.id, existingAssistant.masterAssistantId!))
                .limit(1);

            fillTarget = {
                id: assistantId,
                userId: existingAssistant.userId,
                organisationId: orgId,
                name: updatePayload.name ?? existingAssistant.name,
                onboardingContext: mergedContext,
                draftHorizonDays: updatePayload.draftHorizonDays ?? existingAssistant.draftHorizonDays,
                configuration: updatePayload.configuration ?? existingAssistant.configuration,
                roleKey: master?.roleKey ?? '',
                isActive: existingAssistant.isActive,
            };

            // SCENARIO 5: Create Immutable Audit Log
            await tx.insert(auditLogs).values({
                userId: currentUserId,
                actionType: 'UPDATE_CONTEXT',
                resourceType: 'aiAssistants',
                resourceId: assistantId.toString(),
                previousState: existingAssistant.onboardingContext,
                newState: mergedContext,
                ipAddress: event.headers['x-nf-client-connection-ip'] || 'unknown',
            });
        });

        // Recompile the blueprint so this edit actually reaches generation.
        //
        // Generation drives off the COMPILED blueprint sections, not the live rows — so before this,
        // an edit here changed what the profile displayed while drafts carried on being written from
        // whatever the sections held when they were last assembled. Some fields hid the lag because
        // the worker reads them live (platform_strategy, brand hashtags, operational setup); the
        // rest — audience, tone, pillars, offerings, objective, strict rules — simply did not apply
        // until something else happened to trigger a recompile.
        //
        // It also keeps the STORED blueprint an honest record of what produced a post, which it
        // could not be while half its inputs were read live and half from a stale snapshot.
        //
        // Data assembly only, no LLM call, so it is cheap enough to run on every save. Best-effort
        // exactly as in reject-post.ts: a recompile failure must never fail the user's save — the
        // edit is already committed, and the next recompile picks it up.
        try {
            await assembleBlueprint(assistantId, `user-${currentUserId}`, 'context_update');
        } catch (e) {
            console.warn('[update-assistant-context] blueprint recompile failed (context still saved):', e instanceof Error ? e.message : e);
        }

        // If the user just supplied AI disclosure text, re-trigger this assistant in case it was
        // parked at provisioning_status='blocked' on the disclosure gate (best-effort; the
        // background fn re-evaluates every gate, so it advances or re-blocks accordingly).
        if (typeof disclosureText === 'string' && disclosureText.trim()) {
            const baseUrl = resolveBaseUrl(event.headers);
            if (baseUrl) {
                await retryBlockedAssistants(db, { baseUrl, assistantId, organisationId: orgId }).catch(() => {});
            }
        }

        // ── Top up the draft queue now, rather than at the next cron tick ────────────────────────
        //
        // Saving this form is the moment a hire becomes a working assistant: it is where the
        // publishing cadence and the draft horizon are answered. Nothing here used to enqueue
        // anything, so the first drafts waited for the daily/hourly gap-fill cron — and because
        // blog-horizon-fill runs once a day at 05:00 UTC, a Blog Writer hired at 08:00 sat visibly
        // idle for 21 hours with nothing in the UI to explain the silence. That reads as broken,
        // and the support answer ("wait until tomorrow") is indistinguishable from a real fault.
        //
        // Safe to run on EVERY save, not just the first:
        //   · Both helpers are idempotent — a slot already covered by a planned post or an
        //     in-flight job is skipped, so a repeat save enqueues nothing (`fully_covered`).
        //   · An on-demand cadence returns `on_demand` and enqueues nothing, so switching autopilot
        //     off and saving cannot resurrect it.
        //   · Changing the cadence is exactly when a user expects the queue to follow, so filling
        //     the newly-shaped window here is the behaviour the form already implies.
        //
        // Best-effort, like the recompile above: the save is already committed and the cron remains
        // the backstop, so a failure here must never surface as a failed save.
        let draftsQueued = 0;
        // The assertion is load-bearing: `fillTarget` is only ever assigned inside the withTenant
        // callback, which TS's control-flow analysis does not track, so it narrows the variable to
        // `null` here and every property access below becomes an error on type `never`.
        const target = fillTarget as GapFillTarget | null;
        if (target && target.isActive) {
            try {
                const common = {
                    id: target.id,
                    userId: target.userId,
                    organisationId: target.organisationId,
                    name: target.name,
                    onboardingContext: target.onboardingContext,
                    draftHorizonDays: target.draftHorizonDays,
                };
                // Route by role, and route EXHAUSTIVELY: the social gap-fill used to be the else
                // branch, so every non-blog role — Newsletter, Lead Generator, Campaign — was run
                // through the social posting engine on every save. It reads posting_frequency, and
                // resolvePostingSchedule substitutes a default cadence when there isn't one, so a
                // role that has no posting schedule at all was still judged against one. That is how
                // a Newsletter Assistant on a monthly cadence was told its POSTING schedule could
                // not be read (prod, 20 Aug 2026). Roles with their own engine (Newsletter's
                // draft-newsletter-issues cron) or no drafting at all now enqueue nothing here.
                const result = BLOG_WRITER_ROLE_KEYS.includes(target.roleKey)
                    ? await enqueueBlogGapFill(db, common)
                    : SMM_ROLE_KEYS.includes(target.roleKey)
                        ? await enqueueScheduleGapFill(db, { ...common, configuration: target.configuration })
                        : { enqueued: 0 };
                draftsQueued = result.enqueued;
            } catch (e) {
                console.warn('[update-assistant-context] gap-fill failed (context still saved):',
                    e instanceof Error ? e.message : e);
            }
        }

        // draftsQueued lets the caller tell the user their assistant has already started, instead of
        // ending onboarding on a screen that promises work with no evidence any was scheduled.
        return { statusCode: 200, body: JSON.stringify({ success: true, draftsQueued }) };
    } catch (error: any) {
        if (error?.message?.startsWith('DISCLOSURE_REQUIRED')) {
            return { statusCode: 422, body: JSON.stringify({ error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).', code: 'DISCLOSURE_MISSING' }) };
        }
        console.error('Update Context Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update context.' }) };
    }
});