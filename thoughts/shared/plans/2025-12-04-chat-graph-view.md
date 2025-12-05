# Chat Graph View Implementation Plan

## Overview

Add a toggleable graph view to the agent UI that visualizes chat conversations as an interactive tree. The graph shows the flow of user messages, assistant responses, tool calls, and subagent branches. Users can click nodes to see details in a card/modal. This provides "ultimate observability UX" for understanding what happened during complex agent interactions.

## Current State Analysis

- **Single-file SolidJS app** (`agent/src/client/App.tsx`, ~1700 lines)
- **Linear message list** - messages rendered chronologically with `<For each={messages()}>`
- **Subagent tracking exists** - `runningSubagents` and `completedSubagents` signals track subagent state
- **Modal patterns exist** - `expandedSubagent` opens a window overlay showing subagent history
- **No graph visualization** - current UI is purely linear

### Key Data Structures (from `agent/src/server/types.ts`):
- `Message`: `{ role, content, toolCalls?: ToolCall[] }`
- `ToolCall`: `{ id, name, input, output, status, details }`
- `SubagentResult`: `{ taskId, task, summary, fullHistory: Message[], status }`
- Subagents have nested `fullHistory` containing their own messages and tool calls

## Desired End State

A new "Graph View" toggle in the header that switches from linear chat to an interactive tree visualization:

1. **Tree Structure**: Messages flow top-to-bottom, with branches for subagents
2. **Node Types**:
   - User message nodes (prominent)
   - Assistant response nodes (prominent)
   - Tool call nodes (smaller, visually distinct)
   - Subagent branch nodes (collapsed by default, expandable)
3. **Interactions**:
   - Click any node to open a detail card/modal
   - Click subagent branch to expand/collapse
   - Live updates as agent works (nodes appear in real-time)
4. **Layout**: Simple vertical tree with horizontal offsets for branches

### Verification:
- Toggle between linear and graph view preserves conversation state
- All message types render correctly as nodes
- Tool calls appear as smaller child nodes under assistant responses
- Subagent branches expand to show nested conversation
- Live updates work during active agent execution
- Click node opens detail modal with full content

## What We're NOT Doing

- No drag-and-drop node repositioning
- No complex force-directed layout algorithms
- No minimap (maybe later)
- No search/filter in first version
- No persistence of graph view preference
- No zoom controls (browser zoom is sufficient for MVP)
- No export/screenshot functionality

## Implementation Approach

**Custom SVG/CSS-based tree** - no external libraries. SolidJS tree libraries are designed for file trees, not chat visualization. A custom implementation will be:
- Simpler and more tailored to our data model
- Zero additional dependencies
- Full control over styling and animation
- Easy to integrate with existing SolidJS signals

**Layout Algorithm**: Simple recursive tree layout
- Calculate node positions based on depth and sibling index
- Fixed vertical spacing between levels
- Horizontal offset for branches
- SVG lines connecting parent-child nodes

## Phase 1: Data Model & Graph State

### Overview
Create the graph data structure and transform functions to convert linear messages into a tree.

### Changes Required:

#### 1.1 Add Graph Types

**File**: `agent/src/client/App.tsx`
**Changes**: Add interfaces for graph nodes after existing interfaces (~line 100)

```typescript
// Graph view types
type GraphNodeType = 'user' | 'assistant' | 'tool' | 'subagent-root' | 'subagent-message'

interface GraphNode {
  id: string
  type: GraphNodeType
  // Position (computed by layout)
  x: number
  y: number
  // Content
  label: string           // Short display text
  content?: string        // Full content for detail view
  toolCall?: ToolCall     // If type === 'tool'
  subagentResult?: SubagentResult  // If type === 'subagent-root'
  message?: Message       // Original message
  // Tree structure
  children: GraphNode[]
  parent?: GraphNode
  // State
  expanded: boolean       // For subagent branches
  isLive: boolean         // Currently being updated
}

interface GraphViewState {
  nodes: GraphNode[]
  rootNodes: GraphNode[]  // Top-level conversation nodes
  selectedNode: GraphNode | null
  viewBox: { x: number; y: number; width: number; height: number }
}
```

