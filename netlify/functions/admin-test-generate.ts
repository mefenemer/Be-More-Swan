// netlify/functions/admin-test-generate.ts
// US-ADM-4.3.3: Admin-only endpoint to trigger and poll a test generation against a compiled blueprint.
//
// POST  — create test job (admin auth required)
//   Body: { assistantId, blueprintId, platform, contextPrompt? }
//   Returns: { jobId, status: 'queued' }
//
// GET ?jobId=<uuid> — poll status; when complete, returns result + compliance check

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { users, aiAssistants, aiBlueprints, contentGenerationJobs, scheduledPosts } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';

const JWT_SECRET = process.env.JWT_SECRET;

// Sonnet 4.6 pricing (USD per M tokens) → converted to GBP at 0.79
const INPUT_COST_GBP_PER_M  = 3 * 0.79;
const OUTPUT_COST_GBP_PER_M = 15 * 0.79;

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
    instagram: 2200,
    linkedin:  3000,
    x:         280,
    facebook:  63206,
};

async function requireAdmin(event: any): Promise<{ userId: number; name: string } | null> {
    if (!JWT_SECRET) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], JWT_SECRET) as { userId: number }).userId; }
    catch (_e) { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    const name = [row.firstName, row.lastName].filter(Boolean).join(' ') || `Admin #${userId}`;
    return { userId, name };
}

function checkCompliance(caption: string, hashtags: string, sections: Record<string, any>, platform: string) {
    const fullText = `${caption} ${hashtags}`.toLowerCase();
    const limit = PLATFORM_CHAR_LIMITS[platform] ?? 2200;
    const captionLen = (caption || '').length;

    const contentRules: Array<{ rule: string; pass: boolean }> = [];
    const strictRules: Array<{ rule: string; pass: boolean }> = [];

    // Content rules (§4) and strict rules (§3) — correct section keys
    const contentRulesData = sections['4-content-rules']?.content?.rules as Array<{ text?: string }> | null;
    const strictConstraints = sections['3-strict-rules']?.content?.constraints as string | null;

    if (Array.isArray(contentRulesData)) {
        for (const r of contentRulesData) {
            const rule = r.text?.trim();
            if (!rule) continue;
            const keywords = rule.toLowerCase().split(/\W+/).filter(w => w.length > 4);
            const pass = keywords.length === 0 || !keywords.some(kw => fullText.includes(kw) === false && kw.length > 6);
            contentRules.push({ rule, pass });
        }
    }

    if (strictConstraints) {
        for (const line of strictConstraints.split('\n')) {
            const rule = line.trim();
            if (!rule) continue;
            const lowerRule = rule.toLowerCase();
            const isProhibition = lowerRule.includes('do not') || lowerRule.includes('never') || lowerRule.includes('avoid') || lowerRule.includes('must not') || lowerRule.includes('prohibited');
            let pass = true;
            if (isProhibition) {
                const prohibitedTerms = rule.toLowerCase().split(/\W+/).filter(w => w.length > 5 && !['never', 'avoid', 'prohibited', 'donot', 'mustnot'].includes(w));
                pass = !prohibitedTerms.some(t => fullText.includes(t));
            }
            strictRules.push({ rule, pass });
        }
    }

    // Disclosure text from §9 compliance
    const disclosureText = sections['9-compliance']?.content?.disclosureText as string | null;
    const disclosurePresent = !!disclosureText && caption.includes(disclosureText.trim().substring(0, 20));

    return { contentRules, strictRules, disclosurePresent, disclosureText, captionLen, platformLimit: limit };
}

