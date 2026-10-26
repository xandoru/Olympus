// Evernote MCP probe 3 for the Olympus Evernote connector: the listing design Jamie asked for.
//
// 1. Lists every note by date, splitting any slice that reaches the 2,000 cap into months,
//    then days, then hours. Also forces that splitting on the busiest year, to prove it works.
// 2. Lists every notebook's notes, to see what a date listing cannot (which notebook a note is in).
// 3. Looks at the notes that belong to no listed notebook, and at the trash.
// 4. Times one full pass.
//
// The report holds counts, yes/no answers, years and Evernote's own field names only. No titles,
// snippets, ids or names of your notes or notebooks. Ids stay in memory. Read-only sign-in.

import { PAUSE_MS, call, connect, dataOf, hitsOf, numbers, say, sleep, stats, writeReport } from './lib.mjs';

const CAP = 2000;
const UNITS = ['year', 'month', 'day', 'hour'];
const report = { generatedAt: new Date().toISOString(), problems: [] };

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; // 20240101T000000Z
const rangeQuery = (filter, start, end) =>
  [filter, start ? `created:${stamp(start)}` : '', end ? `-created:${stamp(end)}` : ''].filter(Boolean).join(' ');

function subdivide(start, end, unit) {
  const out = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(cursor);
    if (unit === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
    else if (unit === 'day') next.setUTCDate(next.getUTCDate() + 1);
    else next.setUTCHours(next.getUTCHours() + 1);
    out.push([cursor, next < end ? next : end]);
    cursor = next;
  }
  return out;
}

async function search(query, startIndex = 0, maxResults = 100) {
  const outcome = await call('search_notes', { query, maxResults, startIndex, sortBy: 'created', ascending: true });
  await sleep(PAUSE_MS);
  return outcome;
}

// Lists one slice, splitting it into the next smaller unit while it holds more than `cap` notes.
async function listSlice(filter, start, end, unitIndex, cap, into, tally) {
  const query = rangeQuery(filter, start, end);
  const first = await search(query);
  const total = dataOf(first.result)?.totalResultCount ?? 0;
  tally.slices += 1;
  if (!first.ok) { tally.errors += 1; return 0; }
  if (total > cap && unitIndex + 1 < UNITS.length && start && end) {
    const unit = UNITS[unitIndex + 1];
    tally.splits[unit] = (tally.splits[unit] ?? 0) + 1;
    let sum = 0;
    for (const [a, b] of subdivide(start, end, unit)) sum += await listSlice(filter, a, b, unitIndex + 1, cap, into, tally);
    return sum;
  }
  if (total > CAP) tally.stillOverCap += 1;
  tally.largestSlice = Math.max(tally.largestSlice, total);
  const take = (outcome) => {
    for (const hit of hitsOf(outcome)) {
      if (into.has(hit.noteId)) tally.duplicates += 1;
      into.set(hit.noteId, hit);
    }
  };
  take(first);
  for (let at = 100; at < Math.min(total, CAP); at += 100) take(await search(query, at));
  return total;
}

// The whole account (or one filter) by date: before 1990, each year, after next year.
async function listByDate(filter, cap, into, years) {
  const tally = { slices: 0, splits: {}, duplicates: 0, errors: 0, stillOverCap: 0, largestSlice: 0 };
  const first = new Date(Date.UTC(1990, 0, 1));
  const last = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 0, 1));
  await listSlice(filter, undefined, first, 0, cap, into, tally);
  for (let y = 1990; y < last.getUTCFullYear(); y += 1) {
    const a = new Date(Date.UTC(y, 0, 1));
    const b = new Date(Date.UTC(y + 1, 0, 1));
    const n = await listSlice(filter, a, b, 0, cap, into, tally);
    if (years) years[y] = n;
  }
  await listSlice(filter, last, undefined, 0, cap, into, tally);
  return tally;
}

// A filter that usually holds fewer than CAP notes: plain paging, by date only when it is bigger.
async function listFilter(filter, into) {
  const first = await search(filter);
  const total = dataOf(first.result)?.totalResultCount ?? 0;
  if (total > CAP) return listByDate(filter, CAP, into);
  const tally = { slices: 1, splits: {}, duplicates: 0, errors: first.ok ? 0 : 1, stillOverCap: 0, largestSlice: total };
  const take = (outcome) => {
    for (const hit of hitsOf(outcome)) {
      if (into.has(hit.noteId)) tally.duplicates += 1;
      into.set(hit.noteId, hit);
    }
  };
  take(first);
  for (let at = 100; at < total; at += 100) take(await search(filter, at));
  return tally;
}