#### 1.2 Add Graph State Signals

**File**: `agent/src/client/App.tsx`
**Changes**: Add signals for graph view state (after line 136, near other state signals)

```typescript
// Graph view state
const [showGraphView, setShowGraphView] = createSignal(false)
const [graphNodes, setGraphNodes] = createSignal<GraphNode[]>([])
const [selectedGraphNode, setSelectedGraphNode] = createSignal<GraphNode | null>(null)
const [expandedSubagents, setExpandedSubagents] = createSignal<Set<string>>(new Set())
```

#### 1.3 Create Graph Builder Function

**File**: `agent/src/client/App.tsx`
**Changes**: Add function to transform messages into graph nodes (before the return statement)

```typescript
// Build graph nodes from messages and subagents
const buildGraphNodes = (): GraphNode[] => {
  const nodes: GraphNode[] = []
  let nodeId = 0

  // Process main conversation messages
  for (const msg of messages()) {
    const msgNode: GraphNode = {
      id: `msg-${nodeId++}`,
      type: msg.role === 'user' ? 'user' : 'assistant',
      x: 0, y: 0, // Layout computed later
      label: msg.content.slice(0, 50) + (msg.content.length > 50 ? '...' : ''),
      content: msg.content,
      message: msg,
      children: [],
      expanded: true,
      isLive: false
    }

    // Add tool calls as children
    if (msg.toolCalls) {
      for (const tool of msg.toolCalls) {
        const toolNode: GraphNode = {
          id: `tool-${tool.id}`,
          type: 'tool',
          x: 0, y: 0,
          label: tool.name,
          toolCall: tool,
          children: [],
          parent: msgNode,
          expanded: true,
          isLive: tool.status === 'running' || tool.status === 'pending'
        }

        // Check if this tool spawned subagents
        if (tool.name === 'task' && tool.details?.type === 'subagent') {
          // Link to subagent results
          const subagentData = tool.details.data as { taskId: string }
          const subagent = completedSubagents().find(s => s.taskId === subagentData.taskId)
            || Array.from(runningSubagents().values()).find(s => s.taskId === subagentData.taskId)

          if (subagent) {
            const subagentNode = buildSubagentNode(subagent, nodeId++)
            subagentNode.parent = toolNode
            toolNode.children.push(subagentNode)
          }
        }

        msgNode.children.push(toolNode)
      }
    }

    nodes.push(msgNode)
  }

  // Add currently streaming content as live nodes
  if (currentAssistant()) {
    nodes.push({
      id: 'current-assistant',
      type: 'assistant',
      x: 0, y: 0,
      label: currentAssistant().slice(0, 50) + '...',
      content: currentAssistant(),
      children: [],
      expanded: true,
      isLive: true
    })
  }

  // Add running subagents that aren't linked to tool calls yet
  for (const subagent of runningSubagents().values()) {
    const existing = nodes.some(n =>
      n.children.some(c =>
        c.children.some(sc => sc.id === `subagent-${subagent.taskId}`)
      )
    )
    if (!existing) {
      nodes.push(buildSubagentNode(subagent, nodeId++))
    }
  }

  return nodes
}

const buildSubagentNode = (subagent: SubagentResult, baseId: number): GraphNode => {
  const isExpanded = expandedSubagents().has(subagent.taskId)

  const node: GraphNode = {
    id: `subagent-${subagent.taskId}`,
    type: 'subagent-root',
    x: 0, y: 0,
    label: `${subagent.task.role}: ${subagent.task.description.slice(0, 30)}...`,
    subagentResult: subagent,
    children: [],
    expanded: isExpanded,
    isLive: subagent.status === 'running'
  }

  // If expanded, add child nodes for subagent's history
  if (isExpanded && subagent.fullHistory) {
    let childId = 0
    for (const msg of subagent.fullHistory) {
      const childNode: GraphNode = {
        id: `${node.id}-msg-${childId++}`,
        type: 'subagent-message',
        x: 0, y: 0,
        label: msg.content.slice(0, 40) + '...',
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
          childNode.children.push({
            id: `${childNode.id}-tool-${tool.id}`,
            type: 'tool',
            x: 0, y: 0,
            label: tool.name,
            toolCall: tool,
            children: [],
            parent: childNode,
            expanded: true,
            isLive: false
          })
        }
      }

      node.children.push(childNode)
    }
  }

  return node
}
```

