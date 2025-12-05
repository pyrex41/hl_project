/* @refresh reload */
import { render } from 'solid-js/web'
import { createSignal, createEffect, For, Show, onMount } from 'solid-js'
import { MCPPanel } from './MCPPanel'

// Prompt suffix for parallel task execution
const PARALLEL_PROMPT = `

Use the task tool to spawn multiple subagents in parallel to accomplish this efficiently. Break down the work into independent subtasks that can run concurrently.`

interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
}

interface ToolCall {
  id: string
  name: string
  input: string
  output?: string
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  details?: {
    type: string
    data: unknown
  }
}

interface SessionSummary {
  id: string
  name?: string
  updatedAt: string
  messageCount: number
}

interface ProviderInfo {
  provider: string
  defaultModel: string
}

interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
}

// Subagent types
type SubagentRole = 'simple' | 'complex' | 'researcher'

interface SubagentTask {
  id: string
  description: string
  role: SubagentRole
  context?: string
  provider?: string
  model?: string
}

interface SubagentResult {
  taskId: string
  task: SubagentTask
  summary: string
  fullHistory: Message[]
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'max_iterations'
  error?: string
  iterations?: number
  // Live progress tracking
  currentText?: string
  currentTools?: Map<string, ToolCall>
  parentMessageIndex?: number  // NEW: Index of the message that spawned this subagent
}

interface PendingConfirmation {
  requestId: string
  tasks: SubagentTask[]
}

// Configuration types
interface MainChatConfig {
  provider: string
  model: string
}

interface RoleConfig {
  provider: string
  model: string
  maxIterations: number
}

interface SubagentConfig {
  confirmMode: 'always' | 'never' | 'multiple'
  timeout: number
  maxConcurrent: number
  roles: Record<SubagentRole, RoleConfig>
}

interface FullConfig {
  mainChat?: MainChatConfig
  subagents: SubagentConfig
}

type AgentStatus = 'idle' | 'thinking' | 'executing' | 'error' | 'awaiting_confirmation'

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

interface TokenUsage {
  input: number
  output: number
}

interface SubagentTab {
  id: string           // Unique tab ID (can reuse taskId)
  taskId: string       // The subagent's task ID
  title: string        // Tab title (truncated description)
}

