---
date: 2025-12-05T17:18:57Z
researcher: Claude
git_commit: 8b6e0aa9f155f357586dca6a8fb692356f168a3e
branch: master
repository: pyrex41/hl_project
topic: "Available Tools Overview"
tags: [research, tools, mcp, cli, development]
status: complete
last_updated: 2025-12-05
last_updated_by: Claude
---

# Research: Available Tools Overview

**Date**: 2025-12-05T17:18:57Z
**Researcher**: Claude
**Git Commit**: 8b6e0aa9f155f357586dca6a8fb692356f168a3e
**Branch**: master
**Repository**: pyrex41/hl_project

## Research Question
Can you walk me through what tools we have available?

## Summary
This project has four categories of tools: **Agent Tools** (built-in + MCP), **Slash Commands**, **Development Scripts**, and **SCUD Task Management**. The agent system provides file operations, shell execution, and task delegation. MCP (Model Context Protocol) enables dynamic tool discovery from external servers. Slash commands provide file-based prompts for common workflows. Development uses Bun + Vite + TypeScript.

---

## Detailed Findings

### 1. Agent Built-in Tools

These are the core tools available to the AI agent during conversations.

| Tool | Description | File |
|------|-------------|------|
| `read_file` | Read file contents with pagination support | `agent/src/server/providers/index.ts:81-91` |
| `write_file` | Create/overwrite files with auto-directory creation | `agent/src/server/providers/index.ts:93-103` |
| `edit_file` | Exact text replacement within files | `agent/src/server/providers/index.ts:105-116` |
| `bash` | Execute shell commands with configurable timeout | `agent/src/server/providers/index.ts:118-129` |
| `task` | Spawn parallel subagents for concurrent work | `agent/src/server/providers/index.ts:130-172` |
| `scud` | SCUD task graph integration | `agent/src/server/providers/index.ts:173-234` |

**Tool execution router**: `agent/src/server/tools.ts:496-523`

---

### 2. MCP (Model Context Protocol) Tools

MCP enables dynamic tool discovery from external servers. Tools appear/disappear as servers connect/disconnect.

#### Configuration
- **Config file**: `.agent/mcp.json`
- **Config management**: `agent/src/server/mcp/config.ts`

#### Transport Types
| Type | Use Case | Required Fields |
|------|----------|-----------------|
| `stdio` | Local processes (npm packages) | `command`, `args`, `env` |
| `sse` | Server-Sent Events endpoints | `url` |
| `streamable-http` | HTTP streaming (default for URLs) | `url`, `headers` |

#### Tool Naming Convention
MCP tools are prefixed: `mcp_<serverId>_<toolName>`
- Example: `mcp_filesystem_read_file`
- Prefix configurable via `settings.toolPrefix` (default: `mcp_`)

#### Key Files
| File | Purpose |
|------|---------|
| `agent/src/server/mcp/types.ts` | Type definitions |
| `agent/src/server/mcp/client.ts` | Connection management |
| `agent/src/server/mcp/tools.ts` | Tool execution |
| `agent/src/server/mcp/commands.ts` | Prompt-to-command mapping |

#### REST API Endpoints
- `GET /api/mcp/config` - Load config
- `PUT /api/mcp/config` - Save config
- `GET /api/mcp/servers` - List servers
- `POST /api/mcp/servers/:id/connect` - Connect
- `POST /api/mcp/servers/:id/disconnect` - Disconnect
- `GET /api/mcp/tools` - List all tools
- `GET /api/mcp/prompts` - List all prompts

---

### 3. Slash Commands

File-based command system using markdown files with YAML frontmatter.

#### Command Discovery Order (priority)
1. `.agent/commands/` - Project-specific
2. `.claude/commands/` - Claude Code compatible
3. `src/server/commands/` - Built-in (lowest priority)

