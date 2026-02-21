/**
 * code-approver-bridge.js
 *
 * Oracle bridge for CodeApproverOracle.sol.
 *
 * Watches the on-chain ApprovalRequested event, calls the appropriate
 * code-approver MCP server (tool: approve_pr), then submits one of:
 *   fulfillApproval()      — decision === 'approved'
 *   fulfillNeedsRevision() — decision === 'needs_revision'
 *   fulfillRejection()     — decision === 'rejected'
 *
 * Usage:
 *   node code-approver-bridge.js \
 *     --contract  0xYourCodeApproverOracleAddress \
 *     --rpc       http://127.0.0.1:8545 \
 *     --privkey   0xYourOraclePrivateKey
 *
 * Env vars (alternative to CLI flags):
 *   APPROVER_CONTRACT_ADDRESS
 *   RPC_URL
 *   ORACLE_PRIVATE_KEY
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

const CONTRACT_ADDRESS = arg('--contract', 'APPROVER_CONTRACT_ADDRESS');
const RPC_URL          = arg('--rpc',      'RPC_URL')      ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY      = arg('--privkey',  'ORACLE_PRIVATE_KEY');

if (!CONTRACT_ADDRESS) { console.error('Missing --contract / APPROVER_CONTRACT_ADDRESS'); process.exit(1); }
if (!PRIVATE_KEY)      { console.error('Missing --privkey  / ORACLE_PRIVATE_KEY');         process.exit(1); }

// ── Load approver agent cards ─────────────────────────────────────────────────
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
const approverAgents = fs
  .readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('.'))
  .map(f => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')))
  .filter(c => c.capabilities?.includes('approve-pr'));

if (approverAgents.length === 0) {
  console.error('No approve-pr agent cards found in', AGENTS_DIR);
  process.exit(1);
}
console.log(`Loaded ${approverAgents.length} approver agent(s):`, approverAgents.map(a => `${a.name} @ ${a.endpoint}`));

function pickApproverEndpoint() {
  return approverAgents[0].endpoint;
}

// ── Minimal ABI ───────────────────────────────────────────────────────────────
const ABI = [
  // Events
  'event ApprovalRequested(bytes32 indexed requestId, address indexed requester, string prId, string reviewerAgent, uint256 timestamp)',
  // Fulfillment callbacks
  'function fulfillApproval(bytes32 requestId, string prId, bytes reasonJson)',
  'function fulfillNeedsRevision(bytes32 requestId, string prId, bytes reasonJson, bytes unresolvedJson)',
  'function fulfillRejection(bytes32 requestId, string prId, bytes reasonJson)',
];

// ── Call the MCP server's approve_pr tool ─────────────────────────────────────
async function callApproveTool(endpoint, prId, reviewerAgent) {
  const body = {
    jsonrpc: '2.0', id: 1,
    method:  'tools/call',
    params: {
      name:      'approve_pr',
      arguments: {
        pr_id:          prId,
        reviewer_agent: reviewerAgent || undefined,
      },
    },
  };

  const res  = await fetch(`${endpoint}/mcp`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await res.json();

  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);

  const raw = json?.result?.content?.[0]?.text;
  if (!raw) throw new Error('Empty MCP response');
  return JSON.parse(raw); // { pr_id, decision, reason, unresolved_blockers }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`[approver-bridge] Connected to ${RPC_URL}`);
  console.log(`[approver-bridge] Contract : ${CONTRACT_ADDRESS}`);
  console.log(`[approver-bridge] Oracle   : ${wallet.address}`);
  console.log(`[approver-bridge] Listening for ApprovalRequested events…\n`);

  contract.on('ApprovalRequested', async (requestId, requester, prId, reviewerAgent, timestamp) => {
    console.log(`\n[approver-bridge] ← ApprovalRequested  requestId=${requestId}  prId="${prId}"  reviewerAgent="${reviewerAgent}"`);

    const endpoint = pickApproverEndpoint();
    console.log(`[approver-bridge]   routing to MCP server: ${endpoint}`);

    try {
      const result = await callApproveTool(endpoint, prId, reviewerAgent);
      const { decision, reason, unresolved_blockers } = result;

      const reasonBytes     = ethers.toUtf8Bytes(JSON.stringify(reason ?? ''));
      const unresolvedBytes = ethers.toUtf8Bytes(JSON.stringify(unresolved_blockers ?? []));

      console.log(`[approver-bridge]   MCP decision: ${decision}`);

      let tx;
      if (decision === 'approved') {
        tx = await contract.fulfillApproval(requestId, prId, reasonBytes);
      } else if (decision === 'needs_revision') {
        tx = await contract.fulfillNeedsRevision(requestId, prId, reasonBytes, unresolvedBytes);
      } else {
        // 'rejected' or anything unexpected
        tx = await contract.fulfillRejection(requestId, prId, reasonBytes);
      }

      console.log(`[approver-bridge]   → fulfill tx: ${tx.hash}`);
      await tx.wait();
      console.log(`[approver-bridge]   ✓ fulfilled  requestId=${requestId}  decision=${decision}`);

    } catch (err) {
      console.error(`[approver-bridge]   ✗ Error processing ${requestId}: ${err.message}`);
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });

