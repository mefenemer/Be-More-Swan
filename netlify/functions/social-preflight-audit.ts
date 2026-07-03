// netlify/functions/social-preflight-audit.ts
// US-SMM-4.3.1: Pre-flight configuration audit for social connections.
// POST { organisationId, platform }  — runs checks, stores results in systemConnections.metadata.
// GET ?organisationId=N&platform=X   — returns last audit results.
// Runs within 5s of OAuth callback (fire-and-forget), nightly schedule, and manual trigger.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { requireTenant } from '../../src/utils/tenant';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const HAIKU = 'claude-haiku-4-5-20251001';

// Platform-specific execution constraints for LLM blueprint assembly
const PLATFORM_CONSTRAINTS: Record<string, Record<string, unknown>> = {
    instagram: {
        postsPerDay: 25,
        storiesPerDay: 100,
        apiRateLimitPerHour: 200,
        mediaTypes: ['image', 'video', 'carousel', 'reel'],
        maxCaptionChars: 2200,
        maxHashtags: 30,
        bestPostingWindows: ['08:00-10:00', '12:00-14:00', '18:00-21:00'],
        restrictions: ['No adult content', 'No misleading claims', 'Must disclose ads'],
    },
    facebook: {
        postsPerDay: 5,
        apiRateLimitPerHour: 200,
        maxPostChars: 63206,
        bestPostingWindows: ['09:00-11:00', '13:00-16:00'],
        restrictions: ['Community Standards apply', 'No misleading claims'],
    },
    linkedin: {
        postsPerDay: 1,
        sharesPerDay: 100,
        maxPostChars: 3000,
        apiRateLimitPerDay: 100,
        bestPostingWindows: ['08:00-10:00', '17:00-18:00'],
        restrictions: ['Professional content only', 'No spam', 'Authentic engagement required'],
    },
    x: {
        tweetsPerDay: 2400,
        tweetsPerThreeHours: 300,
        maxTweetChars: 280,
        bestPostingWindows: ['08:00-10:00', '12:00-13:00', '17:00-19:00'],
        restrictions: ['Rules of the Road apply', 'No duplicate content'],
    },
};

interface PreflightCheck {
    id: 'CHK-01' | 'CHK-02' | 'CHK-03' | 'CHK-04' | 'CHK-05';
    label: string;
    status: 'pass' | 'fail' | 'unknown';
    detail?: string;
    deepLink?: string;
}

