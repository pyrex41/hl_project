---
date: 2025-12-04T22:59:52Z
researcher: Claude
git_commit: d82bd430f68b8227a93c39e0b7b617c9463ceea8
branch: dev
repository: opencode
topic: "Test Harness and Agent Approach Architecture"
tags: [research, codebase, testing, agents, sessions, tools]
status: complete
last_updated: 2025-12-04
last_updated_by: Claude
---

# Research: Test Harness and Agent Approach Architecture

**Date**: 2025-12-04T22:59:52Z
**Researcher**: Claude
**Git Commit**: d82bd430f68b8227a93c39e0b7b617c9463ceea8
**Branch**: dev
**Repository**: opencode

## Research Question

Deep dive into understanding the test harness and agent approach used in the OpenCode codebase.

## Summary

OpenCode uses a **context-based test harness pattern** built on Node.js `AsyncLocalStorage` rather than traditional test harness classes. The `Instance.provide()` function creates isolated execution contexts for tests and server requests, providing project metadata and enabling instance-scoped state management with automatic cleanup.

The **agent system** is a flexible, configurable architecture where agents are defined via markdown files with YAML frontmatter or as built-in defaults. Agents control tool access, permissions, model parameters, and system prompts. The **Task tool** enables hierarchical agent execution by spawning sub-agents in child sessions.

Key architectural patterns:
- **AsyncLocalStorage-based context isolation** for test and request scoping
- **Configuration-driven agent definitions** loaded from `.opencode/agent/` directories
- **Hierarchical session model** with parent-child relationships for sub-agent tasks
- **Event-driven tool execution** with real-time metadata streaming
- **Permission-based access control** at agent, tool, and command levels

---

## Detailed Findings

### 1. Test Harness Architecture

#### The Instance.provide() Pattern

The primary "test harness" is the `Instance.provide()` function at `packages/opencode/src/project/instance.ts:16-37`. Rather than using a class-based harness, OpenCode uses Node.js's `AsyncLocalStorage` to create isolated execution contexts.

**Core mechanism:**
```typescript
async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R>
```

**What it provides:**
- `Instance.directory` - Current working directory
- `Instance.worktree` - Git repository root
- `Instance.project` - Project metadata (ID, VCS info, timestamps)

**How it enables test isolation:**
1. Each call with a unique directory path gets its own cached context
2. AsyncLocalStorage ensures async operations see the correct context
3. State entries (via `Instance.state()`) are keyed by directory
4. `Symbol.asyncDispose` enables automatic cleanup with `await using`

**Test usage pattern:**
```typescript
test("example", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // All Instance.* calls resolve to tmp.path context
      const config = await Config.get()
      expect(config).toBeDefined()
    },
  })
})
```

#### Test Infrastructure Files

| File | Purpose |
|------|---------|
| `packages/opencode/bunfig.toml` | Bun test configuration with preload |
| `packages/opencode/test/preload.ts` | Environment setup before test imports |
| `packages/opencode/test/fixture/fixture.ts` | `tmpdir()` helper for temp directories |
| `packages/opencode/test/fixture/lsp/fake-lsp-server.js` | Mock LSP server |

#### Test Framework

- **Primary**: Bun's built-in test runner (`bun:test`)
- **Python SDK**: pytest with pytest-asyncio
- **Go SDK**: Native Go testing package
- **VSCode Extension**: @vscode/test-cli with Mocha-style API

---

### 2. Agent System Architecture

#### Agent Definition and Loading

Agents are defined in markdown files at `.opencode/agent/*.md` with YAML frontmatter:

```markdown
---
description: Use this agent when...
mode: subagent
temperature: 0.7
tools:
  edit: false
---

System prompt content here...
```

**Loading flow** (`packages/opencode/src/config/config.ts:218-258`):
1. `Filesystem.up()` discovers `.opencode` directories from cwd to project root
2. Glob pattern `agent/**/*.md` finds all agent files
3. `gray-matter` parses YAML frontmatter + markdown body
4. Zod schema validates configuration
5. `mergeDeep()` combines with built-in agents

**Built-in agents** (`packages/opencode/src/agent/agent.ts:102-169`):
| Agent | Mode | Purpose |
|-------|------|---------|
| `build` | primary | Default execution agent |
| `plan` | primary | Planning with restricted bash permissions |
| `general` | subagent | Parallel multi-step tasks |
| `explore` | subagent | Read-only codebase exploration |

