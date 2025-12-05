# Subagent Chat History in New Tab Implementation Plan

## Overview

Add the ability to open a subagent's chat history in a new dedicated tab from the expanded card view. This tab will show the full conversation history and continue receiving live updates if the subagent is still running.

## Current State Analysis

The application currently has:
- **Inline subagent cards** (lines 1167-1222 in App.tsx) - Compact cards for running/completed subagents
- **Expanded subagent overlay** (lines 1313-1416 in App.tsx) - Modal overlay showing full history
- **No tab system** - The app uses a single-view with modal overlays pattern

### Key Discoveries:
- `expandedSubagent` signal (line 129) holds the currently viewed subagent in modal
- `runningSubagents` signal (line 127) is a Map that tracks live progress
- `completedSubagents` signal (line 128) is an array of finished subagents
- Live progress is tracked via `currentText` and `currentTools` fields on `SubagentResult`
- The subagent window shows both `fullHistory` and live `currentTools`/`currentText` for running subagents

## Desired End State

When viewing a subagent in the expanded modal view, users can click a button to "Open in Tab". This will:
1. Create a new tab dedicated to that subagent's chat history
2. Close the modal overlay
3. The new tab will show the same content as the expanded view
4. If the subagent is still running, the tab continues to receive live updates
5. Multiple subagent tabs can be open simultaneously
6. Tabs can be closed individually

### Verification:
- Click "Open in Tab" on a running subagent → new tab appears with live updates
- Click "Open in Tab" on a completed subagent → new tab appears with full history
- Close a subagent tab → returns to main chat (if it was active)
- Multiple subagent tabs can coexist

## What We're NOT Doing

- Not implementing a full tabbed interface for the main chat
- Not persisting subagent tabs across page reloads
- Not implementing drag-and-drop tab reordering
- Not implementing tab groups or nested tabs

## Implementation Approach

Introduce a minimal tab system specifically for viewing subagent histories. The main chat remains the "default" view, and subagent tabs are additional views that can be opened/closed.

## Phase 1: Add Tab State Management

### Overview
Add state signals and types to manage open tabs.

### Changes Required:

#### 1.1 Add Tab Types and State

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
**Changes**: Add new interfaces and signals for tab management

After line 106 (after `TokenUsage` interface), add:

```typescript
interface SubagentTab {
  id: string           // Unique tab ID (can reuse taskId)
  taskId: string       // The subagent's task ID
  title: string        // Tab title (truncated description)
}
```

After line 136 (after `settingsModels` signal), add:

```typescript
// Tab state
const [openTabs, setOpenTabs] = createSignal<SubagentTab[]>([])
const [activeTab, setActiveTab] = createSignal<string | null>(null) // null = main chat
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd agent && npm run build`
- [x] App loads without runtime errors

#### Manual Verification:
- [ ] No visible UI changes yet (state only)

---

## Phase 2: Add Tab Bar UI

### Overview
Add a tab bar component below the header showing open subagent tabs.

### Changes Required:

#### 2.1 Add Tab Bar Component

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
**Changes**: Add tab bar UI between header and messages area

After line 1102 (after sessions panel `</Show>`), add the tab bar:

```tsx
{/* Tab Bar - only show when there are open subagent tabs */}
<Show when={openTabs().length > 0}>
  <div class="tab-bar">
    <button
      class={`tab-item ${activeTab() === null ? 'active' : ''}`}
      onClick={() => setActiveTab(null)}
    >
      <span class="tab-icon">◈</span>
      <span class="tab-title">Main Chat</span>
    </button>
    <For each={openTabs()}>
      {(tab) => {
        // Get the current subagent state (could be running or completed)
        const getSubagent = () => {
          const running = runningSubagents().get(tab.taskId)
          if (running) return running
          return completedSubagents().find(s => s.taskId === tab.taskId)
        }
        return (
          <button
            class={`tab-item ${activeTab() === tab.id ? 'active' : ''} ${getSubagent()?.status === 'running' ? 'running' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span class={`role-badge-mini ${getRoleBadgeClass(getSubagent()?.task.role || 'simple')}`}>
              {getSubagent()?.task.role?.charAt(0).toUpperCase() || 'S'}
            </span>
            <span class="tab-title">{tab.title}</span>
            <Show when={getSubagent()?.status === 'running'}>
              <span class="tab-spinner"><span class="spinner" /></span>
            </Show>
            <button
              class="tab-close"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ×
            </button>
          </button>
        )
      }}
    </For>
  </div>
