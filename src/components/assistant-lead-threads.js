/**
 * src/components/assistant-lead-threads.js
 * Conversations tab — the human-facing surface over Phase 2 of
 * docs/lead-generator-revenue-engine-plan.md (§5.1 threads, §5.2 sequences).
 *
 * The mockup calls this screen "Deal Thread". It is named Conversations here because the deal
 * half of that mockup — envelope, floor price, concession rounds, Closing Agent — is Phase 4 and
 * does not exist. Naming the tab after the part that isn't built would advertise a feature the
 * screen cannot show. What IS built, and what this renders:
 *
 *   • the exchange itself      lead_messages, outbound + inbound, in order
 *   • what a reply meant       classification / sentiment / objections, set by the classifier
 *   • what the human changed   generated_body vs body — the §2.6 edit, shown as a diff
 *   • what the cadence did     sequence_enrolments: step reached, next send, why it halted
 *
 * Backed by netlify/functions/lead-threads.ts:
 *   • list  → POST { action:'list',  assistantId, cursor? }
 *   • get   → POST { action:'get',   assistantId, threadId }
 *   • nudge → POST { action:'nudge', assistantId, threadId }              (send the next chase now)
 *   • stop  → POST { action:'stop_follow_ups', assistantId, threadId }    (stop the cadence)
 *
 * ── This tab is the END of the lead's life, and now says so ──────────────────
 * It used to be a read-only viewer with exactly one write on it, buried inside a conversation you
 * had to navigate away from the list to reach. Users arrived asking three questions it could not
 * answer — where do the chaser emails come from, how do I write a note, how do I record what
 * happened — and the honest answer to all three was "somewhere else, or nowhere". So:
 *
 *   • The chasers are explained where they happen (the cadence banner) and are now CONTROLLABLE:
 *     send the next one now, or stop them. Both go through the sequence worker's own helpers, so
 *     every safety gate (reply halt, suppression, daily cap, step ceiling) still applies.
 *   • Notes are written from here, via the shared LeadNotesModal — the same append-only field the
 *     Enrichment and Outreach tabs write.
 *   • The outcome is recorded from here, via the shared LeadOutcomeModal, and now from the LIST as
 *     well as from inside a conversation.
 *
 * ⚠️ Still not a writer of lead_threads / lead_messages. Those have exactly one owner
 * (src/utils/lead-threads.ts) and this screen must not become a second. The writes above touch
 * `sequence_enrolments` and the LEAD record's `data`, both through their own owners' helpers.
 *
 * ── Reading the list ─────────────────────────────────────────────────────────
 * Search / per-column filters / group-by / sort / paging, matching the Enrichment tab
 * (assistant-data-hub.js) control for control, because they are the same job on the same funnel and
 * two different answers to "how do I find the one I want?" is one answer too many. As there, every
 * control compares the RENDERED cell — the string in the column — which is the only definition that
 * cannot surprise anyone.
 *
 * ⚠️ Filtering is CLIENT-side over the whole set, so the whole set has to be here. load() drains
 * the server's cursor up to MAX_THREADS and says so if it hits the cap; a partially-loaded list
 * behind a filter reading "3" when the truth is 40 is the failure this avoids.
 *
 * Styling reuses classes already compiled into style.css (no Tailwind rebuild — see the drift note
 * in the project conventions). All server values are escaped on render; treat them as untrusted.
 */
