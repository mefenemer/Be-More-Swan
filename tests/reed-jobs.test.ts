// tests/reed-jobs.test.ts
// Buying triggers Phase 5, Admin only (docs/buying-triggers-plan.md §5; owner 2026-11-17): businesses hiring,
// from the Reed Jobseeker API.
//
// WHY THIS EXISTS. We told Reed in writing what we would and wouldn't do (docs/reed-api-terms-email.md): keep
// only employer, title, location, date and the link; never the description or anything about job seekers;
// credit Reed; leave out agencies; keep 90 days. These pin those promises in code, plus the measurement rules
// shared with the FSA feed: the first read of each search is silent, an old advert surfacing is not news, a
// failed search never stops the rest, and nothing reaches a workspace.
//
// Run:  npx tsx tests/reed-jobs.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import {
    looksLikeAgency, reedDate, reedPostcode, isFreshPosting, reedToEvent, reedLabel, reedQueries, queryKey, roleCode,
    REED_FRESH_DAYS, REED_ROLES, REED_LOCATIONS,
} from '../src/lib/triggers/reed-jobs';
import { planReedQuery } from '../src/utils/reed-poll';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

// A real result (2026-11-17), with the fields we must NOT keep included.
const JOB = {
    jobId: 57541224, employerId: 703584, employerName: 'Mitchells & Butlers', employerProfileId: null,
    jobTitle: 'Chef', locationName: 'LS196LP', minimumSalary: null, maximumSalary: null, currency: null,
    expirationDate: '05/12/2026', date: '15/11/2026', applications: 0,
    jobDescription: 'No CV to hand? No problem! As a Chef at the Stone Trough…',
    jobUrl: 'https://www.reed.co.uk/jobs/chef/57541224',
};

console.log('What we keep (our promise to Reed)');
check('an event keeps employer, title, location, date and link, and never the description or salary', () => {
    const ev = reedToEvent(JOB, { role: 'chef', location: 'Leeds' }, '2026-11-17', 1);
    const blob = JSON.stringify(ev);
    assert.doesNotMatch(blob, /No CV to hand|jobDescription|Salary|applications|expirationDate/i);
    assert.strictEqual(ev.name, 'Mitchells & Butlers');
    assert.strictEqual(ev.payload.jobTitle, 'Chef');
    assert.strictEqual(ev.payload.url, 'https://www.reed.co.uk/jobs/chef/57541224');
    assert.strictEqual(ev.postcode, 'LS19 6LP');
    assert.strictEqual(ev.area, 'Leeds');
    assert.deepStrictEqual(ev.tradeCodes, ['chef']);
    assert.strictEqual(ev.occurredOn, '2026-11-15');
    assert.strictEqual(ev.kind, 'hiring');
    assert.strictEqual(ev.source, 'reed_jobs');
});
check('a link that is not on reed.co.uk is replaced by Reed\'s own job page', () => {
    const ev = reedToEvent({ ...JOB, jobUrl: 'https://evil.example/x' }, { role: 'chef', location: 'Leeds' }, '2026-11-17', 1);
    assert.strictEqual(ev.payload.url, 'https://www.reed.co.uk/jobs/57541224');
});
check('the label credits Reed', () => {
    const ev = reedToEvent(JOB, { role: 'chef', location: 'Leeds' }, '2026-11-17', 1);
    assert.strictEqual(reedLabel(ev).text, 'Hiring: Chef in LS196LP, advertised on Reed (15 Nov)');
});
check('the adapter asks Reed for direct employers only, and the admin page credits Reed', () => {
    assert.match(read('src/lib/triggers/reed-jobs.ts'), /postedByDirectEmployer: 'true'/);
    assert.match(read('admin.html'), /Jobs from <a href="https:\/\/www\.reed\.co\.uk"/);
});
check('agencies that slip through are caught by name; ordinary employers are not', () => {
    for (const n of ['Hays Recruitment', 'Acme Staffing Ltd', 'Blue Arrow Personnel', 'Talent Hub', 'Office Angels Appointments']) assert.ok(looksLikeAgency(n), n);
    for (const n of ['Mitchells & Butlers', 'Acme Signs Ltd', 'The Talbot Arms', 'Leeds Bakery']) assert.ok(!looksLikeAgency(n), n);
});
check('events are kept 90 days, like the FSA feed', () => {
    assert.match(read('src/utils/reed-poll.ts'), /DELETE FROM trigger_events WHERE source = \$\{REED_SOURCE\} AND first_seen_at < now\(\) - make_interval\(days => \$\{EVENT_KEEP_DAYS\}\)/);
    assert.match(read('src/utils/trigger-engine.ts'), /export const EVENT_KEEP_DAYS = 90;/);
});

