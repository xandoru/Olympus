// Shared plumbing for the Evernote MCP probes: read-only sign-in, tool calls, and
// helpers that keep real-account answers to numbers only. Not part of Olympus.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

// EVERNOTE_PROBE_MOCK_URL is for testing the script against a local fake server, without sign-in.
const MOCK = process.env.EVERNOTE_PROBE_MOCK_URL;
const SERVER = MOCK ?? 'https://mcp.evernote.com/mcp';
const SCOPE = 'read';
const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}/callback`;
export const PAUSE_MS = 300;


export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const say = (text) => console.log(`\n${text}`);

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
  provider.authInfo = {
    requestedScope: SCOPE,
    grantedScope: tokens?.scope ?? null,
    accessTokenLifetimeSeconds: tokens?.expires_in ?? null,
    refreshTokenIssued: Boolean(tokens?.refresh_token),
  };
  return provider;
}

export const stats = { calls: 0, rateLimitRetries: 0 };

// --- Calling tools ----------------------------------------------------------------

let client;

export async function connect() {
  const provider = MOCK ? undefined : await signIn();
  client = new Client({ name: 'olympus-evernote-probe', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER), provider ? { authProvider: provider } : {}));
  return { client, auth: provider?.authInfo ?? { mock: true } };
}

export async function call(name, args) {
  for (let attempt = 1; ; attempt += 1) {
    stats.calls += 1;
    try {
      const result = await client.callTool({ name, arguments: args });
      const errorText = result.isError ? textOf(result).slice(0, 300) : undefined;
      if (result.isError && /rate|too many|429/i.test(errorText) && attempt < 4) {
        stats.rateLimitRetries += 1;
        await sleep(15000 * attempt);
        continue;
      }
      return { ok: !result.isError, result, errorText };
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      if (/rate|too many|429/i.test(message) && attempt < 4) {
        stats.rateLimitRetries += 1;
        await sleep(15000 * attempt);
        continue;
      }
      return { ok: false, result: undefined, errorText: message };
    }
  }
}

export function textOf(result) {
  return (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

export function dataOf(result) {
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(textOf(result)); } catch { return undefined; }
}

// Full output, for test notebooks only. Pre-signed download links lose their signature.
export function redactLinks(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, v) =>
    typeof v === 'string' ? v.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?<signature removed>') : v));
}

export function full(outcome) {
  return {
    ok: outcome.ok,
    errorText: outcome.errorText ?? null,
    content: redactLinks(outcome.result?.content),
    structuredContent: redactLinks(outcome.result?.structuredContent),
  };
}

// Numbers only, for questions about the real account.
export function numbers(outcome) {
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

export function findHashes(value, found = new Set()) {
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

export function findUrl(value) {
  if (typeof value === 'string') {
    const match = value.match(/https?:\/\/[^\s"']+/);
    return match ? match[0] : undefined;
  }
  if (Array.isArray(value)) { for (const item of value) { const u = findUrl(item); if (u) return u; } }
  else if (value && typeof value === 'object') { for (const v of Object.values(value)) { const u = findUrl(v); if (u) return u; } }
  return undefined;
}

export const hitsOf = (outcome) => (dataOf(outcome.result)?.hits ?? []);
export const titleIs = (hit, wanted) => String(hit.title ?? '').trim().toLowerCase() === wanted;

export function writeReport(file, report) {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  say(`Done. Report written to ${process.cwd()}/${file}`);
}

