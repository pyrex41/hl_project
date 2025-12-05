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

type AgentStatus = 'idle' | 'thinking' | 'executing' | 'error'

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
  let messagesEndRef: HTMLDivElement | undefined

  // Load sessions and providers on mount
  onMount(async () => {
    await Promise.all([loadSessions(), loadProviders()])
  })

  const loadProviders = async () => {
    try {
      const res = await fetch('/api/providers')
      const data = await res.json()
      setProviders(data.providers || [])
      // Select first available provider by default
      if (data.providers?.length > 0 && !selectedProvider()) {
        const firstProvider = data.providers[0]
        setSelectedProvider(firstProvider.provider)
        setSelectedModel(firstProvider.defaultModel)
        // Load models for the default provider
        await loadModels(firstProvider.provider)
      }
    } catch (e) {
      console.error('Failed to load providers:', e)
    }
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

  const startNewChat = () => {
    setSessionId(null)
    setMessages([])
    setTokens({ input: 0, output: 0 })
    setShowSessions(false)
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
