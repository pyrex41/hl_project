# Subagent Streaming UI Fixes Implementation Plan

## Overview

Fix multiple UI issues with subagent rendering: streaming visibility, result ordering, and card expansion behavior.

## Current State Analysis

### Issue 1: Subagents Don't Stream Results (XAI Models)
**Location**: `agent/src/client/App.tsx:825-872` (subagent_progress handler)

The streaming infrastructure exists - `subagent_progress` events update `currentText` and `currentTools` in the running subagents map. However, there may be provider-specific issues with xAI models where events are buffered on the server side before being sent to the client.

**Server-side streaming**: `agent/src/server/subagent.ts` - The `runSubagent()` generator yields events that should stream.

### Issue 2: All Results Appear at Once
**Location**: `agent/src/client/App.tsx:1744-1800`

The rendering happens correctly with `For each={Array.from(runningSubagents().values())}`, but if the server batches events (e.g., buffering until completion), they all arrive simultaneously.

### Issue 3: Main Task Card Auto-Expands
**Observation**: The inline subagent cards aren't "expanded" by default - they show collapsed in the main chat. The "expanded" state (`expandedSubagent`) is for the modal overlay. This may refer to a different behavior - perhaps the main orchestrating task's tool calls are showing expanded?

### Issue 4: Output Ordering (Top-level shifts above subtasks)
**Location**: `agent/src/client/App.tsx:1802-1807`

The current rendering order is:
1. Messages (1683-1717)
2. Current tools (1719-1742)
3. Running subagents (1744-1768)
4. Completed subagents (1770-1800)
5. Current assistant text (1802-1807)

The issue is that `currentAssistant()` (the streaming parent response) appears AFTER subagent cards. But once `finalizeAssistantMessage()` is called (line 936-954), the content is moved to `messages()` which renders BEFORE the subagent cards.

This creates the "shift" - while streaming, parent text is below subagents. After finalization, it moves to the messages array above.

## Desired End State

1. **Streaming**: Subagent results stream in real-time with visible progress
2. **Incremental display**: See each subagent's results as they complete, not all at once
3. **Card expansion**: Main task orchestrator card (if any) is collapsed by default
4. **Output ordering**: Parent task output stays consistently below all subtask cards

## What We're NOT Doing

- Server-side streaming architecture changes (unless xAI-specific buffering is identified)
- Complete UI redesign
- Tab system modifications

## Implementation Approach

### Phase 1: Fix Output Ordering

The core fix is to prevent finalized messages from appearing above subagent cards. Completed subagents should be "associated" with the assistant message that spawned them.

**Changes Required:**

#### 1.1 Track Which Subagents Belong to Which Message

**File**: `agent/src/client/App.tsx`

Add a field to track which message spawned which subagents:

```typescript
// Around line 59, modify SubagentResult:
interface SubagentResult {
  taskId: string
  task: SubagentTask
  summary: string
  fullHistory: Message[]
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'max_iterations'
  error?: string
  iterations?: number
  currentText?: string
  currentTools?: Map<string, ToolCall>
  parentMessageIndex?: number  // NEW: Index of the message that spawned this subagent
}
```

#### 1.2 Associate Subagents with Messages

**File**: `agent/src/client/App.tsx`

When subagent_start arrives, track the current message index:

```typescript
// Line 805, modify subagent_start handler:
case 'subagent_start':
  setRunningSubagents(prev => {
    const next = new Map(prev)
    next.set(event.taskId as string, {
      taskId: event.taskId as string,
      task: {
        id: event.taskId as string,
        description: event.description as string,
        role: event.role as SubagentRole
      },
      summary: '',
      fullHistory: [],
      status: 'running',
      currentText: '',
      currentTools: new Map(),
      parentMessageIndex: messages().length  // Track current message count
    })
    return next
  })
  break
```

#### 1.3 Render Subagents Inline with Their Parent Message

**File**: `agent/src/client/App.tsx`

Modify the message rendering to include completed subagents after each message:

```typescript
// Replace lines 1683-1800 with:
<For each={messages()}>
  {(msg, index) => (
    <>
      <div class="message">
        <Show when={msg.role === 'user'}>
          <div class="message-user">{msg.content}</div>
        </Show>
        <Show when={msg.role === 'assistant'}>
          <Show when={msg.toolCalls}>
            <For each={msg.toolCalls}>
              {(tool) => (
                <div class="tool-call">
                  {/* ... existing tool rendering ... */}
                </div>
              )}
            </For>
          </Show>
          <Show when={msg.content}>
            <div class="message-assistant">{msg.content}</div>
          </Show>
        </Show>
      </div>

      {/* Render completed subagents that belong to this message */}
      <For each={completedSubagents().filter(s => s.parentMessageIndex === index())}>
        {(subagent) => (
          <div class="message">
            <div class={`subagent-card-inline ${subagent.status}`} onClick={() => setExpandedSubagent(subagent)}>
              {/* ... existing subagent card rendering ... */}
            </div>
          </div>
        )}
      </For>
    </>
  )}
</For>

{/* Running subagents (always at the bottom, being actively worked on) */}
<For each={Array.from(runningSubagents().values())}>
  {/* ... existing running subagent rendering ... */}
</For>

{/* Completed subagents that don't have a parent message yet (orphaned during streaming) */}
<For each={completedSubagents().filter(s => s.parentMessageIndex === undefined || s.parentMessageIndex >= messages().length)}>
  {/* ... existing completed subagent rendering ... */}
</For>

{/* Current assistant text */}
<Show when={currentAssistant()}>
  {/* ... existing ... */}
</Show>
```

