/**
 * code-reviewer-server.js
 *
 * MCP HTTP server for code-reviewer agent cards (Alice, Bob, …).
 * Implements all tools, resources, and prompts from agents/mcp/code-reviewer.mcp.json.
 *
 * Invocation (handled by launch-agents.js):
 *   node code-reviewer-server.js <path-to-agent-card.json> <port>
 *
 * MCP endpoints:
 *   GET  /                      → agent card (JSON)
 *   GET  /.well-known/agent     → agent card (JSON)
 *   GET  /mcp/resources/list    → list resources
 *   GET  /mcp/prompts/list      → list prompts
 *   POST /mcp                   → MCP JSON-RPC 2.0 (tools/list, tools/call, etc.)
 */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

// ── CLI args ─────────────────────────────────────────────────────────────────
const [, , cardPath, portArg] = process.argv;
if (!cardPath || !portArg) {
  console.error('Usage: node code-reviewer-server.js <agent-card.json> <port>');
  process.exit(1);
}
const PORT = parseInt(portArg, 10);
if (Number.isNaN(PORT)) { console.error(`Invalid port: ${portArg}`); process.exit(1); }

// ── Load agent card ──────────────────────────────────────────────────────────
const absoluteCardPath = path.resolve(cardPath);
let agentCard = JSON.parse(fs.readFileSync(absoluteCardPath, 'utf8'));
agentCard = { ...agentCard, endpoint: `http://localhost:${PORT}` };
const agentName = agentCard.name ?? path.basename(cardPath, '.json');

// ── In-memory review store (keyed by prId) ───────────────────────────────────
// In production replace with a DB / the on-chain CodeReviewerOracle.
const reviewStore = new Map(); // prId → { summary, comments, approved, updatedAt }
const diffStore   = new Map(); // prId → string

