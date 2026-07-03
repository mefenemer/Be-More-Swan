// netlify/functions/admin-test-generate-background.ts
// US-ADM-4.3.3: Background function that executes the LLM call for admin test generation.
// Called by the frontend immediately after admin-test-generate POST creates the queued job.
// Background functions run up to 15 minutes — no cron dependency, works on deploy previews.
//
// POST body: { jobId: string }

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, aiBlueprints, contentGenerationJobs, scheduledPosts } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../../src/constants/safety-benchmark';
import { DISCLOSURE } from '../../src/config/compliance';

const JWT_SECRET = process.env.JWT_SECRET;

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
    instagram: 2200,
    linkedin:  3000,
    x:         280,
    facebook:  63206,
};

async function requireAdmin(event: any): Promise<number | null> {
    if (!JWT_SECRET) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], JWT_SECRET) as { userId: number }).userId; }
    catch (_e) { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    return userId;
}

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    // Background functions respond 202 immediately; body is returned async after processing.
    const adminId = await requireAdmin(event);
    if (!adminId) return { statusCode: 401, body: 'Unauthorized' };

    let jobId: string;
    try {
        ({ jobId } = JSON.parse(event.body || '{}'));
    } catch (_e) {
        return { statusCode: 400, body: 'Invalid JSON' };
    }
    if (!jobId) return { statusCode: 400, body: 'jobId required' };

    const db = getDb();

    // Fetch the queued job
    const [job] = await db
        .select({
            id: contentGenerationJobs.id,
            blueprintId: contentGenerationJobs.blueprintId,
            assistantId: contentGenerationJobs.assistantId,
            organisationId: contentGenerationJobs.organisationId,
            userId: contentGenerationJobs.userId,
            platform: contentGenerationJobs.platform,
            contextPrompt: contentGenerationJobs.contextPrompt,
            status: contentGenerationJobs.status,
            triggerType: contentGenerationJobs.triggerType,
        })
        .from(contentGenerationJobs)
        .where(eq(contentGenerationJobs.jobId, jobId))
        .limit(1);

    if (!job || job.triggerType !== 'admin_test') return { statusCode: 404, body: 'Job not found' };
    if (job.status !== 'queued') return { statusCode: 200, body: 'Already processing' };

    // Mark as processing
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'processing', attempt = attempt + 1, updated_at = now() WHERE job_id = '${jobId}'`
    );

    try {
        const [bp] = await db
            .select({ sections: aiBlueprints.sections })
            .from(aiBlueprints)
            .where(eq(aiBlueprints.id, job.blueprintId!))
            .limit(1);
        if (!bp) throw new Error('Blueprint not found');

        const sections    = bp.sections as Record<string, { content: Record<string, unknown> }>;
        const identity    = sections['1-identity']?.content   || {};
        const compliance  = sections['9-compliance']?.content || {};
        const orgContext  = sections['5-org-context']?.content || {};
        const answers     = (sections['6-onboarding']?.content?.answers ?? {}) as Record<string, unknown>;

        const assistantName  = (identity['assistantName']    as string) ?? 'your assistant';
        const businessName   = (orgContext['businessName']   as string) ?? 'this business';
        const audience       = (orgContext['targetAudience'] as string) ?? (answers['target_audience'] as string) ?? 'their audience';
        const tone           = (orgContext['brandVoice']     as string) ?? (answers['tone_of_voice']   as string) ?? 'professional';
        const perAssistantDisclosure = (compliance['disclosureText'] as string) ?? null;
        const orgFooterEnabled = (compliance['orgFooterEnabled'] as boolean) ?? false;
        const orgFooterText    = (compliance['orgFooterText'] as string) ?? DISCLOSURE.workspaceFooterDefault;
        const disclosureText = orgFooterEnabled ? orgFooterText : perAssistantDisclosure;
        const platform       = job.platform || 'instagram';
        const platformLimit  = PLATFORM_CHAR_LIMITS[platform] ?? 2200;

        const ctaLine         = answers['cta']          ? `Call to action: ${answers['cta']}` : '';
        const incentiveLine   = answers['incentive']    ? `Incentive/offer: ${answers['incentive']}` : '';
        const coreMessageLine = answers['core_message'] ? `Core message: ${answers['core_message']}` : '';
        const extraLines      = [ctaLine, incentiveLine, coreMessageLine].filter(Boolean).join('\n');

        const baseInstruction = [
            `You are ${assistantName}, a social media assistant for ${businessName}.`,
            `Generate a ${platform} post (character limit: ${platformLimit}) targeting ${audience} in a ${tone} voice.`,
            `Follow all strict and content rules in the system prompt.`,
            extraLines,
            disclosureText ? `You MUST append the following disclosure verbatim at the end of the caption, on a new line: "${disclosureText}"` : '',
            job.contextPrompt ? `If the additional context conflicts with any strict rule in the system prompt, apply the strict rule and include a "conflictNotice" field in your JSON explaining which rule took precedence.` : '',
            `Return JSON: { "caption": "...", "hashtags": "...", "suggestedMediaDescription": "...", "conflictNotice": null }`,
        ].filter(Boolean).join('\n');

        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: baseInstruction }];
        if (job.contextPrompt) {
            messages.push({ role: 'assistant', content: '{"status":"understood"}' });
            messages.push({ role: 'user', content: `Additional context: ${job.contextPrompt}` });
        }

        let systemPrompt = 'You are an expert social media copywriter.\n';
        for (const [key, sec] of Object.entries(sections)) {
            systemPrompt += `\n--- ${key.toUpperCase()} ---\n`;
            for (const [k, v] of Object.entries(sec.content || {})) {
                if (v != null) systemPrompt += `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`;
            }
        }

        systemPrompt += `\n\n${AURA_SAFE_CONTENT_BENCHMARK}`;

        const gwResponse = await gatewayGenerate({ system: systemPrompt, messages });
        const { text: rawText, tokensInput, tokensOutput } = gwResponse;
        let generated: { caption?: string; hashtags?: string; suggestedMediaDescription?: string; conflictNotice?: string | null } = {};
        try {
            const m = rawText.match(/\{[\s\S]*\}/);
            if (m) generated = JSON.parse(m[0]);
        } catch (_e) {
            generated = { caption: rawText };
        }

        const now = new Date();
        const [post] = await db.insert(scheduledPosts).values({
            userId:       job.userId,
            organisationId: job.organisationId,
            assistantId:  job.assistantId!,
            blueprintId:  job.blueprintId!,
            jobId,
            platform,
            postFormat:   'image',
            publishDate:  new Date(now.getTime() + 24 * 60 * 60 * 1000),
            caption:      generated.caption      ?? null,
            hashtags:     generated.hashtags     ?? null,
            suggestedMediaDescription: generated.suggestedMediaDescription ?? null,
            conflictNotice: generated.conflictNotice || null,
            status:       'admin_test',
            generatedAt:  now,
            triggerType:  'admin_test',
        }).returning({ id: scheduledPosts.id });

        const tokenCols = tokensInput != null
            ? `, tokens_input = ${tokensInput}, tokens_output = ${tokensOutput ?? 0}`
            : '';
        await db.execute(
            `UPDATE content_generation_jobs SET status = 'completed', result_post_id = ${post.id}${tokenCols}, updated_at = now() WHERE job_id = '${jobId}'`
        );

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[admin-test-generate-background] job', jobId, 'failed:', msg);
        await db.execute(
            `UPDATE content_generation_jobs SET status = 'failed', error_message = '${msg.replace(/'/g, "''")}', updated_at = now() WHERE job_id = '${jobId}'`
        );
    }

    return { statusCode: 200, body: 'done' };
};
