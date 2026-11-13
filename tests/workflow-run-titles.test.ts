// tests/workflow-run-titles.test.ts
// The app finds each cloud run by its exact title ("AI fix for issue #40"). An unquoted `#` in a
// YAML `run-name` starts a comment, so GitHub named every run "AI fix for issue" and the board
// never saw runs finish or fail (2026-11-12). Pins: each run-name is quoted and, with the issue id
// filled in, equals the title the app looks for.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRunTitle } from '../src/utils/issue-cloud-merge';
import { hotfixRunTitle } from '../src/utils/issue-hotfix';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const cases: Array<[string, (id: number) => string]> = [
    ['merge-to-staging.yml', mergeRunTitle],
    ['hotfix-pr.yml', hotfixRunTitle],
];

for (const [file, title] of cases) {
    check(`${file} run-name matches the title the app looks for`, () => {
        const src = readFileSync(join(root, '.github/workflows', file), 'utf8');
        const line = src.split('\n').find((l) => l.startsWith('run-name:'));
        assert.ok(line, `${file} has no run-name`);
        const m = /^run-name:\s*"([^"]*)"\s*$/.exec(line!);
        assert.ok(m, `${file} run-name must be in double quotes (an unquoted # is a YAML comment): ${line}`);
        assert.strictEqual(m![1].replace('${{ inputs.issue_id }}', '40'), title(40));
    });
}

console.log(`\nworkflow-run-titles: ${passed}/${cases.length} passed`);
