// scripts/promote-ci-verdict.mjs
// Is CI on a staging → main promote PR green, red, or still running? Read by the "Push to prod"
// lane in scripts/dev-issue-fixer.mjs, which merges only on 'pass'.
//
// ⚠️ REQUIRED_CHECKS must match the job `name:`s in .github/workflows/ci.yml AND the required
// status checks on main's ruleset ("Protect main"). tests/promote-ci-gate.test.ts pins the first.
// Each check usually appears TWICE (the push run and the pull_request run); every copy must pass.

export const REQUIRED_CHECKS = ['Typecheck + tests', 'RLS tenant-isolation (Postgres)'];

/** Pure: given `gh pr checks --json name,bucket` rows → { state: 'pass' | 'fail' | 'pending', check? }. */
export function promoteCiVerdict(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const name of REQUIRED_CHECKS) {
    const mine = list.filter((r) => r && r.name === name);
    if (mine.some((r) => r.bucket === 'fail' || r.bucket === 'cancel')) return { state: 'fail', check: name };
  }
  for (const name of REQUIRED_CHECKS) {
    const mine = list.filter((r) => r && r.name === name);
    if (!mine.length || mine.some((r) => r.bucket !== 'pass')) return { state: 'pending', check: name };
  }
  return { state: 'pass' };
}