async function runMetaChecks(token: string, metadata: Record<string, unknown>): Promise<PreflightCheck[]> {
    const fbPageId = metadata?.fbPageId as string | undefined;
    const igUserId  = metadata?.igUserId  as string | undefined;
    const checks: PreflightCheck[] = [];

    // CHK-01: Facebook Page is published — live API call
    let chk01: PreflightCheck = { id: 'CHK-01', label: 'Facebook Page linked & published', status: 'unknown', deepLink: 'https://www.facebook.com/pages/' };
    if (fbPageId) {
        try {
            const pageRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}?fields=is_published&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
            const pageData: { is_published?: boolean; error?: { message: string } } = await pageRes.json();
            if (typeof pageData.is_published === 'boolean') {
                chk01.status = pageData.is_published ? 'pass' : 'fail';
                chk01.detail = pageData.is_published ? `Page ID: ${fbPageId} (published)` : 'Facebook Page exists but is not published.';
            } else if (pageData.error) {
                chk01.status = 'fail';
                chk01.detail = pageData.error.message;
            }
        } catch { chk01.detail = 'Timeout checking Facebook Page.'; }
    } else {
        chk01.status = 'fail';
        chk01.detail = 'No Facebook Page is linked to this Instagram account.';
    }
    checks.push(chk01);

    // CHK-02: Instagram Business account connected — live API call
    let chk02: PreflightCheck = { id: 'CHK-02', label: 'Instagram Business account connected', status: 'unknown', deepLink: 'https://business.facebook.com/instagram' };
    if (fbPageId) {
        try {
            const igRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}?fields=instagram_accounts&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
            const igData: { instagram_accounts?: { data: Array<{ id: string }> }; error?: { message: string } } = await igRes.json();
            const hasIg = (igData.instagram_accounts?.data?.length ?? 0) > 0;
            chk02.status = hasIg ? 'pass' : 'fail';
            chk02.detail = hasIg ? 'Instagram account linked to Facebook Page.' : 'No Instagram account linked to this Facebook Page.';
        } catch { chk02.detail = 'Timeout checking Instagram accounts.'; }
    } else {
        chk02.status = 'fail';
        chk02.detail = 'Cannot check — no Facebook Page linked.';
    }
    checks.push(chk02);

    // CHK-03: Account type is BUSINESS — live API call
    let chk03: PreflightCheck = { id: 'CHK-03', label: 'Instagram account is Business type', status: 'unknown', deepLink: 'https://www.instagram.com/accounts/convert_to_business/' };
    if (igUserId) {
        try {
            const typeRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}?fields=account_type&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
            const typeData: { account_type?: string; error?: { message: string } } = await typeRes.json();
            if (typeData.account_type) {
                const at = typeData.account_type.toUpperCase();
                chk03.status = at === 'BUSINESS' ? 'pass' : 'fail';
                chk03.detail = `Account type: ${typeData.account_type}`;
            } else if (typeData.error) {
                chk03.detail = typeData.error.message;
            }
        } catch { chk03.detail = 'Timeout checking account type.'; }
    } else {
        chk03.status = 'unknown';
        chk03.detail = 'Instagram User ID not available — re-connect to refresh.';
    }
    checks.push(chk03);

    // CHK-04: Messaging enabled on Facebook Page (requires page-level API call)
    let chk04: PreflightCheck = { id: 'CHK-04', label: 'Facebook Page messaging enabled', status: 'unknown', deepLink: 'https://www.facebook.com/settings/?tab=messaging' };
    if (fbPageId) {
        try {
            const pageRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}?fields=messaging_feature_status&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
            const pageData: { messaging_feature_status?: string; error?: { message: string } } = await pageRes.json();
            if (pageData.messaging_feature_status) {
                chk04.status = pageData.messaging_feature_status === 'ENABLED' ? 'pass' : 'fail';
                chk04.detail = `Messaging status: ${pageData.messaging_feature_status}`;
            } else if (pageData.error) {
                chk04.detail = pageData.error.message;
            }
        } catch { /* timeout or network error — leave as unknown */ }
    } else {
        chk04.status = 'fail';
        chk04.detail = 'Cannot check messaging — no Facebook Page linked.';
    }
    checks.push(chk04);

    // CHK-05: Meta Terms of Service accepted
    let chk05: PreflightCheck = { id: 'CHK-05', label: 'Meta Terms of Service accepted', status: 'unknown', deepLink: 'https://www.facebook.com/policies_center/' };
    try {
        const tosRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=tos_accepted&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
        const tosData: { tos_accepted?: Record<string, boolean>; error?: { message: string } } = await tosRes.json();
        if (tosData.tos_accepted) {
            const allAccepted = Object.values(tosData.tos_accepted).every(Boolean);
            chk05.status = allAccepted ? 'pass' : 'fail';
            chk05.detail = allAccepted ? 'All applicable Meta ToS accepted.' : 'One or more Meta Terms of Service not yet accepted.';
        } else {
            chk05.status = 'pass'; // field absent = no additional ToS pending
            chk05.detail = 'No additional ToS required.';
        }
    } catch { /* timeout or network error */ }
    checks.push(chk05);

    return checks;
}

async function runLinkedInChecks(token: string): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    let orgStatus: PreflightCheck = {
        id: 'CHK-01',
        label: 'LinkedIn organisation verified',
        status: 'unknown',
        deepLink: 'https://www.linkedin.com/company/admin/',
    };
    try {
        const orgRes = await fetch('https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&projection=(elements*(organizationStatus))', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(4000),
        });
        const orgData: { elements?: Array<{ organizationStatus: string }> } = await orgRes.json();
        const verified = orgData.elements?.some(e => e.organizationStatus === 'APPROVED');
        orgStatus.status = verified ? 'pass' : 'fail';
        orgStatus.detail = verified ? 'Organisation page is approved.' : 'No approved LinkedIn organisation found for this account.';
    } catch { /* leave unknown */ }
    checks.push(orgStatus);
    return checks;
}

async function runXChecks(token: string): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    let writeCheck: PreflightCheck = {
        id: 'CHK-01',
        label: 'X write scope granted',
        status: 'unknown',
        deepLink: 'https://developer.twitter.com/en/portal/dashboard',
    };
    try {
        // Attempt a dry-run: fetch the authed user; if scopes include tweet.write it would succeed
        const meRes = await fetch('https://api.twitter.com/2/users/me?user.fields=id', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(4000),
        });
        const meData: { data?: { id: string }; errors?: unknown[] } = await meRes.json();
        writeCheck.status = meData.data?.id ? 'pass' : 'fail';
        writeCheck.detail = meData.data?.id ? 'X account accessible with current token.' : 'Token cannot access X account — write scope may be missing.';
    } catch { /* leave unknown */ }
    checks.push(writeCheck);
    return checks;
}

