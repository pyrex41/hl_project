# Parallel Subagents Implementation Plan

## Overview

Add a `task` tool that spawns subagents to execute tasks in parallel. Each subagent runs its own agent loop with independent provider/model configuration.

## Requirements Summary

1. **Parallel Execution**: Multiple subagents can run simultaneously
2. **Configuration System**: Settings for subagent behavior stored in `.agent/config.json`
3. **Confirmation Mode**: Option to auto-spawn or ask user before spawning
4. **Per-Subagent Model Selection**: User can specify model/provider for each subagent when prompted
5. **Subagent Types**: Three role types with different prompts and default models:
   - `simple` - Simple task executor (fast, cheap model)
   - `complex` - Complicated task executor (powerful model)
   - `researcher` - Research/exploration focused (balanced model)
6. **Smart Role Selection**: Prompting to help LLM pick appropriate role type

---

## Architecture

### New Files

```
src/server/
├── config.ts           # Configuration loading/saving
├── subagent.ts         # Subagent execution logic
└── tools/
    └── task.ts         # Task tool implementation

src/client/
└── components/
    └── SubagentConfirm.tsx  # Confirmation dialog component
```

### Modified Files

```
src/server/
├── agent.ts            # Add subagent event handling
├── types.ts            # New event types for subagents
├── prompt.ts           # Add task tool guidance
└── providers/index.ts  # Add task tool definition

src/server/index.ts     # Config endpoints
src/client/App.tsx      # Subagent confirmation UI
```

---

## Phase 1: Configuration System

### 1.1 Config Schema (`src/server/config.ts`)

```typescript
export interface SubagentConfig {
  // When to confirm with user
  confirmMode: 'always' | 'never' | 'multiple' // multiple = only when >1 agent

  // Default timeout per subagent (seconds)
  timeout: number

  // Max concurrent subagents
  maxConcurrent: number

  // Role-specific defaults
  roles: {
    simple: {
      provider: ProviderName
      model: string
      maxIterations: number
    }
    complex: {
      provider: ProviderName
      model: string
      maxIterations: number
    }
    researcher: {
      provider: ProviderName
      model: string
      maxIterations: number
    }
  }
}

export const DEFAULT_CONFIG: SubagentConfig = {
  confirmMode: 'always',
  timeout: 120,
  maxConcurrent: 5,
  roles: {
    simple: {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      maxIterations: 10
    },
    complex: {
      provider: 'anthropic',
      model: 'claude-opus-4-5-20251101',
      maxIterations: 25
    },
    researcher: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250514',
      maxIterations: 15
    }
  }
}
```

### 1.2 Config File Location

- Project-level: `{workingDir}/.agent/config.json`
- Falls back to defaults if not present
- API endpoints:
  - `GET /api/config` - Load current config
  - `PUT /api/config` - Update config

---

## Phase 2: Task Tool Definition

### 2.1 Tool Schema

```typescript
{
  name: 'task',
  description: `Spawn a subagent to handle a task. Use for:
- Parallel work that doesn't depend on each other
- Delegating research or exploration
- Complex subtasks that need focused attention

Role selection guide:
- simple: Quick, straightforward tasks (file reads, simple edits, commands)
- complex: Multi-step tasks requiring reasoning and iteration
- researcher: Exploring codebases, finding patterns, gathering information

Multiple tasks are executed in parallel. Results are returned when all complete.`,
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'List of tasks to spawn',
        items: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'What the subagent should do'
            },
            role: {
              type: 'string',
              enum: ['simple', 'complex', 'researcher'],
              description: 'Task complexity/type for model selection'
            },
            context: {
              type: 'string',
              description: 'Optional additional context for the subagent'
            }
          },
          required: ['description', 'role']
        }
      }
    },
    required: ['tasks']
  }
}
```

### 2.2 Example Usage by LLM

```json
{
  "name": "task",
  "input": {
    "tasks": [
      {
        "description": "Find all files that import the User model",
        "role": "researcher"
      },
      {
        "description": "Read and summarize the authentication middleware",
        "role": "simple"
      },
      {
        "description": "Implement input validation for the login endpoint",
        "role": "complex"
      }
    ]
  }
}
```

---

## Phase 3: Subagent Execution

### 3.1 New Types (`src/server/types.ts`)