#### Built-in Commands
| Command | Description | File |
|---------|-------------|------|
| `/help` | List available slash commands | `agent/src/server/commands/help.md` |
| `/status` | Show git and task status | `agent/src/server/commands/status.md` |
| `/commit` | Create git commits with approval | `agent/src/server/commands/commit.md` |
| `/review <PR>` | Review a pull request | `agent/src/server/commands/review.md` |

#### Claude Workflow Commands (`/cl:*`)
| Command | Description |
|---------|-------------|
| `/cl:commit` | Create commits without Claude attribution |
| `/cl:create_plan` | Create implementation plans with research |
| `/cl:implement_plan` | Execute approved plans phase-by-phase |
| `/cl:iterate_plan` | Update existing plans with feedback |
| `/cl:describe_pr` | Generate PR descriptions |
| `/cl:research_codebase` | Spawn parallel research sub-agents |

#### SCUD Task Commands (`/scud:*`)
| Command | Description |
|---------|-------------|
| `/scud:task-next` | Find next available task |
| `/scud:task-list` | List tasks with status filter |
| `/scud:task-show <id>` | Show task details |
| `/scud:task-status <id> <status>` | Update task status |
| `/scud:task-claim` | Claim/release task locks |
| `/scud:task-stats` | Show completion statistics |
| `/scud:task-waves` | Show parallel execution waves |
| `/scud:task-whois` | Show task assignments |
| `/scud:task-doctor` | Diagnose task issues |
| `/scud:task-tags` | List/set active tag |

---

### 4. Development Tools

#### Package Manager
**Bun** - Used for all package management and script execution

#### NPM Scripts (`agent/package.json:7-13`)
| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `concurrently "bun run dev:server" "bun run dev:client"` | Run both in dev mode |
| `dev:server` | `bun --watch src/server/index.ts` | Server with hot reload |
| `dev:client` | `vite` | Vite dev server (port 3000) |
| `build` | `vite build && bun build ...` | Production build |
| `start` | `bun dist/server/index.js` | Run production build |
| `typecheck` | `tsc --noEmit` | Type checking only |

#### Build Stack
| Tool | Purpose | Config File |
|------|---------|-------------|
| TypeScript | Type checking | `tsconfig.json` |
| Vite | Frontend bundler | `vite.config.ts` |
| SolidJS | UI framework | JSX configured in `tsconfig.json` |
| Bun | Server bundler/runtime | Native |

#### Dependencies
**Backend:**
- `hono` - Web framework
- `@anthropic-ai/sdk` - Claude API
- `openai` - OpenAI API
- `@modelcontextprotocol/sdk` - MCP protocol
- `zod` - Schema validation

**Frontend:**
- `solid-js` - Reactive UI
- `vite` + `vite-plugin-solid` - Build tooling

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Agent System                          │
├─────────────────────────────────────────────────────────┤
│  Built-in Tools        │  MCP Tools (Dynamic)           │
│  ├─ read_file          │  ├─ mcp_<server>_<tool>        │
│  ├─ write_file         │  └─ Discovered at runtime      │
│  ├─ edit_file          │                                │
│  ├─ bash               │  Slash Commands                │
│  ├─ task (subagents)   │  ├─ /help, /status, /commit    │
│  └─ scud               │  ├─ /cl:* (workflows)          │
│                        │  └─ /scud:* (task mgmt)        │
├─────────────────────────────────────────────────────────┤
│  Development: bun run dev|build|typecheck               │
└─────────────────────────────────────────────────────────┘
```

---

## Code References

- Tool definitions: `agent/src/server/providers/index.ts:79-235`
- Tool execution: `agent/src/server/tools.ts:496-523`
- MCP module: `agent/src/server/mcp/`
- Command system: `agent/src/server/commands.ts`
- Built-in commands: `agent/src/server/commands/`
- SCUD commands: `.claude/commands/scud/`
- Claude commands: `.claude/commands/cl/`
- Package scripts: `agent/package.json:7-13`

---

## Related Research
- See `.claude/skills/scud-workflow.md` for SCUD usage guide

## Open Questions
- None at this time
