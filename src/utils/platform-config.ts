/**
 * src/utils/platform-config.ts
 *
 * US-ADM-3.2.1: Platform Kill Switches & Emergency Controls
 *
 * getPlatformConfig() — fetches platform_config from DB with a 30-second
 * in-process cache so AI calls add zero per-request DB latency.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { platformConfig } from '../../db/schema';

// ── Kill switch / config keys used across the platform ────────────────────────
export const CONFIG_KEYS = {
    GLOBAL_AI_DISABLED:     'global_ai_disabled',         // boolean — kills all AI calls
    DISABLED_MODELS:        'disabled_models',             // string[] — per-model kill list
    MAINTENANCE_MODE:       'maintenance_mode',            // boolean
    MAINTENANCE_MESSAGE:    'maintenance_message',         // string — shown to users
    NEW_REGISTRATION_LOCK:  'new_registration_lock',       // boolean — blocks new sign-ups
    // Per-workspace rate limit overrides are stored as a JSON map under this key:
    //   { [workspaceId: string]: { limit: number, expiresAt?: string } }
    WORKSPACE_RATE_LIMITS:  'workspace_rate_limits',
    // Per-workspace suspension: { [workspaceId: string]: { reason: string, suspendedAt: string } }
    SUSPENDED_WORKSPACES:   'suspended_workspaces',
    // ── Gamification & Engagement (admin-editable; AC4.1.1 / AC4.2.3) ──
    GAMIFICATION_TIME_MULTIPLIERS: 'gamification.time_multipliers', // { leads_generated, content_drafted, tasks_completed } minutes
    GAMIFICATION_MILESTONES:       'gamification.milestones',       // { leads_for_token, hours_for_beta }
    GAMIFICATION_REWARDS_PAUSED:   'gamification.rewards_paused',   // boolean — emergency stop
    // ── AI-regulatory compliance overrides (AC4.1; defaults in src/config/compliance.ts) ──
    COMPLIANCE_EU_EXTRA_COUNTRIES:  'compliance.eu_extra_countries',    // string[] — extra ISO codes added to the EU jurisdiction set
    COMPLIANCE_SYSTEMIC_RISK_FLOPS: 'compliance.systemic_risk_flops',   // number — GPAI systemic-risk compute trigger (FLOPs)
    // ── Session inactivity timeout (issue #127; admin-editable in Admin Portal) ──
    SESSION_INACTIVITY_TIMEOUT_MINUTES: 'session.inactivity_timeout_minutes', // number — idle minutes before the "stay signed in" countdown appears
    SESSION_COUNTDOWN_MINUTES:          'session.countdown_minutes',          // number — minutes the countdown gives the user before auto-logout
    // ── Strategy Agent (Phase 5a §7) ──
    // The last weekly run's outcome: { at, clusters, proposed, skipped, expired, notified,
    // skipReasons[], truncated }. Written by the background worker, read by the Strategy tab's
    // empty state — which is the DEFAULT state for months, so "is this thing even running?" has to
    // be answerable without the function logs. It is also the only place that answer survives now
    // that the run is a background function and its HTTP response is just an ack.
    STRATEGY_AGENT_LAST_RUN: 'strategy_agent.last_run',
} as const;

export type ConfigKey = typeof CONFIG_KEYS[keyof typeof CONFIG_KEYS];

// ── In-process cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;  // 30 seconds

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

const configCache = new Map<string, CacheEntry>();

/**
 * Retrieve a single config value.
 * Returns null if the key doesn't exist.
 * Uses a 30-second in-process cache per key to avoid per-request DB round-trips.
 */
export async function getPlatformConfig(key: ConfigKey): Promise<unknown> {
    const now = Date.now();
    const cached = configCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const db = getDb();
    const [row] = await db
        .select({ value: platformConfig.value })
        .from(platformConfig)
        .where(eq(platformConfig.key, key));

    const value = row?.value ?? null;
    configCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
}

/**
 * Bulk-load all config rows at once into the cache.
 * Called once on cold-start or when the admin updates a setting.
 */
export async function warmPlatformConfigCache(): Promise<Record<string, unknown>> {
    const db = getDb();
    const rows = await db.select({ key: platformConfig.key, value: platformConfig.value }).from(platformConfig);
    const now = Date.now();
    const result: Record<string, unknown> = {};
    for (const row of rows) {
        configCache.set(row.key, { value: row.value, expiresAt: now + CACHE_TTL_MS });
        result[row.key] = row.value;
    }
    return result;
}

/** Invalidate a single cache entry (call after admin writes a new value). */
export function invalidatePlatformConfig(key: string): void {
    configCache.delete(key);
}

/** Check the global AI kill switch. Returns true if AI is disabled. */
export async function isGlobalAiDisabled(): Promise<boolean> {
    const val = await getPlatformConfig(CONFIG_KEYS.GLOBAL_AI_DISABLED);
    return val === true;
}