#### 1.4 Reactive Graph Updates

**File**: `agent/src/client/App.tsx`
**Changes**: Add effect to rebuild graph when messages change

```typescript
// Rebuild graph when conversation changes
createEffect(() => {
  // Dependencies: messages, currentAssistant, runningSubagents, completedSubagents, expandedSubagents
  messages()
  currentAssistant()
  runningSubagents()
  completedSubagents()
  expandedSubagents()

  if (showGraphView()) {
    setGraphNodes(buildGraphNodes())
  }
})
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd agent && npm run build`
- [x] No lint errors: `cd agent && npm run lint`

#### Manual Verification:
- [ ] Adding `console.log(buildGraphNodes())` shows correct tree structure
- [ ] Graph rebuilds when messages change (verified via console)

---

## Phase 2: Layout Algorithm

### Overview
Implement a simple tree layout algorithm that computes x/y positions for all nodes.

### Changes Required:

#### 2.1 Layout Constants

**File**: `agent/src/client/App.tsx`
**Changes**: Add layout configuration constants

```typescript
// Graph layout constants
const GRAPH_LAYOUT = {
  nodeWidth: 200,
  nodeHeight: 60,
  toolNodeHeight: 36,
  horizontalGap: 40,
  verticalGap: 30,
  branchIndent: 60,
  padding: 40
}
```

#### 2.2 Layout Function

**File**: `agent/src/client/App.tsx`
**Changes**: Add tree layout computation

```typescript
// Compute tree layout positions
const computeLayout = (nodes: GraphNode[]): { nodes: GraphNode[]; width: number; height: number } => {
  let currentY = GRAPH_LAYOUT.padding
  const maxX = { value: 0 }

  const layoutNode = (node: GraphNode, depth: number, offsetX: number): number => {
    const isToolNode = node.type === 'tool'
    const nodeHeight = isToolNode ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight

    node.x = offsetX + depth * GRAPH_LAYOUT.branchIndent
    node.y = currentY
    currentY += nodeHeight + GRAPH_LAYOUT.verticalGap

    maxX.value = Math.max(maxX.value, node.x + GRAPH_LAYOUT.nodeWidth)

    // Layout children
    if (node.expanded && node.children.length > 0) {
      for (const child of node.children) {
        layoutNode(child, depth + 1, offsetX)
      }
    }

    return node.y
  }

  // Layout all root nodes
  for (const node of nodes) {
    layoutNode(node, 0, GRAPH_LAYOUT.padding)
  }

  return {
    nodes,
    width: maxX.value + GRAPH_LAYOUT.padding,
    height: currentY + GRAPH_LAYOUT.padding
  }
}
```

#### 2.3 Integrate Layout into Graph Building

**File**: `agent/src/client/App.tsx`
**Changes**: Update buildGraphNodes to include layout

```typescript
const buildGraphNodes = (): GraphNode[] => {
  // ... existing node building code ...

  // Compute layout
  const { nodes: layoutNodes } = computeLayout(nodes)
  return layoutNodes
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd agent && npm run build`

#### Manual Verification:
- [ ] `console.log` shows nodes have x/y coordinates assigned
- [ ] Coordinates increase appropriately with tree depth

---

## Phase 3: Graph View Component

### Overview
Create the SVG-based graph visualization component with node rendering and connection lines.

### Changes Required:

#### 3.1 Add Graph View CSS

**File**: `agent/src/client/styles.css`
**Changes**: Add styles at end of file

