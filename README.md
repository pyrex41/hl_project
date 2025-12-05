# Agent

A minimal, web-based AI coding agent with streaming tool execution, parallel subagent orchestration, and terminal-style UI. Supports multiple LLM providers (Anthropic, xAI, OpenAI) and the Model Context Protocol (MCP).

```
┌─────────────────────────────────────────────────────────────────┐
│  agent v0.1                    [Grok]   [idle]  [tokens: 1.2k]  │
├─────────────────────────────────────────────────────────────────┤
│  > read_file src/index.ts                          [done ✓]    │
│    const app = new Hono()                                       │
│                                                                 │
│  > edit_file src/index.ts                      [running...]    │
│    - oldText: "Hello"                                           │
│    + newText: "Hello World"                                     │
├─────────────────────────────────────────────────────────────────┤
│  > _                                                            │
└─────────────────────────────────────────────────────────────────┘
```

## Overview

Agent is a lightweight AI coding assistant that takes the "less is more" approach to AI-assisted development. Built on the principle that frontier models already understand coding tasks deeply, it uses a minimal system prompt (~100 tokens) and just four core tools to handle any coding task.

### Key Features

- **Multi-Provider Support** - Switch between Claude, Grok, and GPT models from the UI
- **Streaming Tool Execution** - Watch tool arguments appear as the model generates them
- **Parallel Subagent Orchestration** - Spawn multiple agents to work on tasks concurrently
- **MCP Integration** - Connect to external MCP servers for extended capabilities
- **Session Persistence** - Save and resume conversations
- **Project-Aware Context** - Loads CLAUDE.md/AGENTS.md for project-specific instructions
- **Doom Loop Detection** - Automatically breaks out of repeated identical tool calls
- **Real-time Token Tracking** - Monitor context window usage

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Client                                  │
│  Solid.js + SSE Consumer + Terminal UI                          │
│  - Streaming message display                                     │
│  - Real-time tool call visualization                            │
│  - Provider selection dropdown                                   │
│  - MCP server management panel                                   │
│  - Session management                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ SSE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Server                                  │
│  Hono + SSE Producer + Tool Executor                            │
│  - Multi-provider agent loop                                    │
│  - 4 core tools (read, write, edit, bash)                       │
│  - Parallel subagent runner                                     │
│  - MCP client manager                                            │
│  - Project instructions loader                                   │
│  - Session persistence                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ API
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLM Providers                                 │
│  Anthropic (Claude) | xAI (Grok) | OpenAI (GPT)                 │
│  Unified provider abstraction with streaming                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ MCP Protocol
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Servers                                   │
│  stdio | SSE | HTTP transports                                   │
│  Extended tools, prompts, and resources                         │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- At least one API key (Anthropic, xAI, or OpenAI)

### Installation

```bash
# Navigate to agent directory
cd agent

# Install dependencies
bun install

# Configure API keys
cp .env.example .env
# Edit .env and add your API key(s)

# Run development server
bun run dev
```

Open http://localhost:3000 in your browser.

### Configuration

Set one or more API keys in `.env`:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514  # optional

# xAI (Grok)
XAI_API_KEY=xai-...
XAI_MODEL=grok-3-beta  # optional

# OpenAI (GPT)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o  # optional

