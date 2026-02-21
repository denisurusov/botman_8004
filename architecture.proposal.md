# Architecture Proposal: On-Chain Agent Orchestration via MCP

> **Date:** February 21, 2026  
> **Project:** botman_8004  
> **Status:** Prototype / In Progress

---

## 1. Overview

This document captures the full body of architectural work completed to design and implement a system where **AI agents are described by machine-readable cards**, their **capabilities are formalised in MCP specifications**, and **on-chain Solidity contracts delegate execution to those agents** via an oracle-like bridge pattern.

The result is a traceable, auditable pipeline where every agent action — a code review, an approval decision — is requested and recorded on-chain, while the actual intelligence lives off-chain in MCP servers.

---

## 2. The Pipeline

```
Agent Card (JSON)
      │
      │  links to
      ▼
MCP Specification (JSON)
      │
      ├──[codegen]──▶  Solidity Oracle Contract   (on-chain request/response)
      ├──[codegen]──▶  MCP Server                 (off-chain tool/resource/prompt implementation)
      └──[codegen]──▶  Oracle Bridge              (event watcher + tx submitter)
```

Each layer is a direct mechanical derivation of the MCP spec — the same schema drives all three artefacts. Adding a new agent type means writing a new MCP spec; everything else can be regenerated from it.

---

## 3. Agent Cards

**Location:** `agents/*.json`

Each agent is described by a JSON card. Cards are the entry point for the entire system — they declare identity, capabilities, network endpoint, and a pointer to the MCP spec that governs the agent's behaviour.

### Agent Roles

| Agent | File | Role | Port | MCP Spec |
|---|---|---|---|---|
| CodeReviewerAlice | `alice.json` | Code reviewer | 8001 | `code-reviewer.mcp.json` |
| CodeReviewerBob   | `bob.json`   | Code reviewer | 8002 | `code-reviewer.mcp.json` |
| CodeApproverDave  | `dave.json`  | Code approver | 8003 | `code-approver.mcp.json` |
| CodeApproverEve   | `eve.json`   | Code approver | 8004 | `code-approver.mcp.json` |

### Card Schema

```json
{
  "name":        "CodeReviewerAlice",
  "description": "Reviews code for bugs",
  "capabilities": ["code-review"],
  "endpoint":    "http://localhost:8001",
  "image":       "https://example.com/alice.png",
  "mcpSpec":     "./mcp/code-reviewer.mcp.json"
}
```

Key fields:
- **`capabilities`** — drives which server script is spawned (`code-review` → `code-reviewer-server.js`, `approve-pr` → `code-approver-server.js`)
- **`endpoint`** — the port the MCP server will listen on; read directly by `launch-agents.js` / `launch-agents.ps1`
- **`mcpSpec`** — relative path to the MCP specification that defines this agent's tools, resources, and prompts

---

## 4. MCP Specifications

**Location:** `agents/mcp/*.mcp.json`

MCP (Model Context Protocol) is the specification format that describes what an agent can do. It defines three primitive types:

| Primitive | Purpose | On-chain mapping |
|---|---|---|
| **Tools** | Executable functions with typed input/output schemas | `request*()` + `fulfill*()` function pairs |
| **Resources** | Read-only data identified by URI | `mapping(key → bytes)` storage + getter |
| **Prompts** | Pre-defined LLM instruction templates with arguments | Loaded as system prompt in MCP server; not stored on-chain |

### 4.1 `code-reviewer.mcp.json`

Governs Alice and Bob.

**Tools:**
- `review_pr(pr_id, focus[])` → `{ pr_id, summary, comments[], approved }` — performs the review
- `get_review_status(pr_id)` → current status and existing comments

**Resources:**
- `review://{pr_id}/comments` — all review comments for a PR (JSON)
- `review://{pr_id}/diff` — raw unified diff of the PR (text)

**Prompts:**
- `code_review(pr_id, language?, focus?)` — instructs the LLM to analyse the diff, produce per-line structured feedback (file, line, severity, category, message, suggestion), and end with APPROVE or REQUEST_CHANGES