```css
/* Graph View */
.graph-view-container {
  flex: 1;
  overflow: auto;
  background: var(--bg);
  position: relative;
}

.graph-svg {
  display: block;
  min-width: 100%;
  min-height: 100%;
}

/* Graph Nodes */
.graph-node {
  cursor: pointer;
  transition: transform 0.1s ease;
}

.graph-node:hover {
  transform: scale(1.02);
}

.graph-node-rect {
  rx: 8;
  ry: 8;
  stroke-width: 2;
  transition: stroke 0.15s ease, fill 0.15s ease;
}

.graph-node-user .graph-node-rect {
  fill: var(--bg-tertiary);
  stroke: var(--accent);
}

.graph-node-assistant .graph-node-rect {
  fill: var(--bg-secondary);
  stroke: var(--border);
}

.graph-node-tool .graph-node-rect {
  fill: var(--bg);
  stroke: var(--text-dim);
  stroke-dasharray: 4 2;
}

.graph-node-subagent-root .graph-node-rect {
  fill: var(--bg-secondary);
  stroke: var(--purple);
  stroke-width: 2;
}

.graph-node-subagent-message .graph-node-rect {
  fill: var(--bg);
  stroke: var(--purple);
  stroke-width: 1;
  opacity: 0.8;
}

.graph-node.live .graph-node-rect {
  stroke: var(--yellow);
  animation: pulse 1.5s ease infinite;
}

.graph-node.selected .graph-node-rect {
  stroke: var(--accent);
  stroke-width: 3;
}

.graph-node-label {
  fill: var(--text);
  font-size: 12px;
  font-family: inherit;
  pointer-events: none;
}

.graph-node-tool .graph-node-label {
  fill: var(--text-muted);
  font-size: 11px;
}

.graph-node-icon {
  fill: var(--text-muted);
  font-size: 14px;
}

/* Connection Lines */
.graph-edge {
  stroke: var(--border);
  stroke-width: 2;
  fill: none;
}

.graph-edge-subagent {
  stroke: var(--purple);
  stroke-dasharray: 6 3;
}

.graph-edge-tool {
  stroke: var(--text-dim);
  stroke-width: 1;
}

/* Expand/Collapse Indicator */
.graph-expand-btn {
  cursor: pointer;
  fill: var(--bg-secondary);
  stroke: var(--border);
}

.graph-expand-btn:hover {
  fill: var(--bg-tertiary);
}

.graph-expand-icon {
  fill: var(--text-muted);
  font-size: 12px;
  pointer-events: none;
}

/* View Toggle Button */
.view-toggle-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.15s ease;
}

.view-toggle-btn:hover {
  background: var(--bg-tertiary);
}

.view-toggle-btn.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}

/* Node Detail Modal */
.graph-node-detail {
  position: fixed;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  max-width: 500px;
  max-height: 60vh;
  overflow-y: auto;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  z-index: 350;
  animation: fadeIn 0.15s ease;
}

.graph-node-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.graph-node-detail-type {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.graph-node-detail-type.user {
  background: rgba(88, 166, 255, 0.15);
  color: var(--accent);
}

.graph-node-detail-type.assistant {
  background: rgba(63, 185, 80, 0.15);
  color: var(--green);
}

.graph-node-detail-type.tool {
  background: rgba(210, 153, 34, 0.15);
  color: var(--yellow);
}

.graph-node-detail-type.subagent {
  background: rgba(163, 113, 247, 0.15);
  color: var(--purple);
}

.graph-node-detail-content {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

.graph-node-detail-close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.graph-node-detail-close:hover {
  background: var(--bg-tertiary);
  color: var(--text);
}
```

#### 3.2 Graph View Component

**File**: `agent/src/client/App.tsx`
**Changes**: Add GraphView component (before the main App function)

