# Graph View Improvements Implementation Plan

## Overview

Improve the agent UI graph view to properly show all subagents as distinct nodes with full history exploration capabilities, and fix text overflow design issues where text extends outside node boundaries.

## Current State Analysis

The graph view is implemented in `agent/src/client/App.tsx:151-300` with styling in `agent/src/client/styles.css:1540-1779`.

### Key Discoveries:

1. **Subagent Node Building** (`App.tsx:1476-1529`): The `buildSubagentNode()` function creates a `subagent-root` node and only adds child `subagent-message` nodes when the subagent is expanded. The subagent's `fullHistory` contains all messages including tool calls.

2. **Nested Subagents Not Rendered**: When a subagent spawns another subagent (via a `task` tool call), that nested subagent appears in the parent's `fullHistory` as a tool call but is NOT rendered as a separate expandable subagent node. The current code at `App.tsx:1508-1521` adds tool calls as simple `tool` type nodes without checking if they spawned subagents.

3. **Text Overflow Problem** (`App.tsx:229-235`): Labels are truncated to 28 characters via JavaScript, but SVG `<text>` elements don't support CSS `text-overflow`. The 200px node width combined with 12px monospace font should fit ~25-28 characters, but font rendering variations can cause overflow.

4. **Limited Detail View** (`App.tsx:326-336`): Clicking a subagent node shows only task description, status, and summary. There's no way to drill into the full conversation history from the graph view.

## Desired End State

1. **All subagents visible as nodes**: Every subagent (including nested ones spawned by other subagents) should appear as a distinct, expandable `subagent-root` node in the graph tree.

2. **Full history exploration**: Clicking a subagent node should allow viewing its complete message history, either:
   - In the expanded graph (as child nodes when toggled)
   - Via a detail panel that shows the full conversation with scrolling

3. **Text never overflows nodes**: Node text should be properly contained within node boundaries using proper truncation and/or responsive sizing.

### Verification:
- Spawn a subagent that spawns another subagent - both should appear as distinct nodes
- Expanding a subagent should show all its messages as child nodes
- Clicking any node shows full content without truncation
- Text labels never extend past node rectangle boundaries

## What We're NOT Doing