### 4.2 `code-approver.mcp.json`

Governs Dave and Eve.

**Tools:**
- `approve_pr(pr_id, reviewer_agent?, message?)` → `{ pr_id, decision, reason, unresolved_blockers[] }` — issues an approval decision after checking reviewer output
- `reject_pr(pr_id, reason)` — outright rejects a PR

**Resources:**
- `review://{pr_id}/comments` — reviewer comments used as input for the decision (proxied from reviewer agent)
- `approval://{pr_id}/decision` — the stored approval/rejection decision

**Prompts:**
- `approve_pr_prompt(pr_id, reviewer_summary?)` — instructs the LLM to fetch review comments, identify unresolved blockers, and call the appropriate tool

---

## 5. On-Chain Oracle Contracts

**Location:** `contracts/CodeReviewerOracle.sol`, `contracts/CodeApproverOracle.sol`

### Design Principles

- **Request/response pattern** — every tool call is a two-step on-chain lifecycle: request (emits event) → fulfillment (oracle callback)
- **Raw bytes storage** — all payloads (`summary`, `comments`, `reason`, `unresolved_blockers`) are stored as raw `bytes` (serialised JSON). This keeps gas low, keeps the contract schema-agnostic, and delegates serialisation to the off-chain layer.
- **Authorised oracle set** — only addresses registered via `addOracle()` may call `fulfill*()`. The owner manages this set.
- **Unique request IDs** — `requestId = keccak256(requester, prId, timestamp, nonce)` — collision-resistant, deterministic, no external randomness needed.
- **MCP resource mirroring** — every MCP resource URI maps to a `mapping` on-chain, updated on each fulfillment, readable by any caller.

### 5.1 `CodeReviewerOracle.sol`

Derived from `code-reviewer.mcp.json`.

```
State
  mapping(bytes32 → ReviewRequest)   requests         // request metadata
  mapping(bytes32 → ReviewResult)    results          // fulfilled results
  mapping(string  → bytes)           reviewComments   // resource: review://{pr_id}/comments
  mapping(string  → bytes)           reviewDiff       // resource: review://{pr_id}/diff

Functions
  requestReview(prId, focus)          → requestId      // emits ReviewRequested
  fulfillReview(requestId, prId,
    summaryJson, commentsJson,
    approved)                                          // oracle only; emits ReviewFulfilled
  getReview(requestId)                → full result
  getComments(prId)                   → bytes          // resource read
  storeDiff(prId, diff)                                // resource write
  getDiff(prId)                       → bytes          // resource read
  cancelReview(requestId)                              // requester only
  addOracle(addr) / removeOracle(addr)                 // owner only

Events
  ReviewRequested(requestId, requester, prId, focus, timestamp)
  ReviewFulfilled(requestId, prId, approved, oracle, timestamp)
  ReviewCancelled(requestId, prId)
  DiffStored(prId, storedBy)
```

### 5.2 `CodeApproverOracle.sol`

Derived from `code-approver.mcp.json`. The three possible MCP decisions (`approved`, `needs_revision`, `rejected`) map to three separate fulfillment functions, giving the contract precise event semantics for each outcome.

```
State
  mapping(bytes32 → ApprovalRequest)  requests
  mapping(bytes32 → ApprovalResult)   results
  mapping(string  → bytes)            approvalDecisions  // resource: approval://{pr_id}/decision

Functions
  requestApproval(prId,
    reviewerAgent, message)           → requestId      // emits ApprovalRequested
  fulfillApproval(requestId, prId,
    reasonJson)                                        // decision = approved
  fulfillNeedsRevision(requestId,
    prId, reasonJson,
    unresolvedJson)                                    // decision = needs_revision
  fulfillRejection(requestId, prId,
    reasonJson)                                        // decision = rejected
  getDecision(prId)                   → bytes          // resource read
  getResult(requestId)                → full result
  cancelApproval(requestId)
  addOracle(addr) / removeOracle(addr)

Events
  ApprovalRequested(requestId, requester, prId, reviewerAgent, timestamp)
  PRApproved(requestId, prId, oracle, timestamp)
  RevisionRequested(requestId, prId, unresolvedBlockers, oracle, timestamp)
  PRRejected(requestId, prId, reason, oracle, timestamp)
  ApprovalCancelled(requestId, prId)
```

