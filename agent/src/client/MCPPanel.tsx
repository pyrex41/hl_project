/**
 * MCP Panel Component
 *
 * Displays MCP server status, tools, and commands.
 * Can be embedded in the main App or shown as a modal/sidebar.
 */

import { createSignal, createEffect, For, Show, onMount } from 'solid-js'

// MCP Types
interface MCPServerSummary {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  toolCount: number
  promptCount: number
  resourceCount: number
  serverInfo?: {
    name: string
    version: string
  }
  lastConnected?: string
}

interface MCPTool {
  name: string
  description?: string
  serverId: string
}

interface MCPPrompt {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
  serverId: string
}

interface MCPCommand {
  name: string
  displayName: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
  serverId: string
  serverName: string
}

interface MCPServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  autoConnect?: boolean
}

export interface MCPPanelProps {
  workingDir: string
  onCommandSelect?: (command: MCPCommand) => void
  onClose?: () => void
}

export function MCPPanel(props: MCPPanelProps) {
  const [servers, setServers] = createSignal<MCPServerSummary[]>([])
  const [tools, setTools] = createSignal<MCPTool[]>([])
  const [commands, setCommands] = createSignal<MCPCommand[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [activeTab, setActiveTab] = createSignal<'servers' | 'tools' | 'commands'>('servers')
  const [showAddServer, setShowAddServer] = createSignal(false)

  // New server form state
  const [newServer, setNewServer] = createSignal<Partial<MCPServerConfig>>({
    transport: 'stdio',
    enabled: true,
    autoConnect: true
  })

  // Fetch data
  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const [serversRes, toolsRes, commandsRes] = await Promise.all([
        fetch(`/api/mcp/servers?workingDir=${encodeURIComponent(props.workingDir)}`),
        fetch('/api/mcp/tools'),
        fetch('/api/mcp/commands')
      ])

      if (serversRes.ok) {
        const data = await serversRes.json()
        setServers(data.servers || [])
      }

      if (toolsRes.ok) {
        const data = await toolsRes.json()
        setTools(data.tools || [])
      }

      if (commandsRes.ok) {
        const data = await commandsRes.json()
        setCommands(data.commands || [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch MCP data')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchData()
    // Refresh every 10 seconds
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  })

  // Server actions
  const connectServer = async (serverId: string) => {
    try {
      await fetch(`/api/mcp/servers/${serverId}/connect`, { method: 'POST' })
      await fetchData()
    } catch (e) {
      console.error('Failed to connect:', e)
    }
  }

  const disconnectServer = async (serverId: string) => {
    try {
      await fetch(`/api/mcp/servers/${serverId}/disconnect`, { method: 'POST' })
      await fetchData()
    } catch (e) {
      console.error('Failed to disconnect:', e)
    }
  }

  const reconnectServer = async (serverId: string) => {
    try {
      await fetch(`/api/mcp/servers/${serverId}/reconnect`, { method: 'POST' })
      await fetchData()
    } catch (e) {
      console.error('Failed to reconnect:', e)
    }
  }

  const deleteServer = async (serverId: string) => {
    if (!confirm('Are you sure you want to remove this MCP server?')) return
    try {
      await fetch(`/api/mcp/servers/${serverId}?workingDir=${encodeURIComponent(props.workingDir)}`, {
        method: 'DELETE'
      })
      await fetchData()
    } catch (e) {
      console.error('Failed to delete:', e)
    }
  }

  // Add new server
  const addServer = async () => {
    const server = newServer()
    if (!server.id || !server.name) {
      alert('Server ID and name are required')
      return
    }

    try {
      const res = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingDir: props.workingDir,
          server: server
        })
      })

      if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to add server')
        return
      }

      setShowAddServer(false)
      setNewServer({
        transport: 'stdio',
        enabled: true,
        autoConnect: true
      })
      await fetchData()
    } catch (e) {
      console.error('Failed to add server:', e)
    }
  }

  // Status badge color
  const statusColor = (status: string) => {
    switch (status) {
      case 'connected': return '#22c55e'
      case 'connecting': return '#eab308'
      case 'error': return '#ef4444'
      default: return '#6b7280'
    }
  }

  return (
    <div class="mcp-panel">
      <div class="mcp-header">
        <h2>MCP Servers</h2>
        <div class="mcp-header-actions">
          <button onClick={() => fetchData()} class="mcp-btn mcp-btn-icon" title="Refresh">
            ⟳
          </button>
          <Show when={props.onClose}>
            <button onClick={props.onClose} class="mcp-btn mcp-btn-icon" title="Close">
              ✕
            </button>
          </Show>
        </div>
      </div>

      <div class="mcp-tabs">
        <button
          class={`mcp-tab ${activeTab() === 'servers' ? 'active' : ''}`}
          onClick={() => setActiveTab('servers')}
        >
          Servers ({servers().length})
        </button>
        <button
          class={`mcp-tab ${activeTab() === 'tools' ? 'active' : ''}`}
          onClick={() => setActiveTab('tools')}
        >
          Tools ({tools().length})
        </button>
        <button
          class={`mcp-tab ${activeTab() === 'commands' ? 'active' : ''}`}
          onClick={() => setActiveTab('commands')}
        >
          Commands ({commands().length})
        </button>
      </div>

      <Show when={loading()}>
        <div class="mcp-loading">Loading...</div>
      </Show>

      <Show when={error()}>
        <div class="mcp-error">{error()}</div>
      </Show>

      <Show when={!loading() && !error()}>
        {/* Servers Tab */}
        <Show when={activeTab() === 'servers'}>
          <div class="mcp-content">
            <For each={servers()}>
              {(server) => (
                <div class="mcp-server-card">
                  <div class="mcp-server-header">
                    <div class="mcp-server-status" style={{ background: statusColor(server.status) }} />
                    <div class="mcp-server-info">
                      <div class="mcp-server-name">{server.name}</div>
                      <div class="mcp-server-id">{server.id}</div>
                    </div>
                    <div class="mcp-server-actions">
                      <Show when={server.status === 'connected'}>
                        <button onClick={() => disconnectServer(server.id)} class="mcp-btn mcp-btn-sm">
                          Disconnect
                        </button>
                      </Show>
                      <Show when={server.status === 'disconnected' || server.status === 'error'}>
                        <button onClick={() => connectServer(server.id)} class="mcp-btn mcp-btn-sm mcp-btn-primary">
                          Connect
                        </button>
                      </Show>
                      <Show when={server.status === 'error'}>
                        <button onClick={() => reconnectServer(server.id)} class="mcp-btn mcp-btn-sm">
                          Retry
                        </button>
                      </Show>
                      <button onClick={() => deleteServer(server.id)} class="mcp-btn mcp-btn-sm mcp-btn-danger">
                        ✕
                      </button>
                    </div>
                  </div>
                  <div class="mcp-server-details">
                    <span class="mcp-badge">{server.transport}</span>
                    <Show when={server.status === 'connected'}>
                      <span class="mcp-badge">{server.toolCount} tools</span>
                      <span class="mcp-badge">{server.promptCount} prompts</span>
                    </Show>
                    <Show when={server.error}>
                      <span class="mcp-badge mcp-badge-error">{server.error}</span>
                    </Show>
                  </div>
                  <Show when={server.serverInfo}>
                    <div class="mcp-server-version">
                      {server.serverInfo?.name} v{server.serverInfo?.version}
                    </div>
                  </Show>
                </div>
              )}
            </For>

            <Show when={servers().length === 0}>
              <div class="mcp-empty">
                No MCP servers configured.
              </div>
            </Show>

            <Show when={!showAddServer()}>
              <button onClick={() => setShowAddServer(true)} class="mcp-btn mcp-btn-full">
                + Add MCP Server
              </button>
            </Show>

            <Show when={showAddServer()}>
              <div class="mcp-add-form">
                <h3>Add MCP Server</h3>

                <div class="mcp-form-group">
                  <label>Server ID</label>
                  <input
                    type="text"
                    placeholder="my-server"
                    value={newServer().id || ''}
                    onInput={(e) => setNewServer({ ...newServer(), id: e.currentTarget.value })}
                  />
                </div>

                <div class="mcp-form-group">
                  <label>Name</label>
                  <input
                    type="text"
                    placeholder="My MCP Server"
                    value={newServer().name || ''}
                    onInput={(e) => setNewServer({ ...newServer(), name: e.currentTarget.value })}
                  />
                </div>

                <div class="mcp-form-group">
                  <label>Transport</label>
                  <select
                    value={newServer().transport}
                    onChange={(e) => setNewServer({ ...newServer(), transport: e.currentTarget.value as any })}
                  >
                    <option value="stdio">stdio (local process)</option>
                    <option value="sse">SSE (HTTP)</option>
                    <option value="streamable-http">Streamable HTTP</option>
                  </select>
                </div>

                <Show when={newServer().transport === 'stdio'}>
                  <div class="mcp-form-group">
                    <label>Command</label>
                    <input
                      type="text"
                      placeholder="npx"
                      value={newServer().command || ''}
                      onInput={(e) => setNewServer({ ...newServer(), command: e.currentTarget.value })}
                    />
                  </div>
                  <div class="mcp-form-group">
                    <label>Arguments (space-separated)</label>
                    <input
                      type="text"
                      placeholder="-y @my-org/my-mcp-server"
                      value={(newServer().args || []).join(' ')}
                      onInput={(e) => setNewServer({
                        ...newServer(),
                        args: e.currentTarget.value.split(' ').filter(Boolean)
                      })}
                    />
                  </div>
                </Show>

                <Show when={newServer().transport !== 'stdio'}>
                  <div class="mcp-form-group">
                    <label>URL</label>
                    <input
                      type="text"
                      placeholder="http://localhost:3000/mcp"
                      value={newServer().url || ''}
                      onInput={(e) => setNewServer({ ...newServer(), url: e.currentTarget.value })}
                    />
                  </div>
                </Show>

                <div class="mcp-form-actions">
                  <button onClick={() => setShowAddServer(false)} class="mcp-btn">
                    Cancel
                  </button>
                  <button onClick={addServer} class="mcp-btn mcp-btn-primary">
                    Add Server
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* Tools Tab */}
        <Show when={activeTab() === 'tools'}>
          <div class="mcp-content">
            <For each={tools()}>
              {(tool) => (
                <div class="mcp-tool-card">
                  <div class="mcp-tool-name">
                    <code>mcp_{tool.serverId}_{tool.name}</code>
                  </div>
                  <Show when={tool.description}>
                    <div class="mcp-tool-desc">{tool.description}</div>
                  </Show>
                  <div class="mcp-tool-server">Server: {tool.serverId}</div>
                </div>
              )}
            </For>
            <Show when={tools().length === 0}>
              <div class="mcp-empty">
                No tools available. Connect to an MCP server to see tools.
              </div>
            </Show>
          </div>
        </Show>

        {/* Commands Tab */}
        <Show when={activeTab() === 'commands'}>
          <div class="mcp-content">
            <For each={commands()}>
              {(cmd) => (
                <div
                  class="mcp-command-card"
                  onClick={() => props.onCommandSelect?.(cmd)}
                >
                  <div class="mcp-command-name">/{cmd.name}</div>
                  <Show when={cmd.description}>
                    <div class="mcp-command-desc">{cmd.description}</div>
                  </Show>
                  <Show when={cmd.arguments && cmd.arguments.length > 0}>
                    <div class="mcp-command-args">
                      Arguments:{' '}
                      <For each={cmd.arguments}>
                        {(arg) => (
                          <span class="mcp-arg">
                            {arg.required ? `<${arg.name}>` : `[${arg.name}]`}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="mcp-command-server">From: {cmd.serverName}</div>
                </div>
              )}
            </For>
            <Show when={commands().length === 0}>
              <div class="mcp-empty">
                No commands available. Connect to an MCP server that provides prompts.
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      <style>{`
        .mcp-panel {
          background: #1a1a1a;
          border-radius: 8px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          max-height: 100%;
        }

        .mcp-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid #333;
        }

        .mcp-header h2 {
          margin: 0;
          font-size: 16px;
          color: #fff;
        }

        .mcp-header-actions {
          display: flex;
          gap: 8px;
        }

        .mcp-tabs {
          display: flex;
          border-bottom: 1px solid #333;
        }

        .mcp-tab {
          flex: 1;
          padding: 10px;
          background: transparent;
          border: none;
          color: #888;
          cursor: pointer;
          font-size: 13px;
        }

        .mcp-tab.active {
          color: #fff;
          border-bottom: 2px solid #3b82f6;
        }

        .mcp-tab:hover {
          color: #fff;
        }

        .mcp-content {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
        }

        .mcp-loading, .mcp-error, .mcp-empty {
          padding: 20px;
          text-align: center;
          color: #888;
        }

        .mcp-error {
          color: #ef4444;
        }

        .mcp-server-card, .mcp-tool-card, .mcp-command-card {
          background: #252525;
          border-radius: 6px;
          padding: 12px;
          margin-bottom: 8px;
        }

        .mcp-server-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .mcp-server-status {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }

        .mcp-server-info {
          flex: 1;
        }

        .mcp-server-name {
          font-weight: 500;
          color: #fff;
        }

        .mcp-server-id {
          font-size: 12px;
          color: #888;
          font-family: monospace;
        }

        .mcp-server-actions {
          display: flex;
          gap: 6px;
        }

        .mcp-server-details {
          margin-top: 8px;
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }

        .mcp-server-version {
          margin-top: 6px;
          font-size: 11px;
          color: #666;
        }

        .mcp-badge {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          background: #333;
          color: #aaa;
        }

        .mcp-badge-error {
          background: #7f1d1d;
          color: #fca5a5;
        }

        .mcp-btn {
          padding: 6px 12px;
          border-radius: 4px;
          border: 1px solid #444;
          background: #333;
          color: #fff;
          cursor: pointer;
          font-size: 12px;
        }

        .mcp-btn:hover {
          background: #444;
        }

        .mcp-btn-sm {
          padding: 4px 8px;
          font-size: 11px;
        }

        .mcp-btn-icon {
          padding: 4px 8px;
          font-size: 14px;
        }

        .mcp-btn-primary {
          background: #3b82f6;
          border-color: #3b82f6;
        }

        .mcp-btn-primary:hover {
          background: #2563eb;
        }

        .mcp-btn-danger {
          color: #ef4444;
        }

        .mcp-btn-danger:hover {
          background: #7f1d1d;
        }

        .mcp-btn-full {
          width: 100%;
          margin-top: 8px;
        }

        .mcp-add-form {
          background: #252525;
          border-radius: 6px;
          padding: 16px;
          margin-top: 12px;
        }

        .mcp-add-form h3 {
          margin: 0 0 12px 0;
          font-size: 14px;
          color: #fff;
        }

        .mcp-form-group {
          margin-bottom: 12px;
        }

        .mcp-form-group label {
          display: block;
          margin-bottom: 4px;
          font-size: 12px;
          color: #888;
        }

        .mcp-form-group input, .mcp-form-group select {
          width: 100%;
          padding: 8px;
          border-radius: 4px;
          border: 1px solid #444;
          background: #1a1a1a;
          color: #fff;
          font-size: 13px;
        }

        .mcp-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }

        .mcp-tool-name {
          font-family: monospace;
          color: #22c55e;
          font-size: 12px;
        }

        .mcp-tool-desc, .mcp-command-desc {
          margin-top: 6px;
          font-size: 13px;
          color: #aaa;
        }

        .mcp-tool-server, .mcp-command-server {
          margin-top: 6px;
          font-size: 11px;
          color: #666;
        }

        .mcp-command-card {
          cursor: pointer;
        }

        .mcp-command-card:hover {
          background: #333;
        }

        .mcp-command-name {
          font-family: monospace;
          color: #3b82f6;
        }

        .mcp-command-args {
          margin-top: 6px;
          font-size: 12px;
          color: #888;
        }

        .mcp-arg {
          font-family: monospace;
          margin-left: 4px;
          color: #eab308;
        }
      `}</style>
    </div>
  )
}

export default MCPPanel