### Phase 2: Prevent Main Task Card Auto-Expansion

This appears to be about the main task tool call (e.g., when the parent agent calls the "task" tool to spawn subagents). The tool call card itself shows expanded.

#### 2.1 Add Collapsed State for Tool Calls

**File**: `agent/src/client/App.tsx`

Add state to track collapsed tool calls:

```typescript
// Around line 358, add:
const [collapsedTools, setCollapsedTools] = createSignal<Set<string>>(new Set())
```

#### 2.2 Modify Tool Call Rendering to Support Collapse

**File**: `agent/src/client/App.tsx`

Update tool call rendering to be collapsible, with task-spawning tools collapsed by default:

```typescript
// In the tool rendering (around line 1691-1709), add toggle:
<div class="tool-call">
  <div
    class="tool-header"
    onClick={() => {
      setCollapsedTools(prev => {
        const next = new Set(prev)
        if (next.has(tool.id)) next.delete(tool.id)
        else next.add(tool.id)
        return next
      })
    }}
  >
    <span class="tool-expand-icon">{collapsedTools().has(tool.id) ? '▶' : '▼'}</span>
    <span class="tool-name">{tool.name}</span>
    <span class={`tool-status ${tool.status}`}>
      {/* ... existing status ... */}
    </span>
  </div>
  <Show when={!collapsedTools().has(tool.id)}>
    <Show when={tool.input}>
      <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
    </Show>
    {renderToolOutput(tool)}
  </Show>
</div>
```

#### 2.3 Auto-Collapse Task Tool Calls

**File**: `agent/src/client/App.tsx`

When a task tool is detected, auto-collapse it:

```typescript
// In tool_start handler (line 708), add auto-collapse for task tools:
case 'tool_start':
  setStatus('executing')
  setCurrentTools(prev => {
    const next = new Map(prev)
    next.set(event.id as string, {
      id: event.id as string,
      name: event.name as string,
      input: '',
      status: 'pending',
    })
    return next
  })
  // Auto-collapse task tool calls
  if ((event.name as string) === 'task') {
    setCollapsedTools(prev => new Set([...prev, event.id as string]))
  }
  break
```

### Phase 3: Investigate XAI Streaming

#### 3.1 Check Server-Side Event Flushing

**File**: `agent/src/server/index.ts`

Ensure SSE events are flushed immediately:

```typescript
// Around line 277-280, verify flush behavior:
await stream.writeSSE({
  event: event.type,
  data: JSON.stringify(event)
})
// Hono's streamSSE should auto-flush, but verify with xAI models
```

#### 3.2 Add Debug Logging for Streaming Events

**File**: `agent/src/server/subagent.ts`

Add timestamps to events to diagnose buffering:

```typescript
// In runSubagent around line 121, add timestamp:
yield {
  type: 'subagent_progress',
  taskId: task.id,
  event: streamEvent,
  timestamp: Date.now()  // For debugging
}
```

#### 3.3 Client-Side Event Timing

**File**: `agent/src/client/App.tsx`

Add console logging to see when events arrive:

```typescript
// In handleEvent (line 702), add timing:
const handleEvent = (event: { type: string; [key: string]: unknown }) => {
  if (event.type.startsWith('subagent')) {
    console.log(`[${Date.now()}] ${event.type}`, event.taskId)
  }
  // ... rest of handler
}
```

## Success Criteria

### Automated Verification:
- [x] TypeScript compiles without errors: `npm run build`
- [ ] No console errors in browser DevTools
- [ ] Event timestamps show progressive streaming (not batched)

### Manual Verification:
- [ ] Spawn multiple subagents with xAI model
- [ ] Verify each subagent's progress streams incrementally
- [ ] Verify completed subagents stay below their parent message
- [ ] Verify task tool calls are collapsed by default
- [ ] Verify clicking collapsed task tool expands it
- [ ] Verify parent output doesn't "jump" above subtasks

## Testing Strategy

### Unit Tests:
- Test `parentMessageIndex` tracking logic
- Test collapsed state toggle behavior

### Manual Testing Steps:
1. Start conversation with xAI model
2. Ask it to spawn 3 parallel subagents
3. Watch streaming - should see incremental updates
4. After completion, verify ordering is stable
5. Verify task tool is collapsed, subagent cards visible

## References

- Main App component: `agent/src/client/App.tsx`
- Styles: `agent/src/client/styles.css`
- Server streaming: `agent/src/server/index.ts`
- Subagent execution: `agent/src/server/subagent.ts`