</Show>
```

#### 2.2 Add Tab Helper Functions

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
**Changes**: Add functions to open/close tabs

After line 952 (after `getRoleBadgeClass` function), add:

```typescript
const openSubagentTab = (subagent: SubagentResult) => {
  // Check if tab already exists
  const existing = openTabs().find(t => t.taskId === subagent.taskId)
  if (existing) {
    setActiveTab(existing.id)
    setExpandedSubagent(null)
    return
  }

  // Create new tab
  const newTab: SubagentTab = {
    id: subagent.taskId,
    taskId: subagent.taskId,
    title: subagent.task.description.slice(0, 30) + (subagent.task.description.length > 30 ? '...' : '')
  }
  setOpenTabs(prev => [...prev, newTab])
  setActiveTab(newTab.id)
  setExpandedSubagent(null)
}

const closeTab = (tabId: string) => {
  setOpenTabs(prev => prev.filter(t => t.id !== tabId))
  // If we closed the active tab, switch to main chat
  if (activeTab() === tabId) {
    const remaining = openTabs().filter(t => t.id !== tabId)
    if (remaining.length > 0) {
      setActiveTab(remaining[remaining.length - 1].id)
    } else {
      setActiveTab(null)
    }
  }
}
```

#### 2.3 Add Tab Bar Styles

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/styles.css`
**Changes**: Add styles for the tab bar

At end of file, add:

```css
/* Tab Bar */
.tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  min-height: 36px;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  max-width: 200px;
}

.tab-item:hover {
  background: var(--bg-tertiary);
  color: var(--text);
}

.tab-item.active {
  background: var(--bg-tertiary);
  border-color: var(--border);
  color: var(--text);
}

.tab-item.running {
  border-color: var(--yellow);
}

.tab-icon {
  color: var(--accent);
  font-size: 12px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.tab-spinner {
  display: flex;
  align-items: center;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  margin-left: 4px;
  transition: all 0.1s ease;
}

.tab-close:hover {
  background: var(--border);
  color: var(--text);
}

.role-badge-mini {
  font-size: 9px;
  font-weight: 700;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
}

.role-badge-mini.role-badge-simple {
  background: rgba(63, 185, 80, 0.15);
  color: var(--green);
}

.role-badge-mini.role-badge-complex {
  background: rgba(163, 113, 247, 0.15);
  color: var(--purple);
}

.role-badge-mini.role-badge-researcher {
  background: rgba(88, 166, 255, 0.15);
  color: var(--accent);
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd agent && npm run build`
- [x] CSS is valid (no syntax errors)

#### Manual Verification:
- [ ] Tab bar does not appear when no subagent tabs are open
- [ ] Tab bar styling looks correct (will test after Phase 3)

---

## Phase 3: Add Tab Content View

### Overview
Show the appropriate content based on which tab is active - either main chat or a subagent's history.

### Changes Required:

#### 3.1 Wrap Main Chat Content in Conditional

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
**Changes**: Conditionally show main chat or subagent tab content

Wrap the messages area (lines 1104-1232) and input area (lines 1234-1247) in a Show block:

Replace the messages div and input-area div with:

