// A fake Evernote MCP server with the same tool shapes, for testing probe.mjs. Not shipped.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const photo = Buffer.from('fake png bytes');
const photoHash = createHash('md5').update(photo).digest('hex');
const A = randomUUID(); const B = randomUUID();
const notebooks = [{ id: A, label: 'MCP Test A' }, { id: B, label: 'MCP Test B' }];
for (let i = 0; i < 180; i += 1) notebooks.push({ id: randomUUID(), label: `Secret notebook ${i} 📒` });
const notes = [];
const Y2010 = Date.UTC(2010, 0, 1);
for (let i = 0; i < 4881; i += 1) {
  const nb = i < 2100 ? notebooks[2].id : notebooks[3 + (i % 179)].id;
  const created = Y2010 + i * 100_000_000; // spread over ~15 years
  notes.push({ id: randomUUID(), title: `SECRET real note ${i}`, nb, created, updated: created });
}
const ghostBook = randomUUID();
notes.push({ id: randomUUID(), title: 'SECRET orphan 1', nb: ghostBook, created: Y2010 + 5, updated: Y2010 + 5 });
notes.push({ id: randomUUID(), title: 'SECRET orphan 2', nb: ghostBook, created: Y2010 + 6, updated: Y2010 + 6 });
const trash = Array.from({ length: 414 }, (_, i) => ({ id: randomUUID(), title: `SECRET trashed ${i}`, nb: notebooks[5].id, created: Y2010 + i, updated: Y2010 + i }));
const n1 = { id: randomUUID(), title: 'Test note 1', nb: A, created: 2e12, updated: 2e12 };
const n2 = { id: randomUUID(), title: 'Test note 2', nb: A, created: 2e12 + 1, updated: 2e12 + 1 };
notes.push(n1, n2);
let moved = false;

const hit = (n) => ({ noteId: n.id, title: n.title, snippet: `snippet of ${n.title}`, createdAt: new Date(n.created).toISOString(), updatedAt: new Date(n.updated).toISOString(), score: null });
const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

function build() {
  const server = new McpServer({ name: 'evernote-mcp', version: '0.1.0' });
  server.registerTool('search_notebooks', { inputSchema: { query: z.string().default(''), maxResults: z.number().default(10), sortBy: z.string().default('name') } }, async ({ query, maxResults }) => {
    const all = notebooks.filter((b) => b.label.toLowerCase().includes(query.toLowerCase()));
    const hits = all.slice(0, maxResults).map((b) => ({ notebookId: b.id, label: b.label, searchFilter: `nbGuid:"${b.id}"`, score: null, stack: null, primaryAccess: 'OWNED', workspaceId: null, workspaceName: null }));
    return json({ hits, totalResultCount: all.length, startIndex: 0, isLastPage: true });
  });
  server.registerTool('search_notes', { inputSchema: { query: z.string(), maxResults: z.number().default(10), startIndex: z.number().default(0), sortBy: z.string().default('updated'), ascending: z.boolean().default(false), clientTimeZone: z.string().optional() } }, async ({ query, maxResults, startIndex }) => {
    if (moved) n2.nb = B;
    let all = notes;
    const nb = query.match(/nbGuid:"([^"]+)"/);
    if (nb) all = all.filter((n) => n.nb === nb[1]);
    if (/pineapple/.test(query)) all = all.filter((n) => n === n1);
    if (/intrash:true/.test(query)) all = trash;
    if (nb && nb[1] === ghostBook) all = [];
    const ymd = (t) => Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
    for (const m of query.matchAll(/(-?)created:(\d{8})(?:T(\d{2})(\d{2})(\d{2})Z)?/g)) {
      const t = ymd(m[2]) + (m[3] ? ((+m[3]) * 3600 + (+m[4]) * 60 + (+m[5])) * 1000 : 0);
      all = all.filter((n) => (m[1] ? n.created < t : n.created >= t));
    }
    all = [...all].sort((x, y) => x.created - y.created);
    if (startIndex >= 2000) return json({ hits: [], totalResultCount: 0, startIndex, isLastPage: true });
    if (/updated:day-1/.test(query)) all = all.slice(0, 3);
    const hits = all.slice(startIndex, Math.min(2000, startIndex + Math.min(maxResults, 100))).map(hit);
    return json({ hits, totalResultCount: all.length, startIndex, isLastPage: startIndex + hits.length >= all.length });
  });
  server.registerTool('get_note', { inputSchema: { noteId: z.string() } }, async ({ noteId }) => {
    const n = notes.find((x) => x.id === noteId) ?? trash.find((x) => x.id === noteId);
    const isTrash = trash.includes(n);
    if (n === n2 && moved) { n2.nb = B; n2.updated = 3e12; }
    const res = n === n1 ? [{ hash: photoHash, mime: 'image/png', fileName: 'handwriting.png', size: photo.length }] : [];
    return { content: [{ type: 'text', text: `<en-note>alpha bravo charlie<en-media hash="${photoHash}"/></en-note>` }], structuredContent: { id: noteId, title: n.title, notebookId: n.nb, version: 1, created: new Date(n.created).toISOString(), active: !isTrash, deleted: isTrash ? new Date().toISOString() : null, resources: res, tasks: [], attributes: { author: 'X', sourceUrl: null } } };
  });
  server.registerTool('search_spaces', { inputSchema: { query: z.string().default(''), maxResults: z.number().default(10) } }, async () =>
    json({ hits: [], totalResultCount: 0, startIndex: 0, isLastPage: true }));
  server.registerTool('get_attachment', { inputSchema: { noteId: z.string(), hash: z.string() } }, async () =>
    json({ url: `http://127.0.0.1:${PORT}/file?X-Amz-Signature=secret123`, expiresAt: 'soon' }));
  server.registerTool('create_note', { inputSchema: { title: z.string(), notebookId: z.string().optional() } }, async () =>
    ({ isError: true, content: [{ type: 'text', text: 'insufficient_scope: create' }] }));
  return server;
}

const PORT = 8977;
createServer(async (req, res) => {
  if (req.url.startsWith('/file')) { res.end(photo); return; }
  if (req.url === '/move') { moved = true; res.end('ok'); return; }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build().connect(transport);
  await transport.handleRequest(req, res);
}).listen(PORT, '127.0.0.1', () => console.log('mock up'));
