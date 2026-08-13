// src/utils/assistant-platform-selection.ts
// "Which platforms has the user ENABLED for THIS assistant?" — the per-assistant half of a question
// whose other half is resolveLiveSocialConnections (org-level: is there a live token?).
//
// Connections are a shared ORG pool, but each assistant carries its own "Use for this assistant"
// switch per connected platform (integrations.js → _intToggleUseForAssistant). Nothing on the
// drafting side ever read that switch: every autonomous path asked only "is the org connected?",
// so turning a platform OFF for an assistant changed the card in front of the user and nothing
// else — the assistant kept drafting for it, week after week, with no way to stop short of
// disconnecting the account for the whole workspace.
//
// Flipping the switch writes TWO fields, and both have to be read or the answer is wrong in one
// direction or the other:
//
//   onboarding_context.primary_platforms   — platform slugs / short codes ('yt', 'youtube', 'ig'…)
//   onboarding_context.linked_integrations — the ticked CONNECTION IDS, mirrored into
//                                            configuration.appliedDefaults.platforms
//
// Reading the slugs alone under-reports: the client builds that list from connections carrying a
// user_id, and a workspace_integrations-backed platform (Threads, YouTube) merges into the grid
// without one — so ticking YouTube adds its id to linked_integrations and nothing to
// primary_platforms. Reading the ids alone under-reports the other way, for assistants onboarded
// before the switch existed, whose selection only ever existed as slugs.
//
// Ids follow the convention integrations.ts established: positive = system_connections.id,
// negative = -workspace_integrations.id (the two tables have independent id sequences, so a bare
// positive id could name a row in either).

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { systemConnections, workspaceIntegrations } from '../../db/schema';
import { normalizePlatform, type SocialPlatform } from '../config/platform-formats';

/** Also satisfied by a drizzle transaction handle, like the other resolvers in this directory. */
type DbLike = Pick<ReturnType<typeof getDb>, 'select'>;

export interface AssistantPlatformScope {
    organisationId: number;
    /** ai_assistants.onboarding_context jsonb. */
    onboardingContext: unknown;
    /** ai_assistants.configuration jsonb — carries appliedDefaults.platforms. Optional. */
    configuration?: unknown;
}

/** Every numeric connection id the two selection fields between them name. */
function readSelectedConnectionIds(ctx: Record<string, unknown>, configuration: unknown): number[] {
    const applied = (configuration as { appliedDefaults?: { platforms?: unknown } } | null)
        ?.appliedDefaults?.platforms;
    const ids = new Set<number>();
    for (const source of [ctx.linked_integrations, applied]) {
        if (!Array.isArray(source)) continue;
        for (const raw of source) {
            const n = Number(raw);
            if (Number.isInteger(n) && n !== 0) ids.add(n);
        }
    }
    return [...ids];
}

/**
 * The platforms this assistant is switched ON for, or null when the assistant has no selection
 * recorded at all.
 *
 * Null means DO NOT FILTER, and that distinction is the whole safety property of this function: an
 * assistant hired before the per-assistant switches existed — or one whose user has simply never
 * opened the Connections tab — has an empty selection that means "nobody has said anything", not
 * "the user turned everything off". Treating those as a filter would silently stop an entire
 * workspace from drafting, which is a far worse failure than the one this module fixes. So an
 * empty or unrecognisable selection reads as null and every caller behaves exactly as before; only
 * a selection that names at least one real platform ever narrows anything.
 */
export async function resolveAssistantEnabledPlatforms(
    db: DbLike,
    scope: AssistantPlatformScope,
): Promise<Set<SocialPlatform> | null> {
    const ctx = (scope.onboardingContext as Record<string, unknown> | null) ?? {};
    const slugs = Array.isArray(ctx.primary_platforms) ? ctx.primary_platforms : [];
    const ids = readSelectedConnectionIds(ctx, scope.configuration);
    if (!slugs.length && !ids.length) return null;

    const enabled = new Set<SocialPlatform>();
    for (const slug of slugs) {
        const platform = normalizePlatform(slug);
        if (platform) enabled.add(platform);
    }

    // Both queries are scoped to the organisation as well as the id: a selection is user-supplied
    // data on a row we already trust, but resolving it must never reach across tenants.
    const systemIds = ids.filter(id => id > 0);
    const workspaceIds = ids.filter(id => id < 0).map(id => -id);
    const [sysRows, wsRows] = await Promise.all([
        systemIds.length
            ? db.select({ serviceName: systemConnections.serviceName })
                .from(systemConnections)
                .where(and(
                    eq(systemConnections.organisationId, scope.organisationId),
                    inArray(systemConnections.id, systemIds),
                ))
            : Promise.resolve([] as { serviceName: string | null }[]),
        workspaceIds.length
            ? db.select({ provider: workspaceIntegrations.provider })
                .from(workspaceIntegrations)
                .where(and(
                    eq(workspaceIntegrations.organisationId, scope.organisationId),
                    inArray(workspaceIntegrations.id, workspaceIds),
                ))
            : Promise.resolve([] as { provider: string }[]),
    ]);
    for (const row of [...sysRows.map(r => r.serviceName), ...wsRows.map(r => r.provider)]) {
        const platform = normalizePlatform(row);
        if (platform) enabled.add(platform);
    }

    return enabled.size ? enabled : null;
}

/**
 * True when this assistant may draft for `platform`. Enabled BY DEFAULT — see the null contract
 * above — so a platform is only ever refused because a selection exists and leaves it out.
 *
 * This is the right question for the ordinary drafting stream, where refusing on a blank selection
 * would stop a workspace posting altogether. It is the wrong question for anything a user would be
 * surprised to receive uninvited — see isPlatformOptedInForAssistant.
 */
export async function isPlatformEnabledForAssistant(
    db: DbLike,
    scope: AssistantPlatformScope,
    platform: SocialPlatform,
): Promise<boolean> {
    const enabled = await resolveAssistantEnabledPlatforms(db, scope);
    return !enabled || enabled.has(platform);
}

/**
 * True only when the assistant is EXPLICITLY ticked for `platform`. A blank selection answers
 * false, which is the opposite of isPlatformEnabledForAssistant and the whole point of having two.
 *
 * Opt-in is for output a user would not expect to arrive uninvited, and the weekly YouTube Short is
 * the case it was written for. Connecting a YouTube channel has never meant "draft me a video every
 * week" — the channel is usually linked so that posts a human composes can publish to it — yet the
 * Short was enqueued off nothing but a live connection. Falling open there would keep producing a
 * video a week for every workspace that has never touched the switches, which is exactly the
 * behaviour being fixed; the cost of falling closed is only that a user who wants Shorts has to
 * turn one switch on.
 */
export async function isPlatformOptedInForAssistant(
    db: DbLike,
    scope: AssistantPlatformScope,
    platform: SocialPlatform,
): Promise<boolean> {
    const enabled = await resolveAssistantEnabledPlatforms(db, scope);
    return !!enabled?.has(platform);
}
