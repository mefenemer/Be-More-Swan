// netlify/functions/get-ai-credit-balance.ts
// Epic 2, US4: returns the org's AI generation credit balance (applies the monthly grant first).
// GET → { balance, held, monthlyCredits, imageCost, videoCost, canImage, assistantCanVideo, canMusic, tierCanVideo }
//
// canImage / assistantCanVideo reflect the admin-managed per-assistant-type capability
// (assistant_features). tierCanVideo reflects the plan tier. The My Content modal shows the
// AI Image tab iff canImage, and the AI Video tab iff assistantCanVideo (with a tier-upgrade
// CTA when !tierCanVideo).
//
// Single task allowance ('unified_task_metering', docs/task-metering.md): the same shape, in TASKS —
// `unit: 'tasks'`, balance = tasks left (getBalance), and the costs are task weights (an image 1,
// a video 20). Callers that compare balance >= cost keep working unchanged; the labels switch on unit.

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { getOrgMediaCapabilities } from '../../src/utils/assistant-capabilities';
import { getBalance, monthlyAllowance, tierCanGenerateVideo, IMAGE_CREDIT_COST, MUSIC_CREDIT_COST, MUSIC_SHARED_CREDIT_COST, VIDEO_CREDIT_COST } from '../../src/utils/ai-credits';
import { withLambda } from '@netlify/aws-lambda-compat';
import { TASK_WEIGHTS } from '../../src/config/task-weights';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const { balance, held, unit } = await getBalance(db, ctx.organisationId);
    const tasks = unit === 'tasks';
    const tierKey = await getActiveTierKeyByOrg(db, ctx.organisationId);
    const { canImage, assistantCanVideo, canMusic } = await getOrgMediaCapabilities(db, ctx.organisationId);
    const monthlyCredits = tasks ? 0 : await monthlyAllowance(db, ctx.organisationId);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            balance, held, unit,
            monthlyCredits,
            ...(tasks
                ? { imageCost: TASK_WEIGHTS.ai_image, videoCost: TASK_WEIGHTS.ai_video, musicCost: TASK_WEIGHTS.ai_music, musicSharedCost: TASK_WEIGHTS.ai_music_shared }
                : { imageCost: IMAGE_CREDIT_COST, videoCost: VIDEO_CREDIT_COST, musicCost: MUSIC_CREDIT_COST, musicSharedCost: MUSIC_SHARED_CREDIT_COST }),
            canImage,
            assistantCanVideo,
            canMusic,
            tierCanVideo: tierCanGenerateVideo(tierKey),
        }),
    };
});