```typescript
// Graph View Component
function GraphView(props: {
  nodes: GraphNode[]
  selectedNode: GraphNode | null
  onSelectNode: (node: GraphNode | null) => void
  onToggleExpand: (nodeId: string) => void
}) {
  // Compute SVG dimensions
  const dimensions = () => {
    let maxX = 800
    let maxY = 600
    const visit = (node: GraphNode) => {
      maxX = Math.max(maxX, node.x + GRAPH_LAYOUT.nodeWidth + GRAPH_LAYOUT.padding)
      maxY = Math.max(maxY, node.y + (node.type === 'tool' ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight) + GRAPH_LAYOUT.padding)
      if (node.expanded) {
        node.children.forEach(visit)
      }
    }
    props.nodes.forEach(visit)
    return { width: maxX, height: maxY }
  }

  // Render connection lines
  const renderEdges = (node: GraphNode): JSX.Element[] => {
    const edges: JSX.Element[] = []
    if (node.expanded && node.children.length > 0) {
      const nodeHeight = node.type === 'tool' ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight
      const startX = node.x + GRAPH_LAYOUT.nodeWidth / 2
      const startY = node.y + nodeHeight

      for (const child of node.children) {
        const childHeight = child.type === 'tool' ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight
        const endX = child.x + GRAPH_LAYOUT.nodeWidth / 2
        const endY = child.y

        // Curved path
        const midY = (startY + endY) / 2
        const path = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`

        const edgeClass = child.type === 'tool'
          ? 'graph-edge graph-edge-tool'
          : child.type.startsWith('subagent')
          ? 'graph-edge graph-edge-subagent'
          : 'graph-edge'

        edges.push(<path class={edgeClass} d={path} />)

        // Recurse for children
        edges.push(...renderEdges(child))
      }
    }
    return edges
  }

  // Render a single node
  const renderNode = (node: GraphNode): JSX.Element => {
    const isToolNode = node.type === 'tool'
    const nodeHeight = isToolNode ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight
    const isSelected = props.selectedNode?.id === node.id
    const hasChildren = node.children.length > 0
    const isSubagentRoot = node.type === 'subagent-root'

    return (
      <g
        class={`graph-node graph-node-${node.type} ${node.isLive ? 'live' : ''} ${isSelected ? 'selected' : ''}`}
        transform={`translate(${node.x}, ${node.y})`}
        onClick={(e) => {
          e.stopPropagation()
          props.onSelectNode(node)
        }}
      >
        {/* Node rectangle */}
        <rect
          class="graph-node-rect"
          width={GRAPH_LAYOUT.nodeWidth}
          height={nodeHeight}
        />

        {/* Node label */}
        <text
          class="graph-node-label"
          x={isSubagentRoot ? 30 : 12}
          y={nodeHeight / 2 + 4}
        >
          {node.label.slice(0, 28)}{node.label.length > 28 ? '...' : ''}
        </text>

        {/* Expand/collapse button for subagents */}
        <Show when={isSubagentRoot && hasChildren}>
          <g
            class="graph-expand-btn"
            transform={`translate(8, ${nodeHeight / 2 - 8})`}
            onClick={(e) => {
              e.stopPropagation()
              props.onToggleExpand(node.subagentResult!.taskId)
            }}
          >
            <rect width="16" height="16" rx="3" />
            <text class="graph-expand-icon" x="5" y="12">
              {node.expanded ? '−' : '+'}
            </text>
          </g>
        </Show>

        {/* Live indicator */}
        <Show when={node.isLive}>
          <circle cx={GRAPH_LAYOUT.nodeWidth - 12} cy={12} r={4} fill="var(--yellow)">
            <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
          </circle>
        </Show>

        {/* Children */}
        <Show when={node.expanded}>
          <For each={node.children}>
            {(child) => renderNode(child)}
          </For>
        </Show>
      </g>
    )
  }

  return (
    <div class="graph-view-container" onClick={() => props.onSelectNode(null)}>
      <svg class="graph-svg" width={dimensions().width} height={dimensions().height}>
        {/* Render edges first (behind nodes) */}
        <g class="graph-edges">
          <For each={props.nodes}>
            {(node) => renderEdges(node)}
          </For>
        </g>

        {/* Render nodes */}
        <g class="graph-nodes">
          <For each={props.nodes}>
            {(node) => renderNode(node)}
          </For>
        </g>
      </svg>
    </div>
  )
}
```

#### 3.3 Node Detail Popup Component

**File**: `agent/src/client/App.tsx`
**Changes**: Add component for node detail view

```typescript
// Node Detail Popup
function GraphNodeDetail(props: {
  node: GraphNode
  onClose: () => void
}) {
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
      return `Task: ${sa.task.description}\n\nStatus: ${sa.status}\n\nSummary:\n${sa.summary || '(running...)'}`
    }
    return props.node.content || props.node.label
  }

  return (
    <div class="graph-node-detail" onClick={(e) => e.stopPropagation()}>
      <button class="graph-node-detail-close" onClick={props.onClose}>×</button>
      <div class="graph-node-detail-header">
        <span class={`graph-node-detail-type ${typeClass()}`}>{typeLabel()}</span>
        <Show when={props.node.isLive}>
          <span class="subagent-window-status running"><span class="spinner" /> Live</span>
        </Show>
      </div>
      <div class="graph-node-detail-content">
        {content()}
      </div>
    </div>
  )
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd agent && npm run build`
- [x] CSS parses correctly (no syntax errors in browser)

#### Manual Verification:
- [ ] Graph renders with correct node shapes
- [ ] Connection lines appear between parent/child nodes
- [ ] Clicking a node opens detail popup
- [ ] Clicking outside popup closes it

---

## Phase 4: View Toggle Integration

### Overview
Add the toggle button to switch between linear and graph views, and integrate everything into the main App.

### Changes Required:

#### 4.1 Add View Toggle Button to Header

**File**: `agent/src/client/App.tsx`
**Changes**: Add toggle button in header-left section (after the settings button, ~line 981)

```tsx
<button
  class={`view-toggle-btn ${showGraphView() ? 'active' : ''}`}
  onClick={() => setShowGraphView(!showGraphView())}
  title="Toggle Graph View"
