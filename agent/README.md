# Agent

A minimal, web-based AI coding agent with streaming tool execution and terminal-style UI. Supports multiple LLM providers (Anthropic, xAI, OpenAI).

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

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Client                                  │
│  Solid.js + SSE Consumer + Terminal UI                          │
│  - Streaming message display                                     │
│  - Real-time tool call visualization                            │
│  - Provider selection dropdown                                   │
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
```

## Supported Providers

| Provider | Models | API Compatible |
|----------|--------|----------------|
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
| Validation | **Zod** | Type-safe schemas, good error messages |

## Design Philosophy

This agent follows the **pi-ai minimal approach**:

1. **Minimal System Prompt** (~100 tokens) - Models are RL-trained to understand coding tasks. Elaborate prompts waste context.

2. **Four Tools Only** - `read_file`, `write_file`, `edit_file`, `bash`. These four primitives handle all coding tasks. Bash subsumes ls, grep, find, git.

3. **YOLO Mode** - No permission prompts. Security theater is pointless when an agent can write and execute code.

4. **Structured Tool Results** - Separate LLM-facing output (concise) from UI-facing details (rich). Keeps context lean.

5. **Observable Execution** - Every tool call streams to the UI in real-time. Full visibility into what the agent does.

6. **Provider Agnostic** - Same agent loop works with any provider. Easy to add new providers.

## Features

- **Multi-Provider Support** - Switch between Claude, Grok, GPT from the UI
- **Streaming Tool Calls** - Watch tool arguments appear as the model generates them
- **Real-time Execution** - See tool results immediately as they complete
- **Diff Visualization** - Edit operations show before/after with syntax highlighting
- **Session Persistence** - Save and resume conversations
- **Project Instructions** - Loads CLAUDE.md/AGENTS.md for context-aware assistance
- **Token Tracking** - Monitor context window usage
- **Doom Loop Detection** - Breaks out of repeated identical tool calls

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- At least one API key (Anthropic, xAI, or OpenAI)

### Setup

```bash
# Clone and install
cd agent
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

### Usage

Type a message and press Enter. The agent will:
1. Think about your request
2. Execute tools as needed (visible in real-time)
3. Provide a response

Click the provider name in the header to switch between available providers.

Example prompts:
- "List the files in this directory"
- "Read package.json and tell me what dependencies we have"
- "Create a simple hello world TypeScript file"
- "Edit index.ts to add error handling"

## Project Structure

```
agent/
├── package.json
├── .env.example
├── src/
│   ├── server/
│   │   ├── index.ts           # Hono app, API routes
│   │   ├── agent.ts           # Multi-provider agent loop
│   │   ├── tools.ts           # 4 tool implementations
│   │   ├── prompt.ts          # System prompt, project instructions
│   │   ├── sessions.ts        # Session persistence
│   │   ├── types.ts           # TypeScript interfaces
│   │   └── providers/
│   │       ├── index.ts       # Provider registry
│   │       ├── types.ts       # Provider interfaces
│   │       ├── anthropic.ts   # Anthropic provider
│   │       └── openai-compatible.ts  # xAI/OpenAI provider
│   └── client/
│       ├── index.html
│       ├── App.tsx            # Main Solid.js component
│       └── styles.css         # Terminal-style CSS
├── vite.config.ts
└── tsconfig.json
```

## API Reference

### POST /api/chat

Stream agent responses via SSE.

**Request:**
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

**SSE Events:**
- `text_delta` - Streaming text content
- `tool_start` - Tool execution begins
- `tool_input_delta` - Streaming tool arguments
- `tool_running` - Tool is executing
- `tool_result` - Tool completed with output
- `turn_complete` - Agent finished responding
- `error` - Error occurred

### GET /api/providers

List available providers based on configured API keys.

**Response:**
```json
{
  "providers": [
    { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    { "provider": "xai", "model": "grok-3-beta" }
  ]
}
```

### Session Endpoints

- `GET /api/sessions` - List saved sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/:id` - Load session
- `PUT /api/sessions/:id` - Update session
- `DELETE /api/sessions/:id` - Delete session

## Tool Reference

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

Execute shell commands.

```json
{
  "command": "ls -la src/",
  "timeout": 30
}
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

## AI Methodology

This project was built using an AI-assisted development workflow:

### Coding Agents Used

- **Claude Code** (Opus 4.5) - Primary development agent for architecture, implementation, and debugging

### Development Approach

1. **Research Phase** - Studied existing coding agents (Claude Code, pi-ai, OpenCode) to understand architectural patterns
2. **Architecture Design** - Created PRD with key decisions: minimal prompting, 4 tools, streaming-first, multi-provider
3. **Iterative Implementation** - Built core features incrementally with continuous testing
4. **Prompt Engineering** - Refined system prompt to ~100 tokens based on pi-ai benchmarks

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

This works because:
1. Frontier models have extensive RL training on coding tasks
2. Tool schemas are self-documenting
3. Additional instructions can be injected via CLAUDE.md

## License

MIT
