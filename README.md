# botman_8004

Local development environment for **ERC-8004** — an on-chain agent identity and reputation registry, paired with a fleet of **MCP-over-HTTP** agent servers.

---

## Overview

| Layer | What it does |
|---|---|
| **Smart contracts** | `IdentityRegistryUpgradeable` (ERC-721 + UUPS) mints an NFT per agent. `ReputationRegistryUpgradeable` records scores against those identities. |
| **Hardhat** | Local EVM node, compile, deploy, and registration scripts. |
| **MCP servers** | One lightweight HTTP/JSON-RPC 2.0 server per agent card, auto-spawned from `/agents/*.json`. |

---

## Project structure

```
botman_8004/
├── agents/                      # Agent card JSON files (one per agent)
│   ├── alice.json               #   port 8001
│   ├── bob.json                 #   port 8002
│   ├── dave.json                #   port 8003
│   └── eve.json                 #   port 8004
├── agents_implementation/       # MCP server infrastructure
│   ├── server.js                #   Single MCP HTTP server (run once per agent)
│   ├── launch-agents.js         #   Node.js launcher (foreground, all agents)
│   ├── launch-agents.ps1        #   PowerShell launcher (background processes)
│   └── stop-agents.ps1          #   Kills background agents
├── contracts/
│   ├── IdentityRegistryUpgradeable.sol   # ERC-721 UUPS upgradeable identity registry
│   └── ReputationRegistry.sol            # Reputation scoring contract
├── scripts/
│   ├── deploy-registries.js     # Deploys both contracts via proxy
│   └── register-mocks.js        # Registers agent cards on-chain
├── hardhat.config.js
├── start.ps1                    # ← One-shot launcher (see Quick start)
└── package.json
```

---

## Quick start

> Requires: **Node.js ≥ 18**, **npm**

### One command — does everything

```powershell
.\start.ps1
```

This script runs the following steps in order:

1. **Compile** — `npx hardhat compile`
2. **Start Hardhat node** — background process on `http://127.0.0.1:8545`, waits until ready
3. **Deploy contracts** — `IdentityRegistryUpgradeable` + `ReputationRegistryUpgradeable` via UUPS proxy
4. **Register agents** — reads every `agents/*.json` and mints an identity NFT per agent
5. **Launch MCP servers** — one HTTP server per agent card (foreground; Ctrl-C stops everything)

#### Options

```powershell
.\start.ps1 -SkipCompile          # skip compile if contracts already built
.\start.ps1 -BasePort 8100        # override MCP server base port fallback
```

Hardhat node output is written to `hardhat-node.log` / `hardhat-node.err.log`.

---

## Running pieces individually

### Compile

```powershell
npx hardhat compile
```

### Start Hardhat node

```powershell
npx hardhat node
```

### Deploy contracts

```powershell
npx hardhat run scripts/deploy-registries.js --network localhost
```

### Register agent cards on-chain

```powershell
$env:IDENTITY_REGISTRY_ADDRESS = "0xYourProxyAddress"
npx hardhat run scripts/register-mocks.js --network localhost
```

### Launch MCP servers only

```powershell
# Foreground (Ctrl-C to stop all)
node agents_implementation/launch-agents.js

# Background (logs to agents_implementation/logs/)
.\agents_implementation\launch-agents.ps1
.\agents_implementation\stop-agents.ps1   # to stop
```

---

## Agent cards

Each file in `agents/` describes one agent:

```json
{
  "name": "CodeReviewerAlice",
  "description": "Reviews Solidity code for bugs",
  "capabilities": ["code-review", "solidity"],
  "endpoint": "http://localhost:8001",
  "image": "https://example.com/alice.png"
}
```

The `endpoint` port is used directly by the launcher — the server will listen on that port.  
To **add an agent**: create a new `.json` file in `agents/` with a unique port and restart.  
To **remove an agent**: delete its `.json` file and restart.

---

## MCP server API

Every agent server exposes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Agent card JSON |
| `GET` | `/.well-known/agent` | Agent card JSON (MCP/A2A discovery) |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 endpoint |

### MCP methods

| Method | Description |
|---|---|
| `initialize` | MCP handshake |
| `tools/list` | List available tools |
| `tools/call` | Call a tool |

### Built-in tools

| Tool | Description |
|---|---|
| `agent/info` | Returns the full agent card |
| `agent/ping` | Health check → `{ status: "pong" }` |
| `agent/capabilities` | Lists capabilities from the agent card |

### Example

```bash
# Agent card
curl http://localhost:8001/

# List tools
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Ping
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent/ping","arguments":{}}}'
```

---

## Smart contracts

### IdentityRegistryUpgradeable

- ERC-721 token — one NFT per registered agent
- UUPS upgradeable (OpenZeppelin)
- EIP-712 signatures for off-chain authorisation
- `register(string uri)` — mints an identity NFT, stores agent card URI on-chain

### ReputationRegistryUpgradeable

- Records reputation scores linked to identity NFT IDs
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

Install:

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
.env
```
