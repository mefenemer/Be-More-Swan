// src/utils/task-metering-flag.ts
// The rollout switch for the single task allowance (docs/task-metering.md).
//
// While 'unified_task_metering' is off for an org, the old meters run unchanged: chat and editing
// helpers spend tasks, AI media spends credits, X posts spend X credits. When it is on: chat and
// helpers are free under fair use, and media and X link posts spend weighted tasks.
//
// The flag ships whitelisted for test workspaces only and is switched on for everyone at the
// 17 October 2026 cutover, together with db/ops/task-allowance-cutover.sql. Fails closed (old meters)
// on a lookup error, like every feature flag.

import { isFeatureEnabled } from './feature-flags';

export const UNIFIED_TASK_METERING_FLAG = 'unified_task_metering';

export function isUnifiedTaskMetering(organisationId: number): Promise<boolean> {
    return isFeatureEnabled(organisationId, UNIFIED_TASK_METERING_FLAG);
}
