// netlify/functions/process-video-project-background.ts
// The Video Producer's slow steps, off the request path (15-minute ceiling):
//   POST { projectId, action: 'plan', feedback? }  → planProject  (planning → planned | failed)
//   POST { projectId, action: 'build' }             → buildProject (building → built | failed)
//   POST { projectId, action: 'review' }            → reviewProject (reviewing → reviewed | failed) — own footage
// Both act only when the project is in the matching state, so a duplicate wake is a no-op rather
// than a second plan or a second paid build. Every exit leaves the project in a terminal state.

import type { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { planProject, buildProject } from '../../src/utils/video-producer';
import { reviewProject } from '../../src/utils/footage-review';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    let body: { projectId?: number; action?: string; feedback?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    const projectId = Number(body.projectId);
    if (!Number.isInteger(projectId)) return { statusCode: 400, body: 'Missing projectId' };
    const db = getDb();
    if (body.action === 'plan') await planProject(db, projectId, { feedback: body.feedback ?? null });
    else if (body.action === 'build') await buildProject(db, projectId);
    else if (body.action === 'review') await reviewProject(db, projectId);
    else return { statusCode: 400, body: 'Unknown action' };
    return { statusCode: 200, body: 'done' };
});
