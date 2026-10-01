// tests/form-builder.test.ts
// The Form Builder end to end (docs/form-builder-plan.md): the chat (Mode A), the visual builder
// (Mode B), the admin API, the public endpoint, campaign linkage, and the migration.
//
// What would hurt:
//   1. THE CHAT GUESSING IDS it cannot see — a segment, an email campaign, a logo.
//   2. A FORM GOING LIVE FROM A CHAT CARD before anybody has looked at it.
//   3. ONE TENANT REACHING ANOTHER'S DATA through an id in a definition (segment, campaign, logo).
//   4. THE BROWSER DECIDING WHAT A VALID SUBMISSION IS.
//   5. A FORM'S CAMPAIGN NOT STARTING — or the welcome sequence starting beside it.
//   6. THE MIGRATION DYING HALF-APPLIED on a re-run.
//   7. A BUILDER BUTTON THAT RENDERS AND DOES NOTHING (handlers bound from a render path).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formDraftFromUiElement, AUDIENCE_FORM_DRAFT_TYPE } from '../src/utils/form-chat-draft';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ORCH = read('netlify/functions/chat-orchestrator.ts');
const REGISTRY = read('src/components/disruptive-ui-registry.js');
const SESSION = read('src/components/chat-session.js');
const FORMS = read('netlify/functions/audience-forms.ts');
const PUBLIC = read('netlify/functions/audience-public.ts');
const ENGINE = read('src/utils/newsletter-sequence.ts');
const BUILDER = read('src/components/form-builder.js');
const RENDERER = read('subscribe.js');
const SQL = read('db/form-builder.sql');
const SEQ_API = read('netlify/functions/newsletter-sequences.ts');

// ── 1. The chat ─────────────────────────────────────────────────────────────

check('a chat form never carries a segment, campaign or logo id', () => {
    const d = formDraftFromUiElement({ type: AUDIENCE_FORM_DRAFT_TYPE, form: {
        fields: [{ type: 'email', label: 'Email' }],
        audience: { segmentId: 4 }, campaign: { sequenceId: 9, skipWelcome: true }, style: { logo: { assetId: 12 } },
    } })!;
    assert.strictEqual(d.form.audience.segmentId, null);
    assert.deepStrictEqual(d.form.campaign, { sequenceId: null, skipWelcome: false });
    assert.strictEqual(d.form.style.logo, null);
    assert.strictEqual(formDraftFromUiElement({ type: 'newsletter_issue_draft', bodyMarkdown: 'x' }), null);
});

check('the route designs forms, refuses sensitive questions, and never claims one is live', () => {
    const route = ORCH.slice(landmark(ORCH, '    newsletter_editor: {'), landmark(ORCH, '    blog_writer: {'));
    assert.match(route, /SIGN-UP FORMS —/);
    assert.match(route, /Never ask for a date of birth, home address, payment details/);
    assert.match(route, /Never say a form is live, published or collecting sign-ups/);
    assert.match(route, /"type": "audience_form_draft"/);
});

check('the form card is normalised before it is stored, and restated in history', () => {
    assert.match(ORCH, /formDraft \? \{ type: AUDIENCE_FORM_DRAFT_TYPE, \.\.\.formDraft \}/);
    assert.match(ORCH, /type !== AUDIENCE_FORM_DRAFT_TYPE\) return null;/);
    assert.match(ORCH, /!formDraft && replyClaimsPostSaved/);
});

// ── 2. Saved switched off ───────────────────────────────────────────────────