---

## 6. MCP Servers

**Location:** `agents_implementation/code-reviewer-server.js`, `agents_implementation/code-approver-server.js`

Each server is a plain Node.js HTTP process. One instance is spawned per agent card. The port is read directly from the card's `endpoint` field.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Returns the agent card |
| `GET` | `/.well-known/agent` | Agent card (A2A/MCP discovery) |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 dispatcher |

### JSON-RPC Methods Handled

| Method | Description |
|---|---|
| `initialize` | MCP handshake — returns server capabilities |
| `tools/list` | Lists all tools with name, description, inputSchema |
| `tools/call` | Invokes a named tool with arguments |
| `resources/list` | Lists available resource URIs |
| `resources/read` | Reads a resource by URI |
| `prompts/list` | Lists available prompts |
| `prompts/get` | Renders a prompt template with supplied arguments |

### Stub Implementation Note

The `review_pr` and `approve_pr` tool handlers currently contain **stub logic** that returns synthetic results. These stubs are clearly marked with `// ── Stub implementation ──` comments and are designed to be replaced with real LLM API calls (e.g. OpenAI, Anthropic, local model) without changing any surrounding infrastructure.

---

## 7. Oracle Bridges

**Location:** `agents_implementation/code-reviewer-bridge.js`, `agents_implementation/code-approver-bridge.js`

A bridge is a lightweight off-chain process that closes the loop between the on-chain oracle contract and the MCP server. It is the only component that speaks both languages.

### Responsibilities

| Responsibility | How |
|---|---|
| Watch for on-chain requests | `ethers.Contract.on(eventName, handler)` — subscribes to provider event stream |
| Route to correct MCP endpoint | Reads agent cards from `../agents`, picks endpoint by capability |
| Call MCP tool | `POST /mcp` with `tools/call` JSON-RPC payload |
| Submit fulfillment transaction | Signs and sends `fulfill*()` call with result bytes |

### Full Request Lifecycle

```
1.  Caller           →  contract.requestReview(prId, focus)
2.  Contract         →  emits ReviewRequested(requestId, ...)
3.  Bridge           ←  receives event via ethers.js listener
4.  Bridge           →  POST http://localhost:8001/mcp  { tools/call: review_pr }
5.  MCP Server       →  returns { summary, comments, approved }
6.  Bridge           →  contract.fulfillReview(requestId, prId, summaryBytes, commentsBytes, approved)
7.  Contract         →  stores result, emits ReviewFulfilled(requestId, approved)
8.  Any caller       →  contract.getComments(prId)  // reads result from chain
```

### Configuration

Bridges accept contract address, RPC URL, and oracle private key via CLI flags or environment variables:

```
REVIEWER_CONTRACT_ADDRESS  /  --reviewer-contract
APPROVER_CONTRACT_ADDRESS  /  --approver-contract
RPC_URL                    /  --rpc
ORACLE_PRIVATE_KEY         /  --privkey
```

---

## 8. Launch Infrastructure

**Location:** `agents_implementation/`

### Starting Agents

```powershell
# PowerShell (recommended — reads ports from agent cards)
.\agents_implementation\launch-agents.ps1

# Node.js
node agents_implementation/launch-agents.js
```

`launch-agents` reads every `*.json` card in `agents/`, extracts the port from `endpoint`, and spawns the correct server script based on capabilities:

```
capability: code-review  →  code-reviewer-server.js
capability: approve-pr   →  code-approver-server.js
```

### Starting Bridges

```powershell
node agents_implementation/launch-bridges.js `
  --reviewer-contract 0x... `
  --approver-contract 0x... `
  --rpc http://127.0.0.1:8545 `
  --privkey 0x...