>
  <span>{showGraphView() ? '≡' : '◇'}</span>
  <span>{showGraphView() ? 'List' : 'Graph'}</span>
</button>
```

#### 4.2 Conditional Rendering of Views

**File**: `agent/src/client/App.tsx`
**Changes**: Wrap messages div and add graph view (around line 1104)

Replace:
```tsx
<div class="messages">
  {/* ... existing message rendering ... */}
</div>
```

With:
```tsx
<Show when={!showGraphView()}>
  <div class="messages">
    {/* ... existing message rendering (unchanged) ... */}
  </div>
</Show>

<Show when={showGraphView()}>
  <GraphView
    nodes={graphNodes()}
    selectedNode={selectedGraphNode()}
    onSelectNode={setSelectedGraphNode}
    onToggleExpand={(taskId) => {
      setExpandedSubagents(prev => {
        const next = new Set(prev)
        if (next.has(taskId)) {
          next.delete(taskId)
        } else {
          next.add(taskId)
        }
        return next
      })
    }}
  />

  {/* Node detail popup */}
  <Show when={selectedGraphNode()}>
    {(node) => (
      <GraphNodeDetail
        node={node()}
        onClose={() => setSelectedGraphNode(null)}
      />
    )}
  </Show>
</Show>
```

#### 4.3 Update Effect for Auto-rebuild

**File**: `agent/src/client/App.tsx`
**Changes**: Ensure graph rebuilds on view toggle

```typescript
// Rebuild graph when switching to graph view or when data changes
createEffect(() => {
  if (showGraphView()) {
    // Trigger rebuild by accessing reactive dependencies
    messages()
    currentAssistant()
    currentTools()
    runningSubagents()
    completedSubagents()
    expandedSubagents()

    setGraphNodes(buildGraphNodes())
  }
})
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd agent && npm run build`
- [x] App starts without errors: `cd agent && npm run dev`

#### Manual Verification:
- [ ] Toggle button appears in header
- [ ] Clicking toggle switches between list and graph view
- [ ] Graph view shows conversation structure
- [ ] List view still works correctly
- [ ] Switching back and forth preserves state

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 5: Live Updates & Polish

### Overview
Ensure graph updates in real-time during agent execution and polish the visual appearance.

### Changes Required:

#### 5.1 Live Update Handling

The reactive effect from Phase 4 should already handle live updates since it depends on `currentAssistant()`, `currentTools()`, and `runningSubagents()`. Verify this works during active agent execution.

#### 5.2 Scroll to Latest Node

**File**: `agent/src/client/App.tsx`
**Changes**: Auto-scroll graph view to show latest activity

```typescript
// Ref for graph container
let graphContainerRef: HTMLDivElement | undefined