# Optional: Set default provider
LLM_PROVIDER=xai  # anthropic, xai, or openai
```

## Supported Providers

| Provider | Models | API Type |
|----------|--------|----------|
| **Anthropic** | claude-sonnet-4, claude-opus-4 | Native |
| **xAI** | grok-3-beta, grok-2 | OpenAI-compatible |
| **OpenAI** | gpt-4o, gpt-4-turbo | Native |

Switch providers in the UI via the dropdown, or per-request via the API.

## Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Runtime | **Bun** | Fast startup, native TypeScript, built-in bundler |
| Server | **Hono** | Lightweight, fast, great SSE support |
| Frontend | **Solid.js** | Fine-grained reactivity, perfect for streaming UX |
| LLM | **Multi-provider** | Anthropic SDK + OpenAI SDK for flexibility |
| MCP | **@modelcontextprotocol/sdk** | Official MCP implementation |
| Validation | **Zod** | Type-safe schemas, good error messages |

## Design Philosophy

This agent follows the **pi-ai minimal approach**:

1. **Minimal System Prompt** (~100 tokens) - Models are RL-trained to understand coding tasks. Elaborate prompts waste context.

2. **Four Tools Only** - `read_file`, `write_file`, `edit_file`, `bash`. These four primitives handle all coding tasks. Bash subsumes ls, grep, find, git.

3. **YOLO Mode** - No permission prompts. Security theater is pointless when an agent can write and execute code.

4. **Structured Tool Results** - Separate LLM-facing output (concise) from UI-facing details (rich). Keeps context lean.

5. **Observable Execution** - Every tool call streams to the UI in real-time. Full visibility into what the agent does.

6. **Provider Agnostic** - Same agent loop works with any provider. Easy to add new providers.

## Core Tools

### read_file

Read file contents with optional line range.

```json
{
  "path": "src/index.ts",
  "offset": 1,
  "limit": 100
}
```

### write_file

Create or overwrite a file. Auto-creates parent directories.

```json
{
  "path": "src/new-file.ts",
  "content": "export const hello = 'world'"
}
```

### edit_file

Replace exact text in a file. Must match exactly.

```json
{
  "path": "src/index.ts",
  "oldText": "const x = 1",
  "newText": "const x = 2"
}
```

### bash

Execute shell commands with configurable timeout.

```json
{
  "command": "ls -la src/",
  "timeout": 30
}
```

## Subagent System

Agent supports spawning parallel subagents to work on complex tasks. Each subagent:

- Gets a fresh context (no parent history)
- Has one of three roles with different token limits
- Can use the same four core tools
- Returns results to the parent agent

### Subagent Roles

| Role | Purpose | Token Budget |
|------|---------|--------------|
| **simple** | Quick operations | Lower limits |
| **complex** | Heavy lifting, multi-step tasks | Maximum tokens |
| **researcher** | Code exploration, information gathering | Balanced |

### Confirmation Modes

- **always** - Ask before spawning any subagent
- **never** - Spawn automatically without asking
- **multiple** - Ask only when spawning multiple subagents

## MCP Integration

Agent integrates with the Model Context Protocol for extended capabilities:

- **Transport Support**: stdio, SSE, and HTTP transports
- **Auto-Discovery**: Finds configs from Claude Code, Claude Desktop, and OpenCode
- **Tool Integration**: MCP tools appear alongside native tools
- **Prompts & Resources**: Access MCP prompts and resources through the API

### Connecting MCP Servers

1. Open the MCP panel in the UI
2. Add server configuration (command, args, env)
3. Click Connect

Or import from existing configs:

1. Click "Discover" in the MCP panel
2. Select configs to import from Claude Code, Desktop, or OpenCode

## Project Structure

```
hl_project/
├── CLAUDE.md                    # Project instructions
├── README.md                    # This file
├── agent/
│   ├── package.json
│   ├── .env.example
│   ├── README.md                # Detailed agent documentation
│   ├── src/
│   │   ├── server/
│   │   │   ├── index.ts         # Hono app, API routes
│   │   │   ├── agent.ts         # Multi-provider agent loop
│   │   │   ├── tools.ts         # 4 tool implementations
│   │   │   ├── prompt.ts        # System prompt, project instructions
│   │   │   ├── sessions.ts      # Session persistence
│   │   │   ├── subagent.ts      # Parallel subagent runner
│   │   │   ├── config.ts        # Configuration management
│   │   │   ├── types.ts         # TypeScript interfaces
│   │   │   ├── providers/
│   │   │   │   ├── index.ts     # Provider registry
│   │   │   │   ├── types.ts     # Provider interfaces
│   │   │   │   ├── anthropic.ts # Anthropic provider
│   │   │   │   └── openai-compatible.ts  # xAI/OpenAI
│   │   │   └── mcp/
│   │   │       ├── client.ts    # MCP client manager
│   │   │       ├── config.ts    # MCP config loading
│   │   │       ├── tools.ts     # MCP tool integration
│   │   │       └── types.ts     # MCP type definitions
│   │   └── client/
│   │       ├── index.html
│   │       ├── App.tsx          # Main Solid.js component
│   │       ├── MCPPanel.tsx     # MCP management UI
│   │       └── styles.css       # Terminal-style CSS
│   ├── vite.config.ts
│   └── tsconfig.json
├── .claude/                     # Claude Code configuration
└── thoughts/                    # Development notes and research
```

## API Reference

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Stream agent responses via SSE |
| `/api/providers` | GET | List available providers |
| `/api/providers/:provider/models` | GET | List models for provider |

### Session Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions` | GET | List saved sessions |
| `/api/sessions` | POST | Create new session |
| `/api/sessions/:id` | GET | Load session |
| `/api/sessions/:id` | PUT | Update session |
| `/api/sessions/:id` | DELETE | Delete session |

