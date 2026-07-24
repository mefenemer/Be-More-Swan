// remotion.config.ts — applies to the Studio and the CLI (`remotion render` / `lambda sites create`).
// Not read by the Lambda render itself (that takes options from the render request). Excluded from the
// main `tsc` build (see tsconfig.json) because it imports the Remotion CLI config, a bundler concern.
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setOverwriteOutput(true);