```typescript
// New event types
export type AgentEvent =
  | ... existing ...
  | { type: 'subagent_request'; tasks: SubagentTask[] }
  | { type: 'subagent_confirmed'; tasks: SubagentTask[] }
  | { type: 'subagent_cancelled'; taskIds: string[] }
  | { type: 'subagent_start'; taskId: string; description: string; role: SubagentRole }
  | { type: 'subagent_progress'; taskId: string; event: AgentEvent }
  | { type: 'subagent_complete'; taskId: string; summary: string; fullHistory: Message[] }
  | { type: 'subagent_error'; taskId: string; error: string; fullHistory: Message[] }

export type SubagentRole = 'simple' | 'complex' | 'researcher'

export interface SubagentTask {
  id: string
  description: string
  role: SubagentRole
  context?: string
  // User can override these in confirmation
  provider?: ProviderName
  model?: string
}
```

### 3.2 Subagent Execution Flow

```
1. LLM calls task tool with tasks array
2. Agent emits 'subagent_request' event
3. If confirmMode != 'never':
   - UI shows confirmation dialog
   - User can modify model/provider per task
   - User confirms or cancels
4. Agent receives confirmation via 'subagent_confirmed' event
5. For each task (in parallel):
   a. Create subagent with role-specific config
   b. Run agent loop with task description as user message
   c. Stream progress events (nested in subagent_progress)
   d. Collect final result
6. Return combined results to parent agent
```

### 3.3 Subagent Implementation (`src/server/subagent.ts`)

```typescript
export interface SubagentOptions {
  task: SubagentTask
  workingDir: string
  config: SubagentConfig
  // NO parent history - subagents get fresh context only
}

export async function* runSubagent(
  options: SubagentOptions
): AsyncGenerator<AgentEvent> {
  const { task, workingDir, config } = options

  // Get role config (with user overrides)
  const roleConfig = config.roles[task.role]
  const provider = task.provider || roleConfig.provider
  const model = task.model || roleConfig.model

  // Build subagent prompt
  const subagentPrompt = buildSubagentPrompt(task)

  yield { type: 'subagent_start', taskId: task.id, description: task.description, role: task.role }

  // Run the agent loop - NO task tool available to subagents (no nesting)
  let finalOutput = ''
  let history: Message[] = []  // Track for expandable view
  try {
    for await (const event of agentLoop(
      subagentPrompt,
      [],  // Fresh context - no parent history
      workingDir,
      { provider, model, excludeTools: ['task'] }  // Prevent nested spawning
    )) {
      // Forward events with taskId wrapper
      yield { type: 'subagent_progress', taskId: task.id, event }

      // Capture final text output (this is the summary)
      if (event.type === 'text_delta') {
        finalOutput += event.delta
      }

      // Track history for UI
      // (accumulate messages as they come in)
    }

    // The final text output IS the summary (prompted to be concise)
    yield {
      type: 'subagent_complete',
      taskId: task.id,
      summary: finalOutput,  // Goes to parent agent
      fullHistory: history   // Only for UI expansion
    }
  } catch (error) {
    yield {
      type: 'subagent_error',
      taskId: task.id,
      error: error instanceof Error ? error.message : 'Unknown error',
      fullHistory: history  // Still provide history for debugging
    }
  }
}

function buildSubagentPrompt(task: SubagentTask): string {
  const rolePrompts = {
    simple: 'Complete this task efficiently.',
    complex: 'Carefully work through this task step by step. Think before acting.',
    researcher: 'Explore and gather information thoroughly.'
  }

  return `${rolePrompts[task.role]}

Task: ${task.description}
${task.context ? `\nContext: ${task.context}` : ''}