### MCP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp/config` | GET/PUT | Load/save MCP config |
| `/api/mcp/servers` | GET | List connected servers |
| `/api/mcp/servers/:id/connect` | POST | Connect to server |
| `/api/mcp/servers/:id/disconnect` | POST | Disconnect |
| `/api/mcp/tools` | GET | List all MCP tools |
| `/api/mcp/discover` | GET | Discover configs from other tools |

### Chat Request Format

```json
{
  "message": "Your prompt here",
  "history": [],
  "workingDir": "/path/to/project",
  "sessionId": "optional-session-id",
  "provider": "xai",
  "model": "grok-3-beta"
}
```

### SSE Event Types

| Event | Description |
|-------|-------------|
| `text_delta` | Streaming text content |
| `tool_start` | Tool execution begins |
| `tool_input_delta` | Streaming tool arguments |
| `tool_running` | Tool is executing |
| `tool_result` | Tool completed with output |
| `subagent_start` | Subagent spawned |
| `subagent_complete` | Subagent finished |
| `turn_complete` | Agent finished responding |
| `error` | Error occurred |

## Usage Examples

Type a message and press Enter. The agent will think, execute tools as needed, and respond.

Example prompts:

```
"List the files in this directory"
"Read package.json and tell me what dependencies we have"
"Create a simple hello world TypeScript file"
"Edit index.ts to add error handling"
"Run the tests and fix any failures"
"Refactor this function to be more readable"
```

## Adding New Providers

To add a new OpenAI-compatible provider:

```typescript
// In providers/openai-compatible.ts
export function createNewProvider(apiKey?: string, model?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: 'newprovider',
    apiKey: apiKey || process.env.NEWPROVIDER_API_KEY || '',
    baseURL: 'https://api.newprovider.com/v1',
    model: model || 'default-model'
  })
}
```

Then register it in `providers/index.ts` and `providers/types.ts`.

## Development

```bash
# Run development server (frontend + backend)
bun run dev

# Type checking
bun run typecheck

# Production build
bun run build

# Start production server
bun run start
```

Development URLs:
- Frontend: http://localhost:3000 (Vite dev server)
- Backend: http://localhost:3001 (Bun server)
- Vite proxies `/api/*` to the backend

## AI Development Methodology

This project was built using AI-assisted development:

### Key Insights from Research

- **Less is more** - Pi-ai's Terminal-Bench results prove minimal prompts work as well as elaborate ones
- **Bash subsumes many tools** - No need for separate ls, grep, find tools when bash handles them
- **Streaming UX matters** - Real-time tool call visibility dramatically improves user experience
- **Context is king** - Keep tool results concise for the LLM, rich for the UI
- **Provider flexibility** - Different models excel at different tasks; easy switching is valuable

### Prompting Philosophy

The system prompt is intentionally minimal:

```
You are a coding assistant. Help with coding tasks by reading files,
executing commands, editing code, and writing files.

Tools: read_file, write_file, edit_file, bash

Guidelines:
- Read files before editing
- Use edit_file for precise changes (oldText must match exactly)
- Use bash for ls, grep, find, git
- Be concise
```

This works because frontier models have extensive RL training on coding tasks, and tool schemas are self-documenting.

## Contributing

Contributions are welcome. Please ensure:

1. Code passes type checking (`bun run typecheck`)
2. New providers follow the existing abstraction pattern
3. UI changes maintain the terminal aesthetic

## License

MIT
