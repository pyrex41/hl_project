# Model Interruption Implementation Plan

## Overview

Add the ability to interrupt/stop the model during generation, with options to stop individual subagents or stop all. When stopped, partial responses are preserved with an "[interrupted]" marker, and users can continue naturally by typing follow-up messages.

## Current State Analysis

### The Problem
- Once a chat request starts, it runs to completion with no way to stop it
- No AbortController is used for fetch requests
- The server-side `agentLoop` has no abort signal
- Subagents can only be cancelled during confirmation, not while running

### Key Files
- `agent/src/client/App.tsx` - Client state, sendMessage, UI
- `agent/src/server/index.ts` - `/api/chat` endpoint with SSE streaming
- `agent/src/server/agent.ts` - `agentLoop` AsyncGenerator
- `agent/src/server/subagent.ts` - `runSubagent`, `runSubagentsParallel`

### Key Discoveries
- Status signal at App.tsx:416 tracks: `idle | thinking | executing | error | awaiting_confirmation`
- Fetch + getReader() pattern at App.tsx:842-880
- `streamSSE` from Hono at index.ts:293
- `agentLoop` is AsyncGenerator at agent.ts:46
- Subagent events include `subagent_start`, `subagent_progress`, `subagent_complete`

## Desired End State

1. **Stop button** appears when model is generating (status !== 'idle')
2. **Clicking stop** aborts the current request, preserves partial output with "[interrupted by user]" marker
3. **User can continue** by simply typing a follow-up message (normal flow)
4. **Individual subagent stop** - Each running subagent card has a stop button
5. **Global stop all** - Main stop button also stops all running subagents

### Verification
- Start a long response → click stop → partial response preserved with marker
- Start subagents → stop one individually → others continue
- Start subagents → click main stop → all stop
- After stopping → type message → conversation continues normally

## What We're NOT Doing

- Adding a "continue from where you left off" special command
- Storing interrupt state in sessions
- Server-side request tracking/management beyond AbortSignal
- Graceful shutdown of tool executions mid-way

## Implementation Approach

Use standard web AbortController/AbortSignal pattern:
1. Client creates AbortController, passes signal to fetch
2. Server detects abort and stops streaming
3. Client finalizes partial message with interrupt marker

## Phase 1: Client-Side Abort Infrastructure

### Overview
Add AbortController to track and cancel ongoing requests.

### Changes Required:

#### 1.1 Add Abort Controller State

**File**: `agent/src/client/App.tsx`
**Location**: Near other state declarations (~line 416)
**Changes**: Add signal to track current request

```typescript
// Add after status signal
const [abortController, setAbortController] = createSignal<AbortController | null>(null)
```

#### 1.2 Update sendMessage to Use AbortController

**File**: `agent/src/client/App.tsx`
**Location**: sendMessage function (~line 817)
**Changes**: Create controller, pass signal to fetch, handle abort

```typescript
const sendMessage = async (useParallel = false) => {
  let msg = input().trim()
  if (!msg || status() !== 'idle') return

  // ... existing code until fetch ...

  // Create abort controller for this request
  const controller = new AbortController()
  setAbortController(controller)

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg,
        history: messages().slice(0, -1),
        sessionId: sessionId(),
        provider: selectedProvider(),
        model: selectedModel(),
      }),
      signal: controller.signal,  // Add abort signal
    })

    // ... rest of streaming code ...

  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Request was aborted - finalize with interrupt marker
      finalizeAssistantMessage(true)  // true = interrupted
    } else {
      setStatus('error')
      console.error('Agent error:', error)
    }
  } finally {
    setAbortController(null)
  }
}
```

#### 1.3 Update finalizeAssistantMessage

**File**: `agent/src/client/App.tsx`
**Location**: finalizeAssistantMessage function (~line 1145)
**Changes**: Accept interrupted flag, append marker

```typescript
const finalizeAssistantMessage = (interrupted = false) => {
  const text = currentAssistant()
  const tools = currentTools()

  if (text || tools.size > 0) {
    const toolCalls = Array.from(tools.values())
    let finalContent = text

    // Add interrupt marker if stopped by user
    if (interrupted && text) {
      finalContent = text + '\n\n*[interrupted by user]*'
    }

    setMessages(prev => [...prev, {
      role: 'assistant',
      content: finalContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    }])
  }

  setCurrentAssistant('')
  setCurrentTools(new Map())
  setStatus('idle')
}
```

