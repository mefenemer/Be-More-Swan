// src/utils/assistant-go-live.ts
// One status per assistant, and the checks that must pass before customers can hire it.
//
// Before this, three switches on two admin pages decided whether a role could be hired —
// master_assistants.is_active (Master Data), coming_soon and lifecycle_state (Assistant Catalog) —
// and only 'beta' of the six lifecycle states did anything for a customer: a "draft" role that was
// active and not coming-soon was hireable by anyone. Nothing checked that a role had the code behind
// it either, so launching one of the sixteen unbuilt roles would have let customers hire an assistant
// that could only make small talk, and emailed the waitlist that it was ready.
//
// Now one status, mapped onto the existing columns (no migration):
//   hidden       is_active=false                                   not in the catalogue at all
//   coming_soon  is_active, coming_soon                            listed; waitlist only
//   beta         is_active, !coming_soon, lifecycle 'beta'         hireable by beta-access workspaces only
//   live         is_active, !coming_soon, lifecycle 'live'         hireable by everyone
//   retired      is_active=false, lifecycle 'archived'/'deprecated' gone from the catalogue; hires keep working
// and every status change goes through admin-assistants.ts, which runs these checks first.
// Pure — tested without a database (tests/assistant-go-live.test.ts).

import { ASSISTANT_BUILD } from '../config/assistant-build-manifest';

export type AssistantStatus = 'hidden' | 'coming_soon' | 'beta' | 'live' | 'retired';
export const ASSISTANT_STATUSES: readonly AssistantStatus[] = ['hidden', 'coming_soon', 'beta', 'live', 'retired'];
export const STATUS_LABELS: Record<AssistantStatus, string> = {
    hidden: 'Hidden', coming_soon: 'Coming soon', beta: 'Beta', live: 'Live', retired: 'Retired',
};

export interface StatusColumns { isActive: boolean; comingSoon: boolean; lifecycleState: string }

/** The one status the three stored columns amount to — what a customer actually experiences. */
export function statusOf(row: StatusColumns): AssistantStatus {
    const lc = row.lifecycleState;
    if (!row.isActive) return lc === 'archived' || lc === 'deprecated' ? 'retired' : 'hidden';
    if (row.comingSoon) return 'coming_soon';
    if (lc === 'beta') return 'beta';
    // draft / review / live / deprecated with is_active and not coming-soon: customers can hire it,
    // so it IS live, whatever the stored label said.
    return 'live';
}

/** The columns a status is written as. All three are always written, so they cannot disagree again. */
export function columnsFor(status: AssistantStatus): StatusColumns {
    switch (status) {
        case 'hidden':      return { isActive: false, comingSoon: false, lifecycleState: 'draft' };
        case 'coming_soon': return { isActive: true,  comingSoon: true,  lifecycleState: 'review' };
        case 'beta':        return { isActive: true,  comingSoon: false, lifecycleState: 'beta' };
        case 'live':        return { isActive: true,  comingSoon: false, lifecycleState: 'live' };
        case 'retired':     return { isActive: false, comingSoon: false, lifecycleState: 'archived' };
    }
}

export type CheckGroup = 'details' | 'prompt' | 'built' | 'capabilities';
export const CHECK_GROUP_LABELS: Record<CheckGroup, string> = {
    details: 'Details', prompt: 'Prompt', built: 'Built and working', capabilities: 'Capabilities',
};
export interface GoLiveCheck {
    group: CheckGroup;
    key: string;
    label: string;
    ok: boolean;
    /** blocking = must pass to set the status; warning = shown, never blocks. */
    severity: 'blocking' | 'warning';
    /** What is wrong and how to fix it, when !ok. */
    fix?: string;
}

export interface GoLiveInput {
    roleKey: string;
    name?: string | null;
    tagline?: string | null;
    description?: string | null;
    category?: string | null;
    iconKey?: string | null;
    iconColor?: string | null;
    keyFeatures?: unknown;
    integrations?: unknown;
    worksWith?: unknown;
    video?: { url?: string | null } | null;
    currentVersionId?: number | null;
    riskClassification?: string | null;
    specialCategoryClauseEnabled?: boolean | null;
    /** Every role key in the catalogue — what a worksWith entry may name. */
    knownRoleKeys: readonly string[];
    /** assistant_features rows for this role. */
    capabilityRowCount: number;
}

