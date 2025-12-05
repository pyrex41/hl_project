/* @refresh reload */
import { render } from 'solid-js/web'
import { createSignal, createEffect, For, Show, onMount } from 'solid-js'

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
  status: 'running' | 'completed' | 'error' | 'cancelled'
  error?: string
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

interface TokenUsage {
  input: number
  output: number
}

function App() {
  const [messages, setMessages] = createSignal<Message[]>([])
  const [input, setInput] = createSignal('')
  const [status, setStatus] = createSignal<AgentStatus>('idle')
  const [tokens, setTokens] = createSignal<TokenUsage>({ input: 0, output: 0 })
  const [currentAssistant, setCurrentAssistant] = createSignal('')
  const [currentTools, setCurrentTools] = createSignal<Map<string, ToolCall>>(new Map())
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
  const [expandedSubagent, setExpandedSubagent] = createSignal<SubagentResult | null>(null)
  // Settings state
  const [showSettings, setShowSettings] = createSignal(false)
  const [config, setConfig] = createSignal<FullConfig | null>(null)
  const [editingConfig, setEditingConfig] = createSignal<FullConfig | null>(null)
  const [savingConfig, setSavingConfig] = createSignal(false)
  // Per-provider models cache for settings
  const [settingsModels, setSettingsModels] = createSignal<Record<string, ModelInfo[]>>({})
  let messagesEndRef: HTMLDivElement | undefined

  // Load sessions and providers on mount
  onMount(async () => {
    // Load config first, then providers (so we can use config defaults)
    await loadConfig()
    await Promise.all([loadSessions(), loadProviders()])

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

  const sendMessage = async () => {
    const msg = input().trim()
    if (!msg || status() !== 'idle') return

    // Create a session if we don't have one
    if (!sessionId()) {
      await createNewSession()
    }

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    setStatus('thinking')
    setCurrentAssistant('')
    setCurrentTools(new Map())

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
            status: 'running'
          })
          return next
        })
        break

      case 'subagent_progress':
        // Update the running subagent with progress (could track more detail)
        break

      case 'subagent_complete':
        setRunningSubagents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.taskId as string)
          if (existing) {
            existing.status = 'completed'
            existing.summary = event.summary as string
            existing.fullHistory = event.fullHistory as Message[]
            // Move to completed
            setCompletedSubagents(c => [...c, { ...existing }])
          }
          next.delete(event.taskId as string)
          return next
        })
        break

      case 'subagent_error':
        setRunningSubagents(prev => {
          const next = new Map(prev)
          const existing = next.get(event.taskId as string)
          if (existing) {
            existing.status = 'error'
            existing.error = event.error as string
            existing.fullHistory = event.fullHistory as Message[]
            setCompletedSubagents(c => [...c, { ...existing }])
          }
          next.delete(event.taskId as string)
          return next
        })
        break
    }
  }

  const finalizeAssistantMessage = () => {
    const content = currentAssistant()
    const tools = Array.from(currentTools().values())

    if (content || tools.length > 0) {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content,
          toolCalls: tools.length > 0 ? tools : undefined,
        },
      ])
    }

    setCurrentAssistant('')
    setCurrentTools(new Map())
    setStatus('idle')
  }

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
    return n.toString()
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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
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

  const getRoleBadgeClass = (role: SubagentRole) => {
    const classes: Record<SubagentRole, string> = {
      simple: 'role-badge-simple',
      complex: 'role-badge-complex',
      researcher: 'role-badge-researcher'
    }
    return classes[role] || ''
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
              <span class="provider-icon">{getProviderIcon(selectedProvider() || '')}</span>
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
                      <span class="item-icon">{getProviderIcon(p.provider)}</span>
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

      <div class="messages">
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
                        <div class="tool-header">
                          <span class="tool-name">{tool.name}</span>
                          <span class={`tool-status ${tool.status}`}>
                            {tool.status === 'running' && <span class="spinner" />}
                            {tool.status === 'done' && '✓'}
                            {tool.status === 'error' && '✗'}
                            {tool.status}
                          </span>
                        </div>
                        <Show when={tool.input}>
                          <div class="tool-input">{formatToolInput(tool.name, tool.input)}</div>
                        </Show>
                        {renderToolOutput(tool)}
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

        {/* Current streaming content */}
        <Show when={currentAssistant() || currentTools().size > 0}>
          <div class="message">
            <Show when={currentTools().size > 0}>
              <For each={Array.from(currentTools().values())}>
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
                    {renderToolOutput(tool)}
                  </div>
                )}
              </For>
            </Show>
            <Show when={currentAssistant()}>
              <div class="message-assistant">{currentAssistant()}</div>
            </Show>
          </div>
        </Show>

        {/* Inline Running Subagents */}
        <For each={Array.from(runningSubagents().values())}>
          {(subagent) => (
            <div class="message">
              <div class="subagent-card-inline running">
                <div class="subagent-card-header">
                  <span class={`role-badge ${getRoleBadgeClass(subagent.task.role)}`}>{subagent.task.role}</span>
                  <span class="subagent-card-desc">{subagent.task.description}</span>
                </div>
                <div class="subagent-card-status">
                  <span class="spinner" /> Running...
                </div>
              </div>
            </div>
          )}
        </For>

        {/* Inline Completed Subagents */}
        <For each={completedSubagents()}>
          {(subagent) => (
            <div class="message">
              <div
                class={`subagent-card-inline completed ${subagent.status === 'error' ? 'error' : ''}`}
                onClick={() => setExpandedSubagent(subagent)}
              >
                <div class="subagent-card-header">
                  <span class={`role-badge ${getRoleBadgeClass(subagent.task.role)}`}>{subagent.task.role}</span>
                  <span class="subagent-card-desc">{subagent.task.description}</span>
                  <span class="expand-hint">Click to expand</span>
                </div>
                <div class="subagent-card-summary">
                  {subagent.status === 'error' ? subagent.error : subagent.summary.slice(0, 200)}
                  {subagent.summary.length > 200 ? '...' : ''}
                </div>
              </div>
            </div>
          )}
        </For>

        <div ref={messagesEndRef} />
      </div>

      <div class="input-area">
        <div class="input-wrapper">
          <span class="input-prompt">&gt;</span>
          <input
            type="text"
            class="input-field"
            placeholder={status() === 'idle' ? 'Type a message...' : 'Agent is working...'}
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={status() !== 'idle'}
          />
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
                  {(task) => (
                    <div class="subagent-item">
                      <div class="subagent-item-header">
                        <span class={`role-badge ${getRoleBadgeClass(task.role)}`}>{task.role}</span>
                        <span class="subagent-description">{task.description}</span>
                      </div>
                      <div class="subagent-item-config">
                        <select
                          class="subagent-select"
                          value={task.provider || selectedProvider() || ''}
                          onChange={(e) => {
                            const newTasks = [...confirmation().tasks]
                            const idx = newTasks.findIndex(t => t.id === task.id)
                            if (idx >= 0) {
                              newTasks[idx] = { ...task, provider: e.currentTarget.value }
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
                          value={task.model || selectedModel() || ''}
                          onChange={(e) => {
                            const newTasks = [...confirmation().tasks]
                            const idx = newTasks.findIndex(t => t.id === task.id)
                            if (idx >= 0) {
                              newTasks[idx] = { ...task, model: e.currentTarget.value }
                              setPendingConfirmation({ ...confirmation(), tasks: newTasks })
                            }
                          }}
                        >
                          <For each={models()}>
                            {(m) => <option value={m.id}>{getShortModelName(m.id)}</option>}
                          </For>
                        </select>
                      </div>
                    </div>
                  )}
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
          <div class="subagent-window-overlay" onClick={() => setExpandedSubagent(null)}>
            <div class="subagent-window" onClick={(e) => e.stopPropagation()}>
              <div class="subagent-window-header">
                <span class={`role-badge ${getRoleBadgeClass(subagent().task.role)}`}>{subagent().task.role}</span>
                <span class="subagent-window-desc">{subagent().task.description}</span>
                <button class="close-btn" onClick={() => setExpandedSubagent(null)}>×</button>
              </div>
              <div class="subagent-window-content">
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
              </div>
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
    </>
  )
}

// Helper to format tool input for display
function formatToolInput(name: string, input: string): string {
  try {
    const parsed = JSON.parse(input)
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
    return input
  }
}

render(() => <App />, document.getElementById('root')!)