async function notebookIds() {
  const books = new Map();
  for (const query of ['', ...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')]) {
    for (const sortBy of query === '' ? ['name', 'updated'] : ['name']) {
      const outcome = await call('search_notebooks', { query, maxResults: 100, sortBy });
      hitsOf(outcome).forEach((hit) => books.set(hit.notebookId, hit));
      await sleep(PAUSE_MS);
    }
  }
  return books;
}

function shape(note) {
  const sc = note ?? {};
  const present = (obj) => Object.keys(obj ?? {}).filter((k) => obj[k] !== null && obj[k] !== undefined && !(Array.isArray(obj[k]) && obj[k].length === 0)).sort();
  return {
    fieldsPresent: present(sc),
    attributesPresent: present(sc.attributes),
    active: sc.active ?? null,
    deletedIsSet: sc.deleted !== null && sc.deleted !== undefined,
    resources: Array.isArray(sc.resources) ? sc.resources.length : null,
    tasks: Array.isArray(sc.tasks) ? sc.tasks.length : null,
    createdYear: sc.created ? new Date(sc.created).getUTCFullYear() : null,
  };
}

async function main() {
  const { auth } = await connect();
  report.auth = auth;
  say('Signed in. This takes about 15 minutes; leave it running.');

  const accountTotal = numbers(await search('', 0, 1)).totalResultCount;
  report.accountTotal = accountTotal;
  report.activeOnlyQueryTotal = numbers(await search('intrash:false', 0, 1)).totalResultCount;
  report.datetimeOperatorAccepted = numbers(await search(rangeQuery('', new Date(Date.UTC(1900, 0, 1)), new Date(Date.UTC(2100, 0, 1))), 0, 1)).totalResultCount;

  // 1. The full pass by date, as the connector would run it.
  const byDate = new Map();
  const years = {};
  let started = Date.now();
  let callsBefore = stats.calls;
  const dateTally = await listByDate('', CAP, byDate, years);
  report.dateListing = {
    ...dateTally,
    distinctReached: byDate.size,
    reachedEveryNote: byDate.size === accountTotal,
    toolCalls: stats.calls - callsBefore,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
  report.notesPerYear = Object.fromEntries(Object.entries(years).filter(([, n]) => n > 0));

  // 1b. Force the splitting on the busiest year: months over 100 notes split into days, and so on.
  const [busiestYear, busiestCount] = Object.entries(years).sort((a, b) => b[1] - a[1])[0] ?? [];
  if (busiestYear) {
    const forced = new Map();
    const y = Number(busiestYear);
    const tally = { slices: 0, splits: {}, duplicates: 0, errors: 0, stillOverCap: 0, largestSlice: 0 };
    await listSlice('', new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1)), 0, 100, forced, tally);
    report.forcedSplitCheck = { year: y, yearTotal: busiestCount, cap: 100, ...tally, distinctReached: forced.size, reachedEveryNote: forced.size === busiestCount };
  }

  // 2. Notebook membership, which a date listing does not show.
  started = Date.now();
  callsBefore = stats.calls;
  const books = await notebookIds();
  const membership = new Map();
  let notesInTwoNotebooks = 0;
  for (const id of books.keys()) {
    const inBook = new Map();
    await listFilter(`nbGuid:"${id}"`, inBook);
    for (const noteId of inBook.keys()) {
      if (membership.has(noteId)) notesInTwoNotebooks += 1;
      membership.set(noteId, id);
    }
  }
  const spaces = await call('search_spaces', { query: '', maxResults: 100 });
  report.notebookListing = {
    notebooks: books.size,
    notebooksInASpace: [...books.values()].filter((b) => b.workspaceId).length,
    notebooksByAccess: [...books.values()].reduce((acc, b) => ({ ...acc, [b.primaryAccess ?? 'null']: (acc[b.primaryAccess ?? 'null'] ?? 0) + 1 }), {}),
    spacesListed: numbers(spaces).hitsReturned,
    notesReached: membership.size,
    notesInTwoNotebooks,
    toolCalls: stats.calls - callsBefore,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };

  // 3. Notes with no listed notebook.
  const orphans = [...byDate.keys()].filter((id) => !membership.has(id));
  report.notesInNoListedNotebook = orphans.length;
  report.notesInNotebooksButNotByDate = [...membership.keys()].filter((id) => !byDate.has(id)).length;
  report.orphans = [];
  for (const id of orphans.slice(0, 10)) {
    const got = await call('get_note', { noteId: id });
    const sc = got.result?.structuredContent ?? dataOf(got.result);
    const nb = sc?.notebookId;
    const entry = { getNoteOk: got.ok, errorText: got.errorText ?? null, ...shape(sc), notebookIdPresent: Boolean(nb), notebookInListedNotebooks: Boolean(nb && books.has(nb)) };
    if (nb) entry.notesFoundByThatNotebookFilter = numbers(await search(`nbGuid:"${nb}"`, 0, 1)).totalResultCount;
    report.orphans.push(entry);
  }

  // 4. The trash.
  const trash = new Map();
  const trashTally = await listFilter('intrash:true', trash);
  const sampleTrashed = [...trash.keys()][0];
  let trashedShape = null;
  if (sampleTrashed) {
    const got = await call('get_note', { noteId: sampleTrashed });
    trashedShape = { getNoteOk: got.ok, ...shape(got.result?.structuredContent ?? dataOf(got.result)) };
  }
  report.trash = {
    total: numbers(await search('intrash:true', 0, 1)).totalResultCount,
    distinctReached: trash.size,
    duplicates: trashTally.duplicates,
    inDateListing: [...trash.keys()].filter((id) => byDate.has(id)).length,
    inNotebookListing: [...trash.keys()].filter((id) => membership.has(id)).length,
    sampleTrashedNote: trashedShape,
  };

  report.cost = { toolCalls: stats.calls, rateLimitRetries: stats.rateLimitRetries };
}

try {
  await main();
} catch (error) {
  report.problems.push(`Stopped early: ${String(error?.message ?? error).slice(0, 500)}`);
}
writeReport('evernote-listing-report.json', report);
say('Attach that file in the chat.');
process.exit(0);
