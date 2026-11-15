// scripts/trends-phase0.ts
//
// Phase 0 of docs/google-trends-plan.md (FR#31): does DataForSEO's Google Trends data hold up for
// the broad trade terms our customers would track, at country, nation and US-state level?
//
// Go/no-go measure: what share of term × region pairs return usable data, and are the rising
// queries sensible? Writes NOTHING to any database. Only search terms leave the machine.
//
// Uses the Live endpoint (one task per call, ~$0.009–0.011 each) so the test finishes in minutes.
// Production will use Standard (task_post, ~$0.0027). One call per term × region asks for the
// 12-month graph AND the related queries (queries_list allows one keyword per task).
//
// Usage:
//   # credentials in .env (never pasted into chat):  DATAFORSEO_LOGIN=…  DATAFORSEO_PASSWORD=…
//   npx tsx scripts/trends-phase0.ts --dry-run          # plan + cost estimate, no network
//   npx tsx scripts/trends-phase0.ts --limit=5          # first 5 terms only (smoke test)
//   npx tsx scripts/trends-phase0.ts                    # full run (60 terms × 5 regions ≈ $3)
//
// Options: --terms=path.json (default scripts/trends-phase0-terms.json), --limit=N,
//          --regions="United Kingdom,Texas" (overrides the file), --dry-run,
//          --fresh (ignore replies saved in .tmp-trends-phase0/ and pay for them again),
//          --standard (cheaper queue, ~$0.0027 a task, up to 45 min; resumable via pending-standard.json),
//          --max-new=N (with --standard: post at most N new tasks, e.g. 1 to check the price).
//
// Output: raw responses in .tmp-trends-phase0/ (gitignored), summary in
// docs/google-trends-phase0-results.md.

import { config } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

config();

const API = 'https://api.dataforseo.com/v3/keywords_data/google_trends';
const COST_PER_LIVE_CALL = 0.011; // upper bound for the estimate; the API reports the real cost
const COST_PER_STANDARD_TASK = 0.0027; // confirmed 2026-11-15 on a real task_post
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, '.tmp-trends-phase0');
const SUMMARY = path.join(ROOT, 'docs', 'google-trends-phase0-results.md');

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
}

type Location = { location_code: number; location_name: string; location_type: string; country_iso_code: string };
type Point = { date_from: string; date_to: string; missing_data?: boolean; values: (number | null)[] };
type QueryRow = { query: string; value: number | string };

type Outcome = {
  term: string;
  region: string;
  status: 'ok' | 'not_enough_data' | 'error';
  detail?: string;
  peakMonth?: string;
  nonZeroShare?: number;
  top: string[];
  rising: { query: string; value: string }[];
  cost: number;
};

function authHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set (in .env). Do not paste them into chat.');
  }
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

async function call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    // DataForSEO puts the reason in the body even on 4xx (e.g. 40104 "Please verify your account").
    const why = json?.status_message ? ` — ${json.status_code} ${json.status_message}` : '';
    throw new Error(`HTTP ${res.status} from ${url}${why}`);
  }
  if (json.status_code !== 20000) throw new Error(`${json.status_code} ${json.status_message}`);
  return json;
}

/** Resolves region names through the free locations endpoint instead of hard-coding codes. */
async function resolveRegions(names: string[]): Promise<Map<string, Location | null>> {
  const json = await call('GET', `${API}/locations`);
  const all: Location[] = json.tasks?.[0]?.result ?? [];
  const out = new Map<string, Location | null>();
  for (const name of names) {
    const want = name.toLowerCase();
    // Sub-national names carry their country: "Scotland,United Kingdom", "Texas,United States".
    const exact = all.filter((l) => {
      const n = l.location_name.toLowerCase();
      return n === want || n.split(',')[0] === want;
    });
    // Prefer a country, nation or state over a same-named smaller place (New South Wales ≠ Wales).
    const pick = exact.find((l) => /country|province|state|region/i.test(l.location_type)) ?? exact[0] ?? null;
    out.set(name, pick);
  }
  return out;
}