(function () {
  const API = '/.netlify/functions/lead-threads';

  /**
   * How many conversations are held client-side.
   *
   * The controls compare every loaded row, so this is also the point past which the filters would
   * start quietly lying. Generous — threads are far lower-volume than leads (one per lead actually
   * emailed) — and the strip says so out loud on the accounts that reach it.
   */
  const MAX_THREADS = 1000;

  /** Rows per page. Matches the Enrichment tab, for the same reason: one row is one line. */
  const ROWS_PER_PAGE = 25;

  let state = {
    assistantId: null,
    threads: [],
    counts: { total: 0, open: 0, replied: 0, stalled: 0, closed: 0 },
    // The role's label for this tab, from the registry (conversationsTab.label). Held here rather
    // than read back off the button, because the button's text carries the record count once one
    // has landed and re-wrapping it would give "Conversations (12) (12)".
    tabLabel: 'Conversations',
    /** True when the drain stopped at MAX_THREADS rather than at the end of the list. */
    truncated: false,

    // How the list is being READ right now. Kept on `state` rather than in the DOM so a repaint
    // (after a nudge, a note, an outcome) cannot silently reset the user's view.
    view: { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1, collapsed: new Set() },

    // threadId → the loaded conversation { thread, messages, enrolment }, for rows expanded in
    // place. Cached so collapsing and re-opening a row is free, and so a repaint (which rebuilds
    // the table) does not have to refetch every open one.
    open: {},
    // threadId → true while its detail is in flight.
    loadingThread: {},
    // threadId → an error string from its last action, shown on the row.
    rowError: {},
    // threadId → true while a nudge/stop is in flight.
    busy: {},
    // threadId → a transient success line ("Chase sent."), cleared on the next action.
    rowNotice: {},

    showDiff: {},        // messageId → bool, for "show changes vs template"
    // threadId → the reply draft being typed, so a repaint (a note saved on the same row, a
    // background refresh) cannot discard half-written text. Kept out of the DOM for the same
    // reason state.view is: paintRows() rewrites every row.
    replyDraft: {},
    replySending: {},    // threadId → true while a reply is in flight
    replyError: {},      // threadId → why the last reply did not go (the draft is kept)
    replyNotice: {},     // threadId → "Sent to …", cleared on the next attempt
    // Set from the reply notification's deep link (window._assistantDetailFocusThreadId), consumed
    // once by paintRows so a later repaint cannot re-scroll the page.
    focusThreadId: null,
    loading: false,
    error: null,
    rendered: false,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const host = () => document.getElementById('lead-threads-host');

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code });
    return data;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  /** "3d ago" / "just now". Coarse on purpose — an exact timestamp is noise in a timeline. */
  function ago(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  /** Future-facing counterpart, for the next scheduled send. */
  function until(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.round((then - Date.now()) / 60000);
    if (mins <= 0) return 'due now';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.round(hours / 24)}d`;
  }

  const THREAD_CHIP = {
    open: 'bg-amber-50 text-amber-700 border-amber-200',
    replied: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    stalled: 'bg-gray-100 text-gray-500 border-gray-200',
    closed: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  const THREAD_LABEL = {
    open: 'Awaiting reply',
    replied: 'Replied',
    stalled: 'Stalled',
    closed: 'Closed',
  };

  // How the classifier's verdict on an inbound reply is shown. Mirrors the `classification`
  // vocabulary on lead_messages; an unknown value falls through to the raw string rather than
  // vanishing, so a newly-added class is visible rather than silently dropped.
  const CLASS_CHIP = {
    interested: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    not_now: 'bg-amber-50 text-amber-700 border-amber-200',
    objection: 'bg-amber-50 text-amber-800 border-amber-300',
    not_interested: 'bg-gray-100 text-gray-500 border-gray-200',
    unsubscribe: 'bg-red-50 text-red-700 border-red-200',
    ooo: 'bg-gray-100 text-gray-500 border-gray-200',
    other: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  const CLASS_LABEL = {
    interested: 'Interested',
    not_now: 'Not right now',
    objection: 'Objection',
    not_interested: 'Not interested',
    unsubscribe: 'Unsubscribed',
    ooo: 'Out of office',
    other: 'Other',
  };

  const chip = (cls, text) => `<span class="text-xs font-bold px-2 py-0.5 rounded-full border ${cls}">${esc(text)}</span>`;

  // ── Deal outcome ───────────────────────────────────────────────────────────
  // How the deal ENDED, which is a different axis from the thread state above it. A thread can be
  // 'replied' and the deal won, lost or still running; a thread can be 'stalled' and the deal won
  // on the phone. Neither column can be derived from the other, which is exactly why marking the
  // outcome has to be an explicit act rather than something inferred from the last message.
  const OUTCOME_CHIP = {
    won: 'bg-green-50 text-green-700 border-green-100',
    lost: 'bg-red-50 text-red-700 border-red-200',
    disqualified: 'bg-gray-100 text-gray-500 border-gray-200',
  };

  /** The recorded outcome's display label, via the generated vocabulary. Empty when unrecorded. */
  function outcomeLabel(outcome) {
    const RC = window.RevenueConstants;
    return (RC && outcome) ? RC.outcomeLabel(outcome) : '';
  }

  // ── The columns ────────────────────────────────────────────────────────────
  //
  // Declared as data, exactly like the Enrichment tab's hub.columns, because everything below —
  // the filter dropdowns, the group-by menu, the sort headings, the search haystack — is generic
  // over this list. Adding a column is one entry here and one case in cellValue().
  //
  // ⚠️ `key` is what state.view.filters / groupKey / sortKey hold. Renaming one silently drops any
  // view the user had; the labels are free to change.
  const COLUMNS = [
    { key: 'title', label: 'Lead' },
    { key: 'state', label: 'Status' },
    { key: 'classification', label: 'Their reply' },
    { key: 'outcome', label: 'Outcome' },
    { key: 'followUps', label: 'Follow-ups' },
    { key: 'messageCount', label: 'Messages' },
    { key: 'updatedAt', label: 'Last activity' },
  ];

  /**
   * The follow-up cadence as ONE word, which is what a column can hold.
   *
   * "Stopped" deliberately covers both a halt and a completed sequence for filtering purposes; the
   * REASON they differ is a sentence, and a sentence belongs in the expanded row, not in a cell.
   */
  function followUpState(t) {
    const s = t.sequence;
    if (!s) return 'None';
    if (s.state === 'active') return 'Running';
    if (s.state === 'completed') return 'Finished';
    if (s.haltReason === 'replied') return 'Stopped — they replied';
    return 'Stopped';
  }

  /**
   * The rendered string in one cell. THE definition every control compares against.
   *
   * Every branch returns a human string, never null and never a raw enum: a filter offering
   * "not_now" as an option would be the database leaking through the screen, and a blank option is
   * one nobody can reason about. "No reply yet" and "Not recorded" are real, distinct answers and
   * are the ones users most often want to filter TO.
   */
  function cellValue(t, key) {
    switch (key) {
      case 'title': return t.title || '';
      case 'state': return THREAD_LABEL[t.state] || t.state || '';
      case 'classification':
        return t.classification ? (CLASS_LABEL[t.classification] || t.classification) : 'No reply yet';
      case 'outcome':
        return (t.dealOutcome && t.dealOutcome.outcome)
          ? (outcomeLabel(t.dealOutcome.outcome) || t.dealOutcome.outcome)
          : 'Not recorded';
      case 'followUps': return followUpState(t);
      case 'messageCount': return String(t.messageCount ?? 0);
      case 'updatedAt': return ago(t.updatedAt);
      default: return '';
    }
  }

  /** Column values with a natural order the alphabet does not agree with. */
  const ORDERED_VALUES = {
    // The order of the funnel: what needs you, then what is alive, then what is over.
    state: ['Replied', 'Awaiting reply', 'Stalled', 'Closed'],
    // Warmest first — the point of the column is that "Interested" outranks "Not interested".
    classification: ['Interested', 'Objection', 'Not right now', 'Out of office', 'Other', 'No reply yet', 'Not interested', 'Unsubscribed'],
    outcome: ['Won', 'Lost', 'Disqualified', 'Not recorded'],
    followUps: ['Running', 'Stopped', 'Stopped — they replied', 'Finished', 'None'],
  };

  /** A comparable for one cell: time for dates, number for counts, rank for a vocabulary. */
  function sortValue(t, key) {
    // ⚠️ Sorts by the TIMESTAMP, never by the "3d ago" label. "3d ago" and "12h ago" compare as
    // strings to 1 < 3, which would put yesterday after last week.
    if (key === 'updatedAt') {
      const ms = new Date(t.updatedAt).getTime();
      return Number.isNaN(ms) ? -Infinity : ms;
    }
    if (key === 'messageCount') return Number(t.messageCount) || 0;
    const shown = cellValue(t, key);
    const ordered = ORDERED_VALUES[key];
    if (ordered) {
      const i = ordered.findIndex((v) => v.toLowerCase() === String(shown).toLowerCase());
      return i === -1 ? ordered.length : i;        // anything unrecognised sorts last, not first
    }
    return String(shown).toLowerCase();
  }

  function compareThreads(a, b, key, dir) {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    const out = (typeof av === 'number' && typeof bv === 'number')
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return dir === 'desc' ? -out : out;
  }

  /** Every distinct rendered value in a column, in the column's own order. */
  function distinctValues(key) {
    const seen = new Set();
    for (const t of state.threads) seen.add(cellValue(t, key));
    const ordered = ORDERED_VALUES[key];
    return [...seen].sort((x, y) => {
      if (!ordered) return x.localeCompare(y, undefined, { numeric: true });
      const rank = (v) => {
        const i = ordered.findIndex((o) => o.toLowerCase() === v.toLowerCase());
        return i === -1 ? ordered.length : i;
      };
      return rank(x) - rank(y) || x.localeCompare(y);
    });
  }

  /**
   * Which columns get a dropdown. Same rule as the Enrichment tab: a <select> beats the search box
   * only while the list is short enough to read, so the one-value-per-row columns (Lead, Last
   * activity) are covered by the search box instead.
   */
  const MAX_FILTER_OPTIONS = 20;
  /**
   * Columns that never get a dropdown, whatever their cardinality.
   *
   * `title` and `updatedAt` hold roughly one distinct value per row — a menu of those is a worse
   * search box, and the search box already covers them. `messageCount` is a CONTINUOUS quantity:
   * its dropdown offers "1, 2, 3, 4, 5" and asks the user to pick exactly one, which is a filter
   * nobody wants, and which then silently vanishes once an account has more than twenty distinct
   * message counts. Sorting is the control that serves it, and the heading is wired for that.
   */
  const NEVER_FILTERABLE = new Set(['title', 'updatedAt', 'messageCount']);

  function filterableColumns() {
    return COLUMNS.filter((c) => {
      if (NEVER_FILTERABLE.has(c.key)) return false;
      // A column currently being filtered on keeps its dropdown whatever the data has become —
      // otherwise clearing the last "Won" row takes the control away and leaves the filter running
      // invisibly, with no way to turn it off but Clear.
      if (state.view.filters[c.key]) return true;
      const n = distinctValues(c.key).length;
      return n >= 2 && n <= MAX_FILTER_OPTIONS;
    });
  }

  /** Does this thread survive the search box and every per-column dropdown? */
  function matchesView(t) {
    const v = state.view;
    const q = v.search.trim().toLowerCase();
    if (q) {
      // The email address is in the haystack but not in a column — searching for a domain is one
      // of the two things anyone actually types here.
      const hay = [...COLUMNS.map((c) => cellValue(t, c.key)), t.contactEmail || '', t.lastExcerpt || '']
        .join('  ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    for (const [key, wanted] of Object.entries(v.filters)) {
      if (!wanted) continue;
      if (cellValue(t, key) !== wanted) return false;
    }
    return true;
  }

  function visibleThreads() {
    const list = state.threads.filter(matchesView);
    if (state.view.sortKey) list.sort((a, b) => compareThreads(a, b, state.view.sortKey, state.view.sortDir));
    return list;
  }

  /** Group the visible rows, or return one unlabelled group. Group order follows the column's own. */
  function groupVisible(list) {
    const key = state.view.groupKey;
    if (!key) return [{ label: null, threads: list }];
    const groups = new Map();
    for (const t of list) {
      const label = cellValue(t, key);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(t);
    }
    const vocab = ORDERED_VALUES[key];
    const ordered = [...groups.keys()].sort((x, y) => {
      if (!vocab) return x.localeCompare(y, undefined, { numeric: true });
      const rank = (v) => {
        const i = vocab.findIndex((o) => o.toLowerCase() === v.toLowerCase());
        return i === -1 ? vocab.length : i;
      };
      return rank(x) - rank(y) || x.localeCompare(y);
    });
    return ordered.map((label) => ({ label, threads: groups.get(label) }));
  }

  function pagedThreads(list) {
    return window.ListPager
      ? window.ListPager.page(list, state.view.page, ROWS_PER_PAGE)
      : { items: list, page: 1, pages: 1, total: list.length };
  }

  function resetPage() { state.view.page = 1; }

  // ── Row + expanded conversation ────────────────────────────────────────────

  function cellHtml(t, key) {
    const text = cellValue(t, key);
    switch (key) {
      case 'state':
        return chip(THREAD_CHIP[t.state] || THREAD_CHIP.closed, text);
      case 'classification':
        return t.classification
          ? chip(CLASS_CHIP[t.classification] || CLASS_CHIP.other, text)
          : '<span class="text-xs text-gray-400">No reply yet</span>';
      case 'outcome':
        return (t.dealOutcome && t.dealOutcome.outcome)
          ? chip(OUTCOME_CHIP[t.dealOutcome.outcome] || OUTCOME_CHIP.disqualified, text)
          : '<span class="text-xs text-gray-400">Not recorded</span>';
      case 'followUps': {
        // Amber only for a cadence stopped by something that isn't a reply — that is the one state
        // on this column a user may need to do something about.
        const s = t.sequence;
        const needsEye = s && s.state === 'halted' && s.haltReason !== 'replied';
        return `<span class="text-xs ${needsEye ? 'font-bold text-amber-700' : 'text-gray-600'}">${esc(text)}</span>`;
      }
      case 'title':
        return `<span class="font-semibold text-gray-900">${esc(text)}</span>${
          t.contactEmail ? `<span class="block text-xs text-gray-400">${esc(t.contactEmail)}</span>` : ''}`;
      default:
        return `<span class="text-xs text-gray-600">${esc(text)}</span>`;
    }
  }

  function rowHtml(t) {
    return `${COLUMNS.map((c, i) => `<td class="px-4 py-3 align-top ${i === 0 ? '' : 'whitespace-nowrap'}">${cellHtml(t, c.key)}</td>`).join('')}
      <td class="px-4 py-3 text-right align-top">
        <svg class="w-4 h-4 text-gray-400 inline transition-transform" data-lt-chevron fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      </td>`;
  }

  // ── The diff (§2.6) ────────────────────────────────────────────────────────
  //
  // Word-level LCS of the agent's draft against what actually went out. Two things make the output
  // readable rather than confetti:
  //   • Consecutive same-type tokens are COALESCED into one span. Per-word spans turn a rewritten
  //     sentence into alternating red/green fragments with no word boundaries left to read.
  //   • Additions use green-*, not emerald-*. input.css remaps the emerald scale to the brand's
  //     neon pink, which lands close enough to the red deletions that the two stop being
  //     distinguishable — the one thing a diff has to get right.
  // Both sides are escaped before any markup is added.
  const DIFF_STYLE = {
    del: 'bg-red-50 text-red-700 line-through',
    ins: 'bg-green-50 text-green-700',
  };

  /**
   * A common run this short between two edits is noise, not a match.
   *
   * Raw LCS latches onto filler — "venues", "in the", "a" — and shreds a rewritten sentence into
   * alternating red/green fragments that nobody can read as either the old wording or the new one.
   * Six characters is the point where the common run stops being incidental.
   */
  const SHORT_SAME_CHARS = 6;

  /**
   * Collapse each region of change into ONE removal followed by ONE addition.
   *
   * This is what diff-match-patch calls semantic cleanup, and the reason every readable diff does
   * it: the useful unit is "here is the phrase that was there, here is the phrase that replaced
   * it", not a token-by-token account of how the algorithm got from one to the other.
   */
  function coalesceRegions(ops) {
    const isChange = (o) => o.kind !== 'same';
    const out = [];
    let k = 0;
    while (k < ops.length) {
      if (!isChange(ops[k])) { out.push(ops[k]); k++; continue; }

      // Extend through changes, and through short common runs that have another change after them.
      let end = k, lastChange = k;
      while (end < ops.length) {
        if (isChange(ops[end])) { lastChange = end; end++; }
        else if (ops[end].text.trim().length <= SHORT_SAME_CHARS
          && end + 1 < ops.length && isChange(ops[end + 1])) { end++; }
        else break;
      }

      // A common run inside the region belongs to BOTH sides — it was there before and after.
      let oldText = '', newText = '';
      for (const o of ops.slice(k, lastChange + 1)) {
        if (o.kind !== 'ins') oldText += o.text;
        if (o.kind !== 'del') newText += o.text;
      }
      if (oldText.trim()) out.push({ kind: 'del', text: oldText });
      if (newText.trim()) out.push({ kind: 'ins', text: newText });
      k = lastChange + 1;
    }
    return out;
  }

  function diffWords(before, after) {
    // Keep the separators as tokens so whitespace survives the round trip intact.
    const a = String(before || '').split(/(\s+)/);
    const b = String(after || '').split(/(\s+)/);
    const n = a.length, m = b.length;

    // Standard LCS table, bounded by message length — the sender caps that well below anything
    // that would make this expensive.
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    // Walk the table into runs first, render second.
    const runs = [];
    const push = (kind, text) => {
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) last.text += text;
      else runs.push({ kind, text });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) { push('del', a[i]); i++; }
    while (j < m) { push('ins', b[j]); j++; }

    const cleaned = coalesceRegions(runs);
    return cleaned.map((r, idx) => {
      if (r.kind === 'same') return esc(r.text);
      // A removal butted straight against its replacement reads as one run-on word ("UK.Grade").
      // The gap is presentational — it belongs to neither side's text.
      const gap = (r.kind === 'ins' && cleaned[idx - 1] && cleaned[idx - 1].kind === 'del') ? ' ' : '';
      // Trailing whitespace inside a highlighted run paints a stray coloured gap against the next
      // word, so it is lifted out of the span rather than filled.
      const trail = (/\s+$/.exec(r.text) || [''])[0];
      return `${gap}<span class="${DIFF_STYLE[r.kind]}">${esc(r.text.replace(/\s+$/, ''))}</span>${esc(trail)}`;
    }).join('');
  }

  function messageItem(m) {
    const inbound = m.direction === 'inbound';
    const showDiff = !!state.showDiff[m.id];
    const objections = Array.isArray(m.objections) ? m.objections : [];

    const bodyHtml = (m.edited && showDiff)
      ? diffWords(m.generatedBody, m.body)
      : esc(m.body);

    return `
      <div class="p-4 border-b border-gray-100 ${inbound ? 'bg-emerald-50' : ''}">
        <div class="flex flex-wrap items-center gap-2 mb-1">
          ${chip(inbound ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-gray-100 text-gray-600 border-gray-200',
            inbound ? 'Reply received' : 'Sent by your assistant')}
          ${m.classification ? chip(CLASS_CHIP[m.classification] || CLASS_CHIP.other, CLASS_LABEL[m.classification] || m.classification) : ''}
          ${m.edited ? chip('bg-amber-50 text-amber-700 border-amber-200', 'Edited before sending') : ''}
          <span class="text-xs text-gray-400">${esc(ago(m.occurredAt))}</span>
          ${m.edited ? `
            <label class="ml-auto flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" data-lt-diff="${m.id}" ${showDiff ? 'checked' : ''} class="cursor-pointer">
              Show changes vs the draft
            </label>` : ''}
        </div>
        ${m.subject ? `<p class="text-sm font-semibold text-gray-900">${esc(m.subject)}</p>` : ''}
        ${m.fromEmail ? `<p class="text-xs text-gray-400 mt-0.5">${inbound ? 'From' : 'To'} ${esc(m.fromEmail)}</p>` : ''}
        <p class="text-sm text-gray-700 mt-2 whitespace-pre-wrap">${bodyHtml}</p>
        ${objections.length ? `<p class="text-xs text-amber-800 mt-2">Objections raised: ${objections.map((o) => esc(o)).join(', ')}</p>` : ''}
        ${m.edited && m.editedByName ? `<p class="text-xs text-gray-400 mt-2">Edited by ${esc(m.editedByName)} before sending.</p>` : ''}
      </div>`;
  }

  /**
   * The cadence banner: what the follow-up engine is doing, or why it stopped — and WHERE IT COMES
   * FROM, which is the question this tab was actually generating.
   *
   * "Where do chaser emails get sent from?" had no answer anywhere in the product: the sequence
   * worker drafted and sent them from the user's own connected mailbox on an hourly cron, and the
   * only evidence was the emails appearing. Saying it plainly, on the screen where they appear, is
   * most of the fix; the buttons beside it are the rest.
   */
  function cadenceBanner(t, e) {
    const busy = !!state.busy[t.id];
    const btn = 'px-2.5 py-1 text-xs font-bold rounded-lg border transition disabled:opacity-50';

    const provenance = `<p class="text-[11px] text-gray-500 mt-1">
      Your assistant writes each chaser in the context of this conversation and sends it from your own connected mailbox.
      It stops the moment they reply.</p>`;

    if (!e) {
      return `<div class="p-4 border-b border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-600"><span class="font-bold">No follow-ups on this one.</span>
          The opening email went out, but no chase sequence was started — so nothing further goes out on its own. Write the next message yourself below.</p>
      </div>`;
    }

    if (e.state === 'active') {
      return `<div class="p-4 border-b border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-600">
          <span class="font-bold">Follow-ups running.</span>
          ${e.lastStepSent > 0 ? `Chase ${esc(e.lastStepSent)} sent.` : 'Opening email sent.'}
          ${e.nextSendAt ? `Next one ${esc(until(e.nextSendAt))}.` : ''}
        </p>
        ${provenance}
        <div class="flex flex-wrap gap-2 mt-2">
          <button type="button" data-lt-nudge="${t.id}" ${busy ? 'disabled' : ''}
            class="${btn} bg-white border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800">
            ${busy ? 'Sending…' : 'Send the next one now'}</button>
          <button type="button" data-lt-stop="${t.id}" ${busy ? 'disabled' : ''}
            class="${btn} bg-white border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-700">Stop follow-ups</button>
        </div>
      </div>`;
    }

    // 'replied' is the success case and reads as good news; every other halt is something the user
    // may need to act on, so it gets the amber treatment.
    const good = e.haltReason === 'replied' || e.state === 'completed';
    return `<div class="p-4 border-b border-gray-100 ${good ? 'bg-emerald-50' : 'bg-amber-50'}">
      <p class="text-xs ${good ? 'text-emerald-800' : 'text-amber-800'}">
        <span class="font-bold">Follow-ups stopped.</span>
        ${esc(e.haltReasonLabel || (e.state === 'completed' ? 'The sequence finished.' : 'The sequence is no longer running.'))}
      </p>
      ${e.lastError ? `<p class="text-xs text-gray-500 mt-1">Last error: ${esc(e.lastError)}</p>` : ''}
      <p class="text-[11px] ${good ? 'text-emerald-700' : 'text-amber-700'} mt-1">
        Nothing further will be sent automatically — from here the conversation is yours. Reply below and it goes from your own mailbox, into this thread.</p>
    </div>`;
  }

  /**
   * The action bar for one conversation — the answer to "how do I move this along?".
   *
   * All three buttons write to the LEAD record or its enrolment, never to the thread. Two of them
   * (note, outcome) reuse the shared modals the Enrichment and Outreach tabs use, so the same lead
   * has one notes field and one outcome however you reached it.
   *
   * ⚠️ Gated on `assistantRecordId`. Both modals are keyed by the LEAD record, and a thread can
   * outlive one — the FK is ON DELETE SET NULL, so a lead deleted after the conversation started
   * leaves the thread behind. Offering the buttons there would open forms whose save can only 404.
   */
  function actionBar(t) {
    const recorded = t.dealOutcome && t.dealOutcome.outcome ? t.dealOutcome : null;
    const label = recorded ? outcomeLabel(recorded.outcome) : '';
    const RC = window.RevenueConstants;

    if (!t.assistantRecordId) {
      return `<div class="p-4 border-b border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-500">The lead this conversation belongs to has been deleted, so there is nothing left to record against it.</p>
      </div>`;
    }

    // The reason line under a loss is the whole point of the closed vocabulary — it is what makes
    // "why are we losing?" answerable — so it is shown rather than left inside the form.
    const detail = recorded
      ? [
          recorded.lossReason && RC ? RC.lossReasonLabel(recorded.lossReason) : '',
          recorded.valueGbp != null && recorded.valueGbp !== '' ? `£${esc(recorded.valueGbp)}` : '',
        ].filter(Boolean).join(' · ')
      : '';

    const btn = 'px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 text-xs font-bold rounded-lg transition';
    const noteCount = String(t.notes || '').trim() ? 'Notes' : 'Add a note';

    return `
      <div class="p-4 border-b border-gray-100">
        <div class="flex flex-wrap items-center gap-2">
          ${recorded
            ? `${chip(OUTCOME_CHIP[recorded.outcome] || OUTCOME_CHIP.disqualified, label)}
               ${detail ? `<span class="text-xs text-gray-500">${detail}</span>` : ''}`
            : '<p class="text-xs text-gray-500">No outcome recorded yet — mark it when this deal is done, either way.</p>'}
          <span class="ml-auto flex flex-wrap gap-2">
            <button type="button" data-lt-note="${t.id}" class="${btn}">${noteCount}</button>
            <button type="button" data-lt-outcome="${t.id}" class="${btn}">${recorded ? 'Change outcome' : 'Record outcome'}</button>
          </span>
        </div>
        ${String(t.notes || '').trim() ? `
          <p class="mt-2 text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 border border-gray-100 rounded-lg p-2 max-h-32 overflow-y-auto">${esc(t.notes)}</p>` : ''}
        ${state.rowNotice[t.id] ? `<p class="mt-2 text-xs font-bold text-green-700">${esc(state.rowNotice[t.id])}</p>` : ''}
        ${state.rowError[t.id] ? `<p class="mt-2 text-xs font-bold text-amber-700">${esc(state.rowError[t.id])}</p>` : ''}
      </div>`;
  }

  /** Everything inside an expanded row. */
  function detailHtml(t) {
    if (state.loadingThread[t.id]) {
      return '<div class="p-6 text-center text-xs text-gray-500">Loading this conversation…</div>';
    }
    const loaded = state.open[t.id];
    if (!loaded) {
      return `<div class="p-6 text-center">
        <p class="text-xs text-gray-500">${esc(state.rowError[t.id] || 'Could not open this conversation.')}</p>
        <button type="button" data-lt-reopen="${t.id}" class="mt-2 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Try again</button>
      </div>`;
    }
    const { messages, enrolment } = loaded;
    return `
      ${actionBar(t)}
      ${cadenceBanner(t, enrolment)}
      ${messages.length
        ? messages.map(messageItem).join('')
        : `<div class="p-6 text-center">
             <p class="text-sm font-semibold text-gray-900">Nothing recorded on this conversation</p>
             <p class="text-xs text-gray-500 mt-1">The thread exists but no message was written to it &mdash; check the function logs for lead-threads warnings.</p>
           </div>`}
      ${composer(t, loaded)}`;
  }

  /**
   * Write and send a reply, in the thread.
   *
   * ── Why this is here at all ────────────────────────────────────────────────
   * Until this shipped, the warmest lead in the pipeline was the one thing the product could not act
   * on: a prospect's reply could be read here and answered only from the user's own inbox, outside
   * the thread — so the transcript ended at "they replied", the next chaser was drafted with no idea
   * what the human had already said, and the tab's own copy had to tell people to go elsewhere.
   *
   * ⚠️ Deliberately NOT a drafting surface. There is no "write it for me" button: the whole reason a
   * reply needs a human is that the prospect asked something specific, and a model answer to a real
   * question from a real stranger is the highest-risk message this system could send. The assistant
   * writes cold openers and chasers, where the content is ours; a reply is a conversation.
   *
   * The draft lives in state.replyDraft, not in the DOM — paintRows() rewrites every row on any
   * repaint (a note saved, a nudge sent, the list refreshed), and half-typed text must survive that.
   */
  function composer(t, loaded) {
    const sending = !!state.replySending[t.id];
    const draft = state.replyDraft[t.id] || '';
    const to = loaded.thread && loaded.thread.contactEmail;

    // No address, nothing to reply to. Says which of the two it is rather than showing a box whose
    // Send can only fail.
    if (!to) {
      return `<div class="p-4 border-t border-gray-100 bg-gray-50">
        <p class="text-xs text-gray-500">No email address is recorded on this conversation, so there is nothing to reply to.</p>
      </div>`;
    }

    const notice = state.replyNotice && state.replyNotice[t.id];
    const err = state.replyError && state.replyError[t.id];

    return `<div class="p-4 border-t border-gray-100 bg-gray-50">
      <div class="flex items-baseline justify-between gap-3 flex-wrap">
        <p class="text-xs font-bold text-gray-700">Reply to ${esc(to)}</p>
        <p class="text-[11px] text-gray-400">Sent from your connected mailbox. Their answer comes back here.</p>
      </div>
      <textarea data-lt-reply="${t.id}" rows="4" maxlength="8000" ${sending ? 'disabled' : ''}
        placeholder="Write your reply&hellip;"
        class="mt-2 w-full border border-gray-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 outline-none transition disabled:opacity-60">${esc(draft)}</textarea>
      <div class="flex items-center gap-2 mt-2 flex-wrap">
        <button type="button" data-lt-send-reply="${t.id}" ${sending || !draft.trim() ? 'disabled' : ''}
          class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">
          ${sending ? 'Sending&hellip;' : 'Send reply'}</button>
        <span class="text-[11px] text-gray-400">Your opt-out footer and postal address are added automatically.</span>
      </div>
      ${err ? `<p class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">${esc(err)}</p>` : ''}
      ${notice ? `<p class="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">${esc(notice)}</p>` : ''}
    </div>`;
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  /**
   * The search / filter / group strip.
   *
   * ⚠️ Rendered by render() and re-rendered whenever the strip's own contents must change. The
   * search box lives in here, so paintRows() deliberately does NOT touch it — rebuilding this
   * markup on every keystroke would blow away the input the user is typing into and take the caret
   * with it.
   */
  function controlsHtml() {
    const v = state.view;
    const selectCls = 'px-2 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg bg-white text-gray-700 cursor-pointer focus:outline-none focus:border-emerald-400';

    // ⚠️ The chosen value is unioned in even when nothing has it any more. Filter to "Won", change
    // that outcome, and the option disappears — the select then shows "All" while state.view.filters
    // is still filtering, so the strip would say one thing above a table doing another.
    const filters = filterableColumns().map((c) => {
      const chosen = v.filters[c.key];
      const options = distinctValues(c.key);
      if (chosen && !options.includes(chosen)) options.push(chosen);
      return `
      <label class="inline-flex items-center gap-1.5">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">${esc(c.label)}</span>
        <select data-lt-filter="${esc(c.key)}" class="${selectCls}">
          <option value="">All</option>
          ${options.map((val) => `<option value="${esc(val)}"${chosen === val ? ' selected' : ''}>${esc(val)}</option>`).join('')}
        </select>
      </label>`;
    }).join('');

    return `
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <input type="search" data-lt-search value="${esc(v.search)}"
          placeholder="Search conversations…"
          class="px-3 py-1.5 text-sm border border-gray-200 rounded-lg w-full sm:w-64 focus:outline-none focus:border-emerald-400">
        ${filters}
        <label class="inline-flex items-center gap-1.5">
          <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">Group by</span>
          <select data-lt-group class="${selectCls}">
            <option value="">Nothing</option>
            ${COLUMNS.map((c) => `<option value="${esc(c.key)}"${v.groupKey === c.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </label>
        <span class="text-xs text-gray-500 ml-auto" data-lt-count></span>
        <button type="button" data-lt-clear
          class="text-xs font-bold text-gray-500 hover:text-gray-800 underline cursor-pointer">Clear</button>
      </div>`;
  }

  // ── List view ──────────────────────────────────────────────────────────────

  function listView() {
    const c = state.counts;
    const v = state.view;
    const arrow = (key) => (v.sortKey === key ? (v.sortDir === 'asc' ? ' ↑' : ' ↓') : '');

    if (!state.threads.length) {
      return `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <p class="text-sm font-semibold text-gray-900">No conversations yet</p>
          <p class="text-xs text-gray-500 mt-1 max-w-md mx-auto">Approve a lead on the Outreach tab and the email it sends starts a conversation here &mdash;
            along with every chaser your assistant sends and anything the prospect writes back. This is where a lead finishes its life: you record the outcome here.</p>
        </div>`;
    }

    return `
      <div class="mb-4">
        <p class="text-sm text-gray-600">
          Every prospect your assistant has emailed, and what happened next. Chasers are written and sent from your own connected mailbox
          and stop the moment someone replies &mdash; open a conversation to reply in your own words, send the next chaser early, stop them,
          add a note, or record how the deal ended.
        </p>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        ${[['Conversations', c.total], ['Awaiting reply', c.open], ['Replied', c.replied], ['Stalled', c.stalled]]
          .map(([label, n]) => `
          <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
            <p class="text-2xl font-bold text-gray-900">${n}</p>
            <p class="text-xs text-gray-500 mt-0.5">${label}</p>
          </div>`).join('')}
      </div>

      ${state.truncated ? `
      <div class="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
        <p class="text-xs text-amber-800">Showing your ${state.threads.length} most recent conversations. The filters below search those, not the full history.</p>
      </div>` : ''}

      ${controlsHtml()}

      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                ${COLUMNS.map((col) => `
                  <th class="px-4 py-3">
                    <button type="button" data-lt-sort="${esc(col.key)}" class="uppercase tracking-wider hover:text-gray-900 cursor-pointer transition-colors">${esc(col.label)}${arrow(col.key)}</button>
                  </th>`).join('')}
                <th class="px-4 py-3 w-8"><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody data-lt-tbody></tbody>
          </table>
        </div>
      </div>
      <div class="mt-3" data-lt-pager></div>`;
  }

  /**
   * Repaint the rows for the current view. Cheap enough to run on every keystroke, and deliberately
   * does NOT touch the controls above it (see controlsHtml).
   */
  function paintRows() {
    const h = host();
    const tbody = h && h.querySelector('[data-lt-tbody]');
    if (!tbody) return;
    const list = visibleThreads();
    const span = COLUMNS.length + 1;

    tbody.innerHTML = '';
    if (!list.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${span}" class="px-4 py-8 text-center text-sm text-gray-500">
        Nothing matches these filters. <button type="button" data-lt-clear-inline class="font-bold text-emerald-700 underline cursor-pointer">Clear them</button> to see all ${state.threads.length}.
      </td>`;
      tr.querySelector('[data-lt-clear-inline]').addEventListener('click', () => h.querySelector('[data-lt-clear]')?.click());
      tbody.appendChild(tr);
    }

    // One page of the filtered list, THEN grouped — never the reverse. Grouping the page keeps the
    // headings honest ("Replied · 12" counts the twelve on screen); paging each group separately
    // would give every group its own page and no way to say which page you are on.
    const pg = pagedThreads(list);
    for (const group of groupVisible(pg.items)) {
      // A group is FOLDED by its LABEL, not its index — it has to stay shut when a sort reorders
      // it, when a filter shrinks it, and when the tab refetches.
      const collapsed = group.label !== null && state.view.collapsed.has(group.label);
      if (group.label !== null) {
        const head = document.createElement('tr');
        head.className = 'bg-gray-50';
        // The whole heading is the control, not a small chevron beside it. The chevron SWAPS PATH
        // rather than rotating — the compiled stylesheet has `rotate-90` but no `-rotate-90`, and a
        // chevron that turned the wrong way would point at the row above.
        const chevron = collapsed ? 'M9 5l7 7-7 7' : 'M19 9l-7 7-7-7';
        head.innerHTML = `<td colspan="${span}" class="p-0">
          <button type="button" data-lt-group-toggle aria-expanded="${collapsed ? 'false' : 'true'}"
            class="w-full flex items-center gap-2 px-4 py-2 text-left cursor-pointer hover:bg-gray-100 transition-colors">
            <svg class="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${chevron}"/></svg>
            <span class="text-xs font-bold text-gray-600 uppercase tracking-wide">${esc(group.label)} <span class="text-gray-400 normal-case">· ${group.threads.length}</span></span>
          </button>
        </td>`;
        head.querySelector('[data-lt-group-toggle]').addEventListener('click', () => {
          if (state.view.collapsed.has(group.label)) state.view.collapsed.delete(group.label);
          else state.view.collapsed.add(group.label);
          // Repaint rather than hiding rows in place: each row carries a sibling <tr> holding its
          // detail panel, and toggling two <tr>s per row by hand is how one of them ends up
          // visible on its own.
          paintRows();
        });
        tbody.appendChild(head);
      }
      // Folded rows are not rendered at all. The count in the heading and the "N of M" above the
      // table keep counting the whole filtered set — folding changes what is drawn, never what is
      // filtered or paged.
      if (collapsed) continue;

      for (const t of group.threads) {
        const tr = document.createElement('tr');
        tr.className = 'cursor-pointer hover:bg-gray-50 transition-colors';
        tr.setAttribute('data-lt-row', String(t.id));
        tr.innerHTML = rowHtml(t);

        const detailTr = document.createElement('tr');
        const wasOpen = !!(state.open[t.id] || state.loadingThread[t.id]);
        detailTr.className = wasOpen ? '' : 'hidden';
        detailTr.setAttribute('data-lt-detail', String(t.id));
        const td = document.createElement('td');
        td.colSpan = span;
        td.className = 'p-0 border-t border-gray-100 bg-white';
        detailTr.appendChild(td);
        // A row already open before this repaint stays open — a repaint happens after every note,
        // outcome and nudge, and collapsing the row the user just acted on would hide the result.
        if (wasOpen) { td.innerHTML = detailHtml(t); wireDetail(td, t); }

        const chev = tr.querySelector('[data-lt-chevron]');
        if (wasOpen && chev) chev.classList.add('rotate-180');

        tr.addEventListener('click', () => toggleRow(t, tr, detailTr, td));

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);

        // Deep link from the "a prospect replied" notification (notifications.js sets the global).
        // Consumed once — a repaint after a note or a nudge must not yank the page back here, and the
        // row stays open on its own from state.open after the first pass.
        if (state.focusThreadId === t.id) {
          state.focusThreadId = null;
          if (!wasOpen) toggleRow(t, tr, detailTr, td);
          // After the row's own paint, or the browser scrolls to a collapsed row and the panel
          // opens below the fold.
          setTimeout(() => tr.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
        }
      }
    }

    const count = h.querySelector('[data-lt-count]');
    if (count) {
      // The FILTER's number, not the page's — "25 of 400" beside a filter that matched 137 would
      // read as the filter having matched 25.
      count.textContent = list.length === state.threads.length
        ? `${state.threads.length} ${state.threads.length === 1 ? 'conversation' : 'conversations'}`
        : `${list.length} of ${state.threads.length}`;
    }

    const pager = h.querySelector('[data-lt-pager]');
    if (pager) {
      state.view.page = pg.page || 1;             // clamped: the list may have shrunk under us
      pager.innerHTML = window.ListPager
        ? window.ListPager.controlsHtml(pg, { attr: 'data-lt-page', noun: 'conversations' })
        : '';
    }
  }

  /** Open or close one row, loading its conversation the first time. */
  async function toggleRow(t, tr, detailTr, td) {
    const isOpen = !detailTr.classList.contains('hidden');
    const chev = tr.querySelector('[data-lt-chevron]');
    if (isOpen) {
      detailTr.classList.add('hidden');
      chev?.classList.remove('rotate-180');
      // The loaded conversation is KEPT in state.open — closing a row should not cost a refetch
      // when the user opens it again a second later.
      return;
    }
    detailTr.classList.remove('hidden');
    chev?.classList.add('rotate-180');

    if (!state.open[t.id]) {
      state.loadingThread[t.id] = true;
      td.innerHTML = detailHtml(t);
      try {
        const data = await call('get', { threadId: t.id });
        state.open[t.id] = { thread: data.thread, messages: data.messages || [], enrolment: data.enrolment || null };
        // The list row is the summary; the fetched thread is authoritative. Copy the two fields the
        // row renders from the record so the collapsed row cannot disagree with what is open above it.
        if (data.thread) {
          t.dealOutcome = data.thread.dealOutcome || t.dealOutcome;
          t.notes = data.thread.notes ?? t.notes;
        }
        delete state.rowError[t.id];
      } catch (err) {
        state.rowError[t.id] = err.message || 'Could not open that conversation.';
      } finally {
        delete state.loadingThread[t.id];
      }
    }
    td.innerHTML = detailHtml(t);
    wireDetail(td, t);
  }

  /** Repaint ONE open row's detail in place, without disturbing the rest of the table. */
  function repaintDetail(t) {
    const h = host();
    const td = h && h.querySelector(`[data-lt-detail="${t.id}"] td`);
    if (!td) { paintRows(); return; }
    td.innerHTML = detailHtml(t);
    wireDetail(td, t);
    // The row's own cells carry the outcome chip, so they move too.
    const tr = h.querySelector(`[data-lt-row="${t.id}"]`);
    if (tr) {
      tr.innerHTML = rowHtml(t);
      tr.querySelector('[data-lt-chevron]')?.classList.add('rotate-180');
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function wireDetail(td, t) {
    // ⚠️ stopPropagation on every control in here. The whole ROW is a click target that toggles the
    // panel, so without this, pressing "Record outcome" opens the modal and collapses the row it
    // was opened from.
    td.querySelectorAll('button, input, label, select, textarea').forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation());
    });

    td.querySelectorAll('[data-lt-diff]').forEach((box) => box.addEventListener('change', (e) => {
      e.stopPropagation();
      state.showDiff[box.getAttribute('data-lt-diff')] = box.checked;
      repaintDetail(t);
    }));

    td.querySelector('[data-lt-reopen]')?.addEventListener('click', async () => {
      delete state.rowError[t.id];
      state.loadingThread[t.id] = true;
      repaintDetail(t);
      try {
        const data = await call('get', { threadId: t.id });
        state.open[t.id] = { thread: data.thread, messages: data.messages || [], enrolment: data.enrolment || null };
      } catch (err) {
        state.rowError[t.id] = err.message || 'Could not open that conversation.';
      } finally {
        delete state.loadingThread[t.id];
        repaintDetail(t);
      }
    });

    td.querySelector('[data-lt-note]')?.addEventListener('click', () => {
      if (!t.assistantRecordId) return;
      window.LeadNotesModal?.open({
        assistantId: state.assistantId,
        recordId: t.assistantRecordId,
        title: t.title,
        existing: t.notes || '',
        // Patched in place rather than refetched: the save has already told us what was stored, and
        // a refetch would rebuild the table and scroll the user away from what they were reading.
        onSaved: (notes) => {
          t.notes = notes;
          if (state.open[t.id]?.thread) state.open[t.id].thread.notes = notes;
          state.rowNotice[t.id] = 'Note saved.';
          repaintDetail(t);
        },
      });
    });

    td.querySelector('[data-lt-outcome]')?.addEventListener('click', () => {
      if (!t.assistantRecordId) return;
      window.LeadOutcomeModal?.open({
        assistantId: state.assistantId,
        recordId: t.assistantRecordId,
        title: t.title,
        existing: t.dealOutcome || null,
        onSaved: (dealOutcome) => {
          t.dealOutcome = dealOutcome;
          if (state.open[t.id]?.thread) state.open[t.id].thread.dealOutcome = dealOutcome;
          state.rowNotice[t.id] = 'Outcome recorded.';
          repaintDetail(t);
        },
      });
    });

    // ── Reply composer ──────────────────────────────────────────────────────
    // `input` rather than `change`: the Send button is disabled while the box is empty, so it has to
    // enable as the first character is typed, not when focus leaves. Toggled directly rather than by
    // repainting — a repaint per keystroke would take the caret with it.
    const replyBox = td.querySelector('[data-lt-reply]');
    if (replyBox) {
      replyBox.addEventListener('input', (e) => {
        e.stopPropagation();
        state.replyDraft[t.id] = replyBox.value;
        const send = td.querySelector('[data-lt-send-reply]');
        if (send) send.disabled = !replyBox.value.trim() || !!state.replySending[t.id];
      });
      // Cmd/Ctrl+Enter sends. A plain Enter must stay a newline — this is a paragraph of prose to a
      // stranger, and a send-on-Enter box would fire off half-written sentences.
      replyBox.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendReply(t); }
      });
    }
    td.querySelector('[data-lt-send-reply]')?.addEventListener('click', () => sendReply(t));

    td.querySelector('[data-lt-nudge]')?.addEventListener('click', () => runCadenceAction(t, 'nudge'));
    td.querySelector('[data-lt-stop]')?.addEventListener('click', () => runCadenceAction(t, 'stop_follow_ups'));
  }

  /**
   * Send the next chaser now, or stop the cadence.
   *
   * ⚠️ Reports what actually happened, not what was asked for. The nudge runs the sequence worker
   * inline, and that worker can legitimately decline the send — the org's daily ceiling, a
   * suppression hit, the step ceiling, a reply that landed a second ago. A button that always said
   * "Sent!" would be lying on exactly the occasions it matters.
   */
  async function runCadenceAction(t, action) {
    if (state.busy[t.id]) return;
    state.busy[t.id] = true;
    delete state.rowError[t.id];
    delete state.rowNotice[t.id];
    repaintDetail(t);
    try {
      const data = await call(action, { threadId: t.id });
      if (state.open[t.id]) state.open[t.id].enrolment = data.enrolment || null;
      // The list row's Follow-ups cell reads from `t.sequence`, so it has to move too.
      t.sequence = data.enrolment || t.sequence;
      if (action === 'stop_follow_ups') {
        state.rowNotice[t.id] = 'Follow-ups stopped. Nothing further will be sent automatically.';
      } else if (data.sent) {
        state.rowNotice[t.id] = 'Chase sent from your mailbox.';
        // The new message is only in the database — refetch this one conversation so it appears.
        try {
          const fresh = await call('get', { threadId: t.id });
          state.open[t.id] = { thread: fresh.thread, messages: fresh.messages || [], enrolment: fresh.enrolment || null };
        } catch { /* the notice above is still true; the message shows on the next open */ }
      } else {
        // Written, not sent. The row is due, so the hourly run will pick it up — say that rather
        // than implying failure or success.
        state.rowNotice[t.id] = 'Queued — it will go out on your assistant’s next run.';
      }
    } catch (err) {
      state.rowError[t.id] = err.message || 'That did not work.';
    } finally {
      delete state.busy[t.id];
      repaintDetail(t);
    }
  }

  /**
   * Send a written reply to the prospect.
   *
   * ⚠️ Reports the SERVER's outcome, exactly like runCadenceAction above. `reply` answers 200 with
   * `sent:false` and a reason for every legitimate non-send — no mailbox connected, the address has
   * opted out, no postal address on file, the OAuth token needs reauthorising — and each of those is
   * something the user can act on. A composer that cleared the box and said "Sent" on all of them
   * would lose the text AND the reason.
   *
   * The draft is kept on failure and cleared only on a confirmed send.
   */
  async function sendReply(t) {
    const draft = (state.replyDraft[t.id] || '').trim();
    if (!draft || state.replySending[t.id]) return;

    state.replySending[t.id] = true;
    state.replyError = state.replyError || {};
    state.replyNotice = state.replyNotice || {};
    delete state.replyError[t.id];
    delete state.replyNotice[t.id];
    repaintDetail(t);

    try {
      const data = await call('reply', { threadId: t.id, replyBody: draft });
      if (data.sent) {
        delete state.replyDraft[t.id];
        state.replyNotice[t.id] = data.message || 'Reply sent.';
        // The sent message exists only in the database — refetch this one conversation so it appears
        // in the transcript above the box the user just typed into.
        try {
          const fresh = await call('get', { threadId: t.id });
          state.open[t.id] = { thread: fresh.thread, messages: fresh.messages || [], enrolment: fresh.enrolment || null };
        } catch { /* the notice is still true; the message appears on the next open */ }
      } else {
        // Non-send with a reason. Keep the draft — the user's words are the expensive part.
        state.replyError[t.id] = data.message || 'Nothing was sent.';
      }
    } catch (err) {
      state.replyError[t.id] = err.message || 'Could not send that reply.';
    } finally {
      delete state.replySending[t.id];
      repaintDetail(t);
    }
  }

  function wireControls(h) {
    const repaint = () => { resetPage(); paintRows(); };

    const search = h.querySelector('[data-lt-search]');
    if (search) search.addEventListener('input', () => { state.view.search = search.value; repaint(); });

    h.querySelectorAll('[data-lt-filter]').forEach((sel) => sel.addEventListener('change', () => {
      state.view.filters[sel.getAttribute('data-lt-filter')] = sel.value;
      repaint();
    }));

    const group = h.querySelector('[data-lt-group]');
    if (group) group.addEventListener('change', () => {
      state.view.groupKey = group.value || null;
      // Folds belong to the column they were made in: "Closed" folded under Status must not
      // silently fold an Outcome group that happens to share a label.
      state.view.collapsed.clear();
      resetPage();
      paintRows();
    });

    h.querySelector('[data-lt-clear]')?.addEventListener('click', () => {
      state.view = { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1, collapsed: new Set() };
      render();                                     // the controls themselves have to reset too
    });

    // Sort: the column headings ARE the control, which is where everyone reaches for it first. A
    // third click clears it and puts the list back in the order the server sent — the only way back
    // to "most recently active first" without knowing that that was the default.
    h.querySelectorAll('[data-lt-sort]').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-lt-sort');
      const v = state.view;
      if (v.sortKey !== key) { v.sortKey = key; v.sortDir = 'asc'; }
      else if (v.sortDir === 'asc') v.sortDir = 'desc';
      else { v.sortKey = null; v.sortDir = 'asc'; }
      resetPage();
      render();                                     // the arrow lives in the heading
    }));

    const pager = h.querySelector('[data-lt-pager]');
    if (pager && window.ListPager) {
      window.ListPager.bind(pager, 'data-lt-page', (n) => {
        state.view.page = n;
        paintRows();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  function view() {
    if (state.loading && !state.threads.length) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-500">Loading conversations…</div>`;
    }
    if (state.error) {
      return `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <p class="text-sm font-semibold text-gray-900">${esc(state.error)}</p>
        <button type="button" data-lt-retry class="mt-3 px-3 py-1.5 bg-white border border-gray-200 text-gray-700 hover:border-gray-300 text-xs font-bold rounded-lg transition">Try again</button>
      </div>`;
    }
    return listView();
  }

  function render() {
    const h = host();
    if (!h) return;
    h.innerHTML = view();
    h.querySelector('[data-lt-retry]')?.addEventListener('click', () => load());
    wireControls(h);
    paintRows();
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  /**
   * The tab button: how many conversations exist.
   *
   * ⚠️ `counts.total` is the server's count over the WHOLE set, not the page or the filtered view —
   * the tab has to agree with the "Conversations" tile, and both have to be the real total.
   *
   * No amber pill here, deliberately. The natural candidate is `counts.replied` — a stranger has
   * written back and nobody has looked — but this tab has no "mark as seen", so the pill could
   * only ever be cleared by the conversation being closed. A permanent badge is a broken badge.
   */
  function updateTab() {
    window.AssistantDashboardRegistry?.setTabCount(
      'conversations-tab-label', state.tabLabel, state.counts && state.counts.total,
    );
  }

  /**
   * Load every conversation, draining the server's cursor.
   *
   * ⚠️ The drain is what makes the filter strip honest. Every control compares the rendered cell
   * across `state.threads`, so a partially-loaded list would silently redefine "filter to Replied"
   * as "…among the most recent page" — the failure mode where the strip says 3 and the truth is 40.
   * `truncated` is set when the cap is reached instead, and the view says so.
   */
  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const all = [];
      let cursor;
      let truncated = false;
      let counts = state.counts;
      // Bounded: PAGE_SIZE is 200 server-side, so this is at most five requests.
      for (let i = 0; i < 10; i++) {
        const data = await call('list', { cursor });
        all.push(...(data.threads || []));
        counts = data.counts || counts;
        cursor = data.nextCursor || null;
        if (!cursor) break;
        if (all.length >= MAX_THREADS) { truncated = true; break; }
      }
      state.threads = all;
      state.counts = counts;
      state.truncated = truncated;
      // Drop cached details for conversations that are no longer in the list.
      const live = new Set(all.map((t) => t.id));
      for (const id of Object.keys(state.open)) if (!live.has(Number(id))) delete state.open[id];
      updateTab();
    } catch (err) {
      // lead_threads / sequence_enrolments are MANUAL applies (db/lead-threads.sql,
      // db/outreach-sequences.sql). Name that rather than showing a generic failure.
      state.error = err.code === 'MIGRATION_PENDING'
        ? 'Conversations are not set up on this environment yet.'
        : (err.message || 'Could not load your conversations.');
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.AssistantLeadThreads = {
    init({ assistantId, cfg }) {
      state.assistantId = assistantId;
      state.rendered = false;
      state.threads = [];
      state.open = {};
      state.rowError = {};
      state.rowNotice = {};
      state.busy = {};
      state.replyDraft = {};
      state.replySending = {};
      state.replyError = {};
      state.replyNotice = {};
      // Read here rather than in activate(): init() runs during _applyDashboardRegistry and starts
      // the fetch, so the id has to be in state before the rows it targets are painted. Cleared off
      // the window immediately — a stale global would re-open this thread on the next assistant the
      // user visits.
      state.focusThreadId = Number(window._assistantDetailFocusThreadId) || null;
      window._assistantDetailFocusThreadId = null;
      state.view = { search: '', filters: {}, sortKey: null, sortDir: 'asc', groupKey: null, page: 1, collapsed: new Set() };
      if (cfg && cfg.label) state.tabLabel = cfg.label;
      // ⚠️ This DOES prefetch, and the comment that used to sit below said the opposite for a good
      // reason: "no tab badge depends on the counts, so a user who never opens the tab should never
      // pay for the query". A count on the button is exactly such a dependency, and it is the
      // point — Conversations was the one tab in the funnel with no number on it, so the tab gave
      // no indication that anything had ever replied.
      //
      // The cost is one drained list per assistant-detail page load. `activate()` reuses this
      // result rather than fetching again, so opening the tab is now free where it used to cost the
      // query — the spend moved rather than doubled.
      state.rendered = true;
      load();
    },
    /**
     * Called on first activation of the tab. init() has normally loaded already, so the usual
     * outcome here is a repaint or nothing at all.
     *
     * ⚠️ The empty-host check is load-bearing now that init() prefetches. init() runs during
     * _applyDashboardRegistry, and its render() writes into `lead-threads-host`; if that fetch
     * resolved before the panel existed, the paint went nowhere and `rendered` was already true —
     * which, with a bare `if (state.rendered) return`, left the tab permanently blank. Repainting
     * from state costs nothing and cannot produce that.
     */
    activate() {
      if (!state.rendered) {
        state.rendered = true;
        load();
        return;
      }
      const h = host();
      if (h && !h.innerHTML.trim()) render();
    },
    refresh: load,
  };
})();
