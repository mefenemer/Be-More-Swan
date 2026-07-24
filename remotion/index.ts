// remotion/index.ts — Remotion entry point. Bundled by `remotion lambda sites create` and by the
// Studio. Keep this thin: it only registers the root.
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