async function run(event: any) {
    const admin = await requireAdmin(event);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Admin auth required.' }) };

    const db = getDb();

    // ── GET: history list or job status poll ─────────────────────────────────
    if (event.httpMethod === 'GET') {
        const qs = event.queryStringParameters || {};

        // History: ?assistantId=N&history=1
        if (qs.history && qs.assistantId) {
            const asstId = parseInt(qs.assistantId);
            if (!asstId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId required.' }) };

            const runs = await db.execute<{
                job_id: string; platform: string | null; context_prompt: string | null;
                created_at: string; tokens_input: number | null; tokens_output: number | null;
                caption: string | null; hashtags: string | null; suggested_media_description: string | null;
                admin_first_name: string | null; admin_last_name: string | null;
                saved_as_reference: boolean;
            }>(`
                SELECT cj.job_id, cj.platform, cj.context_prompt, cj.created_at,
                       cj.tokens_input, cj.tokens_output, cj.saved_as_reference,
                       sp.caption, sp.hashtags, sp.suggested_media_description,
                       u.first_name AS admin_first_name, u.last_name AS admin_last_name
                FROM content_generation_jobs cj
                LEFT JOIN scheduled_posts sp ON sp.job_id = cj.job_id
                LEFT JOIN users u ON u.id = cj.admin_id
                WHERE cj.assistant_id = ${asstId} AND cj.trigger_type = 'admin_test' AND cj.status = 'completed'
                ORDER BY cj.created_at DESC
                LIMIT 20
            `);

            const rows = runs.map(r => ({
                jobId:                    r.job_id,
                platform:                 r.platform,
                contextPrompt:            r.context_prompt,
                createdAt:                r.created_at,
                tokensInput:              r.tokens_input,
                tokensOutput:             r.tokens_output,
                caption:                  r.caption,
                hashtags:                 r.hashtags,
                suggestedMediaDescription: r.suggested_media_description,
                adminName:                [r.admin_first_name, r.admin_last_name].filter(Boolean).join(' ') || null,
                savedAsReference:         r.saved_as_reference ?? false,
            }));

            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
        }

        const jobId = qs.jobId;
        if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId required.' }) };

        const [job] = await db
            .select({
                status:      contentGenerationJobs.status,
                resultPostId: contentGenerationJobs.resultPostId,
                errorMessage: contentGenerationJobs.errorMessage,
                tokensInput:  contentGenerationJobs.tokensInput,
                tokensOutput: contentGenerationJobs.tokensOutput,
                blueprintId:  contentGenerationJobs.blueprintId,
                platform:     contentGenerationJobs.platform,
                updatedAt:    contentGenerationJobs.updatedAt,
            })
            .from(contentGenerationJobs)
            .where(and(eq(contentGenerationJobs.jobId, jobId), eq(contentGenerationJobs.triggerType, 'admin_test')))
            .limit(1);

        if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Test job not found.' }) };

        // Detect stuck-processing jobs (function timed out — cron resets them, but surface error to UI immediately)
        if (job.status === 'processing' && job.updatedAt && Date.now() - new Date(job.updatedAt).getTime() > 3 * 60 * 1000) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'failed', errorMessage: 'Generation timed out. The job will be retried automatically — please try again in a moment.' }),
            };
        }

        if (job.status !== 'completed' || !job.resultPostId) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: job.status, errorMessage: job.errorMessage }),
            };
        }

        // Fetch the generated post
        const [post] = await db
            .select({ caption: scheduledPosts.caption, hashtags: scheduledPosts.hashtags, suggestedMediaDescription: scheduledPosts.suggestedMediaDescription })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, job.resultPostId))
            .limit(1);

        // Fetch blueprint sections for compliance check
        let complianceResult = null;
        if (job.blueprintId) {
            const [bp] = await db.select({ sections: aiBlueprints.sections }).from(aiBlueprints).where(eq(aiBlueprints.id, job.blueprintId)).limit(1);
            if (bp) {
                complianceResult = checkCompliance(
                    post?.caption || '',
                    post?.hashtags || '',
                    bp.sections as Record<string, any>,
                    job.platform || 'instagram',
                );
            }
        }

        // Cost estimate
        const inputCostGbp  = job.tokensInput  ? (job.tokensInput  / 1_000_000) * INPUT_COST_GBP_PER_M  : null;
        const outputCostGbp = job.tokensOutput ? (job.tokensOutput / 1_000_000) * OUTPUT_COST_GBP_PER_M : null;
        const totalCostGbp  = (inputCostGbp ?? 0) + (outputCostGbp ?? 0);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'completed',
                post,
                compliance: complianceResult,
                tokens: { input: job.tokensInput, output: job.tokensOutput },
                costGbp: totalCostGbp > 0 ? parseFloat(totalCostGbp.toFixed(6)) : null,
            }),
        };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { assistantId?: number; blueprintId?: number; platform?: string; contextPrompt?: string; saveReference?: boolean; jobId?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    // Save reference — persist the flag against the job row so history can show which run was pinned
    if (body.saveReference && body.jobId) {
        await db.execute(
            `UPDATE content_generation_jobs SET saved_as_reference = true, updated_at = now()
             WHERE job_id = '${body.jobId}' AND trigger_type = 'admin_test'`
        );
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ saved: true }) };
    }

    const { assistantId, blueprintId, platform = 'instagram', contextPrompt } = body;
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    if (contextPrompt && contextPrompt.length > 500) {
        return { statusCode: 400, body: JSON.stringify({ error: 'contextPrompt must be 500 characters or fewer.' }) };
    }

    // Resolve assistant + org
    const [asst] = await db
        .select({ id: aiAssistants.id, organisationId: aiAssistants.organisationId, userId: aiAssistants.userId })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, assistantId))
        .limit(1);
    if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // Resolve blueprint
    const bpWhere = blueprintId
        ? eq(aiBlueprints.id, blueprintId)
        : eq(aiBlueprints.assistantId, assistantId);

    const [bp] = await db
        .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
        .from(aiBlueprints)
        .where(bpWhere)
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);

    if (!bp) return { statusCode: 404, body: JSON.stringify({ error: 'No compiled blueprint found for this assistant.' }) };

    const blockingGaps = ((bp.missingFields as Array<{ severity: string }>) || []).filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) {
        return { statusCode: 422, body: JSON.stringify({ error: `Blueprint has ${blockingGaps.length} blocking gap(s). Resolve them before running a test.` }) };
    }

    const jobId = randomUUID();

    await db.insert(contentGenerationJobs).values({
        jobId,
        blueprintId:    bp.id,
        assistantId:    asst.id,
        organisationId: asst.organisationId,
        userId:         asst.userId,       // consumer's userId (used for DB FKs only)
        adminId:        admin.userId,      // the admin who triggered the test
        status:         'queued',
        attempt:        0,
        maxAttempts:    3,
        triggerType:    'admin_test',
        platform:       platform || null,
        contextPrompt:  contextPrompt || null,
    });

    return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'queued' }),
    };
}

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    try {
        return await run(event);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[admin-test-generate] unhandled error:', msg);
        return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) };
    }
};
