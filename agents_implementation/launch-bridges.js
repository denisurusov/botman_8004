/**
 * launch-bridges.js
 *
 * Starts the code-reviewer-bridge and code-approver-bridge as background
 * processes, reading contract addresses and config from env vars or CLI flags.
 *
 * Usage:
 *   node launch-bridges.js \
 *     --reviewer-contract  0xReviewerOracleAddress \
 *     --approver-contract  0xApproverOracleAddress \
 *     --rpc                http://127.0.0.1:8545 \
 *     --privkey            0xOraclePrivateKey
 *
 * Env var equivalents:
 *   REVIEWER_CONTRACT_ADDRESS
 *   APPROVER_CONTRACT_ADDRESS
 *   RPC_URL
 *   ORACLE_PRIVATE_KEY
 */

import { spawn } from 'node:child_process';
import path      from 'node:path';
import fs        from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ───────────────────────────────────────────────────────────────────
function arg(flag, envVar) {
  const idx = process.argv.indexOf(flag);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : process.env[envVar];
}

const REVIEWER_CONTRACT = arg('--reviewer-contract', 'REVIEWER_CONTRACT_ADDRESS');
const APPROVER_CONTRACT = arg('--approver-contract', 'APPROVER_CONTRACT_ADDRESS');
const RPC_URL           = arg('--rpc',               'RPC_URL')            ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY       = arg('--privkey',           'ORACLE_PRIVATE_KEY');

if (!REVIEWER_CONTRACT) { console.error('Missing --reviewer-contract / REVIEWER_CONTRACT_ADDRESS'); process.exit(1); }
if (!APPROVER_CONTRACT) { console.error('Missing --approver-contract / APPROVER_CONTRACT_ADDRESS'); process.exit(1); }
if (!PRIVATE_KEY)       { console.error('Missing --privkey / ORACLE_PRIVATE_KEY');                  process.exit(1); }

// ── Bridge definitions ────────────────────────────────────────────────────────
const bridges = [
  {
    name:   'code-reviewer-bridge',
    script: path.resolve(__dirname, 'code-reviewer-bridge.js'),
    args:   ['--contract', REVIEWER_CONTRACT, '--rpc', RPC_URL, '--privkey', PRIVATE_KEY],
  },
  {
    name:   'code-approver-bridge',
    script: path.resolve(__dirname, 'code-approver-bridge.js'),
    args:   ['--contract', APPROVER_CONTRACT, '--rpc', RPC_URL, '--privkey', PRIVATE_KEY],
  },
];

// ── Ensure logs directory exists ──────────────────────────────────────────────
const LOGS_DIR = path.resolve(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Spawn bridges ─────────────────────────────────────────────────────────────
const children = [];

bridges.forEach(({ name, script, args }) => {
  const outPath = path.join(LOGS_DIR, `${name}.log`);
  const errPath = path.join(LOGS_DIR, `${name}.err.log`);

  const out = fs.openSync(outPath, 'a');
  const err = fs.openSync(errPath, 'a');

  const child = spawn(process.execPath, [script, ...args], {
    detached: false,
    stdio: ['ignore', out, err],
  });

  child.on('error', e => console.error(`[${name}] Failed to start: ${e.message}`));
  child.on('exit',  c => { if (c && c !== 0) console.warn(`[${name}] Exited with code ${c}`); });

  console.log(`Spawned [${name}] pid=${child.pid}  stdout→${outPath}`);
  children.push(child);
});

console.log('\nAll bridges running.  Press Ctrl-C to stop.\n');

// ── Shutdown ──────────────────────────────────────────────────────────────────
function shutdown() {
  console.log('\nShutting down bridges…');
  children.forEach(c => { try { c.kill('SIGTERM'); } catch (_) {} });
  setTimeout(() => {
    children.forEach(c => { try { c.kill('SIGKILL'); } catch (_) {} });
    process.exit(0);
  }, 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

