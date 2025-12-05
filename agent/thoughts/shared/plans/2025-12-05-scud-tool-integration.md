# SCUD Tool Integration Implementation Plan

## Overview

Add SCUD task management as a native tool available to the agent and subagents. This provides clean, structured access to task management without requiring bash command construction, with rich UI rendering support.

## Current State Analysis

### Agent Tool Architecture
- Tools defined in `agent/src/server/providers/index.ts:78-171` as `ToolDefinition[]`
- Tool execution in `agent/src/server/tools.ts:303-323` via `executeTool()`
- Current tools: `read_file`, `write_file`, `edit_file`, `bash`, `task`
- Subagents use `subagentToolDefinitions` (excludes `task` to prevent nesting)

### SCUD CLI
- Installed globally at `/Users/reuben/Library/pnpm/scud`
- Core commands: `list`, `show`, `set-status`, `next`, `stats`, `waves`, `claim`, `release`
- AI commands: `parse-prd`, `expand`, `analyze-complexity`

### Key Discoveries
- `agent/src/server/tools.ts:231-300` shows bash tool pattern we can model after
- `agent/src/server/types.ts:20-29` defines `ToolResult` with `output` (for LLM) and `details` (for UI)
- Subagent tool access controlled via `subagentToolDefinitions` filter in `providers/index.ts:175`

## Desired End State

After implementation:
1. Agent can call `scud` tool with structured parameters
2. Subagents can also access the `scud` tool (for updating their own task status)
3. Tool returns structured data for rich UI rendering
4. Auto-claim/release behavior simplifies multi-agent coordination
5. Actions supported: `list`, `show`, `set-status`, `next`, `stats`, `parse-prd`, `expand`

### Verification
- Agent can list tasks via tool call
- Agent can update task status and see UI render the change
- Subagent can mark its assigned task as done
- Auto-claim triggers when setting status to `in-progress`
- `parse-prd` and `expand` work with AI features

## What We're NOT Doing

- Not reimplementing SCUD logic - we wrap the CLI
- Not adding all SCUD commands (waves, whois, doctor, etc.) - can add later
- Not building custom task storage - using existing `.scud/` files
- Not modifying SCUD CLI itself

## Implementation Approach

Wrap the SCUD CLI with a native tool that:
1. Validates and transforms parameters into CLI commands
2. Executes via child_process (like bash tool)
3. Parses output into structured data for UI
4. Handles auto-claim/release logic
5. Provides helpful error messages

---

## Phase 1: Core SCUD Tool

### Overview
Add the basic `scud` tool with core actions: `list`, `show`, `set-status`, `next`, `stats`.

### Changes Required

#### 1.1 Add Tool Definition

**File**: `agent/src/server/providers/index.ts`
**Changes**: Add scud tool to `toolDefinitions` array

```typescript
{
  name: 'scud',
  description: `Manage SCUD tasks (task graph system for tracking work).

Actions:
- list: List tasks. Optional: status (pending|in-progress|done|blocked), tag
- show: Show task details. Required: id. Optional: tag
- set-status: Update task status. Required: id, status. Optional: tag
- next: Find next available task. Optional: tag, claim (boolean), name (for claiming)
- stats: Show completion statistics. Optional: tag

Examples:
- List pending tasks: action="list" status="pending"
- Show task 3: action="show" id="3"
- Start task: action="set-status" id="3" status="in-progress"
- Complete task: action="set-status" id="3" status="done"
- Get next task: action="next"`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'show', 'set-status', 'next', 'stats'],
        description: 'The SCUD action to perform'
      },
      id: {
        type: 'string',
        description: 'Task ID (for show, set-status)'
      },
      status: {
        type: 'string',
        enum: ['pending', 'in-progress', 'done', 'blocked', 'review', 'deferred', 'cancelled'],
        description: 'Task status (for set-status) or filter (for list)'
      },
      tag: {
        type: 'string',
        description: 'Tag/epic name to operate on'
      },
      name: {
        type: 'string',
        description: 'Agent name for claiming tasks'
      },
      claim: {
        type: 'boolean',
        description: 'Auto-claim when using next action'
      }
    },
    required: ['action']
  }
}
```

#### 1.2 Add Tool Implementation

**File**: `agent/src/server/tools.ts`
**Changes**: Add `scudTool` function and register in `executeTool`