// Auto-scroll to latest node in graph view
createEffect(() => {
  if (showGraphView() && graphContainerRef) {
    const nodes = graphNodes()
    if (nodes.length > 0) {
      // Find the node with highest Y position
      let maxY = 0
      const findMaxY = (n: GraphNode) => {
        maxY = Math.max(maxY, n.y)
        if (n.expanded) n.children.forEach(findMaxY)
      }
      nodes.forEach(findMaxY)

      // Scroll to show it
      graphContainerRef.scrollTo({
        top: Math.max(0, maxY - graphContainerRef.clientHeight + 150),
        behavior: 'smooth'
      })
    }
  }
})
```

Update GraphView to accept and use the ref:
```tsx
<div
  class="graph-view-container"
  ref={graphContainerRef}
  onClick={() => props.onSelectNode(null)}
>
```

#### 5.3 Status Indication in Header

**File**: `agent/src/client/App.tsx`
**Changes**: Show live indicator when in graph view during execution

The existing status indicator already shows "thinking"/"executing" - no changes needed.

#### 5.4 Edge Animations for Live Nodes

**File**: `agent/src/client/styles.css`
**Changes**: Add animated dashes for edges to live nodes

```css
.graph-edge.live {
  stroke: var(--yellow);
  stroke-dasharray: 8 4;
  animation: dashMove 0.5s linear infinite;
}

@keyframes dashMove {
  from { stroke-dashoffset: 12; }
  to { stroke-dashoffset: 0; }
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd agent && npm run build`
- [x] No runtime errors in console during execution

#### Manual Verification:
- [ ] Send a message while in graph view - new nodes appear in real-time
- [ ] Graph scrolls to show latest activity
- [ ] Live nodes have yellow pulsing indicator
- [ ] Subagent spawning shows branch growing in real-time
- [ ] Performance is acceptable (no lag with 20+ nodes)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:
- Not applicable for this UI feature (no complex business logic to unit test)

### Integration Tests:
- Not applicable (this is a pure UI feature)

### Manual Testing Steps:
1. **Basic rendering**: Send 3-4 messages, toggle to graph view, verify structure
2. **Tool calls**: Use a tool (file read), verify tool node appears as child of assistant node
3. **Subagents**: Spawn a subagent, verify branch appears with collapse/expand
4. **Live updates**: Send a message while in graph view, watch nodes appear in real-time
5. **Node detail**: Click various node types, verify detail popup shows correct info
6. **Toggle stability**: Switch between list and graph view multiple times
7. **Long conversations**: Load a session with 20+ messages, verify performance

## Performance Considerations

- **Lazy rendering**: Only compute layout when graph view is active
- **Memoization**: `buildGraphNodes()` is called on every reactive update, but SolidJS's fine-grained reactivity should minimize unnecessary re-renders
- **SVG efficiency**: Using `<g>` groups and transform for positioning is more efficient than individual element positioning
- **Node limit**: For very long conversations (100+ messages), may need to virtualize or paginate - defer to future enhancement

## Migration Notes

- No data migration needed - graph view is purely a UI presentation layer
- Existing sessions will work automatically
- No breaking changes to existing functionality

## Future Enhancements (Not in Scope)

- Pan/zoom controls
- Minimap for large graphs
- Search/filter nodes
- Export graph as image
- Keyboard navigation
- Customizable layout options
- Performance optimization for very large conversations

## References

- Main UI file: `agent/src/client/App.tsx`
- Styles: `agent/src/client/styles.css`
- Server types: `agent/src/server/types.ts`
- Existing subagent modal pattern: `App.tsx:1313-1416`
