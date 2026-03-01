/**
 * code-approver-server.js
 *
 * MCP HTTP server for code-approver agent cards (Dave, Eve, …).
 * Implements all tools, resources, and prompts from agents/mcp/code-approver.mcp.json.
 *
 * Invocation (handled by launch-agents.js):
 *   node code-approver-server.js <path-to-agent-card.json> <port>
 *
 * MCP endpoints:
 *   GET  /                      → agent card (JSON)
 *   GET  /.well-known/agent     → agent card (JSON)
 *   POST /mcp                   → MCP JSON-RPC 2.0 (tools, resources, prompts)
 */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

// ── CLI args ─────────────────────────────────────────────────────────────────
const [, , cardPath, portArg] = process.argv;
if (!cardPath || !portArg) {
  console.error('Usage: node code-approver-server.js <agent-card.json> <port>');
  process.exit(1);
}
const PORT = parseInt(portArg, 10);
if (Number.isNaN(PORT)) { console.error(`Invalid port: ${portArg}`); process.exit(1); }

// ── Load agent card ──────────────────────────────────────────────────────────
const absoluteCardPath = path.resolve(cardPath);
let agentCard = JSON.parse(fs.readFileSync(absoluteCardPath, 'utf8'));
agentCard = { ...agentCard, endpoint: `http://localhost:${PORT}` };
const agentName = agentCard.name ?? path.basename(cardPath, '.json');

// ── In-memory decision store ──────────────────────────────────────────────────
// prId → { decision, reason, unresolved_blockers, decidedAt }
const decisionStore = new Map();

// ── Fetch review comments from a reviewer agent ───────────────────────────────
async function fetchReviewComments(reviewerAgent, prId) {
  if (!reviewerAgent) return [];
  try {
    const res = await fetch(reviewerAgent + '/mcp', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'resources/read',
        params: { uri: `review://${prId}/comments` },
      }),
    });
    const json = await res.json();
    const text = json?.result?.contents?.[0]?.text ?? '[]';
    return JSON.parse(text);
  } catch (err) {
    console.warn(`[${agentName}] Could not fetch comments from ${reviewerAgent}: ${err.message}`);
    return [];
  }
}

// ── MCP Prompts ───────────────────────────────────────────────────────────────
const PROMPTS = {
  approve_pr_prompt: {
    description: 'Standard approval prompt. Instructs the agent to read all review comments for a PR, check that blockers are resolved, and issue a final decision.',
    arguments: [
      { name: 'pr_id',            description: 'The pull request identifier',                 required: true  },
      { name: 'reviewer_summary', description: 'Summary text produced by the reviewer agent', required: false },
    ],
    template: (args) => {
      const summaryBlock = args.reviewer_summary
        ? `Reviewer summary:\n${args.reviewer_summary}\n\n`
        : '';
      return [
        { role: 'system', content:
          `You are a senior code approver responsible for the final gate before merge.\n\n` +
          `Pull request: ${args.pr_id}\n\n` +
          `${summaryBlock}` +
          `Steps:\n` +
          `1. Retrieve all review comments for PR ${args.pr_id} using the review://${args.pr_id}/comments resource.\n` +
          `2. Identify any comments with severity 'critical' or 'error' that are still unresolved.\n` +
          `3. If NO blocking issues remain: call approve_pr with decision 'approved' and a brief approval message.\n` +
          `4. If blocking issues exist: call approve_pr with decision 'needs_revision', listing each blocker in unresolved_blockers.\n` +
          `5. If the PR is fundamentally flawed and cannot be salvaged: call reject_pr with a clear reason.\n\n` +
          `Be concise, factual and constructive.`
        }
      ];
    },
  },
};

// ── MCP Resources ─────────────────────────────────────────────────────────────
const RESOURCES = [
  {
    uri:         'review://{pr_id}/comments',
    name:        'PR Review Comments',
    description: 'Review comments produced by reviewer agents, used as input for the approval decision.',
    mimeType:    'application/json',
  },
  {
    uri:         'approval://{pr_id}/decision',
    name:        'Approval Decision',
    description: 'The stored approval or rejection decision for a pull request.',
    mimeType:    'application/json',
  },
];

function resolveResource(uri) {
  // approval://{pr_id}/decision
  let m = uri.match(/^approval:\/\/(.+)\/decision$/);
  if (m) {
    const data = decisionStore.get(m[1]);
    return { uri, mimeType: 'application/json', text: JSON.stringify(data ?? null) };
  }
  // review://{pr_id}/comments — proxy to reviewer agent if known
  m = uri.match(/^review:\/\/(.+)\/comments$/);
  if (m) {
    // Return empty; live fetching happens inside the approve_pr tool handler
    return { uri, mimeType: 'application/json', text: '[]' };
  }
  return null;
}