console.log('Measurement rules');
check('Reed dates and postcodes are read; anything else is null', () => {
    assert.strictEqual(reedDate('16/11/2026'), '2026-11-16');
    assert.strictEqual(reedDate('2026-11-16'), null);
    assert.strictEqual(reedPostcode('West Yorkshire'), null);
    assert.strictEqual(reedPostcode('ls19 6lp'), 'LS19 6LP');
});
check(`a posting is news only within ${REED_FRESH_DAYS} days`, () => {
    assert.ok(isFreshPosting('2026-11-17', '2026-11-17'));
    assert.ok(isFreshPosting('2026-11-14', '2026-11-17'));
    assert.ok(!isFreshPosting('2026-11-10', '2026-11-17'));
    assert.ok(!isFreshPosting(null, '2026-11-17'));
});
check('the first read of a search is silent; later reads report new, fresh, non-agency jobs only', () => {
    const jobs = [
        { ...JOB, jobId: 1, date: '17/11/2026' },
        { ...JOB, jobId: 2, date: '01/11/2026' },
        { ...JOB, jobId: 3, date: '17/11/2026', employerName: 'Hays Recruitment' },
        { ...JOB, jobId: 4, date: '17/11/2026' },
    ];
    const first = planReedQuery(jobs, new Set(), false, '2026-11-17');
    assert.strictEqual(first.fresh.length, 0);
    assert.strictEqual(first.agencies, 1);
    assert.strictEqual(first.direct.length, 3);
    const later = planReedQuery(jobs, new Set(['4']), true, '2026-11-17');
    assert.deepStrictEqual(later.fresh.map((j) => j.jobId), [1]);
    assert.strictEqual(later.old, 1);
});
check('every role is read in every city, each with a unique key', () => {
    const q = reedQueries();
    assert.strictEqual(q.length, REED_ROLES.length * REED_LOCATIONS.length);
    assert.strictEqual(new Set(q.map(queryKey)).size, q.length);
    assert.strictEqual(roleCode('office manager'), 'office_manager');
});
check('a failed search is skipped and the rest carry on; the first read is recorded as the baseline', () => {
    const src = read('src/utils/reed-poll.ts');
    assert.match(src, /failedQueries!\.push\(`\$\{queryKey\(q\)\} \(\$\{err instanceof Error/);
    assert.match(src, /baseline: !baselined/);
    assert.match(src, /checkCompanies\(db, opts\.deadline, opts\.maxCompanyChecks \?\? 300, REED_SOURCE\)/);
});
check('it runs after the FSA read in the same background function, within the time budget', () => {
    const run = read('netlify/functions/run-trigger-poll-background.ts');
    assert.match(run, /runFsaPoll\(db, \{ deadlineMs: 8 \* 60_000 \}\)[\s\S]*runReedPoll\(db, \{ deadline: started \+ 13 \* 60_000 \}\)/);
});
check('the API key is read from the environment and never written in the repo', () => {
    assert.match(read('src/lib/triggers/reed-jobs.ts'), /process\.env\.REED_API_KEY/);
    const hits = execSync('git grep -nE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" -- src/lib/triggers src/utils/reed-poll.ts netlify/functions/admin-triggers.ts || true', { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(hits.trim(), '');
});

console.log('Admin only');
check('nothing outside the engine, the poll and the admin page reads Reed events', () => {
    const allowed = ['src/utils/reed-poll.ts', 'netlify/functions/admin-triggers.ts', 'src/lib/triggers/reed-jobs.ts'];
    const out = execSync('git ls-files src netlify', { cwd: ROOT, encoding: 'utf8' });
    const readers = out.split('\n').filter((f) => /\.(ts|js)$/.test(f) && !allowed.includes(f))
        .filter((f) => { try { return /\breed_jobs\b|REED_SOURCE/.test(read(f)); } catch { return false; } });
    assert.deepStrictEqual(readers, ['src/lib/triggers/types.ts']);
});

console.log(`\n${passed}/${total} passed`);