```

### Stopping Agents

```powershell
.\agents_implementation\stop-agents.ps1
```

PIDs are written to `agent-pids.txt` by `launch-agents.ps1` and consumed by `stop-agents.ps1`.

### Logs

All server and bridge stdout/stderr goes to `agents_implementation/logs/`:

```
logs/alice.log / alice.err.log
logs/bob.log   / bob.err.log
logs/dave.log  / dave.err.log
logs/eve.log   / eve.err.log
logs/code-reviewer-bridge.log / .err.log
logs/code-approver-bridge.log / .err.log
```

---

## 9. Full File Map

```
agents/
  alice.json                          Agent card — CodeReviewerAlice (port 8001)
  bob.json                            Agent card — CodeReviewerBob   (port 8002)
  dave.json                           Agent card — CodeApproverDave  (port 8003)
  eve.json                            Agent card — CodeApproverEve   (port 8004)
  mcp/
    code-reviewer.mcp.json            MCP spec — tools, resources, prompts for reviewers
    code-approver.mcp.json            MCP spec — tools, resources, prompts for approvers

contracts/
  CodeReviewerOracle.sol              On-chain oracle — review request/fulfillment lifecycle
  CodeApproverOracle.sol              On-chain oracle — approval request/fulfillment lifecycle

agents_implementation/
  code-reviewer-server.js             MCP HTTP server for code-reviewer agents
  code-approver-server.js             MCP HTTP server for code-approver agents
  code-reviewer-bridge.js             Oracle bridge — ReviewRequested → review_pr → fulfillReview
  code-approver-bridge.js             Oracle bridge — ApprovalRequested → approve_pr → fulfill*
  launch-agents.js                    Node launcher — spawns one server per card
  launch-agents.ps1                   PowerShell launcher — same, with log redirection
  launch-bridges.js                   Spawns both bridges as background processes
  stop-agents.ps1                     Kills all agents by PID file
```

---

## 10. Design Decisions & Rationale

### Raw `bytes` storage over typed structs
Solidity structs would require a fixed schema baked into the contract. Storing payloads as raw JSON `bytes` keeps contracts schema-agnostic — the MCP spec can evolve (new fields, new comment categories) without requiring a contract upgrade. Off-chain consumers decode JSON however they like.

### Monolithic contracts per agent type
Rather than splitting into `MCPOracle` base + per-tool contracts, the first iteration uses a single self-contained contract per role. This reduces deployment complexity and makes the request/response flow easy to follow. Refactoring to a base class is a natural next step once the interface stabilises.

### Ports taken from agent cards
The MCP server port is the single source of truth — it lives in the agent card's `endpoint` field. Both `launch-agents.js` and `launch-agents.ps1` parse it from there. This avoids port mismatches between the card (which other agents use to call each other) and the actual listening port.

### Bridges are stateless
Each bridge event handler is independently idempotent — it reads the event, calls the MCP tool, and submits the fulfillment. No local database is needed. The oracle contract itself is the source of truth for request state; the `Pending` guard prevents double-fulfillment.

---

## 11. Next Steps

| Priority | Item |
|---|---|
| High | Replace stub `review_pr` / `approve_pr` handlers with real LLM calls |
| High | Deploy `CodeReviewerOracle` and `CodeApproverOracle` and register bridge wallets as oracles via `addOracle()` |
| High | Update `deploy-registries.js` (or add `deploy-oracles.js`) to deploy the new contracts and write addresses to a config file read by `launch-bridges.js` |
| Medium | Add a `deployed-addresses.json` file so bridges can auto-read contract addresses without CLI flags |
| Medium | Extract `MCPOracle.sol` base contract (requestId generation, oracle auth, pending state) shared by both oracle contracts |
| Medium | Add `resources/subscribe` support to MCP servers for real-time resource updates |
| Low | Replace in-memory `reviewStore` / `decisionStore` with a persistent DB or read directly from on-chain state |
| Low | Add round-robin / load-balancing across multiple reviewer instances (Alice + Bob) in the bridge |

