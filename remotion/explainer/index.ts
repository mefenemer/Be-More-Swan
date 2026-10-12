// remotion/explainer/index.ts — entry point for the assistant overview videos. Rendered locally by
// scripts/render-assistant-videos.mjs; never deployed to Lambda (that is remotion/index.ts).
import { registerRoot } from 'remotion';
import { ExplainerRoot } from './Root';

registerRoot(ExplainerRoot);
