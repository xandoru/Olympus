# Evernote MCP research (October 2026)

Evidence for the live Evernote connector issue. Gathered with three read-only scripts against one real account of about 4,900 notes in 180 notebooks. Real notes were only ever counted; the only note content in these reports is from two throwaway test notebooks, deleted afterwards.

## Reports

| File | What it shows |
|---|---|
| `reports/0-tools-list.json` | The server's `tools/list` response (27 tools) |
| `reports/1-tools-and-test-notebooks.json` | Read scope, token lifetime, full tool output on test notes, a note move, an attachment download, write refused under read scope |
| `reports/2-coverage.json` | The 2,000-result cap; listing by year reaches every note, by notebook misses two |
| `reports/3-listing-design.json` | Year/month/day splitting, cost of a full pass, the two notes with no notebook, the trash |

## Scripts

`scripts/` holds the probes and a fake server with the same tool shapes, used to test them. To run one against your own account: `npm ci`, then `node probe.mjs` (needs notebooks "MCP Test A" and "MCP Test B"), `node coverage.mjs` or `node characterize.mjs`. Each signs in with the `read` scope only, keeps the token in memory, and writes a JSON report. To run against the fake server instead: `node mock-server.mjs`, then set `EVERNOTE_PROBE_MOCK_URL=http://127.0.0.1:8977/mcp`.

These are research scripts, not product code.
