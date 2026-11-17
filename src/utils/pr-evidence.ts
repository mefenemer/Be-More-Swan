// src/utils/pr-evidence.ts — the evidence block every PR body carries (owner, 2026-11-17;
// docs/review-tiers-plan.md §3), and reading a unified diff into files for the risk tier
// (src/config/review-tiers.ts). Phase 1 is a convention: nothing refuses a PR without the block yet.

import { tierForChange, tierSummary, type ChangeTier, type ReviewTier } from '../config/review-tiers';

export const EVIDENCE_START = '---EVIDENCE---';
export const EVIDENCE_END = '---END-EVIDENCE---';

/** The block's lines, in order. `required` lines must be filled in (not left as the template's "<…>"). */
export const EVIDENCE_FIELDS = [
    { key: 'tier', label: 'Tier', required: true },
    { key: 'change', label: 'What changed + why', required: true },
    { key: 'rootCause', label: 'Root cause', required: false },
    { key: 'proof', label: 'Proof', required: true },
    { key: 'sql', label: 'SQL', required: true },
    { key: 'review', label: 'Review', required: false },
    { key: 'risk', label: 'Risk if wrong', required: true },
    { key: 'rollback', label: 'Rollback', required: true },
] as const;
export type EvidenceKey = typeof EVIDENCE_FIELDS[number]['key'];

export interface DiffFile { path: string; added: string; deleted: boolean }

/** Files in a unified diff (`git diff` / `gh pr diff`), with the lines each one ADDS. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
    const files: DiffFile[] = [];
    let cur: DiffFile | null = null;
    const added: string[] = [];
    const flush = () => { if (cur) { cur.added = added.join('\n'); files.push(cur); } added.length = 0; };
    for (const line of String(diff || '').split('\n')) {
        const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (head) { flush(); cur = { path: head[2], added: '', deleted: false }; continue; }
        if (!cur) continue;
        if (line.startsWith('+++ ') || line.startsWith('--- ')) {
            if (line === '+++ /dev/null') cur.deleted = true;
            continue;
        }
        if (line.startsWith('+')) added.push(line.slice(1));
    }
    flush();
    return files;
}

/** Tier of a diff. SQL files are judged on the SQL they ADD; a deleted SQL file adds none (medium). */
export function tierForDiff(diff: string): ChangeTier {
    return tierForChange(parseUnifiedDiff(diff).map((f) => ({ path: f.path, sqlText: f.added })));
}

/** A blank block with the tier and SQL lines already filled from the diff. */
export function evidenceTemplate(t: ChangeTier): string {
    const sqlFiles = t.files.filter((f) => f.key === 'sql');
    const sql = !sqlFiles.length ? 'none'
        : sqlFiles.some((f) => f.tier === 'high') ? `NEEDS OWNER (non-additive: ${sqlFiles.filter((f) => f.tier === 'high').map((f) => f.path).join(', ')})`
        : `additive (${sqlFiles.map((f) => f.path).join(', ')}) — staging <✅ / not yet>`;
    const lines: Record<EvidenceKey, string> = {
        tier: tierSummary(t),
        change: '<2–4 plain sentences>',
        rootCause: '<Confirmed | Guessed | n/a (feature)>',
        proof: '<test that failed before and passes after | e2e smoke | screenshot>',
        sql,
        review: t.tier === 'low' ? 'not needed (low tier)' : '<Pass | Pass with notes | Changes needed — reviewer run on <sha>>',
        risk: '<who notices and how bad if this is wrong>',
        rollback: '<revert the PR | SQL down-step | switch off>',
    };
    return [EVIDENCE_START, ...EVIDENCE_FIELDS.map((f) => `${f.label}: ${lines[f.key]}`), EVIDENCE_END].join('\n');
}

export interface EvidenceCheck {
    found: boolean;
    fields: Partial<Record<EvidenceKey, string>>;
    missing: string[];
    declaredTier: ReviewTier | null;
    /** The block claims a LOWER tier than the files give. */
    tierTooLow: boolean;
}

/** Read the block out of a PR body and say what's missing. `computed` = the tier from the diff, when known. */
export function checkEvidence(body: string | null | undefined, computed?: ReviewTier): EvidenceCheck {
    const text = String(body || '');
    const s = text.indexOf(EVIDENCE_START);
    const e = s === -1 ? -1 : text.indexOf(EVIDENCE_END, s);
    if (s === -1 || e === -1) return { found: false, fields: {}, missing: EVIDENCE_FIELDS.filter((f) => f.required).map((f) => f.label), declaredTier: null, tierTooLow: false };
    const fields: Partial<Record<EvidenceKey, string>> = {};
    for (const raw of text.slice(s + EVIDENCE_START.length, e).split('\n')) {
        const line = raw.trim();
        const f = EVIDENCE_FIELDS.find((x) => line.toLowerCase().startsWith(`${x.label.toLowerCase()}:`));
        if (f) fields[f.key] = line.slice(f.label.length + 1).trim();
    }
    const unfilled = (v?: string) => !v || /^<[^>]*>$/.test(v) || /<[^>]*>/.test(v) && v.replace(/<[^>]*>/g, '').trim().length < 3;
    const missing = EVIDENCE_FIELDS.filter((f) => f.required && unfilled(fields[f.key])).map((f) => f.label);
    const m = /^(low|medium|high)\b/i.exec(fields.tier || '');
    const declaredTier = m ? (m[1].toLowerCase() as ReviewTier) : null;
    const rank = { low: 0, medium: 1, high: 2 };
    const tierTooLow = !!(computed && declaredTier && rank[declaredTier] < rank[computed]);
    return { found: true, fields, missing, declaredTier, tierTooLow };
}
