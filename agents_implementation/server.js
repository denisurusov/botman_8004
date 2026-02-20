/**
 * MCP HTTP Server - one instance per agent card.
 *
 * Invocation:
 *   node server.js <path-to-agent-card.json> <port>
 *
 * MCP endpoints exposed:
 *   GET  /                  → agent card (JSON)
 *   GET  /.well-known/agent → agent card (JSON)   (A2A / MCP discovery)
 *   POST /mcp               → MCP JSON-RPC 2.0 handler
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

// ── CLI args ────────────────────────────────────────────────────────────────
const [, , cardPath, portArg] = process.argv;

if (!cardPath || !portArg) {
  console.error('Usage: node server.js <agent-card.json> <port>');
  process.exit(1);
}

const PORT = parseInt(portArg, 10);
if (Number.isNaN(PORT)) {
  console.error(`Invalid port: ${portArg}`);
  process.exit(1);
}

// ── Load agent card ──────────────────────────────────────────────────────────
const absoluteCardPath = path.resolve(cardPath);
let agentCard;
try {
  agentCard = JSON.parse(fs.readFileSync(absoluteCardPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read agent card at "${absoluteCardPath}": ${err.message}`);
  process.exit(1);
}

// Patch the endpoint to reflect the actual port this instance listens on
agentCard = { ...agentCard, endpoint: `http://localhost:${PORT}` };

const agentName = agentCard.name ?? path.basename(cardPath, '.json');

// ── MCP tool registry ────────────────────────────────────────────────────────
// Add / edit tools here.  Each tool must have a handler(params) → result.
const TOOLS = {
  'agent/info': {
    description: 'Returns the agent card for this agent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: (_params) => agentCard,
  },
  'agent/ping': {
    description: 'Health check – returns pong.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: (_params) => ({ status: 'pong', agent: agentName, port: PORT }),
  },
  'agent/capabilities': {
    description: 'Lists the capabilities declared in the agent card.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: (_params) => ({ capabilities: agentCard.capabilities ?? [] }),
  },
};

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────
function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// ── MCP request dispatcher ───────────────────────────────────────────────────
function handleMcpRequest(body) {
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== '2.0') {
    return jsonRpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }

  // ── Standard MCP lifecycle methods ──────────────────────────────────────
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: agentName, version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }

  if (method === 'notifications/initialized') {
    // fire-and-forget; no response needed but we return null result for safety
    return jsonRpcResult(id, null);
  }

  if (method === 'tools/list') {
    const tools = Object.entries(TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
    }));
    return jsonRpcResult(id, { tools });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolParams = params?.arguments ?? {};
    const tool = TOOLS[toolName];
    if (!tool) {
      return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
    }
    try {
      const result = tool.handler(toolParams);
      return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return jsonRpcError(id, -32000, `Tool error: ${err.message}`);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS – allow all origins (HTTP only, so no cert issues)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Agent card discovery ──
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/.well-known/agent')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agentCard, null, 2));
    return;
  }

  // ── MCP JSON-RPC endpoint ──
  if (req.method === 'POST' && url.pathname === '/mcp') {
    let rawBody = '';
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
        return;
      }

      // Support batch requests
      const isBatch = Array.isArray(parsed);
      const requests = isBatch ? parsed : [parsed];
      const responses = requests.map(handleMcpRequest).filter(Boolean);
      const body = isBatch ? responses : responses[0];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[${agentName}] MCP server listening on http://localhost:${PORT}  (card: ${absoluteCardPath})`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