/** Check if maintenance mode is active. */
export async function isMaintenanceMode(): Promise<boolean> {
    const val = await getPlatformConfig(CONFIG_KEYS.MAINTENANCE_MODE);
    return val === true;
}

/** Check if new registrations are locked. */
export async function isRegistrationLocked(): Promise<boolean> {
    const val = await getPlatformConfig(CONFIG_KEYS.NEW_REGISTRATION_LOCK);
    return val === true;
}

/** Upsert a config value (admin writes) and invalidate its cache so it applies immediately. */
export async function setPlatformConfig(key: string, value: unknown, updatedBy?: number, reason?: string): Promise<void> {
    const db = getDb();
    await db.insert(platformConfig)
        .values({ key, value, updatedBy: updatedBy ?? null, reason: reason ?? null, updatedAt: new Date() })
        .onConflictDoUpdate({ target: platformConfig.key, set: { value, updatedBy: updatedBy ?? null, reason: reason ?? null, updatedAt: new Date() } });
    invalidatePlatformConfig(key);
}

// ── Gamification config accessors (with safe defaults if the row is missing) ──
// Minutes of human time each unit of assistant work is deemed to replace. Consumed ONLY through
// src/utils/roi-activity.ts, which owns the mapping from an activity source to a key here — do not
// multiply by one of these at a call site, or the dashboard and the assistant page drift apart.
//
// ⚠️ Adding a key is safe; RENAMING one is not. getTimeMultipliers() spreads the stored
// platform_config row over these defaults, so an env whose row predates a new key silently picks up
// the default (intended), but an env whose row still carries an OLD key would keep overriding a
// field nothing reads any more (silent, and it looks like the admin override stopped working).
export interface TimeMultipliers {
    leads_generated: number;
    content_drafted: number;
    tasks_completed: number;
    // Added when the ROI cards were repointed off the `leads` table onto assistant_records —
    // until then every assistant except the Social Media Manager contributed exactly zero.
    blog_drafted: number;
    meeting_summarised: number;
    invoice_processed: number;
    ticket_handled: number;
    record_enriched: number;
    campaign_managed: number;
}
export interface Milestones { leads_for_token: number; hours_for_beta: number; }

// The six new figures are ESTIMATES, deliberately conservative, and admin-tunable at runtime via
// the gamification.time_multipliers platform_config row — they are relative weights in a headline
// "hours saved" claim shown to a paying customer, not measurements. A blog post outweighs a social
// post because it is long-form research + drafting; a campaign decision is weighted as review time,
// not as the whole campaign.
export const DEFAULT_TIME_MULTIPLIERS: TimeMultipliers = {
    leads_generated: 3,
    content_drafted: 5,
    tasks_completed: 2,
    blog_drafted: 25,
    meeting_summarised: 15,
    invoice_processed: 5,
    ticket_handled: 8,
    record_enriched: 3,
    campaign_managed: 10,
};
export const DEFAULT_MILESTONES: Milestones = { leads_for_token: 100, hours_for_beta: 50 };

export async function getTimeMultipliers(): Promise<TimeMultipliers> {
    const val = await getPlatformConfig(CONFIG_KEYS.GAMIFICATION_TIME_MULTIPLIERS) as Partial<TimeMultipliers> | null;
    return { ...DEFAULT_TIME_MULTIPLIERS, ...(val || {}) };
}

export async function getMilestones(): Promise<Milestones> {
    const val = await getPlatformConfig(CONFIG_KEYS.GAMIFICATION_MILESTONES) as Partial<Milestones> | null;
    return { ...DEFAULT_MILESTONES, ...(val || {}) };
}

export async function areRewardsPaused(): Promise<boolean> {
    return (await getPlatformConfig(CONFIG_KEYS.GAMIFICATION_REWARDS_PAUSED)) === true;
}

// ── Session inactivity timeout config (issue #127; with safe defaults) ────────
export interface SessionTimeoutConfig { inactivityTimeoutMinutes: number; countdownMinutes: number; }
export const DEFAULT_SESSION_TIMEOUT_CONFIG: SessionTimeoutConfig = { inactivityTimeoutMinutes: 15, countdownMinutes: 10 };

export async function getSessionTimeoutConfig(): Promise<SessionTimeoutConfig> {
    const [timeout, countdown] = await Promise.all([
        getPlatformConfig(CONFIG_KEYS.SESSION_INACTIVITY_TIMEOUT_MINUTES),
        getPlatformConfig(CONFIG_KEYS.SESSION_COUNTDOWN_MINUTES),
    ]);
    return {
        inactivityTimeoutMinutes: Number(timeout) > 0 ? Number(timeout) : DEFAULT_SESSION_TIMEOUT_CONFIG.inactivityTimeoutMinutes,
        countdownMinutes: Number(countdown) > 0 ? Number(countdown) : DEFAULT_SESSION_TIMEOUT_CONFIG.countdownMinutes,
    };
}