// Graph View Component
function GraphView(props: {
  nodes: GraphNode[]
  selectedNode: GraphNode | null
  onSelectNode: (node: GraphNode | null) => void
  onToggleExpand: (nodeId: string) => void
  containerRef?: (el: HTMLDivElement) => void
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
  const renderEdges = (node: GraphNode): Element[] => {
    const edges: Element[] = []
    if (node.expanded && node.children.length > 0) {
      const nodeHeight = node.type === 'tool' ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight
      const startX = node.x + GRAPH_LAYOUT.nodeWidth / 2
      const startY = node.y + nodeHeight

      for (const child of node.children) {
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

        edges.push(<path class={`${edgeClass} ${child.isLive ? 'live' : ''}`} d={path} />)

        // Recurse for children
        edges.push(...renderEdges(child))
      }
    }
    return edges
  }

  // Render a single node
  const renderNode = (node: GraphNode): Element => {
    const isToolNode = node.type === 'tool'
    const nodeHeight = isToolNode ? GRAPH_LAYOUT.toolNodeHeight : GRAPH_LAYOUT.nodeHeight
    const isSelected = props.selectedNode?.id === node.id
    const hasChildren = node.children.length > 0 || (node.type === 'subagent-root' && node.subagentResult?.fullHistory?.length)
    const isSubagentRoot = node.type === 'subagent-root'

    return (
      <g
        class={`graph-node graph-node-${node.type} ${node.isLive ? 'live' : ''} ${isSelected ? 'selected' : ''}`}
        transform={`translate(${node.x}, ${node.y})`}
        onClick={(e: MouseEvent) => {
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
            onClick={(e: MouseEvent) => {
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
      </g>
    )
  }

  // Collect all nodes for rendering (flatten tree for separate rendering)
  const collectAllNodes = (nodes: GraphNode[]): GraphNode[] => {
    const result: GraphNode[] = []
    const visit = (node: GraphNode) => {
      result.push(node)
      if (node.expanded) {
        node.children.forEach(visit)
      }
    }
    nodes.forEach(visit)
    return result
  }

  return (
    <div
      class="graph-view-container"
      ref={props.containerRef}
      onClick={() => props.onSelectNode(null)}
    >
      <svg class="graph-svg" width={dimensions().width} height={dimensions().height}>
        {/* Render edges first (behind nodes) */}
        <g class="graph-edges">
          <For each={props.nodes}>
            {(node) => renderEdges(node)}
          </For>
        </g>

        {/* Render nodes */}
        <g class="graph-nodes">
          <For each={collectAllNodes(props.nodes)}>
            {(node) => renderNode(node)}
          </For>
        </g>
      </svg>
    </div>
  )
}

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
    <div class="graph-node-detail" style={{ top: '100px', left: '50%', transform: 'translateX(-50%)' }} onClick={(e) => e.stopPropagation()}>
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

function App() {
  const [messages, setMessages] = createSignal<Message[]>([])
  const [input, setInput] = createSignal('')
  const [status, setStatus] = createSignal<AgentStatus>('idle')
  const [tokens, setTokens] = createSignal<TokenUsage>({ input: 0, output: 0 })
  const [currentAssistant, setCurrentAssistant] = createSignal('')
  const [currentTools, setCurrentTools] = createSignal<Map<string, ToolCall>>(new Map())
  const [collapsedTools, setCollapsedTools] = createSignal<Set<string>>(new Set())
  const [sessionId, setSessionId] = createSignal<string | null>(null)
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  const [showSessions, setShowSessions] = createSignal(false)
  const [providers, setProviders] = createSignal<ProviderInfo[]>([])
  const [selectedProvider, setSelectedProvider] = createSignal<string | null>(null)
  const [models, setModels] = createSignal<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = createSignal<string | null>(null)
  const [showProviders, setShowProviders] = createSignal(false)
  const [showModels, setShowModels] = createSignal(false)
  const [loadingModels, setLoadingModels] = createSignal(false)
  // Subagent state
  const [pendingConfirmation, setPendingConfirmation] = createSignal<PendingConfirmation | null>(null)
  const [runningSubagents, setRunningSubagents] = createSignal<Map<string, SubagentResult>>(new Map())
  const [completedSubagents, setCompletedSubagents] = createSignal<SubagentResult[]>([])
  // Memoize running subagent IDs to prevent flickering - only update when IDs actually change
  const [runningSubagentIds, setRunningSubagentIds] = createSignal<string[]>([])
  const [expandedSubagentId, setExpandedSubagentId] = createSignal<string | null>(null)
  // Derive the live subagent data from the ID
  const expandedSubagent = () => {
    const id = expandedSubagentId()
    if (!id) return null
    const running = runningSubagents().get(id)
    if (running) return running
    return completedSubagents().find(s => s.taskId === id) || null
  }
  // Settings state
  const [showSettings, setShowSettings] = createSignal(false)
  const [config, setConfig] = createSignal<FullConfig | null>(null)
  const [editingConfig, setEditingConfig] = createSignal<FullConfig | null>(null)
  const [savingConfig, setSavingConfig] = createSignal(false)
  // Per-provider models cache for settings
  const [settingsModels, setSettingsModels] = createSignal<Record<string, ModelInfo[]>>({})
  // Graph view state
  const [showGraphView, setShowGraphView] = createSignal(false)
  // MCP panel state
  const [showMCPPanel, setShowMCPPanel] = createSignal(false)
  // Slash command autocomplete state
  const [commands, setCommands] = createSignal<{ name: string; description: string; argumentHint?: string }[]>([])
  const [showCommandAutocomplete, setShowCommandAutocomplete] = createSignal(false)
  const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0)
  const [graphNodes, setGraphNodes] = createSignal<GraphNode[]>([])
  const [selectedGraphNode, setSelectedGraphNode] = createSignal<GraphNode | null>(null)
  const [expandedSubagents, setExpandedSubagents] = createSignal<Set<string>>(new Set())
  // Tab state
  const [openTabs, setOpenTabs] = createSignal<SubagentTab[]>([])
  const [activeTab, setActiveTab] = createSignal<string | null>(null) // null = main chat
  let messagesEndRef: HTMLDivElement | undefined
  let subagentMessagesEndRef: HTMLDivElement | undefined
  let graphContainerRef: HTMLDivElement | undefined
  // Auto-scroll state for subagent views
  let subagentTabScrollRef: HTMLDivElement | undefined
  let subagentModalScrollRef: HTMLDivElement | undefined
  const [subagentTabUserScrolled, setSubagentTabUserScrolled] = createSignal(false)
  const [subagentModalUserScrolled, setSubagentModalUserScrolled] = createSignal(false)

  // Load sessions and providers on mount
  onMount(async () => {
    // Load config first, then providers (so we can use config defaults)
    await loadConfig()
    await Promise.all([loadSessions(), loadProviders(), loadCommands()])

    // Global keyboard handler for Escape to close dropdowns
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSessions(false)
        setShowProviders(false)
        setShowModels(false)
        setShowSettings(false)
      }
    }

    // Click outside handler to close dropdowns
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Close sessions panel if clicking outside
      if (showSessions() && !target.closest('.sessions-panel') && !target.closest('.header-btn')) {
        setShowSessions(false)
      }
      // Close provider/model dropdowns if clicking outside
      if (!target.closest('.model-picker')) {
        setShowProviders(false)
        setShowModels(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
  })

  // Auto-scroll helpers for subagent views
  const isNearBottom = (el: HTMLElement, threshold = 100) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }

  const handleSubagentTabScroll = (e: Event) => {
    const el = e.target as HTMLElement
    setSubagentTabUserScrolled(!isNearBottom(el))
  }

  const handleSubagentModalScroll = (e: Event) => {
    const el = e.target as HTMLElement
    setSubagentModalUserScrolled(!isNearBottom(el))
  }

  // Auto-scroll effect for tab view
  createEffect(() => {
    const id = expandedSubagentId()
    const subagent = id ? runningSubagents().get(id) : null
    // Access reactive properties to trigger effect
    subagent?.currentText
    subagent?.currentTools

    if (subagentTabScrollRef && !subagentTabUserScrolled()) {
      subagentTabScrollRef.scrollTop = subagentTabScrollRef.scrollHeight
    }
  })

  // Auto-scroll effect for modal view
  createEffect(() => {
    const subagent = expandedSubagent()
    // Access reactive properties to trigger effect
    subagent?.currentText
    subagent?.currentTools

    if (subagentModalScrollRef && !subagentModalUserScrolled()) {
      subagentModalScrollRef.scrollTop = subagentModalScrollRef.scrollHeight
    }
  })

  // Reset user scrolled state when switching subagents
  createEffect(() => {
    expandedSubagentId()
    setSubagentTabUserScrolled(false)
    setSubagentModalUserScrolled(false)
  })

  // Filter commands based on input for autocomplete
  const filteredCommands = () => {
    const val = input()
    if (!val.startsWith('/')) return []
    const query = val.slice(1).toLowerCase() // Remove leading /
    return commands().filter(cmd =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
    ).slice(0, 10) // Limit to 10 results
  }

  // Show autocomplete when typing / and there are matching commands
  createEffect(() => {
    const val = input()
    if (val.startsWith('/') && filteredCommands().length > 0 && status() === 'idle') {
      setShowCommandAutocomplete(true)
      setSelectedCommandIndex(0)
    } else {
      setShowCommandAutocomplete(false)
    }
  })

  const loadProviders = async () => {
    try {
      const res = await fetch('/api/providers')
      const data = await res.json()
      setProviders(data.providers || [])

      // Check if we have saved defaults in config
      const savedConfig = config()
      if (savedConfig?.mainChat && data.providers?.length > 0) {
        // Use saved main chat config
        const savedProvider = savedConfig.mainChat.provider
        const savedModel = savedConfig.mainChat.model
        // Verify the saved provider is still available
        if (data.providers.some((p: ProviderInfo) => p.provider === savedProvider)) {
          setSelectedProvider(savedProvider)
          setSelectedModel(savedModel)
          await loadModels(savedProvider)
          return
        }
      }

      // Fallback: select first available provider
      if (data.providers?.length > 0 && !selectedProvider()) {
        const firstProvider = data.providers[0]
        setSelectedProvider(firstProvider.provider)
        setSelectedModel(firstProvider.defaultModel)
        await loadModels(firstProvider.provider)
      }
    } catch (e) {
      console.error('Failed to load providers:', e)
    }
  }

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/config')
      const data = await res.json()
      setConfig(data.config || null)
    } catch (e) {
      console.error('Failed to load config:', e)
    }
  }

  const loadCommands = async () => {
    try {
      const res = await fetch('/api/commands')
      const data = await res.json()
      setCommands(data.commands || [])
    } catch (e) {
      console.error('Failed to load commands:', e)
    }
  }

  const saveConfigToServer = async (newConfig: FullConfig) => {
    setSavingConfig(true)
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: newConfig })
      })
      if (res.ok) {
        const data = await res.json()
        setConfig(data.config)
        setEditingConfig(null)
        setShowSettings(false)
        // If main chat config changed, update the selected provider/model
        if (newConfig.mainChat) {
          setSelectedProvider(newConfig.mainChat.provider)
          setSelectedModel(newConfig.mainChat.model)
          await loadModels(newConfig.mainChat.provider)
        }
      }
    } catch (e) {
      console.error('Failed to save config:', e)
    } finally {
      setSavingConfig(false)
    }
  }

  const loadModelsForProvider = async (provider: string) => {
    // Check cache first
    const cached = settingsModels()[provider]
    if (cached) return cached

    try {
      const res = await fetch(`/api/providers/${provider}/models`)
      const data = await res.json()
      const models = data.models || []
      setSettingsModels(prev => ({ ...prev, [provider]: models }))
      return models
    } catch (e) {
      console.error(`Failed to load models for ${provider}:`, e)
      return []
    }
  }

  const openSettings = async () => {
    // Load current config and start editing
    await loadConfig()
    const currentConfig = config()
    if (currentConfig) {
      // Deep clone for editing
      setEditingConfig({
        mainChat: currentConfig.mainChat ? { ...currentConfig.mainChat } : {
          provider: selectedProvider() || 'anthropic',
          model: selectedModel() || ''
        },
        subagents: {
          ...currentConfig.subagents,
          roles: { ...currentConfig.subagents.roles }
        }
      })
      // Pre-load models for all configured providers (main chat + subagent roles)
      const uniqueProviders = new Set([
        currentConfig.mainChat?.provider || selectedProvider(),
        ...Object.values(currentConfig.subagents.roles).map(r => r.provider)
      ].filter(Boolean) as string[])
      await Promise.all([...uniqueProviders].map(p => loadModelsForProvider(p)))
    } else {
      // No config yet, create default from current selection
      setEditingConfig({
        mainChat: {
          provider: selectedProvider() || 'anthropic',
          model: selectedModel() || ''
        },
        subagents: {
          confirmMode: 'always',
          timeout: 120,
          maxConcurrent: 5,
          roles: {
            simple: { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', maxIterations: 10 },
            complex: { provider: 'anthropic', model: 'claude-opus-4-5-20251101', maxIterations: 25 },
            researcher: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250514', maxIterations: 15 }
          }
        }
      })
    }
    setShowSettings(true)
  }

  const loadModels = async (provider: string) => {
    setLoadingModels(true)
    try {
      const res = await fetch(`/api/providers/${provider}/models`)
      const data = await res.json()
      setModels(data.models || [])
    } catch (e) {
      console.error('Failed to load models:', e)
      setModels([])
    } finally {
      setLoadingModels(false)
    }
  }

  const handleProviderChange = async (provider: string) => {
    setSelectedProvider(provider)
    setShowProviders(false)
    // Reset model and load models for new provider
    const providerInfo = providers().find(p => p.provider === provider)
    setSelectedModel(providerInfo?.defaultModel || null)
    await loadModels(provider)
  }

  const loadSessions = async () => {
    try {
      const res = await fetch('/api/sessions')
      const data = await res.json()
      setSessions(data.sessions || [])
    } catch (e) {
      console.error('Failed to load sessions:', e)
    }
  }

  const createNewSession = async () => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const data = await res.json()
      setSessionId(data.session.id)
      setMessages([])
      setTokens({ input: 0, output: 0 })
      setShowSessions(false)
      await loadSessions()
    } catch (e) {
      console.error('Failed to create session:', e)
    }
  }

  const loadSession = async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${id}`)
      const data = await res.json()
      if (data.session) {
        setSessionId(data.session.id)
        setMessages(data.session.messages || [])
        setTokens(data.session.metadata?.totalTokens || { input: 0, output: 0 })
        setShowSessions(false)
      }
    } catch (e) {
      console.error('Failed to load session:', e)
    }
  }

  // Auto-scroll to bottom
  createEffect(() => {
    messages()
    currentAssistant()
    if (messagesEndRef) {
      messagesEndRef.scrollIntoView({ behavior: 'smooth' })
    }
  })

  const sendMessage = async (useParallel = false) => {
    let msg = input().trim()
    if (!msg || status() !== 'idle') return

    // Append parallel prompt if shift+enter was used
    if (useParallel) {
      msg += PARALLEL_PROMPT
    }

    // Create a session if we don't have one
    if (!sessionId()) {
      await createNewSession()
    }

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    setStatus('thinking')
    setCurrentAssistant('')
    setCurrentTools(new Map())
    // Clear subagents from previous turn
    setCompletedSubagents([])
    setRunningSubagents(new Map())
    setRunningSubagentIds([])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          history: messages().slice(0, -1), // Exclude the just-added user message
          sessionId: sessionId(),
          provider: selectedProvider(),
          model: selectedModel(),
        }),
      })

      if (!response.ok) throw new Error('Failed to connect to agent')

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              handleEvent(event)
            } catch (e) {
              // Skip malformed events
            }
          }
        }
      }

      // Finalize the assistant message
      finalizeAssistantMessage()
    } catch (error) {
      setStatus('error')
      console.error('Agent error:', error)
    }
  }

  const handleEvent = (event: { type: string; [key: string]: unknown }) => {
    // Debug logging for all events
    if (event.type === 'text_delta') {
      console.log(`[${Date.now()}] text_delta:`, JSON.stringify(event.delta).slice(0, 100))
    } else if (event.type === 'subagent_progress') {
      const inner = event.event as { type: string; delta?: string }
      console.log(`[${Date.now()}] subagent_progress:`, event.taskId, inner.type, inner.delta ? JSON.stringify(inner.delta).slice(0, 50) : '')
    } else if (event.type.startsWith('subagent')) {
      console.log(`[${Date.now()}] ${event.type}`, event.taskId, event.timestamp ? `(server: ${event.timestamp})` : '')
    }

    switch (event.type) {
      case 'text_delta':
        setCurrentAssistant(prev => prev + (event.delta as string))
        break

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

      case 'tool_input_delta':
        setCurrentTools(prev => {
          const next = new Map(prev)
          const tool = next.get(event.id as string)
          if (tool) {
            tool.input = event.partialJson as string
          }
          return next
        })
        break

      case 'tool_running':
        setCurrentTools(prev => {
          const next = new Map(prev)
          const tool = next.get(event.id as string)
          if (tool) {
            tool.status = 'running'
          }
          return next
        })
        break

      case 'tool_result':
        setCurrentTools(prev => {
          const next = new Map(prev)
          const tool = next.get(event.id as string)
          if (tool) {
            tool.status = event.error ? 'error' : 'done'
            tool.output = event.output as string
            tool.error = event.error as string | undefined
            tool.details = event.details as ToolCall['details']
          }
          return next
        })
        setStatus('thinking')
        break

      case 'turn_complete':
        const usage = event.usage as { inputTokens: number; outputTokens: number } | undefined
        if (usage) {
          setTokens(prev => ({
            input: prev.input + usage.inputTokens,
            output: prev.output + usage.outputTokens,
          }))
        }
        setStatus('idle')
        break

      case 'error':
        setStatus('error')
        setCurrentAssistant(prev => prev + `\n\nError: ${event.error}`)
        break

      case 'retry_countdown':
        setCurrentAssistant(prev =>
          prev + `\n[Rate limited - retrying in ${event.seconds}s...]`
        )
        break

      case 'session_updated':
        // Session was saved, refresh the list
        loadSessions()
        break

      // Subagent events
      case 'subagent_request':
        setStatus('awaiting_confirmation')
        setPendingConfirmation({
          requestId: event.requestId as string,
          tasks: event.tasks as SubagentTask[]
        })
        break

      case 'subagent_confirmed':
        setPendingConfirmation(null)
        setStatus('executing')
        break

      case 'subagent_cancelled':
        setPendingConfirmation(null)
        setStatus('thinking')
        break

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
            parentMessageIndex: messages().length
          })
          return next
        })
        // Update stable ID list (prevents flickering)
        setRunningSubagentIds(prev => [...prev, event.taskId as string])
        break

      case 'subagent_progress':
        // Update the running subagent with live progress
        setRunningSubagents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.taskId as string)
          if (existing) {
            const innerEvent = event.event as { type: string; [key: string]: unknown }
            // Create a fresh copy to ensure SolidJS reactivity triggers
            const updated = { ...existing }
            switch (innerEvent.type) {
              case 'text_delta':
                updated.currentText = (existing.currentText || '') + (innerEvent.delta as string)
                break
              case 'tool_start':
                updated.currentTools = new Map(existing.currentTools || new Map())
                updated.currentTools.set(innerEvent.id as string, {
                  id: innerEvent.id as string,
                  name: innerEvent.name as string,
                  input: '',
                  status: 'pending'
                })
                break
              case 'tool_input_delta':
                if (existing.currentTools) {
                  updated.currentTools = new Map(existing.currentTools)
                  const tool = updated.currentTools.get(innerEvent.id as string)
                  if (tool) {
                    updated.currentTools.set(innerEvent.id as string, { ...tool, input: innerEvent.partialJson as string })
                  }
                }
                break
              case 'tool_running':
                if (existing.currentTools) {
                  updated.currentTools = new Map(existing.currentTools)
                  const tool = updated.currentTools.get(innerEvent.id as string)
                  if (tool) {
                    updated.currentTools.set(innerEvent.id as string, { ...tool, status: 'running' as const })
                  }
                }
                break
              case 'tool_result':
                if (existing.currentTools) {
                  updated.currentTools = new Map(existing.currentTools)
                  const tool = updated.currentTools.get(innerEvent.id as string)
                  if (tool) {
                    updated.currentTools.set(innerEvent.id as string, {
                      ...tool,
                      status: innerEvent.error ? 'error' as const : 'done' as const,
                      output: innerEvent.output as string,
                      error: innerEvent.error as string | undefined
                    })
                  }
                }
                break
            }
            next.set(event.taskId as string, updated)
          }
          return next
        })
        break

      case 'subagent_complete':
        setRunningSubagents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.taskId as string)
          if (existing) {
            const completed = {
              ...existing,
              status: 'completed' as const,
              summary: event.summary as string,
              fullHistory: event.fullHistory as Message[],
              currentText: undefined,
              currentTools: undefined
            }
            setCompletedSubagents(c => [...c, completed])
          }
          next.delete(event.taskId as string)
          return next
        })
        setRunningSubagentIds(prev => prev.filter(id => id !== event.taskId))
        break

      case 'subagent_error':
        setRunningSubagents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.taskId as string)
          if (existing) {
            const errored = {
              ...existing,
              status: 'error' as const,
              error: event.error as string,
              fullHistory: event.fullHistory as Message[],
              currentText: undefined,
              currentTools: undefined
            }
            setCompletedSubagents(c => [...c, errored])
          }
          next.delete(event.taskId as string)
          return next
        })
        setRunningSubagentIds(prev => prev.filter(id => id !== event.taskId))
        break

      case 'subagent_max_iterations':
        setRunningSubagents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.taskId as string)
          if (existing) {
            const maxed = {
              ...existing,
              status: 'max_iterations' as const,
              iterations: event.iterations as number,
              fullHistory: event.fullHistory as Message[],
              currentText: undefined,
              currentTools: undefined
            }
            setCompletedSubagents(c => [...c, maxed])
          }
          next.delete(event.taskId as string)
          return next
        })
        setRunningSubagentIds(prev => prev.filter(id => id !== event.taskId))
        break
    }
  }

  const finalizeAssistantMessage = () => {
    const content = currentAssistant()
    const tools = Array.from(currentTools().values())
    const hasSubagents = completedSubagents().length > 0 || runningSubagents().size > 0

    if (content || tools.length > 0) {
      // If we have subagents, only add tool calls to messages, not the content
      // The content will be shown after the subagent cards via currentAssistant
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: hasSubagents ? '' : content,  // Content goes after subagents
          toolCalls: tools.length > 0 ? tools : undefined,
        },
      ])
    }

    // Only clear currentAssistant if no subagents - otherwise keep it for display after cards
    if (!hasSubagents) {
      setCurrentAssistant('')
    }
    setCurrentTools(new Map())
    setStatus('idle')
  }

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
    return n.toString()
  }

  // Simple markdown renderer for assistant messages
  const renderMarkdown = (text: string) => {
    if (!text) return ''

    let html = text
      // Escape HTML first
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Code blocks (must be before inline code)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      // Horizontal rules
      .replace(/^---$/gm, '<hr>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Lists (simple)
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/^\* (.+)$/gm, '<li>$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')

    return html
  }

  const formatDate = (isoDate: string) => {
    const date = new Date(isoDate)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const renderToolOutput = (tool: ToolCall) => {
    if (tool.error) {
      return <div class="tool-output" style="color: var(--red)">{tool.error}</div>
    }
    if (!tool.output) return null

    // Render diff specially
    if (tool.details?.type === 'diff') {
      const data = tool.details.data as { before: string; after: string }
      return (
        <div class="tool-output">
          {data.before.split('\n').map(line => (
            <div class="diff-line-remove">- {line}</div>
          ))}
          {data.after.split('\n').map(line => (
            <div class="diff-line-add">+ {line}</div>
          ))}
        </div>
      )
    }

    // Truncate long output
    const output = tool.output.length > 2000
      ? tool.output.slice(0, 2000) + '\n[Output truncated...]'
      : tool.output

    return <div class="tool-output">{output}</div>
  }

  const selectCommand = (cmd: { name: string; argumentHint?: string }) => {
    // Set input to command with trailing space if no hint, or just the command if there's a hint
    setInput(`/${cmd.name} `)
    setShowCommandAutocomplete(false)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // Handle autocomplete navigation
    if (showCommandAutocomplete()) {
      const cmds = filteredCommands()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedCommandIndex(i => Math.min(i + 1, cmds.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedCommandIndex(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        const selected = cmds[selectedCommandIndex()]
        if (selected) {
          selectCommand(selected)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowCommandAutocomplete(false)
        return
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      // Shift+Enter triggers parallel mode
      sendMessage(e.shiftKey)
    }
  }

  const startNewChat = async () => {
    // Clear state for a fresh session (session will be created on first message)
    setSessionId(null)
    setMessages([])
    setTokens({ input: 0, output: 0 })
    setShowSessions(false)
    // Refresh the sessions list so the old session appears
    await loadSessions()
  }

  const getProviderIcon = (provider: string) => {
    const icons: Record<string, string> = {
      anthropic: '◈',
      xai: '✧',
      openai: '◉'
    }
    return icons[provider] || '○'
  }

  const getProviderLabel = (provider: string) => {
    const labels: Record<string, string> = {
      anthropic: 'Anthropic',
      xai: 'xAI',
      openai: 'OpenAI'
    }
    return labels[provider] || provider
  }

  const getShortModelName = (modelId: string | null) => {
    if (!modelId) return 'select model'

    // Claude: claude-sonnet-4-20250514 -> sonnet-4
    // Remove date suffix (8 digits at end)
    if (modelId.startsWith('claude-')) {
      const withoutPrefix = modelId.slice(7) // remove 'claude-'
      // Remove date suffix if present (e.g., -20250514)
      return withoutPrefix.replace(/-\d{8}$/, '')
    }

    // Grok: preserve variant info
    // grok-3-beta -> grok-3-beta
    // grok-4-1-fast-nonreasoning -> grok-4-1-fast
    // grok-4 -> grok-4
    if (modelId.startsWith('grok-')) {
      // Remove verbose suffixes but keep important variant info
      return modelId
        .replace(/-nonreasoning$/, '')
        .replace(/-reasoning$/, '')
    }

    // GPT/OpenAI: keep as-is mostly
    // gpt-4o -> gpt-4o
    // gpt-4o-mini -> gpt-4o-mini
    // gpt-4-turbo-preview -> gpt-4-turbo
    if (modelId.startsWith('gpt-')) {
      return modelId.replace(/-preview$/, '')
    }

    // o1 models: keep as-is
    // o1, o1-mini, o1-preview -> o1, o1-mini, o1
    if (modelId.startsWith('o1')) {
      return modelId.replace(/-preview$/, '')
    }

    // Default: remove date suffixes
    return modelId.replace(/-\d{8}$/, '')
  }

  const getModelDisplayName = (model: ModelInfo) => {
    if (model.name && model.name !== model.id) {
      return model.name
    }
    return model.id
  }

  const closeAllDropdowns = () => {
    setShowProviders(false)
    setShowModels(false)
  }

  // Subagent confirmation handlers
  const confirmSubagents = async (tasks: SubagentTask[]) => {
    const confirmation = pendingConfirmation()
    if (!confirmation) return

    try {
      await fetch('/api/subagents/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: confirmation.requestId,
          confirmed: true,
          tasks
        })
      })
    } catch (e) {
      console.error('Failed to confirm subagents:', e)
    }
  }

  const cancelSubagents = async () => {
    const confirmation = pendingConfirmation()
    if (!confirmation) return

    try {
      await fetch('/api/subagents/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: confirmation.requestId,
          confirmed: false
        })
      })
    } catch (e) {
      console.error('Failed to cancel subagents:', e)
    }
    setPendingConfirmation(null)
    setStatus('thinking')
  }

  const continueSubagent = async (subagent: SubagentResult) => {
    if (subagent.status !== 'max_iterations') return

    try {
      // Remove from completed, add back to running
      setCompletedSubagents(prev => prev.filter(s => s.taskId !== subagent.taskId))
      setRunningSubagents(prev => {
        const next = new Map(prev)
        next.set(subagent.taskId, {
          ...subagent,
          status: 'running',
          currentText: '',
          currentTools: new Map()
        })
        return next
      })
      setExpandedSubagentId(null)

      // Call API to continue the subagent
      const response = await fetch('/api/subagents/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: subagent.taskId,
          sessionId: sessionId(),
          task: subagent.task,
          history: subagent.fullHistory
        })
      })

      if (!response.ok) {
        throw new Error('Failed to continue subagent')
      }

      // Stream the response
      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              handleEvent(event)
            } catch {
              // Skip malformed events
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to continue subagent:', e)
      // Put it back in completed with error
      setRunningSubagents(prev => {
        const next = new Map(prev)
        next.delete(subagent.taskId)
        return next
      })
      setCompletedSubagents(prev => [...prev, {
        ...subagent,
        status: 'error',
        error: 'Failed to continue subagent'
      }])
    }
  }

  const getRoleBadgeClass = (role: SubagentRole) => {
    const classes: Record<SubagentRole, string> = {
      simple: 'role-badge-simple',
      complex: 'role-badge-complex',
      researcher: 'role-badge-researcher'
    }
    return classes[role] || ''
  }

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

  // Build subagent node helper
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
          label: msg.content.slice(0, 40) + (msg.content.length > 40 ? '...' : ''),
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
      const liveNode: GraphNode = {
        id: 'current-assistant',
        type: 'assistant',
        x: 0, y: 0,
        label: currentAssistant().slice(0, 50) + '...',
        content: currentAssistant(),
        children: [],
        expanded: true,
        isLive: true
      }

      // Add current tools as children
      for (const tool of currentTools().values()) {
        liveNode.children.push({
          id: `current-tool-${tool.id}`,
          type: 'tool',
          x: 0, y: 0,
          label: tool.name,
          toolCall: tool,
          children: [],
          parent: liveNode,
          expanded: true,
          isLive: tool.status === 'running' || tool.status === 'pending'
        })
      }

      nodes.push(liveNode)
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

    // Compute layout
    const { nodes: layoutNodes } = computeLayout(nodes)
    return layoutNodes
  }

  // Rebuild graph when conversation changes
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

  const openSubagentTab = (subagent: SubagentResult) => {
    // Check if tab already exists
    const existing = openTabs().find(t => t.taskId === subagent.taskId)
    if (existing) {
      setActiveTab(existing.id)
      setExpandedSubagentId(null)
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
    // Calculate remaining tabs BEFORE updating state to avoid race condition
    const remaining = openTabs().filter(t => t.id !== tabId)
    setOpenTabs(remaining)
    // If we closed the active tab, switch to most recent remaining or main chat
    if (activeTab() === tabId) {
      if (remaining.length > 0) {
        setActiveTab(remaining[remaining.length - 1].id)
      } else {
        setActiveTab(null)
      }
    }
  }

  return (
    <>
      <header class="header">
        <div class="header-left">
          <span class="header-title">agent</span>
          <span class="header-version">v0.1</span>
          <div class="header-divider" />
          <button
            class="header-btn"
            onClick={() => setShowSessions(!showSessions())}
            title="Sessions (Ctrl+S)"
          >
            <span class="btn-icon">≡</span>
          </button>
          <button
            class="header-btn"
            onClick={startNewChat}
            title="New Chat (Ctrl+N)"
          >
            <span class="btn-icon">+</span>
          </button>
          <button
            class="header-btn"
            onClick={openSettings}
            title="Settings"
          >
            <span class="btn-icon">⚙</span>
          </button>
          <button
            class={`header-btn ${showMCPPanel() ? 'active' : ''}`}
            onClick={() => setShowMCPPanel(!showMCPPanel())}
            title="MCP Servers"
          >
            <span class="btn-icon">🔌</span>
          </button>
          <div class="header-divider" />
          <button
            class={`view-toggle-btn ${showGraphView() ? 'active' : ''}`}
            onClick={() => setShowGraphView(!showGraphView())}
            title="Toggle Graph View"
          >
            <span>{showGraphView() ? '≡' : '◇'}</span>
            <span>{showGraphView() ? 'List' : 'Graph'}</span>
          </button>
        </div>

        <div class="header-center">
          <div class="model-picker">
            <button
              class="model-picker-btn"
              onClick={() => {
                setShowModels(false)
                setShowProviders(!showProviders())
              }}
            >
              <span class={`provider-icon provider-${selectedProvider() || ''}`}>{getProviderIcon(selectedProvider() || '')}</span>
              <span class="provider-label">{getProviderLabel(selectedProvider() || '')}</span>
              <span class="picker-arrow">▾</span>
            </button>
            <span class="model-separator">/</span>
            <button
              class="model-picker-btn model-btn"
              onClick={() => {
                setShowProviders(false)
                setShowModels(!showModels())
              }}
            >
              <span class="model-label">{getShortModelName(selectedModel())}</span>
              <span class="picker-arrow">▾</span>
            </button>

            <Show when={showProviders()}>
              <div class="picker-dropdown provider-dropdown">
                <div class="dropdown-header">Select Provider</div>
                <For each={providers()}>
                  {(p) => (
                    <button
                      class={`dropdown-item ${selectedProvider() === p.provider ? 'active' : ''}`}
                      onClick={() => handleProviderChange(p.provider)}
                    >
                      <span class={`item-icon provider-${p.provider}`}>{getProviderIcon(p.provider)}</span>
                      <span class="item-label">{getProviderLabel(p.provider)}</span>
                      <Show when={selectedProvider() === p.provider}>
                        <span class="item-check">✓</span>
                      </Show>
                    </button>
                  )}
                </For>
                <Show when={providers().length === 0}>
                  <div class="dropdown-empty">No providers configured</div>
                </Show>
              </div>
            </Show>

            <Show when={showModels()}>
              <div class="picker-dropdown model-dropdown">
                <div class="dropdown-header">
                  Select Model
                  <Show when={loadingModels()}>
                    <span class="loading-indicator">...</span>
                  </Show>
                </div>
                <Show when={!loadingModels()}>
                  <For each={models()}>
                    {(m) => (
                      <button
                        class={`dropdown-item ${selectedModel() === m.id ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedModel(m.id)
                          setShowModels(false)
                        }}
                      >
                        <span class="item-label">{getModelDisplayName(m)}</span>
                        <Show when={selectedModel() === m.id}>
                          <span class="item-check">✓</span>
                        </Show>
                      </button>
                    )}
                  </For>
                  <Show when={models().length === 0}>
                    <div class="dropdown-empty">No models available</div>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        </div>

        <div class="header-right">
          <div class="status-indicator">
            <span class={`status-dot ${status()}`} />
            <span class="status-text">{status()}</span>
          </div>
          <div class="header-divider" />
          <div class="token-count">
            <span class="token-label">tokens</span>
            <span class="token-value">{formatTokens(tokens().input + tokens().output)}</span>
          </div>
        </div>
      </header>

      {/* Sessions sidebar */}
      <Show when={showSessions()}>
        <div class="sessions-panel">
          <div class="sessions-header">Sessions</div>
          <div class="sessions-list">
            <For each={sessions()}>
              {(session) => (
                <div
                  class={`session-item ${sessionId() === session.id ? 'active' : ''}`}
                  onClick={() => loadSession(session.id)}
                >
                  <div class="session-name">{session.name || `Session ${session.id.slice(0, 8)}`}</div>
                  <div class="session-meta">
                    {session.messageCount} messages · {formatDate(session.updatedAt)}
                  </div>
                </div>
              )}
            </For>
            <Show when={sessions().length === 0}>
              <div class="session-empty">No saved sessions</div>
            </Show>
          </div>
        </div>
      </Show>

      {/* Tab Bar - only show when there are open subagent tabs and not in graph view */}
      <Show when={openTabs().length > 0 && !showGraphView()}>
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
                <div
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
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      {/* Main chat view - shown when not in graph view and no subagent tab is active */}
      <Show when={!showGraphView() && activeTab() === null}>
        <div class="messages">
          {/* Render messages (without inline subagents - they render separately below) */}
          <For each={messages()}>
            {(msg) => (
              <div class="message">
                <Show when={msg.role === 'user'}>
                  <div class="message-user">{msg.content}</div>
                </Show>
                <Show when={msg.role === 'assistant'}>
                  <Show when={msg.toolCalls}>
                    <For each={msg.toolCalls}>
                      {(tool) => (
                        <div class="tool-call">
                          <div
                            class="tool-header tool-header-clickable"
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
                              {tool.status === 'running' && <span class="spinner" />}
                              {tool.status === 'done' && '✓'}
                              {tool.status === 'error' && '✗'}
                              {tool.status}
                            </span>
                          </div>
                          <Show when={!collapsedTools().has(tool.id)}>
                            <Show when={tool.input}>
                              <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
                            </Show>
                            {renderToolOutput(tool)}
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={msg.content}>
                    <div class="message-assistant" innerHTML={renderMarkdown(msg.content)} />
                  </Show>
                </Show>
              </div>
            )}
          </For>

          {/* Current streaming tool calls */}
          <Show when={currentTools().size > 0}>
            <div class="message">
              <For each={Array.from(currentTools().values())}>
                {(tool) => (
                  <div class="tool-call">
                    <div
                      class="tool-header tool-header-clickable"
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
                        {(tool.status === 'pending' || tool.status === 'running') && <span class="spinner" />}
                        {tool.status === 'done' && '✓'}
                        {tool.status === 'error' && '✗'}
                        {tool.status}
                      </span>
                    </div>
                    <Show when={!collapsedTools().has(tool.id)}>
                      <Show when={tool.input}>
                        <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
                      </Show>
                      {renderToolOutput(tool)}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Running subagents - clickable to expand live progress */}
          {/* Use stable ID list to prevent flickering from Map updates */}
          <For each={runningSubagentIds()}>
            {(taskId) => {
              const subagent = () => runningSubagents().get(taskId)
              return (
                <Show when={subagent()}>
                  {(sa) => (
                    <div class="message">
                      <div
                        class="subagent-card-inline running"
                        onClick={() => setExpandedSubagentId(taskId)}
                      >
                        <div class="subagent-card-header">
                          <span class={`role-badge ${getRoleBadgeClass(sa().task.role)}`}>{sa().task.role}</span>
                          <span class="subagent-card-desc">{sa().task.description}</span>
                          <span class="expand-hint">Click to view live</span>
                        </div>
                        <div class="subagent-card-status">
                          <span class="spinner" /> Running...
                        </div>
                      </div>
                    </div>
                  )}
                </Show>
              )
            }}
          </For>

          {/* All completed subagents - shown after running ones */}
          <For each={completedSubagents()}>
            {(subagent) => (
              <div class="message">
                <div
                  class={`subagent-card-inline ${subagent.status} ${subagent.status === 'error' ? 'error' : ''} ${subagent.status === 'max_iterations' ? 'max-iterations' : ''}`}
                  onClick={() => setExpandedSubagentId(subagent.taskId)}
                >
                  <div class="subagent-card-header">
                    <span class={`role-badge ${getRoleBadgeClass(subagent.task.role)}`}>{subagent.task.role}</span>
                    <span class="subagent-card-desc">{subagent.task.description}</span>
                    <span class="expand-hint">Click to expand</span>
                  </div>
                  <div class="subagent-card-summary">
                    <Show when={subagent.status === 'error'}>
                      {subagent.error}
                    </Show>
                    <Show when={subagent.status === 'max_iterations'}>
                      <span class="max-iterations-warning">
                        Hit max iterations ({subagent.iterations}) - click to continue
                      </span>
                    </Show>
                    <Show when={subagent.status === 'completed'}>
                      {subagent.summary.slice(0, 200)}
                      {subagent.summary.length > 200 ? '...' : ''}
                    </Show>
                  </div>
                </div>
              </div>
            )}
          </For>

          {/* Thinking indicator - shown when model is thinking but no text yet */}
          <Show when={status() === 'thinking' && !currentAssistant() && currentTools().size === 0}>
            <div class="message">
              <div class="thinking-indicator">Thinking...</div>
            </div>
          </Show>

          {/* Current assistant text - shown last (this is the parent's final response) */}
          <Show when={currentAssistant()}>
            <div class="message">
              <div class="message-assistant" innerHTML={renderMarkdown(currentAssistant())} />
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>
      </Show>

      {/* Subagent tab view - shown when not in graph view and a subagent tab is active */}
      <Show when={!showGraphView() && activeTab() !== null}>
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
                  <div
                    class="subagent-tab-messages"
                    ref={subagentTabScrollRef}
                    onScroll={handleSubagentTabScroll}
                  >
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
                                      <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
                                    </Show>
                                    <Show when={tool.output}>
                                      <div class="tool-output">{tool.output}</div>
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </Show>
                            <Show when={msg.content}>
                              <div class="message-assistant" innerHTML={renderMarkdown(msg.content)} />
                            </Show>
                          </Show>
                        </div>
                      )}
                    </For>

                    {/* Live progress for running subagents */}
                    <Show when={sa().status === 'running'}>
                      <div class="subagent-live-progress">
                        <Show when={sa().currentTools?.size}>
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
                          <div class="message-assistant" innerHTML={renderMarkdown(sa().currentText || '')} />
                        </Show>
                      </div>
                    </Show>
                    <div ref={subagentMessagesEndRef} />
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
          containerRef={(el) => { graphContainerRef = el }}
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

      <div class="input-area">
        <div class="input-wrapper">
          <span class="input-prompt">&gt;</span>
          <input
            type="text"
            class="input-field"
            placeholder={status() === 'idle' ? 'Type a message... (Shift+Enter for parallel)' : 'Agent is working...'}
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={status() !== 'idle'}
          />
          {/* Slash command autocomplete dropdown */}
          <Show when={showCommandAutocomplete() && filteredCommands().length > 0}>
            <div class="command-autocomplete">
              <For each={filteredCommands()}>
                {(cmd, index) => (
                  <div
                    class={`command-item ${index() === selectedCommandIndex() ? 'selected' : ''}`}
                    onClick={() => selectCommand(cmd)}
                    onMouseEnter={() => setSelectedCommandIndex(index())}
                  >
                    <span class="command-name">/{cmd.name}</span>
                    <span class="command-hint">{cmd.argumentHint || ''}</span>
                    <span class="command-desc">{cmd.description}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      {/* Subagent Confirmation Dialog */}
      <Show when={pendingConfirmation()}>
        {(confirmation) => (
          <div class="subagent-confirm-overlay" onClick={() => cancelSubagents()}>
            <div class="subagent-confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <h3>Spawn {confirmation().tasks.length} Subagent{confirmation().tasks.length > 1 ? 's' : ''}?</h3>
              <div class="subagent-list">
                <For each={confirmation().tasks}>
                  {(task) => {
                    // Get provider/model - use task override, or role default from config, or main chat default
                    const roleConfig = () => config()?.subagents?.roles?.[task.role]
                    const effectiveProvider = () => task.provider || roleConfig()?.provider || selectedProvider() || ''
                    const effectiveModel = () => task.model || roleConfig()?.model || selectedModel() || ''

                    return (
                      <div class={`subagent-item role-${task.role}`}>
                        <div class="subagent-item-header">
                          {/* Editable role selector */}
                          <select
                            class="role-select"
                            value={task.role}
                            onChange={(e) => {
                              const newRole = e.currentTarget.value as SubagentRole
                              const newRoleConfig = config()?.subagents?.roles?.[newRole]
                              const newTasks = [...confirmation().tasks]
                              const idx = newTasks.findIndex(t => t.id === task.id)
                              if (idx >= 0) {
                                // Update role and reset provider/model to new role's defaults
                                newTasks[idx] = {
                                  ...task,
                                  role: newRole,
                                  provider: newRoleConfig?.provider,
                                  model: newRoleConfig?.model
                                }
                                setPendingConfirmation({ ...confirmation(), tasks: newTasks })
                              }
                            }}
                          >
                            <option value="simple">simple</option>
                            <option value="complex">complex</option>
                            <option value="researcher">researcher</option>
                          </select>
                        </div>
                        {/* Editable description/prompt */}
                        <textarea
                          class="subagent-description-edit"
                          value={task.description}
                          rows={3}
                          onInput={(e) => {
                            const newTasks = [...confirmation().tasks]
                            const idx = newTasks.findIndex(t => t.id === task.id)
                            if (idx >= 0) {
                              newTasks[idx] = { ...task, description: e.currentTarget.value }
                              setPendingConfirmation({ ...confirmation(), tasks: newTasks })
                            }
                          }}
                        />
                        <div class="subagent-item-config">
                          <select
                            class="subagent-select"
                            value={effectiveProvider()}
                            onChange={async (e) => {
                              const newProvider = e.currentTarget.value
                              // Load models for this provider if not already loaded
                              await loadModelsForProvider(newProvider)
                              const newTasks = [...confirmation().tasks]
                              const idx = newTasks.findIndex(t => t.id === task.id)
                              if (idx >= 0) {
                                // Get default model for new provider
                                const providerInfo = providers().find(p => p.provider === newProvider)
                                newTasks[idx] = {
                                  ...task,
                                  provider: newProvider,
                                  model: providerInfo?.defaultModel || ''
                                }
                                setPendingConfirmation({ ...confirmation(), tasks: newTasks })
                              }
                            }}
                          >
                            <For each={providers()}>
                              {(p) => <option value={p.provider}>{getProviderLabel(p.provider)}</option>}
                            </For>
                          </select>
                          <select
                            class="subagent-select"
                            value={effectiveModel()}
                            onChange={(e) => {
                              const newTasks = [...confirmation().tasks]
                              const idx = newTasks.findIndex(t => t.id === task.id)
                              if (idx >= 0) {
                                newTasks[idx] = { ...task, model: e.currentTarget.value }
                                setPendingConfirmation({ ...confirmation(), tasks: newTasks })
                              }
                            }}
                          >
                            <For each={settingsModels()[effectiveProvider()] || models()}>
                              {(m) => <option value={m.id}>{getShortModelName(m.id)}</option>}
                            </For>
                            {/* Show current model even if not in list */}
                            <Show when={!(settingsModels()[effectiveProvider()] || models()).some(m => m.id === effectiveModel())}>
                              <option value={effectiveModel()}>{getShortModelName(effectiveModel())}</option>
                            </Show>
                          </select>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
              <div class="dialog-actions">
                <button class="dialog-btn cancel" onClick={() => cancelSubagents()}>Cancel</button>
                <button class="dialog-btn confirm" onClick={() => confirmSubagents(confirmation().tasks)}>
                  Spawn Agents
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Expanded Subagent Window */}
      <Show when={expandedSubagent()}>
        {(subagent) => (
          <div class="subagent-window-overlay" onClick={() => setExpandedSubagentId(null)}>
            <div class="subagent-window" onClick={(e) => e.stopPropagation()}>
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
                <button class="close-btn" onClick={() => setExpandedSubagentId(null)}>×</button>
              </div>
              <div
                class="subagent-window-content"
                ref={subagentModalScrollRef}
                onScroll={handleSubagentModalScroll}
              >
                {/* Full history */}
                <For each={subagent().fullHistory}>
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
                                  <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
                                </Show>
                                <Show when={tool.output}>
                                  <div class="tool-output">{tool.output}</div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                        <Show when={msg.content}>
                          <div class="message-assistant" innerHTML={renderMarkdown(msg.content)} />
                        </Show>
                      </Show>
                    </div>
                  )}
                </For>

                {/* Live progress for running subagents */}
                <Show when={subagent().status === 'running'}>
                  <div class="subagent-live-progress">
                    <Show when={subagent().currentTools?.size}>
                      <For each={Array.from(subagent().currentTools!.values())}>
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
                    <Show when={subagent().currentText}>
                      <div class="message-assistant" innerHTML={renderMarkdown(subagent().currentText || '')} />
                    </Show>
                  </div>
                </Show>
              </div>

              {/* Footer with Continue button for max_iterations */}
              <Show when={subagent().status === 'max_iterations'}>
                <div class="subagent-window-footer">
                  <span class="max-iterations-info">
                    Subagent hit max iterations ({subagent().iterations}). You can continue running it.
                  </span>
                  <button
                    class="dialog-btn confirm"
                    onClick={() => continueSubagent(subagent())}
                  >
                    Continue
                  </button>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Settings Dialog */}
      <Show when={showSettings() && editingConfig()}>
        {(cfg) => (
          <div class="settings-overlay" onClick={() => setShowSettings(false)}>
            <div class="settings-dialog" onClick={(e) => e.stopPropagation()}>
              <div class="settings-header">
                <h2>Settings</h2>
                <button class="close-btn" onClick={() => setShowSettings(false)}>×</button>
              </div>

              <div class="settings-content">
                {/* Main Chat Settings */}
                <div class="settings-section">
                  <h3>Main Chat</h3>
                  <p class="settings-hint">Default provider and model for new conversations.</p>

                  <div class="settings-row">
                    <label>Provider</label>
                    <select
                      value={cfg().mainChat?.provider || ''}
                      onChange={async (e) => {
                        const newProvider = e.currentTarget.value
                        await loadModelsForProvider(newProvider)
                        const providerInfo = providers().find(p => p.provider === newProvider)
                        setEditingConfig(prev => {
                          if (!prev) return null
                          return {
                            ...prev,
                            mainChat: {
                              provider: newProvider,
                              model: providerInfo?.defaultModel || prev.mainChat?.model || ''
                            }
                          }
                        })
                      }}
                    >
                      <For each={providers()}>
                        {(p) => <option value={p.provider}>{getProviderLabel(p.provider)}</option>}
                      </For>
                    </select>
                  </div>

                  <div class="settings-row">
                    <label>Model</label>
                    <select
                      value={cfg().mainChat?.model || ''}
                      onChange={(e) => {
                        setEditingConfig(prev => {
                          if (!prev) return null
                          return {
                            ...prev,
                            mainChat: {
                              provider: prev.mainChat?.provider || '',
                              model: e.currentTarget.value
                            }
                          }
                        })
                      }}
                    >
                      <For each={settingsModels()[cfg().mainChat?.provider || ''] || []}>
                        {(m) => <option value={m.id}>{getShortModelName(m.id)}</option>}
                      </For>
                      {/* Show current model even if not in list */}
                      <Show when={cfg().mainChat?.model && !settingsModels()[cfg().mainChat?.provider || '']?.some(m => m.id === cfg().mainChat?.model)}>
                        <option value={cfg().mainChat?.model}>{getShortModelName(cfg().mainChat?.model || '')}</option>
                      </Show>
                    </select>
                  </div>
                </div>

                {/* Subagent General Settings */}
                <div class="settings-section">
                  <h3>Subagents</h3>

                  <div class="settings-row">
                    <label>Confirmation Mode</label>
                    <select
                      value={cfg().subagents.confirmMode}
                      onChange={(e) => setEditingConfig(prev => prev ? {
                        ...prev,
                        subagents: { ...prev.subagents, confirmMode: e.currentTarget.value as 'always' | 'never' | 'multiple' }
                      } : null)}
                    >
                      <option value="always">Always confirm</option>
                      <option value="multiple">Only for multiple agents</option>
                      <option value="never">Never confirm</option>
                    </select>
                  </div>

                  <div class="settings-row">
                    <label>Timeout (seconds)</label>
                    <input
                      type="number"
                      min="30"
                      max="600"
                      value={cfg().subagents.timeout}
                      onChange={(e) => setEditingConfig(prev => prev ? {
                        ...prev,
                        subagents: { ...prev.subagents, timeout: parseInt(e.currentTarget.value) || 120 }
                      } : null)}
                    />
                  </div>

                  <div class="settings-row">
                    <label>Max Concurrent</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={cfg().subagents.maxConcurrent}
                      onChange={(e) => setEditingConfig(prev => prev ? {
                        ...prev,
                        subagents: { ...prev.subagents, maxConcurrent: parseInt(e.currentTarget.value) || 5 }
                      } : null)}
                    />
                  </div>
                </div>

                {/* Role Settings */}
                <div class="settings-section">
                  <h3>Subagent Role Defaults</h3>
                  <p class="settings-hint">Default provider/model for each role. Can be overridden per-task.</p>

                  <For each={(['simple', 'complex', 'researcher'] as SubagentRole[])}>
                    {(role) => (
                      <div class="role-config">
                        <div class="role-config-header">
                          <span class={`role-badge ${getRoleBadgeClass(role)}`}>{role}</span>
                        </div>
                        <div class="role-config-fields">
                          <div class="settings-row">
                            <label>Provider</label>
                            <select
                              value={cfg().subagents.roles[role].provider}
                              onChange={async (e) => {
                                const newProvider = e.currentTarget.value
                                await loadModelsForProvider(newProvider)
                                const providerInfo = providers().find(p => p.provider === newProvider)
                                setEditingConfig(prev => {
                                  if (!prev) return null
                                  return {
                                    ...prev,
                                    subagents: {
                                      ...prev.subagents,
                                      roles: {
                                        ...prev.subagents.roles,
                                        [role]: {
                                          ...prev.subagents.roles[role],
                                          provider: newProvider,
                                          model: providerInfo?.defaultModel || prev.subagents.roles[role].model
                                        }
                                      }
                                    }
                                  }
                                })
                              }}
                            >
                              <For each={providers()}>
                                {(p) => <option value={p.provider}>{getProviderLabel(p.provider)}</option>}
                              </For>
                            </select>
                          </div>
                          <div class="settings-row">
                            <label>Model</label>
                            <select
                              value={cfg().subagents.roles[role].model}
                              onChange={(e) => {
                                setEditingConfig(prev => {
                                  if (!prev) return null
                                  return {
                                    ...prev,
                                    subagents: {
                                      ...prev.subagents,
                                      roles: {
                                        ...prev.subagents.roles,
                                        [role]: {
                                          ...prev.subagents.roles[role],
                                          model: e.currentTarget.value
                                        }
                                      }
                                    }
                                  }
                                })
                              }}
                            >
                              <For each={settingsModels()[cfg().subagents.roles[role].provider] || []}>
                                {(m) => <option value={m.id}>{getShortModelName(m.id)}</option>}
                              </For>
                              {/* Show current model even if not in list */}
                              <Show when={!settingsModels()[cfg().subagents.roles[role].provider]?.some(m => m.id === cfg().subagents.roles[role].model)}>
                                <option value={cfg().subagents.roles[role].model}>{getShortModelName(cfg().subagents.roles[role].model)}</option>
                              </Show>
                            </select>
                          </div>
                          <div class="settings-row">
                            <label>Max Iterations</label>
                            <input
                              type="number"
                              min="1"
                              max="100"
                              value={cfg().subagents.roles[role].maxIterations}
                              onChange={(e) => {
                                setEditingConfig(prev => {
                                  if (!prev) return null
                                  return {
                                    ...prev,
                                    subagents: {
                                      ...prev.subagents,
                                      roles: {
                                        ...prev.subagents.roles,
                                        [role]: {
                                          ...prev.subagents.roles[role],
                                          maxIterations: parseInt(e.currentTarget.value) || 10
                                        }
                                      }
                                    }
                                  }
                                })
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div class="settings-footer">
                <button class="dialog-btn cancel" onClick={() => setShowSettings(false)}>Cancel</button>
                <button
                  class="dialog-btn confirm"
                  disabled={savingConfig()}
                  onClick={() => {
                    const toSave = editingConfig()
                    if (toSave) saveConfigToServer(toSave)
                  }}
                >
                  {savingConfig() ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* MCP Panel */}
      <Show when={showMCPPanel()}>
        <div class="mcp-panel-overlay" onClick={() => setShowMCPPanel(false)}>
          <div class="mcp-panel-container" onClick={(e) => e.stopPropagation()}>
            <MCPPanel
              workingDir={process.cwd ? process.cwd() : '.'}
              onClose={() => setShowMCPPanel(false)}
              onCommandSelect={(cmd) => {
                // Insert command into input
                setInput(`/${cmd.name} `)
                setShowMCPPanel(false)
              }}
            />
          </div>
        </div>
      </Show>
    </>
  )
}

// Helper to format tool input for display
function formatToolInput(name: string, input: string | unknown): string {
  // Handle non-string input (can come from fullHistory)
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
  try {
    const parsed = JSON.parse(inputStr)
    switch (name) {
      case 'read_file':
        return parsed.path + (parsed.offset ? `:${parsed.offset}` : '') + (parsed.limit ? `-${parsed.limit}` : '')
      case 'write_file':
        return `${parsed.path} (${parsed.content?.length || 0} chars)`
      case 'edit_file':
        return parsed.path
      case 'bash':
        return parsed.command
      default:
        return JSON.stringify(parsed, null, 2)
    }
  } catch {
    return inputStr
  }
}

render(() => <App />, document.getElementById('root')!)
