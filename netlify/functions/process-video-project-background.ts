// netlify/functions/process-video-project-background.ts
// The Video Producer's slow steps, off the request path (15-minute ceiling):
//   POST { projectId, action: 'plan', feedback?, mode? } → planProject (planning → planned | failed);
//        mode 'script' rewrites the words only, 'notes' acts on the notes left on the finished video —
//        both keep every scene's picture (src/lib/video-notes.ts)
//   POST { projectId, action: 'build' }             → buildProject (building → built | failed)
//   POST { projectId, action: 'review' }            → reviewProject (reviewing → reviewed | failed) — own footage
// Each acts only when the project is in the matching state. A long build (Phase 4c-2) hands over to a fresh run of
// itself while presenter pieces are still at the model: that second 'build' wake is normal, and the project stays
// "building" between runs. Pieces are claimed before they're collected and a scene is charged once, so an
// overlapping duplicate run doesn't make or charge anything twice. Every other exit leaves a terminal state.

import type { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { planProject, buildProject } from '../../src/utils/video-producer';
import { reviewProject } from '../../src/utils/footage-review';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    let body: { projectId?: number; action?: string; feedback?: string; mode?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    const projectId = Number(body.projectId);
    if (!Number.isInteger(projectId)) return { statusCode: 400, body: 'Missing projectId' };
    const db = getDb();
    if (body.action === 'plan') await planProject(db, projectId, { feedback: body.feedback ?? null, mode: body.mode === 'script' || body.mode === 'notes' ? body.mode : null });
    else if (body.action === 'build') await buildProject(db, projectId);
    else if (body.action === 'review') await reviewProject(db, projectId);
    else return { statusCode: 400, body: 'Unknown action' };
    return { statusCode: 200, body: 'done' };
});
