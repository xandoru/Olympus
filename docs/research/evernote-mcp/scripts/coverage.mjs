// Evernote MCP coverage probe for the Olympus Evernote connector.
//
// Question: can a connector reach every note, given that search_notes returns nothing past
// the 2,000th result? It tries two ways of splitting the account into pieces under that limit
// (by notebook, and by year created) and counts what each reaches.
//
// Everything in the report is a number or a yes/no. No titles, snippets, ids or names of your
// notes or notebooks are written; note ids are held in memory only, to count distinct notes.
// Read-only sign-in; no tool that changes anything is called.

import { PAUSE_MS, call, connect, dataOf, hitsOf, numbers, say, sleep, stats, writeReport } from './lib.mjs';

const CAP = 2000;
const FIRST_YEAR = 1995;
const LAST_YEAR = new Date().getFullYear() + 1;
const started = Date.now();
const report = { generatedAt: new Date().toISOString(), observedCap: CAP, problems: [] };

async function page(query, startIndex, maxResults = 100) {
  const outcome = await call('search_notes', { query, maxResults, startIndex, sortBy: 'created', ascending: true });
  await sleep(PAUSE_MS);
  return outcome;
}

// Every note matching `query`, when it holds no more than CAP notes. Ids go into `into`.
async function listSmall(query, into) {
  const first = await page(query, 0);
  const data = dataOf(first.result) ?? {};
  const total = data.totalResultCount ?? 0;
  let reached = 0;
  const take = (outcome) => { for (const hit of hitsOf(outcome)) { into.add(hit.noteId); reached += 1; } };
  take(first);
  for (let start = 100; start < Math.min(total, CAP); start += 100) take(await page(query, start));
  return { ok: first.ok, total, reached, overCap: total > CAP };
}

// Every note matching `filter`, split by year created when it holds more than CAP.
async function listAll(filter, into) {
  const whole = await listSmall(filter, into);
  if (!whole.overCap) return { ...whole, splitByYear: false };
  let sumOfYears = 0;
  let yearsOverCap = 0;
  const before = await listSmall(`${filter} -created:${FIRST_YEAR}0101`.trim(), into);
  sumOfYears += before.total;
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year += 1) {
    const slice = await listSmall(`${filter} created:${year}0101 -created:${year + 1}0101`.trim(), into);
    sumOfYears += slice.total;
    if (slice.overCap) yearsOverCap += 1;
  }
  const after = await listSmall(`${filter} created:${LAST_YEAR + 1}0101`.trim(), into);
  sumOfYears += after.total;
  return { ok: whole.ok, total: whole.total, splitByYear: true, sumOfYears, yearsOverCap };
}

async function notebookIds() {
  const ids = new Set();
  let total = null;
  for (const query of ['', ...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')]) {
    for (const sortBy of query === '' ? ['name', 'updated'] : ['name']) {
      const outcome = await call('search_notebooks', { query, maxResults: 100, sortBy });
      if (query === '' && sortBy === 'name') total = numbers(outcome).totalResultCount;
      hitsOf(outcome).forEach((hit) => ids.add(hit.notebookId));
      await sleep(PAUSE_MS);
    }
  }
  return { ids: [...ids], total };
}

async function main() {
  const { auth } = await connect();
  report.auth = auth;
  say('Signed in. Counting (numbers only). This takes several minutes; leave it running.');

  const accountTotal = numbers(await page('', 0, 1)).totalResultCount;
  report.accountTotal = accountTotal;

  report.capProbe = {};
  for (const [start, size] of [[1900, 100], [1950, 100], [1999, 1], [2000, 1]]) {
    report.capProbe[`start${start}_max${size}`] = numbers(await page('', start, size)).hitsReturned;
  }

  // Way 1: notebook by notebook.
  const books = await notebookIds();
  const byNotebook = new Set();
  const sizes = [];
  let sumOfTotals = 0;
  let notebooksSplit = 0;
  let notebooksStillOverCap = 0;
  for (const id of books.ids) {
    const before = byNotebook.size;
    const result = await listAll(`nbGuid:"${id}"`, byNotebook);
    sizes.push(result.total);
    sumOfTotals += result.total;
    if (result.splitByYear) notebooksSplit += 1;
    if (result.yearsOverCap) notebooksStillOverCap += 1;
    if (byNotebook.size - before < (result.splitByYear ? result.total : Math.min(result.total, CAP))) {
      report.problems.push('A notebook returned fewer distinct notes than its count.');
    }
  }
  report.byNotebook = {
    notebooksTotalResultCount: books.total,
    notebooksFound: books.ids.length,
    emptyNotebooks: sizes.filter((n) => n === 0).length,
    largestNotebook: Math.max(0, ...sizes),
    notebooksOverCap: sizes.filter((n) => n > CAP).length,
    notebooksSplitByYear: notebooksSplit,
    notebooksStillOverCapAfterSplit: notebooksStillOverCap,
    sumOfNotebookCounts: sumOfTotals,
    distinctNotesReached: byNotebook.size,
    reachedEveryNote: byNotebook.size === accountTotal,
  };

  // Way 2: the whole account by year created.
  const byYear = new Set();
  const years = await listAll('', byYear);
  report.byYear = {
    sumOfYearCounts: years.sumOfYears ?? null,
    yearsOverCap: years.yearsOverCap ?? null,
    distinctNotesReached: byYear.size,
    reachedEveryNote: byYear.size === accountTotal,
    sameNotesAsByNotebook: byYear.size === byNotebook.size && [...byYear].every((id) => byNotebook.has(id)),
  };

  // Daily change detection.
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const ymd = yesterday.toISOString().slice(0, 10).replaceAll('-', '');
  report.changes = {
    updatedDayMinus1: numbers(await call('search_notes', { query: 'updated:day-1', maxResults: 1, clientTimeZone: 'America/Los_Angeles' })).totalResultCount,
    updatedSinceYesterdayAbsolute: numbers(await call('search_notes', { query: `updated:${ymd}`, maxResults: 1 })).totalResultCount,
    updatedSinceYesterdayWithTime: numbers(await call('search_notes', { query: `updated:${ymd}T000000Z`, maxResults: 1 })).totalResultCount,
  };

  // Trash.
  const trash = new Set();
  const trashed = await listAll('intrash:true', trash);
  report.trash = { total: trashed.total, distinctReached: trash.size };

  report.cost = { toolCalls: stats.calls, rateLimitRetries: stats.rateLimitRetries, minutes: Math.round((Date.now() - started) / 6000) / 10 };
}

try {
  await main();
} catch (error) {
  report.problems.push(`Stopped early: ${String(error?.message ?? error).slice(0, 500)}`);
}
writeReport('evernote-coverage-report.json', report);
say('Attach that file in the chat.');
process.exit(0);
