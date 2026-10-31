// tests/content-prompt-surfaces.test.ts
// The Social Media, Blog Writer and Email Marketing chats must be able to SEE their own work and
// must know the real names of their own page.
//
// WHY THIS EXISTS. All three chats could write work and read none of it, so "where's my Thursday
// post?" got an improvised answer, and with no list of its page's sections the social chat invented
// them — it told a user the app had no "content brief section" when the real one is Assistant
// Profile ▸ Creative Brief. Cloned from tests/campaign-prompt-surfaces.test.ts: a prompt is just a
// string, and a string naming last quarter's tabs still compiles and passes every other test.
//
// No database: source-consistency checks plus the pure renderer.
// Run:  npx tsx tests/content-prompt-surfaces.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderContentSnapshot, type SnapshotItem } from '../src/utils/content-snapshot';

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

/** Blank out comments, preserving length — the helpers' header comments name the very phrases checked. */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone. Update this test's anchors.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone. Update this test's anchors.`);
    return text.slice(a, b);
}

const orchestrator = stripComments(read('netlify/functions/chat-orchestrator.ts'));
const page = read('assistant-detail.html');
const registry = read('src/components/assistant-dashboard-registry.js');
const regEntry = (role: string) => span(registry, `    ${role}: {`, '\n    },\n', `the ${role} registry entry`);
const routeOf = (role: string) => span(orchestrator, `    ${role}: {`, '        parseResponse: parseStructuredReply,', `the ${role} route`);

// Renamed to plain words 2026-10-21 (owner): Mandate, Operational Setup, Creative Brief, Rules,
// Brand Safety & Legal.
const PROFILE = (strategyCard: string) => ['What I do', strategyCard === 'Brand Knowledge' ? 'When and how I work' : 'When and how I post', strategyCard, 'Connections', 'Do’s and don’ts', 'Safety and legal', 'Notifications'];

const ROLES = [
    {
        role: 'social_media_manager', helper: 'socialSurfaces', kind: 'posts', queue: 'Posts',
        columns: ['Review', 'Scheduled', 'Posted', 'Needs attention', 'Archived'],
        // "Goals" is labelled "Results" on every role (2026-10-21).
        tabs: ['Calendar', 'Inspo', 'My Content', 'Results', 'Activity'],
        profile: PROFILE('What I post about'),
    },
    {
        role: 'blog_writer', helper: 'blogSurfaces', kind: 'blog', queue: 'Blogs',
        // "Published" is the Posted column relabelled for this role (assistants.js setText … 'Published').
        columns: ['Review', 'Scheduled', 'Published', 'Needs attention', 'Archived'],
        tabs: ['Calendar', 'Inspo', 'My Content', 'Results', 'Activity'],
        profile: PROFILE('Brand Knowledge'),
    },
    {
        role: 'newsletter_editor', helper: 'emailSurfaces', kind: 'emails', queue: 'Emails',
        // "Sent" is the Posted column relabelled for this role (assistants.js setText … 'Sent').
        columns: ['Review', 'Approved', 'Scheduled', 'Sent', 'Needs attention', 'Archived'],
        tabs: ['Email Flows', 'Calendar', 'Results', 'Activity'],
        profile: PROFILE('Brand Knowledge'),
    },
];

const TAB_ON_PAGE: Record<string, (reg: string) => boolean> = {
    Calendar: () => page.includes('data-maintab="calendar" class="main-tab-btn">Calendar</button>'),
    Inspo: (reg) => /inspoTab:\s*\{[\s\S]*?label:\s*'Inspo'/.test(reg),
    'My Content': (reg) => /myContentTab:\s*\{\s*label:\s*'My Content'/.test(reg),
    Goals: () => page.includes('data-maintab="goals"') && page.includes('>Goals</button>'),
    Results: () => page.includes('data-maintab="goals"')
        && read('assistants.js').includes("const goalsTab = cfg.goalsTab || { label: 'Results', bringsResults: true };")
        && read('assistants.js').includes("setText('maintab-btn-goals', goalsTab.label || 'Goals');"),
    Activity: () => page.includes('data-maintab="activity"') && page.includes('>Activity</button>'),
    'Email Flows': (reg) => /emailCampaignsTab:\s*true/.test(reg) && page.includes('<span id="email-campaigns-tab-label">Email Flows</span>'),
};

const COLUMN_ON_PAGE = (col: string) => col === 'Sent' || col === 'Published'
    ? read('assistants.js').includes(`setText('detail-rq-col-label-posted', '${col}')`)
    : new RegExp(`class="detail-rq-col[^"]*"[\\s\\S]{0,200}?>\\s*(<span[^>]*>)?${col}\\b`).test(page);

const PROFILE_ON_PAGE = (card: string) => card === 'Brand Knowledge'
    ? read('assistants.js').includes("setText('opcard-strategy-title', 'Brand Knowledge')")
    : card === 'When and how I work'
    ? read('assistants.js').includes("setText('opcard-operation-title', 'When and how I work')")
    : page.includes(`font-bold text-gray-900">${card.replace('&', '&amp;')}</p>`);

for (const r of ROLES) {
    console.log(`\n${r.role} — chat sees its own ${r.kind} and names real places`);
    const route = routeOf(r.role);
    const reg = regEntry(r.role);
    const surfaces = span(orchestrator, `function ${r.helper}(): string {`, '\n}\n', `${r.helper}()`)
        // The non-social helpers share one constant for the Profile cards; read it in.
        .replace('${PROFILE_CARDS_NON_SOCIAL}', span(orchestrator, 'const PROFILE_CARDS_NON_SOCIAL = `', '`;', 'PROFILE_CARDS_NON_SOCIAL'));

    check('the route reads its own work every turn and puts it in the prompt', () => {
        assert.ok(new RegExp(`contentSnapshot:\\s*'${r.kind}'`).test(route), `${r.role} must set contentSnapshot: '${r.kind}'`);
        assert.ok(route.includes(`${r.helper}()`), `the prompt must include ${r.helper}()`);
        assert.ok(route.includes('rc.contentSnapshot ??'), 'the prompt must include rc.contentSnapshot with a fallback admission');
    });

    check(`the queue tab is called "${r.queue}" on the page`, () => {
        assert.ok(surfaces.includes(`"${r.queue}" tab`), `${r.helper}() no longer names the "${r.queue}" tab`);
        assert.ok(new RegExp(`reviewQueue:\\s*\\{[^}]*label:\\s*'${r.queue}'`).test(reg), `the ${r.role} queue tab is no longer labelled '${r.queue}' — rename it in ${r.helper}()`);
    });

    check('every other tab it names is on the page for this role', () => {
        for (const tab of r.tabs) {
            assert.ok(surfaces.includes(`"${tab}" tab`), `${r.helper}() no longer mentions the "${tab}" tab`);
            assert.ok(TAB_ON_PAGE[tab](reg), `the "${tab}" tab is named in ${r.helper}() but is not on the page for ${r.role}`);
        }
        assert.ok(page.includes('<span id="profile-btn-label">Assistant Profile</span>') && surfaces.includes('"Assistant Profile" button'));
    });

    check('every column and Profile card it names is on the page', () => {
        for (const col of r.columns) {
            assert.ok(surfaces.includes(`"${col}"`), `${r.helper}() no longer names the "${col}" column`);
            assert.ok(COLUMN_ON_PAGE(col), `the "${col}" column is not on the page`);
        }
        for (const card of r.profile) {
            assert.ok(surfaces.includes(`"${card}"`), `${r.helper}() no longer names the "${card}" card`);
            assert.ok(PROFILE_ON_PAGE(card), `the "${card}" card is not in the Assistant Profile`);
        }
    });

    check('it forbids inventing places and changing existing work', () => {
        assert.ok(/Never name a tab, section, button or setting that is not listed/.test(surfaces));
        assert.ok(/never tell the user a section does not exist/.test(surfaces));
        // Every content chat CAN act on existing work now (chat-post-action.ts, chat-blog-action.ts,
        // chat-email-action.ts) — but only by proposing a card the user confirms.
        if (r.helper === 'socialSurfaces') {
            assert.ok(/only that click changes anything/.test(surfaces), 'the social chat must say the user\'s click acts, not the chat');
            assert.ok(/never say a post HAS been approved, rejected, retried, moved, removed, shortened, lengthened or made into a video/.test(surfaces));
        } else if (r.helper === 'blogSurfaces') {
            assert.ok(/only that click changes anything/.test(surfaces), 'the blog chat must say the user\'s click acts, not the chat');
            assert.ok(/never say an article HAS been approved, scheduled, unscheduled, rejected, removed, shortened, lengthened or revised/.test(surfaces));
            assert.ok(/You cannot publish one immediately/.test(surfaces));
        } else {
            // Email (chat-email-action.ts, 2026-10-21): the same confirm-card rule.
            assert.ok(/only that click changes anything/.test(surfaces), 'the email chat must say the user\'s click acts, not the chat');
            assert.ok(/never say an email HAS been approved, scheduled or sent back/.test(surfaces));
            assert.ok(/You cannot send one immediately/.test(surfaces));
        }
    });
}

check('the handler builds each snapshot scoped to this org and assistant and passes it in', () => {
    for (const fn of ['buildPostsSnapshot', 'buildBlogSnapshot', 'buildEmailsSnapshot']) {
        assert.ok(new RegExp(`${fn}\\(db, orgId, session\\.aiAssistantId`).test(orchestrator), `${fn} must be called with this org and assistant`);
    }
    assert.ok(/briefsSnapshot,\s*(?:siteAuditSnapshot,\s*)?(?:siteSnapshot,\s*)?contentSnapshot,/.test(orchestrator), 'the handler must pass contentSnapshot into buildRolePrompt');
});

console.log('\nThe snapshot text');

const item = (over: Partial<SnapshotItem>): SnapshotItem => ({
    when: new Date('2026-10-16T09:00:00Z'), where: 'LinkedIn', status: 'scheduled', text: 'Three ways to win back a lapsed customer', ...over,
});
const WORDS = { scheduled: 'booked', pending_approval: 'waiting for your approval', sent: 'sent' };

check('names the column, the place, the time and the wording', () => {
    const text = renderContentSnapshot({
        noun: 'posts', tab: 'Posts', stateWords: WORDS, timezone: 'Europe/London',
        sections: [
            { title: 'In the "Review" column', items: [item({ status: 'pending_approval', where: 'Instagram' })], total: 1 },
            { title: 'In the "Scheduled" column', items: [item({})], total: 1 },
            { title: 'In the "Needs attention" column', items: [], total: 0 },
        ],
    });
    assert.ok(text.includes('Fri 16 Oct, 10:00 · Instagram · waiting for your approval · "Three ways to win back a lapsed customer"'), text);
    assert.ok(text.includes('LinkedIn · booked'));
    assert.ok(text.includes('"Posts" tab'));
    assert.ok(/"Needs attention" column: none\./.test(text), 'an empty column must say none, not vanish');
});

check('a capped list says it is capped', () => {
    const text = renderContentSnapshot({
        noun: 'articles', tab: 'Blogs', stateWords: WORDS,
        sections: [{ title: 'In the "Review" column', items: [item({ where: '' })], total: 40 }],
    });
    assert.ok(text.includes('(40)'), 'the count must cover every item');
    assert.ok(text.includes('…and 39 more not listed here'));
});

check('an undated draft and an email\'s recipients read naturally', () => {
    const text = renderContentSnapshot({
        noun: 'emails', tab: 'Emails', stateWords: WORDS,
        sections: [{ title: 'Sent', items: [item({ when: null, where: '', status: 'sent', extra: 'sent to 412 people' })], total: 1 }],
    });
    assert.ok(text.includes('- no date yet · sent · "Three ways to win back a lapsed customer" · sent to 412 people'), text);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
