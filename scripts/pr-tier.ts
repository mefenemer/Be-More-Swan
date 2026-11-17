// scripts/pr-tier.ts — the risk tier of a change, worked out from its files (src/config/review-tiers.ts;
// docs/review-tiers-plan.md). Read-only: it never edits a PR.
//
//   npx tsx scripts/pr-tier.ts                       this branch vs origin/staging (committed + uncommitted + new files)
//   npx tsx scripts/pr-tier.ts <pr>                  a PR's tier, every file and the rule that matched it
//   npx tsx scripts/pr-tier.ts template [<pr>]       the evidence block to paste into the PR body, tier + SQL filled in
//   npx tsx scripts/pr-tier.ts check <pr>            is the PR body's evidence block there, filled in, and not claiming a lower tier?
//   npx tsx scripts/pr-tier.ts release <pr>          a staging→main release PR: the PRs it carries, high first (paste into its body)
//   npx tsx scripts/pr-tier.ts review-status <pr>    the second-opinion verdict for the PR's current commit, and whether ask-approval would accept it
//   npx tsx scripts/pr-tier.ts record-review <pr> --sha <commit> --verdict pass|notes|changes --file <findings.md>
//                                                    (the code-reviewer agent ONLY: posts its verdict on the PR; refused if the PR moved past <commit>)
//
// Add --json for machine output. GitHub: the `gh` CLI.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tierForChange, tierSummary, type ChangeTier, type ReviewTier } from '../src/config/review-tiers';
import { checkEvidence, evidenceTemplate, parseUnifiedDiff } from '../src/utils/pr-evidence';
import { formatReviewComment, isVerdict, VERDICT_LABEL } from '../src/utils/pr-review';
import { gh, prGate, prTier } from './pr-review-gate';

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const flag = (a: string[], n: string) => { const i = a.indexOf(n); return i !== -1 ? a[i + 1] : undefined; };

