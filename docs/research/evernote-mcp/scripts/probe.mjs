// Evernote MCP probe for the Olympus Evernote connector.
//
// What it does, in order:
//   1. Signs in to Evernote's official MCP server asking for the "read" scope only.
//      The sign-in lives in memory and is gone when the script exits.
//   2. Reads the two test notebooks ("MCP Test A", "MCP Test B") and their notes in full.
//   3. Asks you to move "Test note 2" to "MCP Test B", then reads it again.
//   4. Asks the rest of your account questions whose answers are NUMBERS ONLY:
//      counts and page flags. No titles, snippets, ids or text of your real notes
//      or notebooks are written to the report.
//   5. Tries to create one note in "MCP Test A", to see whether a read-only sign-in blocks it.
//   6. Writes everything to evernote-mcp-probe-report.json in this folder.
//
// It calls no tool that edits, moves or deletes anything. The one write attempt (step 5)
// targets the test notebook only.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

// EVERNOTE_PROBE_MOCK_URL is for testing the script against a local fake server, without sign-in.
const MOCK = process.env.EVERNOTE_PROBE_MOCK_URL;
const SERVER = MOCK ?? 'https://mcp.evernote.com/mcp';
const SCOPE = 'read';
const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}/callback`;
const REPORT = 'evernote-mcp-probe-report.json';
const PAUSE_MS = 300;

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  auth: {},
  tools: {},
  testNotebooks: {},
  move: {},
  attachments: [],
  recognition: {},
  account: {},
  writeCheck: {},
  problems: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => console.log(`\n${text}`);

// --- Sign-in (OAuth with PKCE, dynamic client registration, read scope) -------

function signInProvider() {
  let clientInfo;
  let tokens;
  let verifier;
  const state = randomBytes(16).toString('hex');
  let pendingAuthUrl;
  return {
    state: () => state,
    expectedState: state,
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return {
        client_name: 'Olympus Evernote probe (local, read-only)',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      };
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => { clientInfo = info; },
    tokens: () => tokens,
    saveTokens: (next) => { tokens = next; },
    redirectToAuthorization: (url) => { pendingAuthUrl = url; },
    takeAuthUrl: () => pendingAuthUrl,
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
    currentTokens: () => tokens,
  };
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const servers = [];
    const finish = (error, code) => {
      for (const server of servers) server.close();
      if (error) reject(error); else resolve(code);
    };
    const handler = (req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (error || !code || state !== expectedState) {
        res.end('<p>Sign-in did not complete. You can close this tab and look at the Terminal.</p>');
        finish(new Error(`Sign-in failed: ${error ?? (code ? 'state mismatch' : 'no code returned')}`));
        return;
      }
      res.end('<p>Signed in. You can close this tab and go back to the Terminal.</p>');
      finish(undefined, code);
    };
    // Loopback only, on both IPv4 and IPv6, so "localhost" works either way.
    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer(handler);
      server.on('error', () => {});
      server.listen(PORT, host);
      servers.push(server);
    }
    setTimeout(() => finish(new Error('Sign-in timed out after 10 minutes.')), 10 * 60 * 1000).unref();
  });
}

async function signIn() {
  const provider = signInProvider();
  const callback = waitForCallback(provider.expectedState);
  const first = await auth(provider, { serverUrl: SERVER, scope: SCOPE });
  if (first === 'REDIRECT') {
    const url = provider.takeAuthUrl();
    say('Opening Evernote in your browser. Leave ONLY "View" checked, tick the trust box, and click Allow access.');
    say(`If no browser tab opens, paste this into your browser:\n${url}`);
    execFile('open', [url.toString()], () => {});
    const code = await callback;
    const second = await auth(provider, { serverUrl: SERVER, authorizationCode: code, scope: SCOPE });
    if (second !== 'AUTHORIZED') throw new Error('Sign-in did not finish.');
  }
  const tokens = provider.currentTokens();
  report.auth = {
    requestedScope: SCOPE,
    grantedScope: tokens?.scope ?? null,
    accessTokenLifetimeSeconds: tokens?.expires_in ?? null,
    refreshTokenIssued: Boolean(tokens?.refresh_token),
  };
  return provider;
}

// --- Calling tools ----------------------------------------------------------------

let client;

async function call(name, args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await client.callTool({ name, arguments: args });
      const errorText = result.isError ? textOf(result).slice(0, 300) : undefined;
      if (result.isError && /rate|too many|429/i.test(errorText) && attempt < 4) {
        await sleep(15000 * attempt);
        continue;
      }
      return { ok: !result.isError, result, errorText };
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      if (/rate|too many|429/i.test(message) && attempt < 4) {
        await sleep(15000 * attempt);
        continue;
      }
      return { ok: false, result: undefined, errorText: message };
    }
  }
}

function textOf(result) {
  return (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

function dataOf(result) {
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(textOf(result)); } catch { return undefined; }
}

// Full output, for test notebooks only. Pre-signed download links lose their signature.
function redactLinks(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, v) =>
    typeof v === 'string' ? v.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?<signature removed>') : v));
}

function full(outcome) {
  return {
    ok: outcome.ok,
    errorText: outcome.errorText ?? null,
    content: redactLinks(outcome.result?.content),
    structuredContent: redactLinks(outcome.result?.structuredContent),
  };
}

// Numbers only, for questions about the real account.
function numbers(outcome) {
  const data = dataOf(outcome.result) ?? {};
  return {
    ok: outcome.ok,
    errorText: outcome.errorText ?? null,
    hitsReturned: Array.isArray(data.hits) ? data.hits.length : null,
    totalResultCount: typeof data.totalResultCount === 'number' ? data.totalResultCount : null,
    startIndex: typeof data.startIndex === 'number' ? data.startIndex : null,
    isLastPage: typeof data.isLastPage === 'boolean' ? data.isLastPage : null,
  };
}

function findHashes(value, found = new Set()) {
  if (typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)) return found;
  if (Array.isArray(value)) value.forEach((item) => findHashes(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (/hash/i.test(key) && typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)) found.add(v);
      else findHashes(v, found);
    }
  }
  return found;
}

function findUrl(value) {
  if (typeof value === 'string') {
    const match = value.match(/https?:\/\/[^\s"']+/);
    return match ? match[0] : undefined;
  }
  if (Array.isArray(value)) { for (const item of value) { const u = findUrl(item); if (u) return u; } }
  else if (value && typeof value === 'object') { for (const v of Object.values(value)) { const u = findUrl(v); if (u) return u; } }
  return undefined;
}

const hitsOf = (outcome) => (dataOf(outcome.result)?.hits ?? []);
const titleIs = (hit, wanted) => String(hit.title ?? '').trim().toLowerCase() === wanted;

// --- The probe --------------------------------------------------------------------

async function probeTestNotebooks() {
  const notebooks = await call('search_notebooks', { query: 'MCP Test', maxResults: 10 });
  report.testNotebooks.searchNotebooks = full(notebooks);
  const hits = hitsOf(notebooks);
  const a = hits.find((h) => h.label === 'MCP Test A');
  const b = hits.find((h) => h.label === 'MCP Test B');
  if (!a || !b) {
    report.problems.push('Notebooks "MCP Test A" and "MCP Test B" were not both found; test-notebook steps skipped.');
    return {};
  }
  const inA = await call('search_notes', { query: a.searchFilter, maxResults: 20 });
  const inB = await call('search_notes', { query: b.searchFilter, maxResults: 20 });
  report.testNotebooks.notesInA = full(inA);
  report.testNotebooks.notesInB = full(inB);
  const all = [...hitsOf(inA), ...hitsOf(inB)];
  const note1 = all.find((h) => titleIs(h, 'test note 1'));
  const note2 = all.find((h) => titleIs(h, 'test note 2'));
  if (!note1 || !note2) report.problems.push('"Test note 1" or "Test note 2" was not found by exact title.');
  return { a, b, note1, note2, note2StartsInB: Boolean(note2 && hitsOf(inB).some((h) => h.noteId === note2.noteId)) };
}

async function probeNote1(note1, a) {
  const got = await call('get_note', { noteId: note1.noteId });
  report.testNotebooks.getNote1 = full(got);
  const raw = JSON.stringify(got.result ?? {});
  report.recognition.handwritingWordInGetNote = /pineapple/i.test(raw);
  report.recognition.typedWordInGetNote = /bravo/i.test(raw);
  const search = await call('search_notes', { query: `${a.searchFilter} pineapple`, maxResults: 5 });
  report.recognition.searchFindsHandwriting = numbers(search).hitsReturned > 0;
  report.recognition.searchOutcome = full(search);

  for (const hash of findHashes(got.result?.structuredContent ?? dataOf(got.result))) {
    const link = await call('get_attachment', { noteId: note1.noteId, hash });
    const entry = { hash, getAttachment: full(link) };
    const url = findUrl(link.result?.structuredContent) ?? findUrl(textOf(link.result));
    if (url) {
      entry.downloadHost = new URL(url).host;
      try {
        const response = await fetch(url);
        const bytes = Buffer.from(await response.arrayBuffer());
        entry.download = {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bytes: bytes.length,
          md5MatchesHash: createHash('md5').update(bytes).digest('hex') === hash,
        };
      } catch (error) {
        entry.download = { error: String(error?.message ?? error).slice(0, 300) };
      }
    }
    report.attachments.push(entry);
  }
}

async function probeMove(ctx) {
  const { note2, a, b } = ctx;
  report.move.before = full(await call('get_note', { noteId: note2.noteId }));
  if (ctx.note2StartsInB) {
    report.problems.push('"Test note 2" was already in MCP Test B, so the move test has no before/after.');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  say('ACTION NEEDED: in the Evernote app, move "Test note 2" from MCP Test A to MCP Test B.');
  await rl.question('Wait one minute after moving it, then press Enter here... ');
  rl.close();
  report.move.after = full(await call('get_note', { noteId: note2.noteId }));
  report.move.notesInAAfter = full(await call('search_notes', { query: a.searchFilter, maxResults: 20 }));
  report.move.notesInBAfter = full(await call('search_notes', { query: b.searchFilter, maxResults: 20 }));
}

async function probeAccount() {
  const acc = report.account;
  const first = await call('search_notes', { query: '', maxResults: 1 });
  acc.allNotesFirstPage = numbers(first);
  const total = acc.allNotesFirstPage.totalResultCount;

  acc.maxPageSize = numbers(await call('search_notes', { query: '', maxResults: 100 }));
  acc.trashCount = numbers(await call('search_notes', { query: 'intrash:true', maxResults: 1 }));
  acc.updatedLastDay = numbers(await call('search_notes', { query: 'updated:day-1', maxResults: 1, clientTimeZone: 'America/Los_Angeles' }));

  if (typeof total === 'number' && total > 0) {
    acc.lastNote = numbers(await call('search_notes', { query: '', maxResults: 1, startIndex: total - 1 }));
    acc.pastTheEnd = numbers(await call('search_notes', { query: '', maxResults: 1, startIndex: total }));

    // A full walk, oldest first, counting distinct note ids. Ids stay in memory only.
    const seen = new Set();
    let pages = 0;
    let duplicates = 0;
    let errors = 0;
    let lastPageFlagSeen = false;
    for (let start = 0; start < total && pages < 120; start += 100) {
      const page = await call('search_notes', { query: '', maxResults: 100, startIndex: start, sortBy: 'created', ascending: true });
      pages += 1;
      if (!page.ok) { errors += 1; continue; }
      for (const hit of hitsOf(page)) { if (seen.has(hit.noteId)) duplicates += 1; else seen.add(hit.noteId); }
      if (dataOf(page.result)?.isLastPage) lastPageFlagSeen = true;
      await sleep(PAUSE_MS);
    }
    acc.fullWalk = { totalResultCount: total, pages, distinctNotes: seen.size, duplicates, pageErrors: errors, lastPageFlagSeen };
  }

  // Notebooks: one call returns at most 100, with no paging. Try covering all by name fragments.
  const allBooks = await call('search_notebooks', { query: '', maxResults: 100 });
  acc.notebooksOneCall = numbers(allBooks);
  const notebookTotal = acc.notebooksOneCall.totalResultCount;
  const books = new Set(hitsOf(allBooks).map((h) => h.notebookId));
  const queriesAtCap = [];
  const recent = await call('search_notebooks', { query: '', maxResults: 100, sortBy: 'updated' });
  hitsOf(recent).forEach((h) => books.add(h.notebookId));
  for (const fragment of 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) {
    const page = await call('search_notebooks', { query: fragment, maxResults: 100 });
    const hits = hitsOf(page);
    if (hits.length >= 100) queriesAtCap.push(fragment.length);
    hits.forEach((h) => books.add(h.notebookId));
    await sleep(PAUSE_MS);
  }
  acc.notebookCoverage = {
    totalResultCount: notebookTotal,
    distinctFoundByNameFragments: books.size,
    fragmentQueriesThatHitTheCap: queriesAtCap.length,
  };
}

async function probeWrite(a) {
  const attempt = await call('create_note', { title: 'scope test', notebookId: a.notebookId });
  report.writeCheck = {
    createNoteSucceeded: attempt.ok,
    errorText: attempt.errorText ?? null,
    note: attempt.ok ? 'A note titled "scope test" was created in MCP Test A. Delete it with the test notebooks.' : null,
  };
}

async function main() {
  const options = MOCK ? {} : { authProvider: await signIn() };
  client = new Client({ name: 'olympus-evernote-probe', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER), options));
  const listed = await client.listTools();
  report.tools = { count: listed.tools.length, names: listed.tools.map((t) => t.name) };
  say('Signed in. Reading the test notebooks...');

  const ctx = await probeTestNotebooks();
  if (ctx.note1) await probeNote1(ctx.note1, ctx.a);
  if (ctx.note2) await probeMove(ctx);
  say('Counting your account (numbers only)... this takes a minute or two.');
  await probeAccount();
  if (ctx.a) await probeWrite(ctx.a);

  await client.close();
}

try {
  await main();
} catch (error) {
  report.problems.push(`Stopped early: ${String(error?.message ?? error).slice(0, 500)}`);
}
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
say(`Done. Report written to ${process.cwd()}/${REPORT}`);
say('Attach that file in the chat. Then delete the two MCP Test notebooks in Evernote.');
process.exit(0);