IMPORTANT: When you're done, output a brief summary (2-4 sentences) of what you accomplished or found. This summary will be returned to the orchestrating agent.`
}
```

### 3.4 Parallel Execution in Task Tool

```typescript
// In tools/task.ts
export async function* executeTaskTool(
  input: { tasks: SubagentTask[] },
  workingDir: string,
  config: SubagentConfig,
  onConfirm: (tasks: SubagentTask[]) => Promise<SubagentTask[] | null>
): AsyncGenerator<AgentEvent> {
  // Assign IDs
  const tasks = input.tasks.map((t, i) => ({
    ...t,
    id: `subagent_${Date.now()}_${i}`
  }))

  // Request confirmation if needed
  if (config.confirmMode === 'always' ||
      (config.confirmMode === 'multiple' && tasks.length > 1)) {
    yield { type: 'subagent_request', tasks }

    // Wait for user confirmation
    const confirmed = await onConfirm(tasks)
    if (!confirmed) {
      return { output: 'Task execution cancelled by user' }
    }

    yield { type: 'subagent_confirmed', tasks: confirmed }
  }

  // Run all tasks in parallel
  const generators = tasks.map(task =>
    runSubagent({ task, workingDir, config })
  )

  // Merge streams and collect summaries (NOT full history)
  const summaries: Map<string, string> = new Map()

  // Use Promise.all with async iteration
  await Promise.all(
    generators.map(async (gen, i) => {
      for await (const event of gen) {
        yield event
        if (event.type === 'subagent_complete') {
          summaries.set(event.taskId, event.summary)
        }
      }
    })
  )

  // Format summaries for parent agent (lean context)
  const output = tasks.map((task, i) =>
    `## Task ${i + 1}: ${task.description}\n\n${summaries.get(task.id) || '(no result)'}`
  ).join('\n\n---\n\n')

  return { output }  // Parent only sees summaries, not full subagent histories
}
```

---

## Phase 4: UI Components

### 4.1 Subagent Confirmation Dialog

```tsx
// src/client/components/SubagentConfirm.tsx
interface SubagentConfirmProps {
  tasks: SubagentTask[]
  providers: ProviderInfo[]
  onConfirm: (tasks: SubagentTask[]) => void
  onCancel: () => void
}

