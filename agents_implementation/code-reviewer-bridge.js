/**
 * code-reviewer-bridge.js
 *
 * Oracle bridge for CodeReviewerOracle.sol.
 *
 * Watches the on-chain ReviewRequested event, calls the appropriate
 * code-reviewer MCP server (tool: review_pr), then submits the
 * fulfillReview() transaction back to the contract.
 *
 * Distributed tracing: reads traceId from the event and propagates it
 * to the MCP server via X-Trace-Id header and tool argument.
 *
 * Usage:
 *   node code-reviewer-bridge.js \
 *     --contract  0xYourCodeReviewerOracleAddress \
 *     --rpc       http://127.0.0.1:8545 \
 *     --privkey   0xYourOraclePrivateKey
 */

import { ethers } from 'ethers';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI / env config ──────────────────────────────────────────────────────────
function arg(flag, envVar) {
  const idx = process.argv.indexOf(flag);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : process.env[envVar];
}

const CONTRACT_ADDRESS = arg('--contract', 'REVIEWER_CONTRACT_ADDRESS');
const RPC_URL          = arg('--rpc',      'RPC_URL')      ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY      = arg('--privkey',  'ORACLE_PRIVATE_KEY');

if (!CONTRACT_ADDRESS) { console.error('Missing --contract / REVIEWER_CONTRACT_ADDRESS'); process.exit(1); }
if (!PRIVATE_KEY)      { console.error('Missing --privkey  / ORACLE_PRIVATE_KEY');         process.exit(1); }

// ── Load reviewer agent cards ─────────────────────────────────────────────────
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const reviewerAgents = fs
  .readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('.'))
  .map(f => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')))
  .filter(c => c.capabilities?.includes('code-review'));

if (reviewerAgents.length === 0) {
  console.error('No code-review agent cards found in', AGENTS_DIR);
  process.exit(1);
}
console.log(`Loaded ${reviewerAgents.length} reviewer agent(s):`, reviewerAgents.map(a => `${a.name} @ ${a.endpoint}`));

function pickReviewerEndpoint(hint) {
  if (hint) {
    const match = reviewerAgents.find(a => a.endpoint === hint);
    if (match) return match.endpoint;
  }
  // Round-robin among available reviewers (simple: pick first for now)
  return reviewerAgents[0].endpoint;
}

// ── Minimal ABI — only what the bridge needs ──────────────────────────────────
const ABI = [
  // Events (with traceId)
  'event ReviewRequested(bytes32 indexed requestId, address indexed requester, string prId, bytes32 indexed traceId, string focus, uint256 timestamp)',
  // Fulfillment (no traceId param — contract reads it from storage)
  'function fulfillReview(uint256 agentId, bytes32 requestId, string prId, bytes summaryJson, bytes commentsJson, bool approved)',
];

// ── Call the MCP server's review_pr tool ──────────────────────────────────────
async function callReviewTool(endpoint, prId, focus, traceId) {
  const focusArr = focus ? focus.split(',').map(s => s.trim()).filter(Boolean) : [];
  const body = {
    jsonrpc: '2.0', id: 1,
    method:  'tools/call',
    params: {
      name:      'review_pr',
      arguments: {
        pr_id: prId,
        trace_id: traceId,
        ...(focusArr.length ? { focus: focusArr } : {}),
      },
    },
  };

  const res  = await fetch(`${endpoint}/mcp`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id':   traceId,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);

  const raw = json?.result?.content?.[0]?.text;
  if (!raw) throw new Error('Empty MCP response');
  return JSON.parse(raw); // { pr_id, summary, comments, approved }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`[reviewer-bridge] Connected to ${RPC_URL}`);
  console.log(`[reviewer-bridge] Contract : ${CONTRACT_ADDRESS}`);
  console.log(`[reviewer-bridge] Oracle   : ${wallet.address}`);
  console.log(`[reviewer-bridge] Listening for ReviewRequested events…\n`);

  contract.on('ReviewRequested', async (requestId, requester, prId, traceId, focus, timestamp) => {
    console.log(`\n[reviewer-bridge] ← ReviewRequested  requestId=${requestId}  prId="${prId}"  traceId=${traceId}`);

    const endpoint = pickReviewerEndpoint(null);
    console.log(`[reviewer-bridge]   routing to MCP server: ${endpoint}`);

    try {
      const result = await callReviewTool(endpoint, prId, focus, traceId);

      const summaryBytes   = ethers.toUtf8Bytes(JSON.stringify(result.summary   ?? ''));
      const commentsBytes  = ethers.toUtf8Bytes(JSON.stringify(result.comments  ?? []));
      const approved       = !!result.approved;

      console.log(`[reviewer-bridge]   [${traceId}] MCP result: approved=${approved}, comments=${result.comments?.length ?? 0}`);

      // agentId = 0 for now (would be the registered ERC-8004 agentId in production)
      const tx = await contract.fulfillReview(0, requestId, prId, summaryBytes, commentsBytes, approved);
      console.log(`[reviewer-bridge]   [${traceId}] → fulfillReview tx: ${tx.hash}`);
      await tx.wait();
      console.log(`[reviewer-bridge]   [${traceId}] ✓ fulfilled  requestId=${requestId}`);

    } catch (err) {
      console.error(`[reviewer-bridge]   ✗ Error processing ${requestId}: ${err.message}`);
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
