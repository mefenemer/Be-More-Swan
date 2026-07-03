// netlify/functions/get-ai-credit-balance.ts
// Epic 2, US4: returns the org's AI generation credit balance (applies the monthly grant first).
// GET → { balance, held, monthlyCredits, imageCost, videoCost, canImage, assistantCanVideo, tierCanVideo }
//
// canImage / assistantCanVideo reflect the admin-managed per-assistant-type capability
// (assistant_features). tierCanVideo reflects the plan tier. The My Content modal shows the
// AI Image tab iff canImage, and the AI Video tab iff assistantCanVideo (with a tier-upgrade
// CTA when !tierCanVideo).

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { getOrgMediaCapabilities } from '../../src/utils/assistant-capabilities';
import { getBalance, monthlyAllowance, tierCanGenerateVideo, IMAGE_CREDIT_COST, VIDEO_CREDIT_COST } from '../../src/utils/ai-credits';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const { balance, held } = await getBalance(db, ctx.organisationId);
    const tierKey = await getActiveTierKeyByOrg(db, ctx.organisationId);
    const { canImage, assistantCanVideo } = await getOrgMediaCapabilities(db, ctx.organisationId);
    const monthlyCredits = await monthlyAllowance(db, ctx.organisationId);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            balance, held,
            monthlyCredits,
            imageCost: IMAGE_CREDIT_COST, videoCost: VIDEO_CREDIT_COST,
            canImage,
            assistantCanVideo,
            tierCanVideo: tierCanGenerateVideo(tierKey),
        }),
    };
};