#### Agent.Info Structure

```typescript
interface Agent.Info {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  builtIn: boolean
  temperature?: number
  topP?: number
  color?: string
  model?: { providerID: string; modelID: string }
  prompt?: string
  tools: Record<string, boolean>
  options: Record<string, any>
  permission: {
    edit: Permission
    bash: Record<string, Permission>
    webfetch?: Permission
    doom_loop?: Permission
    external_directory?: Permission
  }
}
```

---

### 3. Task Tool and Sub-Agent Spawning

The Task tool (`packages/opencode/src/tool/task.ts`) enables hierarchical agent execution by spawning child sessions with specialized agents.

#### Execution Flow

1. **Session Creation** (lines 33-42):
   - Creates child session with `parentID` set to current session
   - Reuses existing session if `session_id` parameter provided

2. **Agent Configuration** (lines 70-73):
   - Uses agent's model if configured
   - Falls back to parent message's model

3. **Tool Filtering** (lines 91-97):
   - Disables recursive `task` calls
   - Disables `todowrite`/`todoread` for sub-agents
   - Applies agent-specific tool restrictions

4. **Event Monitoring** (lines 56-68):
   - Subscribes to `MessageV2.Event.PartUpdated`
   - Tracks child tool calls for parent metadata
   - Enables real-time UI updates

5. **Result Extraction** (lines 100-116):
   - Collects all tool parts from child session
   - Returns final text output with session metadata

#### Parent-Child Session Relationship

```
Parent Session
├── User Message
├── Assistant Message
│   └── Task Tool Part (running)
│       └── Child Session
│           ├── User Message (from Task prompt)
│           └── Assistant Message
│               ├── Tool Part 1
│               ├── Tool Part 2
│               └── Text Part (final result)
└── (continues after Task completes)
```

---

### 4. Session Processing

The session processor (`packages/opencode/src/session/processor.ts`) handles AI model streaming, tool invocation, and state management.

#### Stream Event Handling

| Event | Action |
|-------|--------|
| `start` | Set session status to "busy" |
| `reasoning-*` | Create/update reasoning part |
| `tool-input-start` | Create pending tool part |
| `tool-call` | Update to running, check doom loop |
| `tool-result` | Update to completed with output |
| `tool-error` | Update to error, check for blocking |
| `step-start` | Create filesystem snapshot |
| `step-finish` | Calculate costs, generate patch |
| `text-*` | Stream text with deltas |

#### Doom Loop Detection (lines 145-184)

Prevents infinite tool call loops:
1. Checks if last 3 tool calls are identical
2. Consults agent's `doom_loop` permission
3. If "ask", prompts user for confirmation
4. If "deny", throws `Permission.RejectedError`

#### Retry Logic (`packages/opencode/src/session/retry.ts`)

- Parses `retry-after` headers from API responses
- Exponential backoff: 2s initial, 2x factor, 30s max
- Session status shows countdown during retry

---

### 5. Tool Registry and Execution

#### Tool Registration (`packages/opencode/src/tool/registry.ts`)

**Sources:**
1. Built-in tools (hardcoded in `all()`)
2. Custom tools from `.opencode/tool/*.{js,ts}`
3. Plugin-provided tools
4. MCP (Model Context Protocol) tools

**Built-in tools:**
- `bash`, `read`, `write`, `edit`, `glob`, `grep`, `list`
- `task` (sub-agent spawning)
- `webfetch`, `websearch`, `codesearch`
- `todowrite`, `todoread`
- `batch` (experimental)

#### Tool Execution Context

```typescript
interface Tool.Context {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { model: Model }
  metadata(input: { title?: string; metadata?: M }): void
}
```

#### Permission Layers

1. **Provider restrictions**: `codesearch`/`websearch` only for `opencode` provider
2. **Agent permissions**: `edit: "deny"` disables edit/write tools
3. **Wildcard patterns**: Enable/disable by pattern matching

---

### 6. State Management

#### Instance.state() Pattern

```typescript
state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S
```

Creates per-instance lazy-initialized state with optional cleanup:

```typescript
// In agent.ts
const state = Instance.state(async () => {
  const agents = { /* build agent registry */ }
  return agents
})

// Usage
const agents = await Agent.state()
```

**Key features:**
- State keyed by directory path
- Function reference used as secondary key
- Cleanup runs on `Instance.dispose()`
- Warning after 10s of slow disposal