function monthName(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}

function analyse(term: string, region: string, json: any): Outcome {
  const task = json.tasks?.[0];
  const cost = Number(task?.cost ?? json.cost ?? 0);
  const base = { term, region, top: [] as string[], rising: [] as { query: string; value: string }[], cost };
  if (task?.status_code !== 20000) {
    return { ...base, status: 'error', detail: `${task?.status_code} ${task?.status_message}` };
  }
  const items: any[] = task.result?.[0]?.items ?? [];
  const graph = items.find((i) => i.type === 'google_trends_graph');
  const queries = items.find((i) => i.type === 'google_trends_queries_list');

  const points: Point[] = graph?.data ?? [];
  const values = points.map((p) => (p.missing_data ? null : p.values?.[0] ?? null));
  const nonZero = values.filter((v) => typeof v === 'number' && v > 0).length;
  const nonZeroShare = points.length ? nonZero / points.length : 0;

  const top = ((queries?.data?.top ?? []) as QueryRow[]).slice(0, 5).map((q) => q.query);
  const rising = ((queries?.data?.rising ?? []) as QueryRow[])
    .slice(0, 5)
    .map((q) => ({ query: q.query, value: String(q.value) }));

  // Usable = most weeks have a real value. Sparse series are what "not enough data" looks like.
  if (nonZeroShare < 0.8) {
    return { ...base, top, rising, status: 'not_enough_data', nonZeroShare };
  }
  let peakIdx = 0;
  values.forEach((v, i) => {
    if ((v ?? -1) > (values[peakIdx] ?? -1)) peakIdx = i;
  });
  return { ...base, top, rising, status: 'ok', nonZeroShare, peakMonth: monthName(points[peakIdx].date_from) };
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((100 * n) / d)}%` : '–';
}

function writeSummary(outcomes: Outcome[], regions: string[], unresolved: string[]): void {
  const lines: string[] = [];
  const total = outcomes.reduce((s, o) => s + o.cost, 0);
  lines.push('# Google Trends — Phase 0 results (FR#31)', '');
  lines.push(`Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`scripts/trends-phase0.ts\`, `
    + `DataForSEO ${arg('standard') ? 'Standard queue (earlier Live replies reused)' : 'Live'}, past 12 months, web search. `
    + `${outcomes.length} term × region pairs, cost of new calls in this run $${total.toFixed(2)}.`, '');
  lines.push('"Usable" = at least 80% of weeks have a real value. Values are relative interest (100 = the peak), not counts.', '');
  if (unresolved.length) lines.push(`⚠️ Regions DataForSEO does not list (skipped): ${unresolved.join(', ')}`, '');

  lines.push('## Usable data by region', '', '| Region | Usable | Not enough data | Errors | With rising queries |', '| --- | --- | --- | --- | --- |');
  for (const r of regions) {
    const rows = outcomes.filter((o) => o.region === r);
    if (!rows.length) continue;
    const ok = rows.filter((o) => o.status === 'ok').length;
    const thin = rows.filter((o) => o.status === 'not_enough_data').length;
    const err = rows.filter((o) => o.status === 'error').length;
    const withRising = rows.filter((o) => o.rising.length > 0).length;
    lines.push(`| ${r} | ${ok}/${rows.length} (${pct(ok, rows.length)}) | ${thin} | ${err} | ${pct(withRising, rows.length)} |`);
  }

  lines.push('', '## Every term', '', '| Term | Region | Result | Peak month | Rising queries (↑ % change) |', '| --- | --- | --- | --- | --- |');
  for (const o of outcomes) {
    const result = o.status === 'ok' ? 'usable' : o.status === 'error' ? `error: ${o.detail}` : `thin (${pct(Math.round((o.nonZeroShare ?? 0) * 100), 100)} weeks)`;
    const rising = o.rising.map((q) => `${q.query} (${q.value})`).join('; ').replace(/\|/g, '/');
    lines.push(`| ${o.term} | ${o.region} | ${result} | ${o.peakMonth ?? ''} | ${rising} |`);
  }
  lines.push('', '## Verdict', '', '_To fill in after reading the table: go / no-go for Phase 1, and which region levels to offer._', '');
  fs.writeFileSync(SUMMARY, lines.join('\n'));
}