#### 1.4 Add Stop Function

**File**: `agent/src/client/App.tsx`
**Location**: After sendMessage function
**Changes**: Add function to abort current request

```typescript
const stopGeneration = () => {
  const controller = abortController()
  if (controller) {
    controller.abort()
    // Also stop all running subagents
    stopAllSubagents()
  }
}

const stopAllSubagents = () => {
  // Mark all running subagents as cancelled
  const running = runningSubagents()
  if (running.size > 0) {
    const cancelled: SubagentResult[] = []
    running.forEach((subagent, id) => {
      cancelled.push({
        ...subagent,
        status: 'cancelled',
        summary: 'Stopped by user'
      })
    })
    setCompletedSubagents(prev => [...prev, ...cancelled])
    setRunningSubagents(new Map())
    setRunningSubagentIds([])
  }
}

const stopSubagent = (taskId: string) => {
  const running = runningSubagents()
  const subagent = running.get(taskId)
  if (subagent) {
    // Move to completed with cancelled status
    setCompletedSubagents(prev => [...prev, {
      ...subagent,
      status: 'cancelled',
      summary: 'Stopped by user'
    }])
    // Remove from running
    const newRunning = new Map(running)
    newRunning.delete(taskId)
    setRunningSubagents(newRunning)
    setRunningSubagentIds(prev => prev.filter(id => id !== taskId))
  }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd agent && bun run build`

#### Manual Verification:
- [ ] Stop button appears during generation
- [ ] Clicking stop aborts the request
- [ ] Partial response is preserved with "[interrupted by user]" marker
- [ ] Status returns to idle after stopping
- [ ] Can send new message after stopping

---

## Phase 2: Stop Button UI

### Overview
Add stop button to input area that shows during generation.

### Changes Required:

#### 2.1 Add Stop Button to Input Area

**File**: `agent/src/client/App.tsx`
**Location**: Input area JSX (~line 2318-2348)
**Changes**: Add conditional stop button

Find the input area and add stop button. The input area is structured like:
```tsx
<div class="input-area">
  {/* Add stop button before input */}
  {status() !== 'idle' && (
    <button
      class="stop-btn"
      onClick={stopGeneration}
      title="Stop generation (Escape)"
    >
      ⏹
    </button>
  )}
  <textarea ... />
</div>
```

#### 2.2 Add Keyboard Shortcut (Escape)

**File**: `agent/src/client/App.tsx`
**Location**: handleKeyDown or global key handler
**Changes**: Add Escape key handler

```typescript
// In the component, add effect for global escape key
createEffect(() => {
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && status() !== 'idle') {
      e.preventDefault()
      stopGeneration()
    }
  }
  window.addEventListener('keydown', handleEscape)
  onCleanup(() => window.removeEventListener('keydown', handleEscape))
})
```

#### 2.3 Add Stop Button Styles

**File**: `agent/src/client/styles.css`
**Location**: Near input-area styles (~line 646)
**Changes**: Add stop button styling

```css
.stop-btn {
  background: var(--error-bg, #3a1a1a);
  border: 1px solid var(--error-border, #ff4444);
  color: var(--error-text, #ff6b6b);
  border-radius: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.15s ease;
  margin-right: 8px;
}

.stop-btn:hover {
  background: var(--error-border, #ff4444);
  color: white;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd agent && bun run build`

#### Manual Verification:
- [ ] Stop button appears when generating, hidden when idle
- [ ] Stop button is visually distinct (red/warning color)
- [ ] Pressing Escape key also stops generation
- [ ] Stop button has hover effect

---

## Phase 3: Individual Subagent Stop

### Overview
Add stop button to each running subagent card.

### Changes Required:

#### 3.1 Add Stop Button to Running Subagent Cards

**File**: `agent/src/client/App.tsx`
**Location**: Running subagent cards JSX (~line 2029-2088)
**Changes**: Add stop button to each card

In the running subagent card, add a stop button:
```tsx
<div class="subagent-card-inline running" onClick={() => setExpandedSubagentId(id)}>
  <div class="subagent-card-header">
    <span class={`role-badge ${getRoleBadgeClass(subagent.task.role)}`}>
      {subagent.task.role}
    </span>
    <span class="subagent-card-desc">{subagent.task.description}</span>
    {/* Add stop button */}
    <button
      class="subagent-stop-btn"
      onClick={(e) => {
        e.stopPropagation()  // Don't expand card
        stopSubagent(id)
      }}
      title="Stop this subagent"
    >
      ⏹
    </button>
  </div>
  <div class="subagent-card-status">Running...</div>
</div>
```