```typescript
interface ScudInput {
  action: 'list' | 'show' | 'set-status' | 'next' | 'stats'
  id?: string
  status?: string
  tag?: string
  name?: string
  claim?: boolean
}

async function scudTool(input: ScudInput, workingDir: string): Promise<ToolResult> {
  // Build command based on action
  let command = 'scud'

  switch (input.action) {
    case 'list':
      command += ' list'
      if (input.status) command += ` --status ${input.status}`
      if (input.tag) command += ` --tag ${input.tag}`
      break

    case 'show':
      if (!input.id) {
        return { output: 'Error: id is required for show action', details: { type: 'error', data: { missing: 'id' } } }
      }
      command += ` show ${input.id}`
      if (input.tag) command += ` --tag ${input.tag}`
      break

    case 'set-status':
      if (!input.id || !input.status) {
        return { output: 'Error: id and status are required for set-status action', details: { type: 'error', data: { missing: !input.id ? 'id' : 'status' } } }
      }
      command += ` set-status ${input.id} ${input.status}`
      if (input.tag) command += ` --tag ${input.tag}`
      break

    case 'next':
      command += ' next'
      if (input.claim && input.name) {
        command += ` --claim --name ${input.name}`
      }
      if (input.tag) command += ` --tag ${input.tag}`
      break

    case 'stats':
      command += ' stats'
      if (input.tag) command += ` --tag ${input.tag}`
      break

    default:
      return { output: `Error: Unknown action: ${input.action}`, details: { type: 'error', data: { unknownAction: input.action } } }
  }

  // Execute command
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], {
      cwd: workingDir,
      env: process.env
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.stderr.on('data', (data) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({
          output: stderr || stdout || `SCUD command failed with code ${code}`,
          details: { type: 'error', data: { exitCode: code, stderr } }
        })
        return
      }

      // Parse output for structured data
      const details = parseScudOutput(input.action, stdout)

      resolve({
        output: stdout.trim(),
        details: { type: 'scud', data: { action: input.action, ...details } }
      })
    })

    proc.on('error', (error) => {
      resolve({
        output: `Error executing SCUD: ${error.message}`,
        details: { type: 'error', data: { error: error.message } }
      })
    })
  })
}

// Parse SCUD CLI output into structured data for UI
function parseScudOutput(action: string, output: string): Record<string, unknown> {
  // Basic parsing - can be enhanced for richer UI
  switch (action) {
    case 'list':
      // Could parse task table into array of objects
      return { raw: output }
    case 'stats':
      // Could extract percentages, counts
      return { raw: output }
    default:
      return { raw: output }
  }
}
```

#### 1.3 Register Tool in executeTool

**File**: `agent/src/server/tools.ts`
**Changes**: Add case for 'scud' in switch statement

```typescript
case 'scud':
  return scudTool(input as ScudInput, workingDir)
```

#### 1.4 Enable for Subagents

**File**: `agent/src/server/providers/index.ts`
**Changes**: Modify `subagentToolDefinitions` to include scud

```typescript
// Tool definitions for subagents - includes scud for task status updates
export const subagentToolDefinitions: ToolDefinition[] = toolDefinitions.filter(t => t.name !== 'task')
```

Note: The scud tool is already included since we're only filtering out 'task'. No change needed unless we want to be explicit.

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles: `cd agent && bun run build`
- [x] Tool appears in tool definitions
- [ ] Basic smoke test: start agent, call scud tool

#### Manual Verification
- [ ] `scud action="list"` returns task list
- [ ] `scud action="show" id="1"` shows task details
- [ ] `scud action="set-status" id="1" status="in-progress"` updates status
- [ ] `scud action="next"` finds next available task
- [ ] `scud action="stats"` shows statistics
- [ ] Subagent can call scud tool

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: AI-Powered Actions

### Overview
Add `parse-prd` and `expand` actions that leverage SCUD's AI capabilities.

### Changes Required

#### 2.1 Extend Tool Definition

**File**: `agent/src/server/providers/index.ts`
**Changes**: Add new actions to enum and description

```typescript
// In the scud tool definition, update:
action: {
  type: 'string',
  enum: ['list', 'show', 'set-status', 'next', 'stats', 'parse-prd', 'expand'],
  description: 'The SCUD action to perform'
},
// Add new properties:
file: {
  type: 'string',
  description: 'File path (for parse-prd)'
},
all: {
  type: 'boolean',
  description: 'Expand all complex tasks (for expand)'
}
```

Update description to include:
```
- parse-prd: Parse PRD file into tasks. Required: file, tag
- expand: Expand complex task into subtasks. Optional: id (specific task), all (expand all >=13 points), tag
```

#### 2.2 Extend Tool Implementation

**File**: `agent/src/server/tools.ts`
**Changes**: Add cases for parse-prd and expand

```typescript
case 'parse-prd':
  if (!input.file || !input.tag) {
    return { output: 'Error: file and tag are required for parse-prd action', details: { type: 'error', data: { missing: !input.file ? 'file' : 'tag' } } }
  }
  command += ` parse-prd ${input.file} --tag=${input.tag}`
  break

case 'expand':
  command += ' expand'
  if (input.id) {
    command += ` ${input.id}`
  }
  if (input.all) {
    command += ' --all'
  }
  if (input.tag) command += ` --tag ${input.tag}`
  break
```

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles: `cd agent && bun run build`
- [x] New actions appear in tool definition

#### Manual Verification
- [ ] `scud action="parse-prd" file="epic.md" tag="test"` parses PRD
- [ ] `scud action="expand" id="1"` expands single task
- [ ] `scud action="expand" all=true` expands all complex tasks

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Auto-Claim and Enhanced UX

### Overview
Add auto-claim behavior when setting status to `in-progress`, and enhance output parsing for better UI rendering.