- Changing the overall graph layout algorithm
- Adding zoom/pan controls
- Supporting infinite nesting (we'll support 2-3 levels)
- Changing the list view at all

## Implementation Approach

We'll make incremental changes focusing on:
1. First fix text overflow (CSS/rendering issue)
2. Then enhance subagent node building to handle nested subagents
3. Finally improve the detail view for better history exploration

---

## Phase 1: Fix Text Overflow in Nodes

### Overview
Ensure text never extends outside node boundaries by using proper SVG text truncation and adding visual clipping.

### Changes Required:

#### 1.1 Add SVG clipPath for text containment

**File**: `agent/src/client/App.tsx`
**Changes**: Add `<clipPath>` definitions and use them for text elements

```tsx
// In renderNode function, after opening <g> tag:
<defs>
  <clipPath id={`clip-${node.id}`}>
    <rect
      x={isSubagentRoot ? 28 : 10}
      y={0}
      width={GRAPH_LAYOUT.nodeWidth - (isSubagentRoot ? 40 : 20)}
      height={nodeHeight}
    />
  </clipPath>
</defs>

// Change text element to use clipPath:
<text
  class="graph-node-label"
  x={isSubagentRoot ? 30 : 12}
  y={nodeHeight / 2 + 4}
  clip-path={`url(#clip-${node.id})`}
>
  {node.label.slice(0, 32)}{node.label.length > 32 ? '…' : ''}
</text>
```

#### 1.2 Improve label truncation calculation

**File**: `agent/src/client/App.tsx`
**Changes**: Use more conservative character limit and add textLength attribute for SVG text fitting

```tsx
// In GRAPH_LAYOUT constants (around line 129):
const GRAPH_LAYOUT = {
  nodeWidth: 200,
  nodeHeight: 60,
  toolNodeHeight: 36,
  horizontalGap: 40,
  verticalGap: 30,
  branchIndent: 60,
  padding: 40,
  labelMaxChars: 24,          // NEW: Conservative limit
  labelPadding: 24            // NEW: Padding on each side
}

// In renderNode, update text rendering:
const maxChars = isSubagentRoot ? 20 : GRAPH_LAYOUT.labelMaxChars
const displayLabel = node.label.slice(0, maxChars) + (node.label.length > maxChars ? '…' : '')
```

#### 1.3 Add CSS fallback for text styling

**File**: `agent/src/client/styles.css`
**Changes**: Add additional text styling to prevent overflow

```css
/* Around line 1609, update .graph-node-label */
.graph-node-label {
  fill: var(--text);
  font-size: 11px;                    /* Slightly smaller for better fit */
  font-family: inherit;
  pointer-events: none;
  dominant-baseline: middle;          /* Better vertical alignment */
  text-anchor: start;
}

/* Add new rule for long labels */
.graph-node-label-overflow {
  opacity: 0.7;                       /* Dim the ellipsis */
}
```

### Success Criteria:

#### Automated Verification:
- [x] Build passes: `cd agent && bun run build`
- [x] Type checking passes: `cd agent && bun run typecheck` (pre-existing errors unrelated to graph view changes)

#### Manual Verification:
- [ ] Create a message with very long text (100+ chars) - label should not overflow node
- [ ] Subagent nodes with long descriptions display correctly
- [ ] Tool nodes with long names display correctly
- [ ] Text is readable and ellipsis indicates truncation

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: ~~Show Nested Subagents as Distinct Nodes~~ SKIPPED

**Note**: Per user feedback, nested subagents are not allowed. This phase is skipped.

---

## Phase 2 (Original): Show Nested Subagents as Distinct Nodes

### Overview
Modify the subagent node building logic to detect when tool calls within a subagent's history spawned additional subagents, and render those as expandable nodes.

### Changes Required:

#### 2.1 Track all subagents by ID for lookup

**File**: `agent/src/client/App.tsx`
**Changes**: Create a lookup map combining running and completed subagents

```tsx
// In buildGraphNodes function (around line 1532):
const buildGraphNodes = (): GraphNode[] => {
  // NEW: Create lookup map for all subagents
  const allSubagents = new Map<string, SubagentResult>()
  for (const sa of completedSubagents()) {
    allSubagents.set(sa.taskId, sa)
  }
  for (const [id, sa] of runningSubagents().entries()) {
    allSubagents.set(id, sa)
  }

  // ... rest of function uses allSubagents for lookups
}
```

#### 2.2 Update buildSubagentNode to handle nested subagents

**File**: `agent/src/client/App.tsx`
**Changes**: Modify the helper to recursively build nested subagent nodes

```tsx
// Modify buildSubagentNode signature to accept lookup map:
const buildSubagentNode = (
  subagent: SubagentResult,
  allSubagents: Map<string, SubagentResult>,
  baseId: number
): GraphNode => {
  const isExpanded = expandedSubagents().has(subagent.taskId)

  const node: GraphNode = {
    id: `subagent-${subagent.taskId}`,
    type: 'subagent-root',
    x: 0, y: 0,
    label: `${subagent.task.role}: ${subagent.task.description.slice(0, 20)}...`,
    subagentResult: subagent,
    children: [],
    expanded: isExpanded,
    isLive: subagent.status === 'running'
  }

  if (isExpanded && subagent.fullHistory) {
    let childId = 0
    for (const msg of subagent.fullHistory) {
      const childNode: GraphNode = {
        id: `${node.id}-msg-${childId++}`,
        type: 'subagent-message',
        x: 0, y: 0,
        label: msg.content.slice(0, 35) + (msg.content.length > 35 ? '...' : ''),
        content: msg.content,
        message: msg,
        children: [],
        parent: node,
        expanded: true,
        isLive: false
      }

      // Add tool calls for subagent messages
      if (msg.toolCalls) {
        for (const tool of msg.toolCalls) {
          const toolNode: GraphNode = {
            id: `${childNode.id}-tool-${tool.id}`,
            type: 'tool',
            x: 0, y: 0,
            label: tool.name,
            toolCall: tool,
            children: [],
            parent: childNode,
            expanded: true,
            isLive: false
          }

          // NEW: Check if this tool spawned a nested subagent
          if (tool.name === 'task' && tool.details?.type === 'subagent') {
            const nestedData = tool.details.data as { taskId: string }
            const nestedSubagent = allSubagents.get(nestedData.taskId)
            if (nestedSubagent) {
              const nestedNode = buildSubagentNode(nestedSubagent, allSubagents, baseId + childId)
              nestedNode.parent = toolNode
              toolNode.children.push(nestedNode)
            }
          }

          childNode.children.push(toolNode)
        }
      }

      node.children.push(childNode)
    }
  }

  return node
}
```

#### 2.3 Update call sites to pass the lookup map

**File**: `agent/src/client/App.tsx`
**Changes**: Update all places that call buildSubagentNode

```tsx
// In the main message loop (around line 1572):
if (subagent) {
  const subagentNode = buildSubagentNode(subagent, allSubagents, nodeId++)
  subagentNode.parent = toolNode
  toolNode.children.push(subagentNode)
}

// For orphaned running subagents (around line 1625):
nodes.push(buildSubagentNode(subagent, allSubagents, nodeId++))
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `cd agent && bun run build`
- [ ] Type checking passes: `cd agent && bun run typecheck`

#### Manual Verification:
- [ ] Spawn a subagent that uses tools - tool calls appear as child nodes
- [ ] Spawn nested subagents (subagent A spawns subagent B) - both appear as distinct expandable nodes
- [ ] Expanding nested subagent shows its full history
- [ ] Graph layout handles deep nesting without visual issues

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Improve Detail View for Full History Access

### Overview
Enhance the node detail popup to provide better access to full content and allow viewing complete subagent conversation history.

### Success Criteria:

#### Automated Verification:
- [x] Build passes: `cd agent && bun run build`

### Changes Required:

#### 3.1 Expand GraphNodeDetail component

**File**: `agent/src/client/App.tsx`
**Changes**: Add tabbed view for subagent nodes showing full history

```tsx
// Replace GraphNodeDetail component (around line 303):
function GraphNodeDetail(props: {
  node: GraphNode
  onClose: () => void
  onOpenInTab?: (subagent: SubagentResult) => void  // NEW: For opening in dedicated tab
}) {
  const [showFullHistory, setShowFullHistory] = createSignal(false)

  const typeLabel = () => {
    switch (props.node.type) {
      case 'user': return 'User Message'
      case 'assistant': return 'Assistant'
      case 'tool': return `Tool: ${props.node.toolCall?.name}`
      case 'subagent-root': return `Subagent (${props.node.subagentResult?.task.role})`
      case 'subagent-message': return 'Subagent Message'
      default: return props.node.type
    }
  }

  const typeClass = () => {
    if (props.node.type === 'user') return 'user'
    if (props.node.type === 'assistant' || props.node.type === 'subagent-message') return 'assistant'
    if (props.node.type === 'tool') return 'tool'
    if (props.node.type === 'subagent-root') return 'subagent'
    return ''
  }

  const content = () => {
    if (props.node.type === 'tool' && props.node.toolCall) {
      const tool = props.node.toolCall
      return `Input:\n${formatToolInput(tool.name, tool.input)}\n\nOutput:\n${tool.output || '(no output)'}`
    }
    if (props.node.type === 'subagent-root' && props.node.subagentResult) {
      const sa = props.node.subagentResult
      if (showFullHistory()) {
        // Show full history in scrollable format
        return sa.fullHistory.map((msg, i) =>
          `[${msg.role.toUpperCase()}]\n${msg.content}${msg.toolCalls ? `\n\nTools: ${msg.toolCalls.map(t => t.name).join(', ')}` : ''}`
        ).join('\n\n---\n\n')
      }
      return `Task: ${sa.task.description}\n\nStatus: ${sa.status}\n\nSummary:\n${sa.summary || '(running...)'}`
    }
    return props.node.content || props.node.label
  }

  const isSubagent = () => props.node.type === 'subagent-root' && props.node.subagentResult

  return (
    <div
      class="graph-node-detail"
      style={{ top: '80px', left: '50%', transform: 'translateX(-50%)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <button class="graph-node-detail-close" onClick={props.onClose}>×</button>
      <div class="graph-node-detail-header">
        <span class={`graph-node-detail-type ${typeClass()}`}>{typeLabel()}</span>
        <Show when={props.node.isLive}>
          <span class="subagent-window-status running"><span class="spinner" /> Live</span>
        </Show>
        <Show when={isSubagent()}>
          <div class="graph-node-detail-actions">
            <button
              class="graph-detail-toggle-btn"
              onClick={() => setShowFullHistory(!showFullHistory())}
            >
              {showFullHistory() ? 'Show Summary' : 'Show Full History'}
            </button>
            <Show when={props.onOpenInTab}>
              <button
                class="graph-detail-tab-btn"
                onClick={() => props.onOpenInTab?.(props.node.subagentResult!)}
              >
                Open in Tab ↗
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <div class={`graph-node-detail-content ${showFullHistory() ? 'full-history' : ''}`}>
        {content()}
      </div>
    </div>
  )
}
```

#### 3.2 Add styling for new detail view features

**File**: `agent/src/client/styles.css`
**Changes**: Add styles for toggle buttons and full history view

```css
/* After line 1779, add new styles */

/* Graph Node Detail Actions */
.graph-node-detail-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.graph-detail-toggle-btn,
.graph-detail-tab-btn {
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s ease;
}

.graph-detail-toggle-btn:hover,
.graph-detail-tab-btn:hover {
  background: var(--bg);
  color: var(--text);
  border-color: var(--accent-dim);
}

.graph-detail-tab-btn {
  color: var(--accent);
}

/* Full history mode */
.graph-node-detail-content.full-history {
  max-height: 70vh;
  font-size: 12px;
  background: var(--bg);
  padding: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
}

/* Increase detail panel max height when showing history */
.graph-node-detail:has(.full-history) {
  max-height: 80vh;
  max-width: 700px;
}
```

#### 3.3 Wire up the "Open in Tab" callback

**File**: `agent/src/client/App.tsx`
**Changes**: Pass the openSubagentTab callback to GraphNodeDetail

```tsx
// In the JSX where GraphNodeDetail is rendered (around line 2237):
<Show when={selectedGraphNode()}>
  {(node) => (
    <GraphNodeDetail
      node={node()}
      onClose={() => setSelectedGraphNode(null)}
      onOpenInTab={openSubagentTab}  // NEW: Pass the tab opener
    />
  )}
</Show>
```

### Phase 3 Success Criteria:

#### Automated Verification:
- [x] Build passes: `cd agent && bun run build`
- [x] Type checking passes: `cd agent && bun run typecheck` (pre-existing errors unrelated to changes)

#### Manual Verification:
- [ ] Clicking any node shows a detail popup with full content (not truncated)
- [ ] Clicking a subagent node shows "Show Full History" toggle
- [ ] Toggling to full history shows complete conversation in scrollable view
- [ ] "Open in Tab" button opens the subagent in a dedicated tab
- [ ] Detail popup is properly positioned and doesn't overflow screen

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Polish and Edge Cases

### Overview
Handle edge cases and improve visual polish for the enhanced graph view.

### Changes Required:

#### 4.1 Handle very deep nesting gracefully

**File**: `agent/src/client/App.tsx`
**Changes**: Add max depth limit and visual indicator

```tsx
// In buildSubagentNode, add depth parameter:
const buildSubagentNode = (
  subagent: SubagentResult,
  allSubagents: Map<string, SubagentResult>,
  baseId: number,
  depth: number = 0           // NEW: Track nesting depth
): GraphNode => {
  const MAX_DEPTH = 5        // Limit recursion

  // ... existing code ...

  // When creating nested subagent node:
  if (nestedSubagent && depth < MAX_DEPTH) {
    const nestedNode = buildSubagentNode(nestedSubagent, allSubagents, baseId + childId, depth + 1)
    // ...
  }
}
```

#### 4.2 Visual indicator for collapsed subagents with content

**File**: `agent/src/client/App.tsx`
**Changes**: Show message count badge on collapsed subagent nodes

```tsx
// In renderNode, after expand button, add message count badge:
<Show when={isSubagentRoot && !node.expanded && node.subagentResult?.fullHistory?.length}>
  <text
    class="graph-node-count"
    x={GRAPH_LAYOUT.nodeWidth - 24}
    y={nodeHeight / 2 + 4}
  >
    {node.subagentResult!.fullHistory!.length}
  </text>
</Show>
```

#### 4.3 Add styling for count badge

**File**: `agent/src/client/styles.css`
**Changes**: Add count badge styling

```css
.graph-node-count {
  fill: var(--text-dim);
  font-size: 10px;
  font-weight: 600;
  text-anchor: end;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Build passes: `cd agent && bun run build`
- [x] Type checking passes: `cd agent && bun run typecheck` (pre-existing errors unrelated to changes)

#### Manual Verification:
- [ ] Collapsed subagent nodes show message count badge
- [ ] Graph remains performant with many expanded nodes
- [ ] All text is readable and within boundaries

---

## Testing Strategy

### Unit Tests:
- Test `buildSubagentNode` with nested subagent data
- Test text truncation helper with various lengths
- Test depth limiting logic

### Integration Tests:
- End-to-end test spawning nested subagents and verifying graph state

### Manual Testing Steps:
1. Start a new chat session
2. Ask agent to perform a task that spawns subagents
3. Switch to graph view
4. Verify all subagents appear as distinct nodes
5. Expand a subagent node and verify its messages appear as children
6. Click on nodes and verify detail popup shows full content
7. For subagent nodes, toggle between summary and full history view
8. Use "Open in Tab" to open subagent in dedicated tab
9. Verify text never overflows node boundaries

## Performance Considerations

- The graph rebuild happens in a SolidJS `createEffect` that tracks multiple signals. With many expanded subagents, this could cause layout thrashing.
- Consider memoizing the graph node building if performance becomes an issue.
- The recursive `buildSubagentNode` function should have depth limiting to prevent stack overflow with malicious/bugged subagent chains.

## Migration Notes

No migration needed - this is a purely UI enhancement with no data model changes.

## References

- Current implementation: `agent/src/client/App.tsx:151-300` (GraphView), `agent/src/client/App.tsx:1476-1632` (node building)
- Styling: `agent/src/client/styles.css:1540-1779`
- Server types: `agent/src/server/types.ts:54-71`