#### 3.2 Add Stop Button to Subagent Window Header

**File**: `agent/src/client/App.tsx`
**Location**: Subagent window modal (~line 2474-2591)
**Changes**: Add stop button in header for running subagents

In the subagent window header:
```tsx
<div class="subagent-window-header">
  {/* existing header content */}
  {subagent.status === 'running' && (
    <button
      class="subagent-stop-btn"
      onClick={() => stopSubagent(subagent.task.id)}
      title="Stop this subagent"
    >
      ⏹ Stop
    </button>
  )}
  <button class="close-btn" onClick={() => setExpandedSubagentId(null)}>×</button>
</div>
```

#### 3.3 Add Subagent Stop Button Styles

**File**: `agent/src/client/styles.css`
**Location**: Near subagent styles
**Changes**: Add subagent stop button styling

```css
.subagent-stop-btn {
  background: transparent;
  border: 1px solid var(--error-border, #ff4444);
  color: var(--error-text, #ff6b6b);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 11px;
  margin-left: auto;
  transition: all 0.15s ease;
}

.subagent-stop-btn:hover {
  background: var(--error-border, #ff4444);
  color: white;
}

.subagent-window-header .subagent-stop-btn {
  padding: 4px 10px;
  font-size: 12px;
  margin-right: 8px;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd agent && bun run build`

#### Manual Verification:
- [ ] Stop button appears on each running subagent card
- [ ] Clicking stop on card doesn't expand the card (stopPropagation works)
- [ ] Stopped subagent shows as "cancelled" with "Stopped by user" message
- [ ] Other subagents continue running
- [ ] Stop button appears in expanded subagent window header

---

## Phase 4: Server-Side Abort Handling (Optional Enhancement)

### Overview
While client-side abort works for stopping the UI, server-side handling ensures resources are cleaned up properly.

### Changes Required:

#### 4.1 Handle Client Disconnect in SSE Stream

**File**: `agent/src/server/index.ts`
**Location**: `/api/chat` endpoint (~line 262)
**Changes**: Detect client disconnect and clean up

The Hono SSE stream already handles client disconnects gracefully - when the client aborts, the stream closes. However, the `agentLoop` generator continues running.

For a full implementation, we would need to:
1. Pass an AbortSignal through to agentLoop
2. Check the signal in the loop iterations
3. Pass signal to provider.stream()

This is optional for v1 since:
- Client-side abort immediately stops showing new content
- Server will eventually complete or timeout
- No resources are permanently leaked

If needed later:
```typescript
// In index.ts
app.post('/api/chat', async (c) => {
  const abortController = new AbortController()

  // Listen for client disconnect
  c.req.raw.signal.addEventListener('abort', () => {
    abortController.abort()
  })

  return streamSSE(c, async (stream) => {
    for await (const event of agentLoop(..., abortController.signal)) {
      if (abortController.signal.aborted) break
      // ...
    }
  })
})
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd agent && bun run build`

#### Manual Verification:
- [ ] Server logs show clean termination when client aborts
- [ ] No orphaned processes or hanging requests

---

## Testing Strategy

### Manual Testing Steps:
1. Start app, send a message that triggers a long response
2. Click stop button mid-generation → verify partial response + marker
3. Press Escape mid-generation → verify same behavior
4. Type follow-up message → verify conversation continues
5. Start subagents, stop one individually → verify others continue
6. Start subagents, click main stop → verify all stop
7. Check cancelled subagent shows proper status
8. Refresh page → verify stopped messages persist in session

## Performance Considerations

- AbortController is lightweight, one per request
- Client-side abort is immediate, no server round-trip needed
- Subagent cancellation is UI-only (server may continue briefly)

## Migration Notes

None required - this is additive functionality.

## References

- MDN AbortController: https://developer.mozilla.org/en-US/docs/Web/API/AbortController
- Hono SSE: https://hono.dev/docs/helpers/streaming#streamsse
- SolidJS effects: https://docs.solidjs.com/reference/basic-reactivity/create-effect