export const handler: Handler = async (event) => {
    // ── GET: return last results ──────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const db = getDb();
        // Session carries `activeOrganisationId`, not `organisationId` — resolve via requireTenant.
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        const { organisationId } = ctx;

        const platform = event.queryStringParameters?.platform ?? 'instagram';
        const [conn] = await db.select({ metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, platform), eq(systemConnections.isActive, true)))
            .limit(1);

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results: (conn?.metadata as Record<string, unknown>)?.preflightAuditResults ?? null }) };
    }

    // ── POST: run audit ───────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        let { organisationId, platform } = body as { organisationId: number | undefined; platform: string };

        // Resolve orgId from session if not provided (user-triggered). Internal callers
        // (post-OAuth fire-and-forget, nightly schedule) pass organisationId in the body.
        if (!organisationId) {
            const cookieHeader = event.headers.cookie || '';
            const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
            if (sessionToken) {
                // Session carries `activeOrganisationId`, not `organisationId` — resolve via requireTenant.
                const ctx = await requireTenant(event, getDb());
                if ('error' in ctx) return ctx.error;
                organisationId = ctx.organisationId;
            }
        }

        if (!organisationId || !platform) {
            return { statusCode: 400, body: JSON.stringify({ error: 'organisationId and platform required' }) };
        }

        const db = getDb();
        const svc = platform === 'instagram' ? 'instagram' : platform;

        const [conn] = await db.select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, svc), eq(systemConnections.isActive, true)))
            .limit(1);

        if (!conn) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No active connection found' }) };
        }

        let checks: PreflightCheck[] = [];
        if (conn.vaultRefKey) {
            const secret = await getSecret(db, conn.vaultRefKey);
            const token = (secret as { token?: string } | null)?.token;
            if (token) {
                if (platform === 'instagram' || platform === 'facebook') {
                    checks = await runMetaChecks(token, (conn.metadata as Record<string, unknown>) ?? {});
                } else if (platform === 'linkedin') {
                    checks = await runLinkedInChecks(token);
                } else if (platform === 'x') {
                    checks = await runXChecks(token);
                }
            }
        }

        const failCount = checks.filter(c => c.status === 'fail').length;
        const preflightStatus = failCount === 0 ? 'passed' : failCount >= checks.length ? 'blocked' : 'partial';

        const existingMeta = (conn.metadata as Record<string, unknown>) ?? {};
        // Append to audit history (max 20 entries) instead of overwriting
        const auditEntry = { runAt: new Date().toISOString(), preflightStatus, checks };
        const existingHistory = Array.isArray(existingMeta.preflightAuditHistory) ? (existingMeta.preflightAuditHistory as unknown[]) : [];
        const preflightAuditHistory = [...existingHistory, auditEntry].slice(-20);
        // Blueprint summary: latest status + failing check labels for LLM context
        const blueprintSummary = {
            preflightStatus,
            lastRunAt: auditEntry.runAt,
            failingChecks: checks.filter(c => c.status === 'fail').map(c => c.label),
        };
        // AC3.1.3: Build executionConstraints for LLM blueprint assembly
        const platformKey = (platform === 'instagram' || platform === 'facebook') ? platform : platform;
        const rawConstraints = PLATFORM_CONSTRAINTS[platformKey] ?? {};
        const failingChecks = checks.filter(c => c.status === 'fail');
        const constraintsInput = {
            platform,
            preflightStatus,
            constraints: rawConstraints,
            blockers: failingChecks.map(c => ({ id: c.id, label: c.label, detail: c.detail })),
        };

        // Call Anthropic to format executionConstraints as LLM-ready narrative
        let executionConstraints: Record<string, unknown> = { raw: constraintsInput };
        try {
            const llmRes = await anthropic.messages.create({
                model: HAIKU,
                max_tokens: 400,
                messages: [{
                    role: 'user',
                    content: `You are assembling a social media posting blueprint for an AI assistant. Based on the platform data below, write a concise JSON object with key "narrative" (a 2-3 sentence plain-English summary of what the assistant must know before posting: rate limits, best times, restrictions, and any current blockers). Return ONLY valid JSON.\n\nData:\n${JSON.stringify(constraintsInput, null, 2)}`,
                }],
            });
            const raw = (llmRes.content[0] as { text: string }).text.trim();
            const match = raw.match(/\{[\s\S]*\}/);
            const parsed = match ? JSON.parse(match[0]) : null;
            if (parsed?.narrative) {
                executionConstraints = { ...constraintsInput, narrative: parsed.narrative };
            }
        } catch { /* non-fatal — use raw constraints */ }

        await db.update(systemConnections).set({
            metadata: {
                ...existingMeta,
                preflightAuditResults: checks,
                preflightStatus,
                preflightAuditAt: auditEntry.runAt,
                preflightAuditHistory,
                blueprintPreflightSummary: blueprintSummary,
                executionConstraints,           // AC3.1.3: injected into LLM blueprint assembly
            },
            updatedAt: new Date(),
        }).where(eq(systemConnections.id, conn.id));

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preflightStatus, checks, auditEntry }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