```tsx
{/* Main chat view - shown when no subagent tab is active */}
<Show when={activeTab() === null}>
  <div class="messages">
    {/* ... existing messages content ... */}
  </div>

  <div class="input-area">
    {/* ... existing input content ... */}
  </div>
</Show>

{/* Subagent tab view */}
<Show when={activeTab() !== null}>
  {(() => {
    const tab = openTabs().find(t => t.id === activeTab())
    if (!tab) return null

    // Get the subagent from running or completed
    const subagent = () => {
      const running = runningSubagents().get(tab.taskId)
      if (running) return running
      return completedSubagents().find(s => s.taskId === tab.taskId)
    }

    return (
      <Show when={subagent()}>
        {(sa) => (
          <div class="subagent-tab-content">
            <div class="subagent-tab-header">
              <span class={`role-badge ${getRoleBadgeClass(sa().task.role)}`}>{sa().task.role}</span>
              <span class="subagent-tab-desc">{sa().task.description}</span>
              <Show when={sa().status === 'running'}>
                <span class="subagent-window-status running"><span class="spinner" /> Live</span>
              </Show>
              <Show when={sa().status === 'max_iterations'}>
                <span class="subagent-window-status max-iterations">Hit max iterations</span>
              </Show>
              <Show when={sa().status === 'completed'}>
                <span class="subagent-window-status completed">Completed</span>
              </Show>
              <Show when={sa().status === 'error'}>
                <span class="subagent-window-status error">Error</span>
              </Show>
            </div>
            <div class="subagent-tab-messages">
              {/* Full history */}
              <For each={sa().fullHistory}>
                {(msg) => (
                  <div class="subagent-message">
                    <Show when={msg.role === 'user'}>
                      <div class="message-user">{msg.content}</div>
                    </Show>
                    <Show when={msg.role === 'assistant'}>
                      <Show when={msg.toolCalls}>
                        <For each={msg.toolCalls}>
                          {(tool) => (
                            <div class="tool-call">
                              <div class="tool-header">
                                <span class="tool-name">{tool.name}</span>
                                <span class={`tool-status ${tool.status}`}>
                                  {tool.status === 'done' && '✓'}
                                  {tool.status === 'error' && '✗'}
                                </span>
                              </div>
                              <Show when={tool.input}>
                                <div class="tool-input">{formatToolInput(tool.name, typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input))}</div>
                              </Show>
                              <Show when={tool.output}>
                                <div class="tool-output">{tool.output}</div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                      <Show when={msg.content}>
                        <div class="message-assistant">{msg.content}</div>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>

              {/* Live progress for running subagents */}
              <Show when={sa().status === 'running'}>
                <div class="subagent-live-progress">
                  <Show when={sa().currentTools && sa().currentTools!.size > 0}>
                    <For each={Array.from(sa().currentTools!.values())}>
                      {(tool) => (
                        <div class="tool-call">
                          <div class="tool-header">
                            <span class="tool-name">{tool.name}</span>
                            <span class={`tool-status ${tool.status}`}>
                              {(tool.status === 'pending' || tool.status === 'running') && <span class="spinner" />}
                              {tool.status === 'done' && '✓'}
                              {tool.status === 'error' && '✗'}
                              {tool.status}
                            </span>
                          </div>
                          <Show when={tool.input}>
                            <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
                          </Show>
                          <Show when={tool.output}>
                            <div class="tool-output">{tool.output}</div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={sa().currentText}>
                    <div class="message-assistant">{sa().currentText}</div>
                  </Show>
                </div>
              </Show>
            </div>

            {/* Footer with Continue button for max_iterations */}
            <Show when={sa().status === 'max_iterations'}>
              <div class="subagent-tab-footer">
                <span class="max-iterations-info">
                  Subagent hit max iterations ({sa().iterations}). You can continue running it.
                </span>
                <button
                  class="dialog-btn confirm"
                  onClick={() => continueSubagent(sa())}
                >
                  Continue
                </button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    )
  })()}
</Show>
```

