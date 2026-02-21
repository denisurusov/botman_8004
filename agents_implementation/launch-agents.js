/**
 * launch-agents.js
 *
 * Reads every *.json file in the ../agents directory, extracts the port
 * from each card's `endpoint` field, then spawns the correct MCP server
 * process for each agent based on its capabilities.
 *
 * Usage:
 *   node launch-agents.js [--base-port 9000]
 *
 * --base-port is used ONLY as a fallback for cards that have no url/port.
 */

import { spawn } from 'node:child_process';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────
const AGENTS_DIR          = path.resolve(__dirname, '..', 'agents');
const REVIEWER_SERVER_JS  = path.resolve(__dirname, 'code-reviewer-server.js');
const APPROVER_SERVER_JS  = path.resolve(__dirname, 'code-approver-server.js');
// Legacy fallback for cards with no recognised capability
const FALLBACK_SERVER_JS  = path.resolve(__dirname, 'code-reviewer-server.js');

/** Pick the right server script for a given agent card. */
function serverScriptFor(card) {
  const caps = card.capabilities ?? [];
  if (caps.includes('approve-pr')) return APPROVER_SERVER_JS;
  if (caps.includes('code-review'))  return REVIEWER_SERVER_JS;
  return FALLBACK_SERVER_JS;
}

let BASE_PORT = 9000;
const bpIdx = process.argv.indexOf('--base-port');
if (bpIdx !== -1 && process.argv[bpIdx + 1]) {
  BASE_PORT = parseInt(process.argv[bpIdx + 1], 10);
}

// ── Discover agent cards ─────────────────────────────────────────────────────
const cardFiles = fs
  .readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (cardFiles.length === 0) {
  console.error(`No agent card JSON files found in: ${AGENTS_DIR}`);
  process.exit(1);
}

console.log(`Found ${cardFiles.length} agent card(s) in ${AGENTS_DIR}\n`);

// ── Extract port from card URL ────────────────────────────────────────────────
function portFromCard(card) {
  // Try common fields: endpoint, url, baseUrl, host
  const raw = card.endpoint ?? card.url ?? card.baseUrl ?? card.host ?? null;
  if (raw) {
    try {
      const port = new URL(raw).port;
      if (port) return parseInt(port, 10);
    } catch (_) {}
  }
  return null;
}

// ── Spawn one server per card ────────────────────────────────────────────────
const children = [];
const usedPorts = new Set();
let fallbackPort = BASE_PORT;

cardFiles.forEach((file) => {
  const cardPath = path.join(AGENTS_DIR, file);
  const card     = JSON.parse(fs.readFileSync(cardPath, 'utf8'));

  // Find a fallback port not already taken
  while (usedPorts.has(fallbackPort)) fallbackPort++;

  const port = portFromCard(card) ?? fallbackPort;

  if (usedPorts.has(port)) {
    console.error(`[${file}] Port ${port} conflicts with another agent — skipping.`);
    return;
  }
  usedPorts.add(port);
  if (port === fallbackPort) fallbackPort++;

  const serverScript = serverScriptFor(card);
  const child = spawn(
    process.execPath,
    [serverScript, cardPath, String(port)],
    { stdio: 'inherit', detached: false }
  );

  child.on('error', (err) => {
    console.error(`[${file}] Failed to start: ${err.message}`);
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[${file}] Exited with code ${code}`);
    }
  });

  console.log(`Spawned [${file}] → http://localhost:${port}  (pid ${child.pid})  [${path.basename(serverScript)}]`);
  children.push(child);
});

console.log('\nAll agents running. Press Ctrl-C to stop.\n');

// ── Shutdown ──────────────────────────────────────────────────────────────────
function shutdown() {
  console.log('\nShutting down all agents…');
  children.forEach((c) => { try { c.kill('SIGTERM'); } catch (_) {} });
  setTimeout(() => {
    children.forEach((c) => { try { c.kill('SIGKILL'); } catch (_) {} });
    process.exit(0);
  }, 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

