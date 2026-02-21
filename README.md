# botman_8004

Local development environment for an **enterprise agentic workflow framework** built on two complementary standards:

- **ERC-8004** — on-chain agent identity registry. Each agent is an ERC-721 NFT with a verified wallet, a bound oracle contract, and arbitrary capability metadata.
- **MCP (Model Context Protocol)** — agent invocation standard. Each agent exposes tools, resources, and prompts over HTTP/JSON-RPC 2.0.

The two standards are linked: every agent card points to an MCP spec, every MCP spec drives a Solidity oracle contract, and the identity registry binds the agent identity to that oracle in a single transaction.

See [`architecture.proposal.md`](./architecture.proposal.md) for the full design rationale.

---

## Architecture overview

```
Agent Card (JSON)
      │  mcpSpec →
      ▼
MCP Specification (JSON)
      │
      ├──▶  Solidity Oracle Contract   on-chain request / response
      ├──▶  MCP Server                 off-chain tool / resource / prompt implementation
      └──▶  Oracle Bridge              event watcher + fulfillment tx submitter
```

```
on-chain                              off-chain
─────────────────────────────────────────────────────────────
IdentityRegistryUpgradeable  ◄──────  one-shot register()
CodeReviewerOracle.sol       ◄──tx──  code-reviewer-bridge.js
  emits ReviewRequested  ────event►         │ POST /mcp
                                    code-reviewer-server.js
                                       (Alice, Bob)

CodeApproverOracle.sol       ◄──tx──  code-approver-bridge.js
  emits ApprovalRequested ───event►         │ POST /mcp
                                    code-approver-server.js
                                       (Dave, Eve)
```

---

## Project structure

```
botman_8004/
├── agents/                            # Agent card JSON files
│   ├── alice.json                     #   CodeReviewerAlice  — port 8001
│   ├── bob.json                       #   CodeReviewerBob    — port 8002
│   ├── dave.json                      #   CodeApproverDave   — port 8003
│   ├── eve.json                       #   CodeApproverEve    — port 8004
│   └── mcp/
│       ├── code-reviewer.mcp.json     #   MCP spec for reviewer agents
│       └── code-approver.mcp.json     #   MCP spec for approver agents
│
├── agents_implementation/             # Off-chain MCP servers + oracle bridges
│   ├── code-reviewer-server.js        #   MCP server for code-review agents
│   ├── code-approver-server.js        #   MCP server for code-approver agents
│   ├── code-reviewer-bridge.js        #   Bridge: ReviewRequested → review_pr → fulfillReview
│   ├── code-approver-bridge.js        #   Bridge: ApprovalRequested → approve_pr → fulfill*
│   ├── launch-agents.js               #   Node.js launcher — spawns one server per card
│   ├── launch-agents.ps1              #   PowerShell launcher — background, logs to logs/
│   ├── launch-bridges.js              #   Spawns both oracle bridges as background processes
│   ├── stop-agents.ps1                #   Kills background agents by PID file
│   └── logs/                          #   Auto-created; one .log/.err.log per process
│
├── contracts/
│   ├── IdentityRegistryUpgradeable.sol  # ERC-8004: ERC-721 identity + oracle binding (UUPS)
│   ├── ReputationRegistry.sol           # Reputation scoring linked to agent identities
│   ├── CodeReviewerOracle.sol           # On-chain oracle for code-review MCP tools
│   ├── CodeApproverOracle.sol           # On-chain oracle for code-approver MCP tools
│   └── IIdentityRegistry.sol            # Interface consumed by oracle contracts
│
├── scripts/
│   ├── deploy-registries.js     # Deploys identity + reputation registries via proxy
│   └── register-mocks.js        # Registers agent cards on-chain
│
├── architecture.proposal.md     # Full design document
├── hardhat.config.js
├── start.ps1
└── package.json
```

---

## Quick start

> Requires: **Node.js ≥ 18**, **npm**

### 1 — Install dependencies

```powershell
npm install
cd agents_implementation ; npm install ; cd ..
```

### 2 — Compile contracts

```powershell
npx hardhat compile
```

### 3 — Start Hardhat node (separate terminal)

```powershell
npx hardhat node
```

### 4 — Deploy contracts

```powershell
npx hardhat run scripts/deploy-registries.js --network localhost
```

Note the printed addresses — you'll need them for steps 5 and 6.

### 5 — Register agents on-chain (one-shot: identity + oracle binding)

```powershell
$env:IDENTITY_REGISTRY_ADDRESS  = "0x<IdentityRegistryProxy>"
$env:REVIEWER_CONTRACT_ADDRESS  = "0x<CodeReviewerOracle>"
$env:APPROVER_CONTRACT_ADDRESS  = "0x<CodeApproverOracle>"
npx hardhat run scripts/register-mocks.js --network localhost
```

This calls `register(agentURI, metadata[], oracleAddress)` — a single transaction per agent that records identity, card URI, capability metadata, and oracle binding together.

### 6 — Launch MCP servers

```powershell
# Foreground (Ctrl-C stops all)
node agents_implementation/launch-agents.js

# Background (logs to agents_implementation/logs/)
.\agents_implementation\launch-agents.ps1
.\agents_implementation\stop-agents.ps1   # to stop
```

### 7 — Launch oracle bridges

```powershell
node agents_implementation/launch-bridges.js `
  --reviewer-contract 0x<CodeReviewerOracle> `
  --approver-contract 0x<CodeApproverOracle> `
  --rpc http://127.0.0.1:8545 `
  --privkey 0x<OraclePrivateKey>
