// netlify/functions/render-video-project-background.ts
// Render a Video Producer project to My Content (docs/video-producer-studio-plan.md §4.1).
//   POST { projectId } → renderProject (rendering → ready | render_failed). A duplicate wake is a no-op.
// Background function: 15-minute ceiling; the render itself is polled for at most 12.

import type { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { renderProject } from '../../src/utils/video-render';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    let body: { projectId?: number };
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    const projectId = Number(body.projectId);
    if (!Number.isInteger(projectId)) return { statusCode: 400, body: 'Missing projectId' };
    await renderProject(getDb(), projectId);
    return { statusCode: 200, body: 'done' };
});
