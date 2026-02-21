# agents_implementation

Off-chain MCP server infrastructure and oracle bridges. One Node.js MCP server process per agent card, plus one bridge process per oracle contract.

## Directory layout

```
agents_implementation/
  code-reviewer-server.js   ← MCP server for code-review agents (Alice, Bob)
  code-approver-server.js   ← MCP server for code-approver agents (Dave, Eve)
  code-reviewer-bridge.js   ← Oracle bridge: ReviewRequested → review_pr → fulfillReview
  code-approver-bridge.js   ← Oracle bridge: ApprovalRequested → approve_pr → fulfill*
  launch-agents.js          ← Node.js launcher (spawns all agent servers, foreground)
  launch-agents.ps1         ← PowerShell launcher (background processes, logs to logs/)
  launch-bridges.js         ← Spawns both oracle bridges as background processes
  stop-agents.ps1           ← Kills all background agents started by launch-agents.ps1
  logs/                     ← Auto-created; one .log/.err.log per agent and bridge
  package.json
```

Agent cards live in `../agents/*.json`.

---

## How ports are assigned

Ports are read directly from each agent card's `endpoint` field — the launcher does not assign them:

| Card       | Endpoint                   | Server spawned            |
|------------|----------------------------|---------------------------|
| alice.json | http://localhost:**8001**  | code-reviewer-server.js   |
| bob.json   | http://localhost:**8002**  | code-reviewer-server.js   |
| dave.json  | http://localhost:**8003**  | code-approver-server.js   |
| eve.json   | http://localhost:**8004**  | code-approver-server.js   |

The server script is chosen based on the card's `capabilities` field:

| Capability    | Server script              |
|---------------|----------------------------|
| `code-review` | `code-reviewer-server.js`  |
| `approve-pr`  | `code-approver-server.js`  |

---

## Running MCP servers

### Foreground (Node.js — all output in one terminal)

```powershell
cd agents_implementation
node launch-agents.js
```

Press **Ctrl-C** to stop everything.

### Background (PowerShell — each agent logs to `logs/`)

```powershell
cd agents_implementation
.\launch-agents.ps1
```

Stop all agents:

```powershell
.\stop-agents.ps1
```

---

## Running oracle bridges

Bridges watch for on-chain events and call back the oracle contracts with MCP tool results.
They require deployed contract addresses and an oracle private key.

### Via CLI flags

```powershell
node launch-bridges.js `
  --reviewer-contract 0x<CodeReviewerOracle> `
  --approver-contract 0x<CodeApproverOracle> `
  --rpc               http://127.0.0.1:8545 `
  --privkey           0x<OraclePrivateKey>
```

### Via environment variables

```powershell
$env:REVIEWER_CONTRACT_ADDRESS = "0x..."
$env:APPROVER_CONTRACT_ADDRESS = "0x..."
$env:RPC_URL                   = "http://127.0.0.1:8545"
$env:ORACLE_PRIVATE_KEY        = "0x..."
node launch-bridges.js
```

Bridge logs are written to `logs/code-reviewer-bridge.log` and `logs/code-approver-bridge.log`.

---

## HTTP API

Every agent server exposes:

| Method | Path                 | Description                          |
|--------|----------------------|--------------------------------------|
| GET    | `/`                  | Returns the agent card JSON          |
| GET    | `/.well-known/agent` | Same — MCP / A2A discovery URL       |
| POST   | `/mcp`               | MCP JSON-RPC 2.0 endpoint            |

### JSON-RPC methods

| Method             | Description                                          |
|--------------------|------------------------------------------------------|
| `initialize`       | MCP handshake — returns server capabilities          |
| `tools/list`       | Lists tools with name, description, inputSchema      |
| `tools/call`       | Invokes a named tool with arguments                  |
| `resources/list`   | Lists available resource URIs                        |
| `resources/read`   | Reads a resource by URI                              |
| `prompts/list`     | Lists available prompts                              |
| `prompts/get`      | Renders a prompt template with supplied arguments    |

### Tools — code-reviewer (Alice, Bob)

| Tool                | Description                                               |
|---------------------|-----------------------------------------------------------|
| `review_pr`         | Reviews a PR — returns `{ summary, comments[], approved }` |
| `get_review_status` | Returns current review status and comments for a PR       |
| `store_diff`        | Stores a raw unified diff as a resource                   |
| `agent/info`        | Returns the full agent card                               |
| `agent/ping`        | Health check → `{ status: "pong" }`                       |

### Tools — code-approver (Dave, Eve)

| Tool         | Description                                                     |
|--------------|-----------------------------------------------------------------|
| `approve_pr` | Issues an approval decision after reading reviewer comments     |
| `reject_pr`  | Rejects a PR with a reason                                      |
| `agent/info` | Returns the full agent card                                     |
| `agent/ping` | Health check → `{ status: "pong" }`                             |

### Resources

| URI pattern                    | Agent type    | Content                         |
|--------------------------------|---------------|---------------------------------|
| `review://{pr_id}/comments`    | code-reviewer | Latest review comments (JSON)   |
| `review://{pr_id}/diff`        | code-reviewer | Raw PR diff (text)              |
| `approval://{pr_id}/decision`  | code-approver | Latest approval decision (JSON) |

### Prompts

| Prompt               | Agent type    | Arguments                              |
|----------------------|---------------|----------------------------------------|
| `code_review`        | code-reviewer | `pr_id`, `language?`, `focus?`         |
| `approve_pr_prompt`  | code-approver | `pr_id`, `reviewer_summary?`           |

### Example requests

```bash
# Agent card
curl http://localhost:8001/

# List tools
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Request a code review
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"review_pr","arguments":{"pr_id":"42"}}}'

# Read review comments resource
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"review://42/comments"}}'

# Get the code review prompt
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"code_review","arguments":{"pr_id":"42","language":"Solidity"}}}'
```

---

## Adding / editing agents

1. Create or edit a file in `../agents/`. Set a unique port in `endpoint` and set `capabilities` to `["code-review"]` or `["approve-pr"]`.
2. Set `mcpSpec` to point to the appropriate MCP spec in `../agents/mcp/`.
3. Restart the launcher — new cards are picked up automatically.

## Adding tools to a server

Open the relevant server file (`code-reviewer-server.js` or `code-approver-server.js`) and add an entry to the `TOOLS` object:

```js
my_tool: {
  description: 'Does something useful.',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input']
  },
  handler: (params) => {
    return { result: params.input.toUpperCase() };
  }
}
```