const RISK_VALUES = ['minimal', 'limited', 'high_risk_borderline', 'high_risk'];
const MIN_DESCRIPTION = 60;
const MIN_KEY_FEATURES = 3;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function runGoLiveChecks(a: GoLiveInput): GoLiveCheck[] {
    const checks: GoLiveCheck[] = [];
    const add = (c: GoLiveCheck) => checks.push(c);
    const features = list(a.keyFeatures);
    const works = list(a.worksWith);
    const badWorks = works.filter((w) => w !== 'standalone' && !a.knownRoleKeys.includes(w));
    const build = ASSISTANT_BUILD[a.roleKey];

    // ── Details: what the public catalogue card and detail page render ──
    add({ group: 'details', key: 'name', label: 'Has a name', ok: filled(a.name), severity: 'blocking', fix: 'Add the name customers will see.' });
    add({ group: 'details', key: 'tagline', label: 'Has a tagline', ok: filled(a.tagline), severity: 'blocking', fix: 'Add the one-line hook shown under the name.' });
    add({ group: 'details', key: 'description', label: `Description of at least ${MIN_DESCRIPTION} characters`, ok: (a.description ?? '').trim().length >= MIN_DESCRIPTION, severity: 'blocking', fix: 'Describe what it does for the customer in a sentence or two.' });
    add({ group: 'details', key: 'category', label: 'Has a category', ok: filled(a.category), severity: 'blocking', fix: 'Set the catalogue category it is filed under.' });
    add({ group: 'details', key: 'icon', label: 'Has an icon and colour', ok: filled(a.iconKey) && filled(a.iconColor), severity: 'blocking', fix: 'Set both the icon key and the icon colour.' });
    add({ group: 'details', key: 'keyFeatures', label: `At least ${MIN_KEY_FEATURES} key features`, ok: features.length >= MIN_KEY_FEATURES, severity: 'blocking', fix: `${features.length} listed — the detail page shows these as its bullet list.` });
    add({ group: 'details', key: 'worksWith', label: '"Works with" names real assistants', ok: works.length > 0 && badWorks.length === 0, severity: 'blocking',
        fix: works.length === 0 ? 'Add "standalone" or the role key of an assistant it works with.' : `Not a role key in the catalogue: ${badWorks.join(', ')}.` });
    add({ group: 'details', key: 'integrations', label: 'Lists the tools it connects with', ok: list(a.integrations).length > 0, severity: 'warning', fix: 'Fine for a role that connects to nothing; otherwise list the tools.' });
    add({ group: 'details', key: 'video', label: 'Has a demo video', ok: filled(a.video?.url ?? ''), severity: 'warning', fix: 'Without one the detail page shows a placeholder.' });

    // ── Prompt ──
    // A BUILT role's prompts live in code (chat route + its drafting seams), not in the master version,
    // which is only a fallback the drafting prompt withholds (src/utils/blueprint.ts §2). And every one
    // of those code prompts carries SPECIAL_CATEGORY_RULE — tests/special-category-rule.test.ts fails if
    // one stops. So for a built role both checks are answered by the code that runs; for an unbuilt role
    // they still read the master version and the admin's confirmation.
    const inCode = !!build;
    add({ group: 'prompt', key: 'version', label: inCode ? 'Has its prompts (in code)' : 'Has a current prompt version', ok: inCode || !!a.currentVersionId, severity: 'blocking', fix: 'Create the first version on the Prompt & versions tab.' });
    add({ group: 'prompt', key: 'risk', label: 'Risk level set', ok: RISK_VALUES.includes(a.riskClassification ?? ''), severity: 'blocking', fix: `One of ${RISK_VALUES.join(', ')}.` });
    add({ group: 'prompt', key: 'specialCategory', label: inCode ? 'Refuses special-category personal data (in every prompt it runs)' : 'Special-category refusal clause confirmed', ok: inCode || !!a.specialCategoryClauseEnabled, severity: 'blocking', fix: 'Confirm the prompt refuses special-category personal data (health, religion, etc.), then tick it on the Details tab.' });

    // ── Built and working: the code a hired assistant needs (assistant-build-manifest.ts) ──
    add({ group: 'built', key: 'setup', label: 'Has set-up questions or a set-up wizard', ok: !!build, severity: 'blocking', fix: 'No set-up exists for this role in the code — a developer must build it first.' });
    add({ group: 'built', key: 'chat', label: 'Has its own chat abilities', ok: !!build?.chat, severity: 'blocking', fix: 'Without a chat route it can only make conversation — a developer must build it first.' });
    add({ group: 'built', key: 'dashboard', label: 'Has a workspace layout', ok: !!build?.dashboard, severity: 'blocking', fix: 'No dashboard layout exists for this role — a developer must build it first.' });

    // ── Capabilities ──
    add({ group: 'capabilities', key: 'rows', label: 'Capabilities set (AI images, video…)', ok: a.capabilityRowCount > 0, severity: 'warning', fix: 'None set, so every capability is off. Set them on the Capabilities tab if it should have any.' });

    return checks;
}

/** The check groups a status needs. Coming soon is public, so its card must be right; hiring needs everything. */
export function groupsRequiredFor(status: AssistantStatus): CheckGroup[] {
    if (status === 'coming_soon') return ['details'];
    if (status === 'beta' || status === 'live') return ['details', 'prompt', 'built', 'capabilities'];
    return [];
}

/** The blocking checks that stop a move to `status`. Empty = allowed. */
export function blockersFor(status: AssistantStatus, checks: GoLiveCheck[]): GoLiveCheck[] {
    const groups = groupsRequiredFor(status);
    return checks.filter((c) => !c.ok && c.severity === 'blocking' && groups.includes(c.group));
}

/** Going live for the first time from anywhere else tells the waitlist and opted-in users. */
export function announcesLaunch(from: AssistantStatus, to: AssistantStatus): boolean {
    return to === 'live' && from !== 'live';
}
