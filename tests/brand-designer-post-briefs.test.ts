// tests/brand-designer-post-briefs.test.ts
// A social draft that found no picture raises a brief for the Brand Designer. Brand Designer plan,
// Phase 5. The attach rules themselves (a chosen picture is never replaced; a published post is left
// alone; cross-post siblings get it) are proven on real Postgres in visual-briefs-db.test.ts.
//
// What is pinned, and how each would fail silently:
//   • The drafting job raises the brief ONLY when every media source came back empty, never for a
//     Short, and it can never fail the draft.
//   • Raising a brief never spends: only an all-free brief starts its round (the one shared rule).
//   • One open brief per post — a retried job or a second click does not make two.
//   • Approving puts the picture on the post through the one attach function, and both surfaces say
//     what happened to the post.
//   • The post editor shows "Ask the Brand Designer" only when there is one to ask.
//   • No import cycle: brief-post-media does not import visual-briefs.
//
// Run:  npx tsx tests/brand-designer-post-briefs.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_ATTACH_NOTES } from '../src/utils/brief-post-media';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what}.`);
    return text.slice(a, b);
}

const engine = code(read('src/utils/visual-briefs.ts'));
const raise = span(engine, 'export async function raiseBriefForPost', '\n}\n', 'raiseBriefForPost');

console.log('\n──── raising a brief ────');

check('the drafting job raises one only when every source came back empty, and never for a Short', () => {
    const jobs = code(read('netlify/functions/process-content-jobs.ts'));
    const exhausted = span(jobs, "mediaExhaustedReason = resolved.lastError === 'insufficient_ai_credits'", '\n                }\n', 'the exhausted branch');
    assert.match(exhausted, /if \(!isYoutubeShort\) \{\s*await raiseBriefForPost\(db, \{/);
    assert.match(exhausted, /postId: post\.id/);
    assert.ok(jobs.indexOf('await raiseBriefForPost(') > jobs.indexOf('if (resolved.ok) {'), 'only on the failure side of the resolver');
});

check('it never fails the draft, is org-scoped, needs a Brand Designer, and is one per post', () => {
    assert.match(raise, /\} catch \(err\) \{[\s\S]*return null;/, 'a picture must never fail a draft');
    assert.match(raise, /eq\(scheduledPosts\.organisationId, args\.orgId\)/);
    assert.match(raise, /'brand_designer'/);
    assert.match(raise, /if \(!designer\) return null;/);
    assert.match(raise, /eq\(visualBriefs\.scheduledPostId, args\.postId\)[\s\S]*if \(open\) return open\.id;/, 'a retry returns the brief that exists');
    assert.match(raise, /origin: 'assistant', scheduledPostId: args\.postId/);
});

check('raising a brief never spends: only an all-free brief starts its round', () => {
    assert.match(raise, /if \(sourcesAreFree\(n\.brief\.sources\)\) \{[\s\S]*startRound\(/);
    assert.ok(raise.indexOf('startRound(') > raise.indexOf('sourcesAreFree('));
    assert.match(raise, /sources: isVideo \? \['stock_video'\] : defaultSourcesFor\(designer\.onboardingContext\)/,
        'a video post asks for stock video only — never an unasked-for AI clip');
});

console.log('\n──── approving puts it on the post ────');

check('both approval paths place it through the one attach function, and report what happened', () => {
    const decide = span(engine, 'export async function decideOption', '\n}\n', 'decideOption');
    assert.ok((decide.match(/postNote: await placeOnPost\(db, brief, orgId,/g) || []).length === 2, 'generated AND "your own" options both go onto the post');
    const place = span(engine, 'async function placeOnPost', '\n}\n', 'placeOnPost');
    assert.match(place, /if \(!brief\.scheduledPostId\) return undefined;/);
    assert.match(place, /attachApprovedToPost\(db, \{ orgId, postId: brief\.scheduledPostId, assetId \}\)/);
    for (const k of ['attached', 'post_has_media', 'not_editable', 'post_gone'] as const) assert.ok(POST_ATTACH_NOTES[k].length > 20, `no sentence for ${k}`);
    assert.match(read('src/components/assistant-briefs.js'), /res\.postNote \? ` \$\{res\.postNote\}` : ''/);
    assert.match(read('src/components/disruptive-ui-registry.js'), /const notes = \(results \|\| \[\]\)\.map\(\(r\) => r\.postNote\)/);
});

check('the attach rules: editable status, no existing media, siblings too, never throws', () => {
    const m = code(read('src/utils/brief-post-media.ts'));
    const fn = span(m, 'export async function attachApprovedToPost', '\n}\n', 'attachApprovedToPost');
    assert.match(fn, /if \(!isMediaEditable\(post\.status\)\) return 'not_editable';/);
    assert.match(fn, /if \(await hasMedia\(db, post\.id\)\) return 'post_has_media';/);
    assert.match(fn, /mediaTargetPostIds\(db, \{ postId: post\.id, orgId: args\.orgId \}\)/);
    assert.match(fn, /if \(id !== post\.id && await hasMedia\(db, id\)\) continue;/, 'a sibling\'s own picture wins too');
    assert.match(fn, /\} catch \(err\) \{/);
    assert.ok(!/from '\.\/visual-briefs'/.test(m), 'import cycle');
});

console.log('\n──── the post editor and the migration ────');

check('"Ask the Brand Designer" appears only when there is one, and asks through the API', () => {
    const page = read('workspace.html');
    assert.match(page, /id="gp-ai-src-designer"[^>]*style="display:none"[^>]*class="hidden /, 'hidden until the check says yes');
    assert.match(page, /if \(btn && _gpDesignerId\) \{ btn\.classList\.remove\('hidden'\); btn\.style\.display = ''; \}/);
    assert.match(page, /action: 'brief_for_post', postId: _gpCurrentPostId/);
    const api = code(read('netlify/functions/brand-briefs.ts'));
    const bfp = span(api, "if (action === 'brief_for_post')", "if (action === 'cancel')", 'brief_for_post');
    assert.match(bfp, /eq\(scheduledPosts\.organisationId, orgId\)/);
    assert.ok(bfp.indexOf('enforcePromptModeration') < bfp.indexOf('raiseBriefForPost'), 'moderated before anything is made');
});

check('the migration links briefs to posts without deleting either way, and widens origin as a superset', () => {
    const sql = read('db/z-brand-designer-post-briefs.sql');
    assert.match(sql, /scheduled_post_id INTEGER REFERENCES scheduled_posts\(id\) ON DELETE SET NULL/);
    assert.match(sql, /CHECK \(origin IN \('user', 'chat', 'campaign', 'assistant'\)\)/);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
    assert.match(read('db/schema.ts'), /\$\{t\.origin\} IN \('user','chat','campaign','assistant'\)/);
});

console.log(`\n${passed} checks passed.`);