type Pending = Record<string, { id: string; cost: number; postedAt: string }>;
const PENDING = path.join(RAW_DIR, 'pending-standard.json');

function slugOf(term: string, region: string): string {
  return `${term}-${region}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function taskBody(term: string, locationCode: number, tag?: string) {
  return {
    keywords: [term],
    location_code: locationCode,
    language_code: 'en',
    type: 'web',
    time_range: 'past_12_months',
    item_types: ['google_trends_graph', 'google_trends_queries_list'],
    ...(tag ? { tag } : {}),
  };
}

/**
 * Standard queue (~$0.0027 a task, answers within 45 min). Posts every pair that has no saved reply,
 * remembers task ids in pending-standard.json (so an interruption never loses a paid task), then
 * polls tasks_ready and saves each answer where the Live path would have. --max-new=N caps posting.
 */
async function runStandard(pairs: { term: string; region: string; code: number }[]): Promise<void> {
  const pending: Pending = fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, 'utf8')) : {};
  const savePending = () => fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
  const maxNew = arg('max-new') ? Number(arg('max-new')) : Infinity;

  const toPost = pairs
    .filter((p) => !fs.existsSync(path.join(RAW_DIR, `${slugOf(p.term, p.region)}.json`)))
    .filter((p) => !pending[slugOf(p.term, p.region)])
    .slice(0, maxNew);

  for (let i = 0; i < toPost.length; i += 100) {
    const chunk = toPost.slice(i, i + 100);
    const json = await call('POST', `${API}/explore/task_post`, chunk.map((p) => taskBody(p.term, p.code, slugOf(p.term, p.region))));
    let posted = 0;
    for (const t of json.tasks ?? []) {
      const tag = t.data?.tag as string | undefined;
      if (t.status_code === 20100 && tag) {
        pending[tag] = { id: t.id, cost: Number(t.cost ?? 0), postedAt: new Date().toISOString() };
        posted++;
      } else {
        console.log(`  post refused for ${tag ?? '?'}: ${t.status_code} ${t.status_message}`);
      }
    }
    savePending();
    console.log(`Posted ${posted} Standard task(s); DataForSEO charged $${Number(json.cost ?? 0).toFixed(4)} for this batch`);
  }

  if (arg('post-only')) return; // a later --standard run collects what is in pending-standard.json
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Object.keys(pending).length && Date.now() < deadline) {
    const byId = new Map(Object.entries(pending).map(([slug, p]) => [p.id, slug]));
    const ready = await call('GET', `${API}/explore/tasks_ready`);
    const ids: string[] = (ready.tasks?.[0]?.result ?? []).map((r: any) => r.id).filter((id: string) => byId.has(id));
    for (const id of ids) {
      const slug = byId.get(id)!;
      const json = await call('GET', `${API}/explore/task_get/${id}`);
      json.tasks[0].cost = pending[slug].cost; // keep the price paid at posting time with the reply
      fs.writeFileSync(path.join(RAW_DIR, `${slug}.json`), JSON.stringify(json, null, 2));
      delete pending[slug];
    }
    savePending();
    const left = Object.keys(pending).length;
    console.log(`${new Date().toISOString().slice(11, 19)} collected ${ids.length}, waiting on ${left}`);
    if (left) await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function main(): Promise<void> {
  const file = JSON.parse(fs.readFileSync(path.resolve(ROOT, arg('terms') ?? 'scripts/trends-phase0-terms.json'), 'utf8'));
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const terms: string[] = (file.terms as string[]).slice(0, limit);
  const regions: string[] = arg('regions') ? arg('regions')!.split(',').map((s) => s.trim()) : file.regions;
  const calls = terms.length * regions.length;

  const perCall = arg('standard') ? COST_PER_STANDARD_TASK : COST_PER_LIVE_CALL;
  console.log(`${terms.length} terms × ${regions.length} regions = ${calls} ${arg('standard') ? 'Standard tasks' : 'Live calls'}, `
    + `at most ≈ $${(calls * perCall).toFixed(2)} (saved replies are free)`);
  if (arg('dry-run')) {
    console.log('Regions:', regions.join(', '));
    console.log('Terms:', terms.join(', '));
    console.log('Dry run: no network calls made.');
    return;
  }

  const resolved = await resolveRegions(regions);
  const unresolved = regions.filter((r) => !resolved.get(r));
  for (const r of regions) {
    const l = resolved.get(r);
    console.log(l ? `  ${r} → ${l.location_code} (${l.location_type})` : `  ${r} → NOT LISTED, skipped`);
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  const standard = Boolean(arg('standard'));
  if (standard) {
    const pairs = terms.flatMap((term) => regions.flatMap((region) => {
      const loc = resolved.get(region);
      return loc ? [{ term, region, code: loc.location_code }] : [];
    }));
    await runStandard(pairs);
    if (arg('post-only')) {
      console.log('Posted only. Run again with --standard (same terms/regions) to collect and summarise.');
      return;
    }
  }
  const outcomes: Outcome[] = [];
  let n = 0;
  for (const term of terms) {
    for (const region of regions) {
      const loc = resolved.get(region);
      if (!loc) continue;
      n++;
      const cached = path.join(RAW_DIR, `${slugOf(term, region)}.json`);
      // Resumable: a reply saved by an earlier (possibly interrupted) run is reused, not paid for again.
      if (!arg('fresh') && fs.existsSync(cached)) {
        const saved = JSON.parse(fs.readFileSync(cached, 'utf8'));
        // Standard replies carry the price paid; Live replies saved earlier were paid for in their own run.
        const isStandardReply = (saved.tasks?.[0]?.path ?? []).includes('task_get');
        const o = { ...analyse(term, region, saved), cost: standard && isStandardReply ? Number(saved.tasks?.[0]?.cost ?? 0) : 0 };
        outcomes.push(o);
        console.log(`[${n}/${calls}] ${term} · ${region}: ${o.status} (saved reply)`);
        continue;
      }
      if (standard) {
        // Never fall back to the dearer Live call: an unanswered Standard task is reported, not re-bought.
        outcomes.push({ term, region, status: 'error', detail: 'Standard task not answered yet', top: [], rising: [], cost: 0 });
        continue;
      }
      try {
        const json = await call('POST', `${API}/explore/live`, [taskBody(term, loc.location_code)]);
        fs.writeFileSync(cached, JSON.stringify(json, null, 2));
        const o = analyse(term, region, json);
        outcomes.push(o);
        console.log(`[${n}/${calls}] ${term} · ${region}: ${o.status}${o.peakMonth ? `, peaks ${o.peakMonth}` : ''}, ${o.rising.length} rising`);
      } catch (e) {
        outcomes.push({ term, region, status: 'error', detail: (e as Error).message, top: [], rising: [], cost: 0 });
        console.log(`[${n}/${calls}] ${term} · ${region}: ERROR ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 300)); // well under the 250 Live calls/minute guidance
    }
  }

  writeSummary(outcomes, regions, unresolved);
  const spent = outcomes.reduce((s, o) => s + o.cost, 0);
  console.log(`Done. Spent $${spent.toFixed(2)}. Summary: docs/google-trends-phase0-results.md; raw: .tmp-trends-phase0/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