```

Or via environment variables:

```powershell
$env:REVIEWER_CONTRACT_ADDRESS = "0x..."
$env:APPROVER_CONTRACT_ADDRESS = "0x..."
$env:RPC_URL                   = "http://127.0.0.1:8545"
$env:ORACLE_PRIVATE_KEY        = "0x..."
node agents_implementation/launch-bridges.js
```

---

## Agent cards

Each file in `agents/` describes one agent. The `capabilities` field drives which server script is spawned; `endpoint` provides the port; `mcpSpec` links to the MCP specification.

```json
{
  "name": "CodeReviewerAlice",
  "description": "Reviews code for bugs",
  "capabilities": ["code-review"],
  "endpoint": "http://localhost:8001",
  "image": "https://example.com/alice.png",
  "mcpSpec": "./mcp/code-reviewer.mcp.json"
}
```

| Capability | Server spawned |
|---|---|
| `code-review` | `code-reviewer-server.js` |
| `approve-pr` | `code-approver-server.js` |

To **add an agent**: create a new `.json` file in `agents/` with a unique port and restart the launcher.  
To **remove an agent**: delete its `.json` file and restart.

---

## MCP server API

Every agent server exposes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Agent card JSON |
| `GET` | `/.well-known/agent` | Agent card JSON (MCP / A2A discovery) |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 endpoint |

### JSON-RPC methods

| Method | Description |
|---|---|
| `initialize` | MCP handshake — returns server capabilities |
| `tools/list` | Lists all tools with name, description, inputSchema |
| `tools/call` | Invokes a named tool with arguments |
| `resources/list` | Lists available resource URIs |
| `resources/read` | Reads a resource by URI |
| `prompts/list` | Lists available prompts |
| `prompts/get` | Renders a prompt template with supplied arguments |

### Tools by agent type

**code-reviewer** (Alice, Bob):

| Tool | Description |
|---|---|
| `review_pr` | Review a PR — returns `{ summary, comments[], approved }` |
| `get_review_status` | Returns current status and comments for a PR |
| `store_diff` | Stores a raw PR diff for retrieval as a resource |
| `agent/ping` | Health check |
| `agent/info` | Returns the agent card |

**code-approver** (Dave, Eve):

| Tool | Description |
|---|---|
| `approve_pr` | Issues an approval decision after checking reviewer output |
| `reject_pr` | Rejects a PR with a reason |
| `agent/ping` | Health check |
| `agent/info` | Returns the agent card |

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

# Get the code review prompt
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"code_review","arguments":{"pr_id":"42","language":"Solidity"}}}'
```

---

## Oracle bridges

Each oracle contract has a corresponding off-chain bridge that closes the on-chain ↔ off-chain loop:

| Bridge | Watches event | Calls MCP tool | Submits tx |
|---|---|---|---|
| `code-reviewer-bridge.js` | `ReviewRequested` | `review_pr` | `fulfillReview(agentId, ...)` |
| `code-approver-bridge.js` | `ApprovalRequested` | `approve_pr` | `fulfillApproval / fulfillNeedsRevision / fulfillRejection` |

The bridge passes the ERC-8004 `agentId` on every fulfillment call. The oracle contract verifies via `IIdentityRegistry` that:
1. `msg.sender` == `agentWallet` registered for that `agentId`
2. `oracleAddress` registered for that `agentId` == `address(this)`

This means **registration in the identity registry is the oracle authorization** — no separate whitelist needed.

---

## Smart contracts

### `IdentityRegistryUpgradeable` (ERC-8004 v3)

- ERC-721 token — one NFT per registered agent
- UUPS upgradeable (OpenZeppelin)
- EIP-712 signatures for `setAgentWallet`
- **Reserved typed fields**: `agentWallet` (address) and `oracleAddress` (address) — both protected from generic metadata writes, both cleared on transfer
- One-shot registration: `register(agentURI, metadata[], oracleAddress)`

### `CodeReviewerOracle` / `CodeApproverOracle`

- On-chain request/response lifecycle per MCP tool
- Authorization delegated to `IIdentityRegistry` via `onlyRegisteredOracle(agentId)` modifier
- Payloads stored as raw JSON `bytes` — schema-agnostic, gas-efficient
- MCP resources mirrored as on-chain mappings: `reviewComments[prId]`, `approvalDecisions[prId]`
- Every fulfilled result stores the `agentId` of the oracle that produced it

### `ReputationRegistryUpgradeable`

- Records reputation scores linked to agent NFT IDs
- References `IdentityRegistryUpgradeable` for ownership checks

---

## Dependencies

| Package | Purpose |
|---|---|
| `hardhat` | EVM development environment |
| `@openzeppelin/contracts` | ERC-721, ECDSA, EIP-712 |
| `@openzeppelin/contracts-upgradeable` | UUPS proxy pattern |
| `@openzeppelin/hardhat-upgrades` | Proxy-aware deploy helpers |
| `@nomicfoundation/hardhat-ethers` | ethers.js v6 integration |
| `ethers` | Ethereum JS library |

```powershell
npm install
```

---

## .gitignore recommendations

```
node_modules/
artifacts/
cache/
hardhat-node.log
hardhat-node.err.log
agents_implementation/logs/
agents_implementation/agent-pids.txt
deployed-addresses.json
.env
```
