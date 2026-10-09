// src/utils/platform-status.ts
// What a CUSTOMER should be told about a platform-wide AI outage — for the dashboard banner.
//
// The two monitors (check-content-generation-health, check-provider-balances) already detect an
// outage and stamp it on their heartbeat — in OPERATOR wording ("fal balance is EMPTY", "Anthropic
// credit is EXHAUSTED"). Customers were told nothing: in September drafting was down for eleven days
// and AI images for days, and every user who looked saw failures that read as their own setup.
//
// This maps each OPEN problem to a plain area + sentence. Never the raw text: it names our suppliers
// and our billing, and the customer cannot act on either. Warnings ("balance is low") are never shown
// — only outages that are happening now. A heartbeat older than its monitor's window is ignored: a
// monitor that stopped running proves nothing about now.

import { MAX_AGE_HOURS, type HeartbeatLog, type MonitorName } from './monitor-heartbeat';

export type PlatformArea = 'writing' | 'images' | 'video' | 'music';
export interface PlatformIssue { area: PlatformArea; message: string }

const MESSAGES: Record<PlatformArea, string> = {
    writing: 'AI drafting is having problems for everyone right now. Drafts may be delayed — they will be written once it recovers.',
    images: 'AI image generation is having problems for everyone right now. Stock photos and branded cards still work.',
    video: 'AI video generation is having problems for everyone right now.',
    music: 'AI music generation is having problems for everyone right now. The music library still works.',
};

/** The area an operator headline is about, or null when it is not a customer-facing outage. */
export function areaOf(monitor: MonitorName, problem: string): PlatformArea | null {
    if (monitor === 'content_generation') return 'writing';
    const p = problem.toLowerCase();
    if (p.includes('anthropic')) return 'writing';
    if (p.includes('stability') || p.includes('music')) return 'music';
    if (p.includes('video')) return 'video';
    if (p.includes('fal') || p.includes('image')) return 'images';
    return null;
}

export function platformIssuesFrom(log: HeartbeatLog | null | undefined, now = new Date()): PlatformIssue[] {
    const seen = new Set<PlatformArea>();
    const out: PlatformIssue[] = [];
    for (const name of Object.keys(MAX_AGE_HOURS) as MonitorName[]) {
        const beat = log?.[name];
        if (!beat?.at) continue;
        const ageH = (now.getTime() - new Date(beat.at).getTime()) / 3_600_000;
        if (!(ageH <= MAX_AGE_HOURS[name])) continue;
        for (const p of beat.problems ?? []) {
            const area = areaOf(name, String(p));
            if (!area || seen.has(area)) continue;
            seen.add(area);
            out.push({ area, message: MESSAGES[area] });
        }
    }
    return out;
}