check('a form saved from the chat is born switched off', () => {
    const h = SESSION.slice(landmark(SESSION, 'function onAudienceFormCreate'), landmark(SESSION, 'The composer does not exist in read-only mode'));
    assert.match(h, /status: 'disabled'/);
    assert.match(SESSION, /addEventListener\('audience:createForm'/);
    assert.match(SESSION, /removeEventListener\('audience:createForm'/);
    const create = FORMS.slice(landmark(FORMS, "if (action === 'create')"), landmark(FORMS, "const id = Number(body.id"));
    assert.match(create, /status: body\.status === 'disabled' \? 'disabled' : 'active'/);
    const card = REGISTRY.slice(landmark(REGISTRY, 'function renderAudienceFormDraftCard'), landmark(REGISTRY, "register('audience_form_draft'"));
    assert.match(card, /audience:createForm/);
    assert.match(card, /nobody can sign up until you do/);
});

// ── 3. Ownership ────────────────────────────────────────────────────────────

check('a definition\'s segment, campaign and logo must belong to the organisation', () => {
    const prep = FORMS.slice(landmark(FORMS, 'async function prepareDefinition'), landmark(FORMS, 'async function ensureCustomFields'));
    assert.match(prep, /eq\(audienceSegments\.organisationId, orgId\)/);
    assert.match(prep, /eq\(newsletterSequences\.organisationId, orgId\)/);
    assert.match(prep, /eq\(contentAssets\.organisationId, orgId\)/, 'a signed logo URL would publish another tenant\'s image');
    assert.match(prep, /lower\(\$\{audienceForms\.slug\}\) = \$\{slug\}/, 'slugs are unique across every org');
});

check('enrolment is scoped to the org even with a sequence id', () => {
    const fn = ENGINE.slice(landmark(ENGINE, 'export async function enrolInSequence'), landmark(ENGINE, 'export async function enrolAfterSignup'));
    assert.match(fn, /eq\(newsletterSequences\.organisationId, args\.organisationId\)/);
});

check('the sequences API addresses a series only within the org', () => {
    assert.match(SEQ_API, /seqId \? eq\(newsletterSequences\.id, seqId\) : eq\(newsletterSequences\.triggerEvent, 'subscribed'\)/);
    const before = SEQ_API.slice(0, landmark(SEQ_API, 'seqId ? eq(newsletterSequences.id, seqId)'));
    assert.match(before.slice(-300), /eq\(newsletterSequences\.organisationId, orgId\)/);
});

check('the old settings panel writes THROUGH the definition, not beside it', () => {
    const upd = FORMS.slice(landmark(FORMS, "if (action === 'update')"));
    assert.match(upd, /columnsFromDefinition\(def\)/);
});

// ── 4. The server decides ───────────────────────────────────────────────────

check('answers are validated against the stored definition before anything is written', () => {
    const sub = PUBLIC.slice(landmark(PUBLIC, 'const checked = validateAnswers(def, rawAnswers)'));
    assert.ok(landmark(sub, 'if (!checked.ok)') < landmark(sub, 'upsertContact('));
    assert.match(PUBLIC, /customFields: answers\.custom/);
});

check('a slug only addresses the hosted page', () => {
    assert.match(PUBLIC, /if \(!byKey && !form\.hostedEnabled\) return json\(404/);
});

check('tags wait for confirmation on double opt-in, and apply at once on single', () => {
    const confirm = PUBLIC.slice(landmark(PUBLIC, "if (path.includes('/api/audience/confirm')"));
    assert.match(confirm, /applyTagsByName\(db, row\.organisationId, row\.contactId, names\)/);
    const single = PUBLIC.slice(landmark(PUBLIC, 'if (!form.doubleOptIn) {'));
    assert.match(single.slice(0, 1500), /applyTagsByName\(db, orgId, contactId, submissionTags\)/);
});

// ── 5. Campaigns ────────────────────────────────────────────────────────────

check('a linked campaign starts, and replaces the welcome sequence unless told otherwise', () => {
    const fn = ENGINE.slice(landmark(ENGINE, 'export async function enrolAfterSignup'), landmark(ENGINE, 'export async function haltEnrolmentsForContact'));
    assert.match(fn, /if \(args\.formSequenceId\) await enrolInSequence/);
    assert.match(fn, /if \(!args\.formSequenceId \|\| !args\.skipWelcome\) await enrolInWelcomeSequence/);
    assert.match(BUILDER, /d\.campaign\.skipWelcome = !!d\.campaign\.sequenceId;/, 'linking defaults to REPLACE (decision D2)');
});

check('single opt-in sign-ups are enrolled too (they never were before)', () => {
    const single = PUBLIC.slice(landmark(PUBLIC, 'if (!form.doubleOptIn) {'), landmark(PUBLIC, '// ── Double opt-in: mint'));
    assert.match(single, /await enrolAfterSignup\(db, \{/);
});

// ── 6. The migration ────────────────────────────────────────────────────────

check('the migration never DROP-then-ADDs a constraint at top level', () => {
    const outside = SQL.replace(/DO \$\$[\s\S]*?END \$\$;/g, '');
    assert.ok(!/DROP CONSTRAINT/.test(outside), 'a bare DROP CONSTRAINT dies on re-run and skips the rest of the file');
    assert.ok(landmark(SQL, 'CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_org_welcome_uidx') < landmark(SQL, 'DROP INDEX IF EXISTS newsletter_sequences_org_trigger_uidx'),
        'the new guarantee exists before the old one goes');
    assert.match(SQL, /APPLY BEFORE DEPLOYING/);
});

// ── 7. The builder ──────────────────────────────────────────────────────────

check('the builder binds its handlers once, on the dialog, never from a render function', () => {
    const renders = ['function renderPanel', 'function panelQuestions', 'function inspector', 'function panelLook', 'function panelWords', 'function panelShare', 'function panelAfter', 'function renderPreview'];
    for (const r of renders) {
        const body = BUILDER.slice(landmark(BUILDER, r), BUILDER.indexOf('\n  }\n', landmark(BUILDER, r)));
        assert.ok(!body.includes('addEventListener'), `${r} must not bind handlers`);
    }
    const modal = BUILDER.slice(landmark(BUILDER, 'function ensureModal'), landmark(BUILDER, '// ── Rendering'));
    assert.match(modal, /document\.body\.appendChild\(m\)/, 'attached to <body>, never inside a hidden view section');
    assert.match(modal, /m\.addEventListener\('click', onClick\)/);
});

check('a drag only repaints on drop', () => {
    const modal = BUILDER.slice(landmark(BUILDER, 'function ensureModal'), landmark(BUILDER, '// ── Rendering'));
    const dragover = modal.slice(landmark(modal, "'dragover'"), landmark(modal, "'drop'"));
    assert.ok(!/render/.test(dragover));
    assert.match(BUILDER.slice(landmark(BUILDER, 'function onDrop')), /renderPanel\(\)/);
});

check('the builder previews with the real renderer and saves the whole definition', () => {
    assert.match(BUILDER, /window\.BmsForm\.render\(/);
    assert.match(BUILDER, /action: 'save', id: S\.formId, definition: S\.def/);
    assert.match(read('workspace.html'), /<script src="\/subscribe\.js"><\/script>\s*<script src="\/src\/components\/form-builder\.js"><\/script>/);
});

check('a preview-only logo is never honoured on a live form', () => {
    assert.match(RENDERER, /var logo = opts\.preview && opts\.previewLogoUrl \?/);
});

check('an email campaign can be deleted — never while it is on, and only by an owner or admin', () => {
    const del = SEQ_API.slice(landmark(SEQ_API, "if (action === 'deleteSequence')"), landmark(SEQ_API, "if (action === 'deleteStep')"));
    assert.ok(landmark(del, 'ENABLE_ROLES.includes(ctx.role)') < landmark(del, 'tx.delete(newsletterSequences)'));
    assert.ok(landmark(del, 'if (sequence.isEnabled)') < landmark(del, 'tx.delete(newsletterSequences)'), 'refused while switched on');
    assert.match(del, /eq\(newsletterSequences\.organisationId, orgId\)/);
    assert.match(del, /jsonb_set\(definition, '\{campaign\}'/, 'linked forms are unlinked in their definition too');
    const studio = read('newsletter.js');
    assert.match(studio, /\$\('nl-welcome-body'\)\?\.addEventListener\('click', \(e\) => \{ if \(e\.target\.closest\('\[data-seq-delete-all\]'\)\) deleteSequence\(\); \}\);/,
        'bound once by delegation, not from the render path');
});

check('every builder setting has an info icon with a glossary entry', () => {
    const ex = read('explainers.js');
    // Tagged three ways: data-explain="…", label('…', '…'), and the colour pickers' slug map ('form-colour-…').
    const slugs = [...new Set([...BUILDER.matchAll(/["'](form-[a-z-]+)["']/g)].map((m) => m[1]))];
    assert.ok(slugs.length >= 30, `expected ~33 tagged settings, found ${slugs.length}`);
    for (const slug of slugs) assert.ok(ex.includes(`'${slug}': {`), `${slug} has no glossary entry — its icon would never appear`);
});

check('the two previews are drawn as the place they will appear', () => {
    assert.match(RENDERER, /var face = surface === 'preview' \? \(opts\.previewAs === 'embed' \? 'embed' : 'hosted'\) : surface;/);
    assert.match(RENDERER, /face === 'hosted' \? '<p class="bms-foot">/, 'the hosted footer follows the PREVIEWED surface');
    assert.match(BUILDER, /www\.your-website\.com/);
    assert.match(BUILDER, /id="fb-preview-above"/);
});

check('the builder can be closed from its top-right X', () => {
    assert.match(BUILDER, /data-fb-close aria-label="Close"/);
});

check('subject and preview line have the Swan "suggest" icon, and suggesting saves nothing', () => {
    const html = read('newsletter.html');
    assert.match(html, /data-nl-suggest="subject"[\s\S]{0,250}BeMoreSwan_SwanAI\.png/);
    assert.match(html, /data-nl-suggest="preheader"[\s\S]{0,250}BeMoreSwan_SwanAI\.png/);
    const issues = read('netlify/functions/newsletter-issues.ts');
    const a = issues.slice(landmark(issues, "if (action === 'suggest')"), landmark(issues, "if (action === 'refine')"));
    assert.ok(!/db\.update|db\.insert/.test(a), 'returns options only');
    assert.match(read('newsletter.js'), /input\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/, 'a pick saves like typing');
});

console.log(`\n${passed} checks passed.`);