// ── MCP Tools ─────────────────────────────────────────────────────────────────
const TOOLS = {

  'agent/info': {
    description: 'Returns the agent card for this agent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: () => agentCard,
  },

  'agent/ping': {
    description: 'Health check – returns pong.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: () => ({ status: 'pong', agent: agentName, port: PORT }),
  },

  // ── MCP spec: approve_pr ─────────────────────────────────────────────────
  approve_pr: {
    description: 'Approves a pull request after verifying that all blocking review comments have been resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_id:          { type: 'string', description: 'The pull request identifier' },
        reviewer_agent: { type: 'string', description: 'Endpoint of the reviewer agent whose comments to consider' },
        message:        { type: 'string', description: 'Optional approval message' },
      },
      required: ['pr_id'],
    },
    // async handler — resolved in the HTTP layer
    handler: async (params) => {
      const { pr_id, reviewer_agent, message, trace_id } = params;
      if (!pr_id) throw new Error('pr_id is required');
      const traceId = trace_id || 'unknown';
      console.log(`[${agentName}] [${traceId}] approve_pr pr_id=${pr_id} reviewer=${reviewer_agent || 'none'}`);

      const comments = await fetchReviewComments(reviewer_agent, pr_id);

      // ── Stub decision logic ──────────────────────────────────────────────
      // Replace with a real LLM call.
      const blockers = comments.filter(c => c.severity === 'critical' || c.severity === 'error');

      let result;
      if (blockers.length === 0) {
        result = {
          pr_id,
          decision:            'approved',
          reason:              message ?? `[stub] No blocking issues found. PR ${pr_id} approved by ${agentName}.`,
          unresolved_blockers: [],
        };
      } else {
        result = {
          pr_id,
          decision:            'needs_revision',
          reason:              `[stub] ${blockers.length} blocking issue(s) found in PR ${pr_id}.`,
          unresolved_blockers: blockers.map(b => `${b.file}:${b.line} — ${b.message}`),
        };
      }

      decisionStore.set(pr_id, { ...result, decidedAt: Date.now() });
      return result;
    },
  },

  // ── MCP spec: reject_pr ──────────────────────────────────────────────────
  reject_pr: {
    description: 'Rejects a pull request and returns reasons for rejection.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_id:  { type: 'string' },
        reason: { type: 'string', description: 'Explanation of why the PR is rejected' },
      },
      required: ['pr_id', 'reason'],
    },
    handler: (params) => {
      const { pr_id, reason, trace_id } = params;
      if (!pr_id || !reason) throw new Error('pr_id and reason are required');
      console.log(`[${agentName}] [${trace_id || 'unknown'}] reject_pr pr_id=${pr_id}`);
      const result = { pr_id, decision: 'rejected', reason, unresolved_blockers: [] };
      decisionStore.set(pr_id, { ...result, decidedAt: Date.now() });
      return result;
    },
  },
};

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────
const rpcError  = (id, code, msg, data) =>
  ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// ── MCP dispatcher ────────────────────────────────────────────────────────────
async function handleMcp(body) {
  const { jsonrpc, id, method, params } = body;
  if (jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request');

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: agentName, version: '1.0.0' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
    });
  }

  if (method === 'notifications/initialized') return rpcResult(id, null);

  // ── tools ────────────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: Object.entries(TOOLS).map(([name, def]) => ({
        name, description: def.description, inputSchema: def.inputSchema,
      })),
    });
  }

  if (method === 'tools/call') {
    const tool = TOOLS[params?.name];
    if (!tool) return rpcError(id, -32601, `Unknown tool: ${params?.name}`);
    try {
      const result = await tool.handler(params?.arguments ?? {});
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return rpcError(id, -32000, `Tool error: ${err.message}`);
    }
  }

  // ── resources ────────────────────────────────────────────────────────────
  if (method === 'resources/list') {
    return rpcResult(id, { resources: RESOURCES });
  }

  if (method === 'resources/read') {
    const resolved = resolveResource(params?.uri);
    if (!resolved) return rpcError(id, -32602, `Unknown resource URI: ${params?.uri}`);
    return rpcResult(id, { contents: [resolved] });
  }

  // ── prompts ──────────────────────────────────────────────────────────────
  if (method === 'prompts/list') {
    return rpcResult(id, {
      prompts: Object.entries(PROMPTS).map(([name, def]) => ({
        name, description: def.description, arguments: def.arguments,
      })),
    });
  }

  if (method === 'prompts/get') {
    const prompt = PROMPTS[params?.name];
    if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${params?.name}`);
    return rpcResult(id, { description: prompt.description, messages: prompt.template(params?.arguments ?? {}) });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && ['/', '/.well-known/agent'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agentCard, null, 2));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mcp') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { res.writeHead(400); res.end(JSON.stringify(rpcError(null, -32700, 'Parse error'))); return; }

      const isBatch = Array.isArray(parsed);
      const reqs    = isBatch ? parsed : [parsed];
      const resps   = await Promise.all(reqs.map(handleMcp));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isBatch ? resps.filter(Boolean) : resps[0]));
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () =>
  console.log(`[${agentName}] code-approver MCP server → http://localhost:${PORT}  (${absoluteCardPath})`)
);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