#### 3.2 Add Subagent Tab Content Styles

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/styles.css`
**Changes**: Add styles for subagent tab content area

At end of file, add:

```css
/* Subagent Tab Content */
.subagent-tab-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.subagent-tab-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.subagent-tab-desc {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.subagent-tab-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.subagent-tab-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.subagent-window-status.completed {
  background: rgba(63, 185, 80, 0.15);
  color: var(--green);
}

.subagent-window-status.error {
  background: rgba(248, 81, 73, 0.15);
  color: var(--red);
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd agent && npm run build`

#### Manual Verification:
- [ ] Tab content switches correctly between main chat and subagent tabs
- [ ] Subagent history is displayed correctly in tab view
- [ ] Live updates work for running subagents in tab view

---

## Phase 4: Add "Open in Tab" Button to Expanded View

### Overview
Add a button in the expanded subagent modal to open the subagent in a dedicated tab.

### Changes Required:

#### 4.1 Add Open in Tab Button

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
**Changes**: Add button to subagent window header

In the subagent window header (around line 1317), add an "Open in Tab" button before the close button:

```tsx
<div class="subagent-window-header">
  <span class={`role-badge ${getRoleBadgeClass(subagent().task.role)}`}>{subagent().task.role}</span>
  <span class="subagent-window-desc">{subagent().task.description}</span>
  <Show when={subagent().status === 'running'}>
    <span class="subagent-window-status running"><span class="spinner" /> Live</span>
  </Show>
  <Show when={subagent().status === 'max_iterations'}>
    <span class="subagent-window-status max-iterations">Hit max iterations</span>
  </Show>
  <button
    class="open-tab-btn"
    onClick={() => openSubagentTab(subagent())}
    title="Open in dedicated tab"
  >
    <span class="btn-icon">⧉</span>
    Open in Tab
  </button>
  <button class="close-btn" onClick={() => setExpandedSubagent(null)}>×</button>
</div>
```

#### 4.2 Add Open in Tab Button Styles

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/styles.css`
**Changes**: Add styles for the open in tab button

At end of file, add:

```css
/* Open in Tab Button */
.open-tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.open-tab-btn:hover {
  background: var(--bg);
  color: var(--text);
  border-color: var(--accent-dim);
}

.open-tab-btn .btn-icon {
  font-size: 12px;
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd agent && npm run build`

#### Manual Verification:
- [ ] "Open in Tab" button appears in expanded subagent view
- [ ] Clicking the button opens a new tab and closes the modal
- [ ] If tab already exists for that subagent, it activates the existing tab

---

## Phase 5: Handle Tab Cleanup and Edge Cases

### Overview
Ensure tabs are properly handled when subagents complete, error, or are cleaned up.

### Changes Required:

#### 5.1 Auto-scroll in Tab View

**File**: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
**Changes**: Add auto-scroll effect for subagent tab content

Add a ref for the subagent tab messages area and update the createEffect for auto-scroll to include it:

In the subagent tab content, add a ref:

```tsx
let subagentMessagesEndRef: HTMLDivElement | undefined

// In the subagent-tab-messages div, add at the end:
<div ref={subagentMessagesEndRef} />
```

Update the createEffect around line 371:

```typescript
createEffect(() => {
  messages()
  currentAssistant()
  runningSubagents() // Track running subagents changes
  if (activeTab() === null && messagesEndRef) {
    messagesEndRef.scrollIntoView({ behavior: 'smooth' })
  }
  if (activeTab() !== null && subagentMessagesEndRef) {
    subagentMessagesEndRef.scrollIntoView({ behavior: 'smooth' })
  }
})
```

#### 5.2 Keep Tab Updated When Subagent Completes

The existing reactive state management should handle this automatically since:
- `runningSubagents` signal updates are reactive
- `completedSubagents` signal updates are reactive
- The tab content lookup function checks both

No additional changes needed - verify this works in testing.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd agent && npm run build`

#### Manual Verification:
- [ ] Tab content auto-scrolls as new messages arrive
- [ ] When a running subagent completes, its tab shows "Completed" status
- [ ] When a running subagent errors, its tab shows "Error" status
- [ ] Closing a tab while subagent is still running doesn't affect the subagent

---

## Testing Strategy

### Unit Tests:
- Not applicable for this UI feature (no complex logic to unit test)

### Integration Tests:
- Not applicable (UI-only changes)

### Manual Testing Steps:
1. Start a subagent task
2. While running, click on the inline card to expand
3. Click "Open in Tab" - verify modal closes and tab appears
4. Verify live updates continue in the tab view
5. Wait for completion - verify status updates to "Completed"
6. Open another subagent in a new tab
7. Switch between tabs - verify content is correct
8. Close a tab - verify tab bar updates correctly
9. Test with max_iterations subagent - verify "Continue" button works in tab view
10. Test with errored subagent - verify error status shows in tab

## Performance Considerations

- Tab content uses the same reactive signals as the modal, so no additional memory overhead
- Only the active tab content is rendered (via Show blocks)
- No unnecessary re-renders since SolidJS only updates what changed

## References

- Main App.tsx: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/App.tsx`
- Styles: `/Users/reuben/gauntlet/hl_project_worktrees/tabs/agent/src/client/styles.css`
- Existing subagent window: App.tsx:1313-1416
- Running subagents state: App.tsx:127
- Completed subagents state: App.tsx:128