// ── MCP Prompts ───────────────────────────────────────────────────────────────
const PROMPTS = {
  code_review: {
    description: 'Standard code review prompt. Instructs the agent to analyse the PR diff and produce structured, actionable feedback.',
    arguments: [
      { name: 'pr_id',    description: 'The pull request identifier',                             required: true  },
      { name: 'language', description: 'Primary programming language (e.g. Solidity, TypeScript)', required: false },
      { name: 'focus',    description: 'Comma-separated focus areas: bugs,security,style,performance,tests,documentation', required: false },
    ],
    template: (args) => {
      const lang    = args.language ? `${args.language} ` : '';
      const focuses = args.focus    ? `Focus specifically on: ${args.focus}.`
                                    : 'Cover all aspects: bugs, security, style, performance, tests and documentation.';
      return [
        { role: 'system', content:
          `You are a senior ${lang}code reviewer.\n\n` +
          `Review pull request ${args.pr_id}.\n\n` +
          `${focuses}\n\n` +
          `For every issue found, provide:\n` +
          `- The file name and line number\n` +
          `- Severity: info | warning | error | critical\n` +
          `- Category: bugs | security | style | performance | tests | documentation\n` +
          `- A clear message explaining the problem\n` +
          `- A concrete suggestion for how to fix it\n\n` +
          `Finish with a one-paragraph summary and a recommendation: APPROVE or REQUEST_CHANGES.`
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
    description: 'All review comments posted on a given pull request.',
    mimeType:    'application/json',
  },
  {
    uri:         'review://{pr_id}/diff',
    name:        'PR Diff',
    description: 'The raw unified diff of the pull request for context.',
    mimeType:    'text/plain',
  },
];

function resolveResource(uri) {
  // review://{pr_id}/comments
  let m = uri.match(/^review:\/\/(.+)\/comments$/);
  if (m) {
    const prId = m[1];
    const data = reviewStore.get(prId);
    return data
      ? { uri, mimeType: 'application/json', text: JSON.stringify(data.comments ?? []) }
      : { uri, mimeType: 'application/json', text: '[]' };
  }
  // review://{pr_id}/diff
  m = uri.match(/^review:\/\/(.+)\/diff$/);
  if (m) {
    const prId = m[1];
    return { uri, mimeType: 'text/plain', text: diffStore.get(prId) ?? '' };
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

  // ── MCP spec: review_pr ──────────────────────────────────────────────────
  review_pr: {
    description: 'Performs a code review on the specified pull request and returns structured comments.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_id: { type: 'string', description: 'Pull request identifier (e.g. "42" or "org/repo#42")' },
        focus: {
          type: 'array',
          items: { type: 'string', enum: ['bugs','security','style','performance','tests','documentation'] },
          description: 'Optional list of aspects to focus the review on. Defaults to all.',
        },
      },
      required: ['pr_id'],
    },
    handler: (params) => {
      const { pr_id, focus } = params;
      if (!pr_id) throw new Error('pr_id is required');

      // ── Stub implementation ──────────────────────────────────────────────
      // Replace this block with a real LLM call or external API.
      const focusAreas = focus?.length ? focus : ['bugs','security','style','performance','tests','documentation'];
      const comments = focusAreas.map((cat, i) => ({
        file:       'src/example.sol',
        line:       (i + 1) * 10,
        severity:   'info',
        category:   cat,
        message:    `[stub] No issues found for category "${cat}" in PR ${pr_id}.`,
        suggestion: 'No action required.',
      }));
      const result = {
        pr_id,
        summary:  `[stub] Automated review of PR ${pr_id} by ${agentName}. No issues found.`,
        comments,
        approved: true,
      };

      // Persist to in-memory resource store
      reviewStore.set(pr_id, { ...result, updatedAt: Date.now() });
      return result;
    },
  },

  // ── MCP spec: get_review_status ──────────────────────────────────────────
  get_review_status: {
    description: 'Returns the current review status and existing comments for a PR.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_id: { type: 'string', description: 'The pull request identifier' },
      },
      required: ['pr_id'],
    },
    handler: (params) => {
      const { pr_id } = params;
      if (!pr_id) throw new Error('pr_id is required');
      const data = reviewStore.get(pr_id);
      if (!data) return { pr_id, status: 'not_found', comments: [] };
      return { pr_id, status: 'completed', ...data };
    },
  },

  // ── Resource helper: store a diff ────────────────────────────────────────
  store_diff: {
    description: 'Store a raw PR diff on the server so it can be retrieved as a resource.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_id: { type: 'string' },
        diff:  { type: 'string', description: 'Raw unified diff text' },
      },
      required: ['pr_id', 'diff'],
    },
    handler: (params) => {
      diffStore.set(params.pr_id, params.diff);
      return { ok: true };
    },
  },
};

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────
const rpcError  = (id, code, msg, data) =>
  ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// ── MCP dispatcher ────────────────────────────────────────────────────────────
function handleMcp(body) {
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
      const result = tool.handler(params?.arguments ?? {});
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
    const uri = params?.uri;
    const resolved = resolveResource(uri);
    if (!resolved) return rpcError(id, -32602, `Unknown resource URI: ${uri}`);
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
    const messages = prompt.template(params?.arguments ?? {});
    return rpcResult(id, { description: prompt.description, messages });
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

  // ── Agent card discovery ──────────────────────────────────────────────────
  if (req.method === 'GET' && ['/', '/.well-known/agent'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agentCard, null, 2));
    return;
  }

  // ── MCP JSON-RPC ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/mcp') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { res.writeHead(400); res.end(JSON.stringify(rpcError(null, -32700, 'Parse error'))); return; }

      const isBatch = Array.isArray(parsed);
      const reqs    = isBatch ? parsed : [parsed];
      const resps   = reqs.map(handleMcp).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isBatch ? resps : resps[0]));
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () =>
  console.log(`[${agentName}] code-reviewer MCP server → http://localhost:${PORT}  (${absoluteCardPath})`)
);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