function prNumber(v: string | undefined): string {
    const m = /^(?:#)?(\d+)$/.exec(v || '') || /\/pull\/(\d+)/.exec(v || '');
    if (!m) throw new Error(`Expected a PR number or URL, got "${v ?? ''}".`);
    return m[1];
}

function branchTier(): ChangeTier {
    const base = run('git', ['merge-base', 'origin/staging', 'HEAD']).trim();
    const files: Array<{ path: string; sqlText: string | null }> = parseUnifiedDiff(run('git', ['diff', base])).map((f) => ({ path: f.path, sqlText: f.added }));
    for (const p of run('git', ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
        let text: string | null = null;
        if (p.endsWith('.sql')) { try { text = readFileSync(p, 'utf8'); } catch { text = null; } }
        files.push({ path: p, sqlText: text });
    }
    return tierForChange(files);
}

const ICON: Record<ReviewTier, string> = { high: '🔴', medium: '🟠', low: '🟢' };

function printTier(t: ChangeTier, title: string) {
    console.log(`${title}: ${ICON[t.tier]} ${tierSummary(t)}`);
    const order: ReviewTier[] = ['high', 'medium', 'low'];
    for (const tier of order) {
        const fs = t.files.filter((f) => f.tier === tier);
        if (!fs.length) continue;
        console.log(`\n  ${ICON[tier]} ${tier} (${fs.length})`);
        for (const f of fs) console.log(`     ${f.path}  — ${f.label}${f.note ? ` (${f.note})` : ''}`);
    }
}

/** PRs a release carries: its merge commits ("Merge pull request #N …"). */
function releasePrs(pr: string): Array<{ number: string; title: string }> {
    const commits = JSON.parse(gh(['pr', 'view', pr, '--json', 'commits'])).commits as Array<{ messageHeadline: string; messageBody: string }>;
    const out: Array<{ number: string; title: string }> = [];
    for (const c of commits) {
        const m = /^Merge pull request #(\d+)/.exec(c.messageHeadline || '');
        if (m && !out.some((x) => x.number === m[1])) out.push({ number: m[1], title: (c.messageBody || '').split('\n')[0].trim() });
    }
    return out;
}

async function main() {
    const argv = process.argv.slice(2);
    const json = argv.includes('--json');
    const args = argv.filter((a) => a !== '--json');
    const [cmd, arg] = args;

    if (!cmd) {
        const t = branchTier();
        if (json) return console.log(JSON.stringify(t, null, 2));
        return printTier(t, 'This branch vs staging');
    }
    if (cmd === 'template') {
        const t = arg ? prTier(prNumber(arg)) : branchTier();
        return console.log(evidenceTemplate(t));
    }
    if (cmd === 'check') {
        const n = prNumber(arg);
        const g = prGate(n);
        const t = g.state.tier;
        const c = checkEvidence(g.state.body, t.tier);
        if (json) return console.log(JSON.stringify({ tier: t.tier, ...c, review: { ok: g.ok, reason: g.reason, summary: g.summary } }, null, 2));
        console.log(`PR #${n}: files say ${ICON[t.tier]} ${tierSummary(t)}`);
        if (!c.found) console.log('  ✗ No evidence block. Run: npx tsx scripts/pr-tier.ts template ' + n);
        else {
            console.log(c.missing.length ? `  ✗ Not filled in: ${c.missing.join(', ')}` : '  ✓ Every required line is filled in');
            if (c.tierTooLow) console.log(`  ✗ The block says ${c.declaredTier}, but the files make it ${t.tier}`);
        }
        console.log(g.ok ? `  ✓ ${g.summary.split('\n')[0]}` : `  ✗ ${g.reason}`);
        if (!c.found || c.missing.length || c.tierTooLow || !g.ok) process.exitCode = 1;
        return;
    }
    if (cmd === 'review-status') {
        const n = prNumber(arg);
        const g = prGate(n, flag(args, '--override-review'));
        if (json) return console.log(JSON.stringify({ ok: g.ok, reason: g.reason, summary: g.summary, reviewedSha: g.reviewedSha, headSha: g.state.headSha, reviews: g.state.reviews }, null, 2));
        console.log(`PR #${n} (into ${g.state.base}, head ${g.state.headSha.slice(0, 7)}): ${g.summary.split('\n')[0]}`);
        console.log(g.ok ? '  ✓ ask-approval would accept it' : `  ✗ ${g.reason}`);
        if (!g.ok) process.exitCode = 1;
        return;
    }
    if (cmd === 'record-review') {
        const n = prNumber(arg);
        const sha = flag(args, '--sha') || '';
        const verdict = flag(args, '--verdict');
        const file = flag(args, '--file');
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha <the full 40-character commit you reviewed>');
        if (!isVerdict(verdict)) throw new Error('--verdict pass|notes|changes');
        if (!file) throw new Error('--file <findings.md>');
        const findings = readFileSync(file, 'utf8');
        if (verdict !== 'pass' && findings.trim().length < 20) throw new Error(`"${VERDICT_LABEL[verdict]}" needs its findings in --file.`);
        const head = JSON.parse(gh(['pr', 'view', n, '--json', 'headRefOid'])).headRefOid as string;
        if (head !== sha) throw new Error(`PR #${n} moved on: you reviewed ${sha.slice(0, 7)}, it is now at ${head.slice(0, 7)}. Review the new commit.`);
        const t = prTier(n);
        const body = formatReviewComment({ sha, verdict, tier: t.tier, findings });
        const url = gh(['pr', 'comment', n, '--body', body]).trim();
        console.log(`PR #${n}: ${VERDICT_LABEL[verdict]} recorded for ${sha.slice(0, 7)} (${t.tier} tier)${url ? ` — ${url}` : ''}`);
        return;
    }
    if (cmd === 'release') {
        const n = prNumber(arg);
        const prs = releasePrs(n).map((p) => {
            let title = p.title;
            try { title = JSON.parse(gh(['pr', 'view', p.number, '--json', 'title'])).title || title; } catch { /* keep the merge commit's line */ }
            return { ...p, title, t: prTier(p.number) };
        });
        const why = (t: ChangeTier) => { const r = t.reasons[0]; return r ? `${r.label}: ${r.path}${t.reasons.length > 1 ? ` +${t.reasons.length - 1} more` : ''}` : ''; };
        if (json) return console.log(JSON.stringify(prs.map((p) => ({ number: p.number, title: p.title, tier: p.t.tier, why: tierSummary(p.t) })), null, 2));
        const order: ReviewTier[] = ['high', 'medium', 'low'];
        const lines = ['## What this release carries, by risk', ''];
        for (const tier of order) {
            const group = prs.filter((p) => p.t.tier === tier);
            if (!group.length) continue;
            lines.push(`### ${ICON[tier]} ${tier[0].toUpperCase() + tier.slice(1)} (${group.length})${tier === 'high' ? ' — read these' : ''}`);
            for (const p of group) lines.push(`- #${p.number} ${p.title}${tier === 'low' ? '' : ` — _${why(p.t)}_`}`);
            lines.push('');
        }
        if (!prs.length) lines.push('_No merged PRs found in this release\'s commits._');
        return console.log(lines.join('\n'));
    }
    const t = prTier(prNumber(cmd));
    if (json) return console.log(JSON.stringify(t, null, 2));
    printTier(t, `PR #${prNumber(cmd)}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