---

## Code References

### Core Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/opencode/src/project/instance.ts` | 16-37 | Instance.provide() implementation |
| `packages/opencode/src/util/context.ts` | 10-24 | AsyncLocalStorage wrapper |
| `packages/opencode/src/project/state.ts` | 12-64 | State management |
| `packages/opencode/src/agent/agent.ts` | 42-214 | Agent initialization |
| `packages/opencode/src/tool/task.ts` | 14-116 | Task tool implementation |
| `packages/opencode/src/session/processor.ts` | 31-390 | Stream processing |
| `packages/opencode/src/session/prompt.ts` | 234-630 | Session prompt loop |
| `packages/opencode/src/tool/registry.ts` | 26-144 | Tool registry |
| `packages/opencode/src/config/config.ts` | 218-258 | Agent loading |

### Test Files

| File | Purpose |
|------|---------|
| `packages/opencode/test/preload.ts` | Test environment setup |
| `packages/opencode/test/fixture/fixture.ts` | tmpdir() helper |
| `packages/opencode/test/snapshot/snapshot.test.ts` | Comprehensive Instance.provide() examples |
| `packages/opencode/test/session/session.test.ts` | Event subscription patterns |
| `packages/opencode/test/tool/bash.test.ts` | Tool testing with context |

---

## Architecture Documentation

### Design Patterns Used

| Pattern | Location | Purpose |
|---------|----------|---------|
| **Factory** | `Tool.define()`, `SessionProcessor.create()` | Consistent object creation |
| **Observer** | `Bus.subscribe()` | Event-driven communication |
| **Strategy** | Agent configurations | Different behaviors per agent |
| **Decorator** | Plugin hooks | Extensible tool execution |
| **Adapter** | `fromPlugin()` | Plugin to internal interface |
| **Singleton** | `Instance.state()` | Per-directory cached state |

### Data Flow

```
User Request
    │
    ▼
Instance.provide({ directory })
    │
    ├── Project.fromDirectory() → Git discovery
    │
    ├── AsyncLocalStorage.run(ctx, fn)
    │       │
    │       ▼
    │   Config.get() → Load agents from .opencode/agent/
    │       │
    │       ▼
    │   Session.create() → Initialize session
    │       │
    │       ▼
    │   SessionPrompt.loop()
    │       │
    │       ├── Agent.get() → Resolve agent config
    │       │
    │       ├── resolveTools() → Filter by agent permissions
    │       │
    │       ├── SessionProcessor.create() → Handle streaming
    │       │       │
    │       │       └── Tool execution → Bus events
    │       │
    │       └── Task tool → Child session (recurse)
    │
    └── Cleanup via Symbol.asyncDispose
```

---

## Open Questions

1. **MCP Tool Discovery**: How are MCP servers discovered and connected? The tool registry loads MCP tools but the discovery mechanism wasn't fully traced.

2. **Plugin Lifecycle**: What triggers plugin loading and when are plugin hooks registered relative to config loading?

3. **Session Compaction**: The compaction system for context overflow mentioned in prompt.ts (lines 402-418, 420-433) handles message summarization - how does this interact with sub-agent sessions?

4. **Snapshot Storage**: Snapshots use git tree objects stored in a separate directory - where is this configured and how is cleanup handled?

---

## Related Research

- No existing research documents found in `thoughts/shared/research/`

---

## Appendix: Test Pattern Examples

### Basic Test with Instance.provide()

```typescript
import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("example", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Test code here
      expect(Instance.worktree).toBe(tmp.path)
    },
  })
})
```

### Event Subscription Test

```typescript
test("event ordering", async () => {
  await Instance.provide({
    directory: projectRoot,
    fn: async () => {
      const events: string[] = []
      const unsub = Bus.subscribe(Session.Event.Created, () => events.push("created"))

      const session = await Session.create({})
      await new Promise(r => setTimeout(r, 100))

      unsub()
      expect(events).toContain("created")
      await Session.remove(session.id)
    },
  })
})
```

### Tool Testing with Context

```typescript
const ctx = {
  sessionID: "test",
  messageID: "",
  toolCallID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

test("bash execution", async () => {
  const bash = await BashTool.init()
  await Instance.provide({
    directory: projectRoot,
    fn: async () => {
      const result = await bash.execute({ command: "echo test" }, ctx)
      expect(result.metadata.exit).toBe(0)
    },
  })
})
```
