// src/utils/fair-use.ts
// Chat messages and editing helpers cost no tasks (docs/task-metering.md). This is what stops one
// of them being clicked in a loop: a quiet per-organisation daily limit, far above normal use.
//
// It is NOT the task allowance and must never say so — hitting it means "come back tomorrow", not
// "upgrade". Limits live in platform_config ('fair_use_chat_per_day', 'fair_use_helpers_per_day')
// so they can be raised without a deploy.
//
// Fails open: a rate-limit fault must not take chat down.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { platformConfig } from '../../db/schema';
import { checkRateLimit } from './rate-limit';

type Db = ReturnType<typeof getDb>;

export type FairUseKind = 'chat' | 'helpers';

const DEFAULTS: Record<FairUseKind, number> = { chat: 300, helpers: 200 };
const CONFIG_KEYS: Record<FairUseKind, string> = {
    chat: 'fair_use_chat_per_day',
    helpers: 'fair_use_helpers_per_day',
};
const DAY_SECS = 24 * 60 * 60;

export const FAIR_USE_MESSAGE: Record<FairUseKind, string> = {
    chat: "You've sent a lot of messages today, so chat is paused until tomorrow. Your assistants keep working in the meantime.",
    helpers: "You've used the editing helpers a lot today, so they're paused until tomorrow. Your assistants keep working in the meantime.",
};

async function dailyLimit(db: Db, kind: FairUseKind): Promise<number> {
    try {
        const [row] = await db.select({ value: platformConfig.value })
            .from(platformConfig).where(eq(platformConfig.key, CONFIG_KEYS[kind])).limit(1);
        const n = Number(row?.value);
        return Number.isInteger(n) && n > 0 ? n : DEFAULTS[kind];
    } catch {
        return DEFAULTS[kind];
    }
}

export interface FairUseResult {
    allowed: boolean;
    message?: string;
    retryAfterSecs?: number;
}

/** Count one chat message or helper action against the org's daily fair-use limit. */
export async function checkFairUse(db: Db, organisationId: number, kind: FairUseKind): Promise<FairUseResult> {
    try {
        const maxAttempts = await dailyLimit(db, kind);
        const result = await checkRateLimit(db as never, `fair_use_${kind}`, `org:${organisationId}`, { maxAttempts, windowSecs: DAY_SECS });
        if (result.allowed) return { allowed: true };
        return { allowed: false, message: FAIR_USE_MESSAGE[kind], retryAfterSecs: result.retryAfterSecs };
    } catch (err) {
        console.error('[fair-use] check failed — allowing (fail open)', {
            organisationId, kind, message: err instanceof Error ? err.message : String(err),
        });
        return { allowed: true };
    }
}

/** The 429 body a helper endpoint returns when fair use is exceeded. */
export function fairUseResponse(r: FairUseResult): { statusCode: number; headers: Record<string, string>; body: string } {
    return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(r.retryAfterSecs ?? DAY_SECS) },
        body: JSON.stringify({ error: r.message, code: 'FAIR_USE_LIMIT' }),
    };
}