### Changes Required

#### 3.1 Add Agent Name to Config

**File**: `agent/src/server/config.ts`
**Changes**: Add `agentName` to configuration

```typescript
export interface AgentConfig {
  mainChat?: MainChatConfig
  subagents: SubagentConfig
  agentName?: string  // For SCUD task claiming
}
```

#### 3.2 Implement Auto-Claim Logic

**File**: `agent/src/server/tools.ts`
**Changes**: Modify set-status to auto-claim/release

```typescript
case 'set-status':
  if (!input.id || !input.status) {
    return { output: 'Error: id and status are required', details: { type: 'error', data: { missing: !input.id ? 'id' : 'status' } } }
  }

  // Auto-claim when starting work
  if (input.status === 'in-progress' && input.name) {
    // First claim, then set status
    const claimCmd = `scud claim ${input.id} --name ${input.name}${input.tag ? ` --tag ${input.tag}` : ''}`
    await execPromise(claimCmd, workingDir)
  }

  command += ` set-status ${input.id} ${input.status}`
  if (input.tag) command += ` --tag ${input.tag}`

  // Auto-release when completing
  if (input.status === 'done') {
    // Release after setting status (will be handled after main command)
  }
  break
```

#### 3.3 Enhanced Output Parsing

**File**: `agent/src/server/tools.ts`
**Changes**: Improve `parseScudOutput` for better UI data

```typescript
function parseScudOutput(action: string, output: string): Record<string, unknown> {
  switch (action) {
    case 'list': {
      // Parse table into structured tasks
      const lines = output.split('\n').filter(l => l.includes('|'))
      const tasks = lines.slice(1).map(line => {
        const [id, status, title, complexity] = line.split('|').map(s => s.trim())
        return { id, status, title, complexity: parseInt(complexity) || 0 }
      })
      return { tasks, count: tasks.length }
    }

    case 'stats': {
      // Extract key metrics
      const totalMatch = output.match(/Total Tasks:\s*(\d+)/)
      const doneMatch = output.match(/Done:\s*(\d+)/)
      const progressMatch = output.match(/(\d+)%/)
      return {
        total: totalMatch ? parseInt(totalMatch[1]) : 0,
        done: doneMatch ? parseInt(doneMatch[1]) : 0,
        progress: progressMatch ? parseInt(progressMatch[1]) : 0
      }
    }

    case 'show': {
      // Extract task details
      const idMatch = output.match(/Task:\s*(\d+)/)
      const titleMatch = output.match(/Title:\s*(.+)/)
      const statusMatch = output.match(/Status:\s*(\w+)/)
      return {
        id: idMatch?.[1],
        title: titleMatch?.[1],
        status: statusMatch?.[1]
      }
    }

    default:
      return { raw: output }
  }
}
```

### Success Criteria

#### Automated Verification
- [ ] TypeScript compiles: `cd agent && bun run build`
- [ ] Config accepts agentName

#### Manual Verification
- [ ] Setting status to `in-progress` with name auto-claims
- [ ] Setting status to `done` auto-releases
- [ ] UI renders structured task data nicely

---

## Phase 4: UI Rendering (Optional Enhancement)

### Overview
Add a custom UI component to render SCUD tool results nicely.

### Changes Required

#### 4.1 Add SCUD Result Type

**File**: `agent/src/server/types.ts`
**Changes**: Add 'scud' to ToolResultDetails type

```typescript
export interface ToolResultDetails {
  type: 'file' | 'diff' | 'command' | 'error' | 'subagent' | 'scud'
  data: unknown
}
```

#### 4.2 Client-Side Rendering

**File**: `agent/src/client/App.tsx` (or equivalent)
**Changes**: Add rendering for scud tool results

This depends on the existing UI architecture. The structured data from `parseScudOutput` enables rich rendering like:
- Task lists as tables with status badges
- Stats as progress bars
- Task details as formatted cards

### Success Criteria

#### Manual Verification
- [ ] Task list renders as a nice table
- [ ] Stats show progress visualization
- [ ] Task details are well-formatted

---

## Testing Strategy

### Unit Tests
- Tool parameter validation
- Command construction for each action
- Output parsing for structured data

### Integration Tests
- End-to-end: agent calls scud tool, SCUD CLI executes, result returns
- Subagent can update task status

### Manual Testing Steps
1. Start agent, ask it to list SCUD tasks
2. Ask agent to show a specific task
3. Ask agent to start working on a task (verify auto-claim)
4. Ask agent to complete a task (verify auto-release)
5. Ask agent to parse a PRD file
6. Spawn a subagent and have it update its task status

## Performance Considerations

- SCUD CLI is fast (Rust-based), so subprocess overhead is minimal
- Consider caching stats/list results if called frequently
- No persistent connections needed

## Migration Notes

None - this is a new tool addition with no breaking changes.

## References

- SCUD PRD: `.scud/docs/prd/scud.xml`
- Agent tools: `agent/src/server/tools.ts`
- Tool definitions: `agent/src/server/providers/index.ts`
- SCUD CLI help: `scud help`