function SubagentConfirm({ tasks, providers, onConfirm, onCancel }: SubagentConfirmProps) {
  const [editedTasks, setEditedTasks] = createSignal([...tasks])

  return (
    <div class="subagent-confirm-overlay">
      <div class="subagent-confirm-dialog">
        <h3>Spawn {tasks.length} Subagent{tasks.length > 1 ? 's' : ''}?</h3>

        <div class="subagent-list">
          <For each={editedTasks()}>
            {(task, i) => (
              <div class="subagent-item">
                <div class="task-header">
                  <span class="task-role">{task.role}</span>
                  <span class="task-description">{task.description}</span>
                </div>

                <div class="task-config">
                  <select
                    value={task.provider}
                    onChange={(e) => updateTask(i(), 'provider', e.target.value)}
                  >
                    <For each={providers}>
                      {(p) => <option value={p.name}>{p.name}</option>}
                    </For>
                  </select>

                  <select
                    value={task.model}
                    onChange={(e) => updateTask(i(), 'model', e.target.value)}
                  >
                    <For each={getModelsForProvider(task.provider)}>
                      {(m) => <option value={m.id}>{m.name}</option>}
                    </For>
                  </select>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button onClick={() => onConfirm(editedTasks())} class="primary">
            Spawn Agents
          </button>
        </div>
      </div>
    </div>
  )
}
```

### 4.2 Subagent Progress Display

Show running subagents with cancel button and live status:

```tsx
// Running subagent card
function SubagentRunning({ task, onCancel }: { task: SubagentTask; onCancel: () => void }) {
  return (
    <div class="subagent-card running">
      <div class="subagent-header">
        <span class="role-badge">{task.role}</span>
        <span class="description">{task.description}</span>
        <button class="cancel-btn" onClick={onCancel} title="Cancel">×</button>
      </div>
      <div class="subagent-status">
        <Spinner /> Running...
      </div>
    </div>
  )
}
```

### 4.3 Subagent Result Display (Expandable Window)

Show summary with click-to-expand into full scrollable window:

```tsx
function SubagentResult({ task, result, fullHistory }: SubagentResultProps) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <>
      <div class="subagent-card completed" onClick={() => setExpanded(true)}>
        <div class="subagent-header">
          <span class="role-badge">{task.role}</span>
          <span class="description">{task.description}</span>
          <span class="expand-hint">Click to expand</span>
        </div>
        <div class="subagent-summary">
          {result.slice(0, 200)}...
        </div>
      </div>

      {expanded() && (
        <SubagentWindow
          task={task}
          history={fullHistory}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  )
}

// Full window overlay with scrollable history
function SubagentWindow({ task, history, onClose }: SubagentWindowProps) {
  return (
    <div class="subagent-window-overlay" onClick={onClose}>
      <div class="subagent-window" onClick={(e) => e.stopPropagation()}>
        <div class="window-header">
          <span class="role-badge">{task.role}</span>
          <span class="description">{task.description}</span>
          <button class="close-btn" onClick={onClose}>×</button>
        </div>
        <div class="window-content">
          <For each={history}>
            {(msg) => <MessageDisplay message={msg} />}
          </For>
        </div>
      </div>
    </div>
  )
}
```

---

## Phase 5: Integration

### 5.1 Modified Agent Loop (`src/server/agent.ts`)

The main agent loop needs to:
1. Recognize the `task` tool as special
2. Handle the confirmation flow
3. Stream subagent events to the client

```typescript
// In agent.ts, modify tool execution section
if (tool.name === 'task') {
  // Special handling for task tool
  const taskInput = tool.input as { tasks: SubagentTask[] }

  for await (const event of executeTaskTool(
    taskInput,
    workingDir,
    config,
    async (tasks) => {
      // Emit request and wait for confirmation via SSE
      yield { type: 'subagent_request', tasks }
      return await waitForConfirmation()
    }
  )) {
    yield event
  }
} else {
  // Normal tool execution
  const result = await executeTool(tool.name, tool.input, workingDir)
  // ...
}
```

### 5.2 SSE Confirmation Flow

The confirmation flow requires bidirectional communication:

1. Server emits `subagent_request` event
2. Client shows dialog
3. Client sends confirmation via new endpoint: `POST /api/confirm-subagents`
4. Server continues execution

Alternative: Use a callback-based approach where the server polls for confirmation.

### 5.3 Updated System Prompt

Add guidance for the task tool in `src/server/prompt.ts`:

```typescript
export const SYSTEM_PROMPT = `You are a coding assistant...

Tools: read_file, write_file, edit_file, bash, task

Guidelines:
- Read files before editing
- Use edit_file for precise changes
- Use bash for ls, grep, find, git
- Use task tool for parallel work:
  - 'simple' role: quick file operations, simple queries
  - 'complex' role: multi-step implementations, refactoring
  - 'researcher' role: exploring code, finding patterns
- Be concise`
```

---

## Implementation Order

1. **Config system** (1-2 hours)
   - Create `config.ts` with types and loading logic
   - Add API endpoints for config
   - Add default config file generation

2. **Task tool definition** (1 hour)
   - Add tool schema to `providers/index.ts`
   - Update system prompt

3. **Subagent execution** (2-3 hours)
   - Create `subagent.ts`
   - Implement parallel execution
   - Handle streaming events

4. **Agent integration** (2-3 hours)
   - Modify `agent.ts` for task tool handling
   - Implement confirmation flow
   - Add new event types

5. **UI components** (2-3 hours)
   - Create confirmation dialog
   - Add subagent progress display
   - Style appropriately

6. **Testing** (1-2 hours)
   - Test parallel execution
   - Test confirmation flow
   - Test error handling

---

## Design Decisions

1. **Context Sharing**: NO. Subagents receive ONLY the prompt from parent.
   - Fresh context, no parent history
   - Parent must provide all necessary context in the task description

2. **Result Aggregation**: Summary for parent, full history for UI
   - Subagent generates a concise summary as its final output
   - Parent agent receives ONLY the summary (not full history)
   - UI shows summary card, click to expand into scrollable window with full history
   - Keeps parent context lean while preserving debuggability

3. **Cancellation**: Yes, if intuitive
   - Show cancel button per running subagent
   - Graceful termination (let current tool finish, don't start new iteration)

4. **Nesting**: ABSOLUTELY NOT.
   - Subagents do NOT have access to the `task` tool
   - Prevents runaway agent spawning
   - Keep architecture simple and predictable

---

## Success Criteria

- [x] User can configure subagent defaults in `.agent/config.json`
- [x] LLM can spawn multiple subagents with single tool call
- [x] Subagents run in parallel (not sequential)
- [x] Confirmation dialog shows before spawning (when configured)
- [x] User can override model/provider per subagent
- [x] Progress is shown for each running subagent
- [x] Results are aggregated and returned to parent agent
- [x] Errors in one subagent don't crash others
