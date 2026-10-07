// src/utils/monitor-heartbeat.ts
// Did the monitors themselves run? Written by every health check, read by platform-watchdog.ts.
//
// ── Why ─────────────────────────────────────────────────────────────────────────────────────────
// check-content-generation-health and check-provider-balances exist because two provider accounts
// ran dry in September and nobody was told. But both only ever speak when they find a problem, and
// both speak through ONE channel — an email sent from inside Netlify, through Resend. So all of these
// look exactly like "everything is fine":
//   · the schedule entry stops matching a filename, or Netlify drops the run
//   · the function throws before it gets to the alert (a DB outage, a bad deploy)
//   · the alert is built and Resend refuses it — logged to a function console nobody can read
// That is the nightly-sweeps lesson again (lead-retention-sweep failed on EVERY run for weeks): a
// scheduled job that fails is invisible, and "no alert" is not evidence that a check ran.
//
// So every run stamps a heartbeat — when it ran, and what it concluded — and platform-watchdog.ts
// serves a verdict on those stamps to a watcher OUTSIDE Netlify (.github/workflows/prod-watchdog.yml),
// which notifies through GitHub's own email rather than ours.
//
// recordHeartbeat NEVER throws: a monitor must not fail because its own bookkeeping did.

import { CONFIG_KEYS, getPlatformConfig, invalidatePlatformConfig, setPlatformConfig } from './platform-config';

export type MonitorName = 'content_generation' | 'provider_balances';

export interface Heartbeat {
    /** When the check last finished a run. */
    at: string;
    /** Problems it judged a human should act on NOW (empty when healthy). */
    problems: string[];
    /** Warnings that are not yet an outage — reported, never failed on. */
    warnings: string[];
    /** True when there was something to send and the send threw. */
    alertFailed: boolean;
}

export type HeartbeatLog = Partial<Record<MonitorName, Heartbeat>>;

/**
 * How old a heartbeat may get before the monitor counts as not running. One missed tick is
 * tolerated, two is not: provider_balances runs every 6h, content_generation daily.
 */
export const MAX_AGE_HOURS: Record<MonitorName, number> = {
    provider_balances: 13,
    content_generation: 30,
};

export async function recordHeartbeat(name: MonitorName, beat: Omit<Heartbeat, 'at'>, now = new Date()): Promise<void> {
    try {
        // ⚠️ Bypass the 30s in-process cache: the two checks write different halves of one row, and a
        // warm instance reading a stale copy would write the other monitor's old heartbeat back.
        invalidatePlatformConfig(CONFIG_KEYS.MONITOR_HEARTBEAT);
        const raw = await getPlatformConfig(CONFIG_KEYS.MONITOR_HEARTBEAT);
        const log: HeartbeatLog = raw && typeof raw === 'object' ? { ...(raw as HeartbeatLog) } : {};
        log[name] = { at: now.toISOString(), ...beat };
        await setPlatformConfig(CONFIG_KEYS.MONITOR_HEARTBEAT, log);
    } catch (err) {
        console.error(`[monitor-heartbeat] could not record ${name} — the watchdog will report it as not running`, err);
    }
}

export interface WatchdogVerdict {
    ok: boolean;
    /** Why it is not ok — each line enough to act on from a phone. */
    failures: string[];
    warnings: string[];
    monitors: Record<MonitorName, { lastRun: string | null; ageHours: number | null }>;
}

/** Pure: judge the heartbeats. */
export function assessHeartbeats(log: HeartbeatLog, now: Date): WatchdogVerdict {
    const failures: string[] = [];
    const warnings: string[] = [];
    const monitors = {} as WatchdogVerdict['monitors'];

    for (const name of Object.keys(MAX_AGE_HOURS) as MonitorName[]) {
        const beat = log[name];
        const at = beat ? new Date(beat.at) : null;
        const ageHours = at && !isNaN(at.getTime()) ? (now.getTime() - at.getTime()) / 3_600_000 : null;
        monitors[name] = { lastRun: at && ageHours !== null ? at.toISOString() : null, ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10 };

        if (!beat || ageHours === null) {
            failures.push(`${name}: has never recorded a run — the check is not running, so nothing is watching it.`);
            continue;
        }
        if (ageHours > MAX_AGE_HOURS[name]) {
            failures.push(`${name}: last ran ${ageHours.toFixed(1)}h ago (limit ${MAX_AGE_HOURS[name]}h) — the check has stopped running.`);
        }
        for (const p of beat.problems ?? []) failures.push(`${name}: ${p}`);
        for (const w of beat.warnings ?? []) warnings.push(`${name}: ${w}`);
        if (beat.alertFailed) {
            failures.push(`${name}: found a problem but could NOT send the alert email — check Resend and FOUNDER_ALERT_EMAIL.`);
        }
    }
    return { ok: failures.length === 0, failures, warnings, monitors };
}
