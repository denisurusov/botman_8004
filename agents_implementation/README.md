# agents_implementation

MCP-over-HTTP server infrastructure. One Node.js process per agent card.

## Directory layout

```
agents_implementation/
  server.js          ← single MCP server (run once per agent)
  launch-agents.js   ← Node.js launcher (spawns all agents, foreground)
  launch-agents.ps1  ← PowerShell launcher (spawns all as background processes)
  stop-agents.ps1    ← kills all background agents started by launch-agents.ps1
  logs/              ← created automatically; one .log/.err.log per agent
  package.json
```

Agent cards live in `../agents/*.json`.

---

## How ports are assigned

Cards are sorted alphabetically. The first card gets `BASE_PORT` (default **9000**),
the next gets `BASE_PORT + 1`, and so on.

| Card file   | Default port |
|-------------|-------------|
| alice.json  | 9000        |
| bob.json    | 9001        |
| dave.json   | 9002        |
| eve.json    | 9003        |

Add a new card → it gets the next port. Remove a card → the ports of later agents
shift down by one (restart required).

---

## Running

### Option A – foreground (Node.js, all output in one terminal)

```powershell
cd agents_implementation
node launch-agents.js
# optional: node launch-agents.js --base-port 8100
```

Press **Ctrl-C** to stop everything.

### Option B – background (PowerShell, each agent logs to `logs/`)

```powershell
cd agents_implementation
.\launch-agents.ps1
# optional: .\launch-agents.ps1 -BasePort 8100
```

Stop all agents:

```powershell
.\stop-agents.ps1
```

---

## HTTP API

Every agent exposes three endpoints:

| Method | Path                 | Description                         |
|--------|----------------------|-------------------------------------|
| GET    | `/`                  | Returns the agent card JSON         |
| GET    | `/.well-known/agent` | Same – MCP/A2A discovery URL        |
| POST   | `/mcp`               | MCP JSON-RPC 2.0 endpoint           |

### MCP methods

| Method                   | Description                                    |
|--------------------------|------------------------------------------------|
| `initialize`             | MCP handshake                                  |
| `tools/list`             | Lists available tools                          |
| `tools/call`             | Calls a tool                                   |

### Built-in tools

| Tool name             | Description                              |
|-----------------------|------------------------------------------|
| `agent/info`          | Returns the full agent card              |
| `agent/ping`          | Health check → `{ status: "pong" }`      |
| `agent/capabilities`  | Lists capabilities from the agent card   |

### Example – call tools/list

```bash
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Example – call a tool

```bash
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent/ping","arguments":{}}}'
```

---

## Adding / editing agents

1. Create or edit a file in `../agents/`.  
   The `endpoint` field is **overridden at runtime** with the actual port, so you don't need to keep it accurate.
2. Restart the launcher.  New cards are picked up automatically.

## Adding tools to a server

Open `server.js` and add an entry to the `TOOLS` object:

```js
'myTool/doSomething': {
  description: 'Does something useful.',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
  },
  handler: (params) => {
    return { result: params.input.toUpperCase() };
  },
},
```

