import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { agentLoop, type AgentConfig } from './agent'
import { createSession, saveSession, loadSession, listSessions, deleteSession, updateSessionMessage } from './sessions'
import { expandSlashCommand, listCommands, formatHelpText } from './commands'
import { listAvailableProviders, listModelsForProvider, type ProviderName } from './providers'
import { loadFullConfig, saveFullConfig, DEFAULT_CONFIG, type AgentConfig as FullAgentConfig, type SubagentConfig } from './config'
import { continueSubagent } from './subagent'
import type { Message, SubagentTask } from './types'
import type { Session } from './sessions'
import {
  getMCPManager,
  loadMCPConfig,
  saveMCPConfig,
  type MCPServerConfig,
  type MCPConfig,
  validateServerConfig,
  createServerConfig,
  getAllMCPCommands,
  executeMCPCommand,
  formatMCPCommandsHelp
} from './mcp'

// Store pending subagent confirmations by request ID
const pendingConfirmations: Map<string, {
  resolve: (tasks: SubagentTask[] | null) => void
  tasks: SubagentTask[]
}> = new Map()

const app = new Hono()

// Enable CORS for the frontend
app.use('*', cors())

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// List available providers
app.get('/api/providers', (c) => {
  const providers = listAvailableProviders()
  return c.json({ providers })
})

// List models for a specific provider
app.get('/api/providers/:provider/models', async (c) => {
  const providerName = c.req.param('provider') as ProviderName
  const validProviders = ['anthropic', 'xai', 'openai']

  if (!validProviders.includes(providerName)) {
    return c.json({ error: 'Invalid provider' }, 400)
  }

  try {
    const models = await listModelsForProvider(providerName)
    return c.json({ models })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to list models'
    }, 500)
  }
})

// Configuration endpoints - full config (mainChat + subagents)
app.get('/api/config', async (c) => {
  const workingDir = c.req.query('workingDir') || process.cwd()
  try {
    const config = await loadFullConfig(workingDir)
    return c.json({ config })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to load config'
    }, 500)
  }
})

app.put('/api/config', async (c) => {
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const config: Partial<FullAgentConfig> = body.config

  if (!config) {
    return c.json({ error: 'Missing config in request body' }, 400)
  }

  try {
    // Load existing config and merge with updates
    const existing = await loadFullConfig(workingDir)
    const merged: FullAgentConfig = {
      mainChat: config.mainChat !== undefined ? config.mainChat : existing.mainChat,
      subagents: config.subagents ? {
        ...existing.subagents,
        ...config.subagents,
        roles: {
          ...existing.subagents.roles,
          ...config.subagents.roles
        }
      } : existing.subagents
    }
    await saveFullConfig(workingDir, merged)
    return c.json({ config: merged })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to save config'
    }, 500)
  }
})

app.get('/api/config/defaults', (c) => {
  return c.json({ config: DEFAULT_CONFIG })
})

// Slash commands endpoints
app.get('/api/commands', async (c) => {
  const workingDir = c.req.query('workingDir') || process.cwd()
  try {
    const commands = await listCommands(workingDir)
    return c.json({ commands })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to list commands'
    }, 500)
  }
})

app.get('/api/commands/help', async (c) => {
  const workingDir = c.req.query('workingDir') || process.cwd()
  try {
    const helpText = await formatHelpText(workingDir)
    return c.json({ help: helpText })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to generate help'
    }, 500)
  }
})

// Subagent confirmation endpoints
app.post('/api/subagents/confirm', async (c) => {
  const body = await c.req.json()
  const requestId: string = body.requestId
  const confirmed: boolean = body.confirmed
  const tasks: SubagentTask[] | undefined = body.tasks

  const pending = pendingConfirmations.get(requestId)
  if (!pending) {
    return c.json({ error: 'No pending confirmation found' }, 404)
  }

  if (confirmed && tasks) {
    pending.resolve(tasks)
  } else {
    pending.resolve(null)
  }

  pendingConfirmations.delete(requestId)
  return c.json({ success: true })
})

// Continue a subagent that hit max iterations
app.post('/api/subagents/continue', async (c) => {
  const body = await c.req.json()
  const taskId: string = body.taskId
  const task: SubagentTask = body.task
  const history: Message[] = body.history || []
  const workingDir: string = body.workingDir || process.cwd()

  if (!taskId || !task) {
    return c.json({ error: 'Missing taskId or task' }, 400)
  }

  // Load subagent config
  const fullConfig = await loadFullConfig(workingDir)
  const subagentConfig = fullConfig.subagents

  return streamSSE(c, async (stream) => {
    try {
      for await (const event of continueSubagent({
        task,
        workingDir,
        config: subagentConfig,
        existingHistory: history
      })) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    } catch (error) {
      await stream.writeSSE({
        event: 'subagent_error',
        data: JSON.stringify({
          type: 'subagent_error',
          taskId,
          error: error instanceof Error ? error.message : 'Unknown error',
          fullHistory: history
        }),
      })
    }
  })
})

// Session management endpoints
app.get('/api/sessions', async (c) => {
  const workingDir = c.req.query('workingDir') || process.cwd()
  const sessions = await listSessions(workingDir)
  return c.json({ sessions })
})

app.post('/api/sessions', async (c) => {
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const session = await createSession(workingDir)
  await saveSession(session)
  return c.json({ session })
})

app.get('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  const workingDir = c.req.query('workingDir') || process.cwd()
  const session = await loadSession(workingDir, sessionId)

  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  return c.json({ session })
})

app.put('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()

  const session = await loadSession(workingDir, sessionId)
  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  // Update session fields
  if (body.name !== undefined) session.name = body.name
  if (body.messages !== undefined) session.messages = body.messages
  if (body.metadata !== undefined) session.metadata = { ...session.metadata, ...body.metadata }

  await saveSession(session)
  return c.json({ session })
})

app.delete('/api/sessions/:id', async (c) => {
  const sessionId = c.req.param('id')
  const workingDir = c.req.query('workingDir') || process.cwd()

  const deleted = await deleteSession(workingDir, sessionId)
  if (!deleted) {
    return c.json({ error: 'Session not found or could not be deleted' }, 404)
  }

  return c.json({ success: true })
})

// SSE endpoint for agent interactions
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  let userMessage: string = body.message
  const history: Message[] = body.history || []
  const workingDir: string = body.workingDir || process.cwd()
  const sessionId: string | undefined = body.sessionId

  // Provider configuration from request
  const agentConfig: AgentConfig = {
    provider: body.provider,
    model: body.model
  }

  // Load or create session
  let session: Session | null = null
  if (sessionId) {
    session = await loadSession(workingDir, sessionId)
  }

  // Expand slash commands before processing
  let commandExpanded = false
  let commandName: string | undefined
  if (userMessage.startsWith('/')) {
    const expansion = await expandSlashCommand(userMessage, workingDir)
    if (expansion) {
      commandName = expansion.command.name
      userMessage = expansion.expanded
      commandExpanded = true
    }
  }

  return streamSSE(c, async (stream) => {
    // If a command was expanded, notify the client
    if (commandExpanded && commandName) {
      await stream.writeSSE({
        event: 'command_expanded',
        data: JSON.stringify({ type: 'command_expanded', command: commandName })
      })
    }
    try {
      let assistantContent = ''
      let toolCalls: Message['toolCalls'] = []
      let tokenUsage = { input: 0, output: 0 }

      // Subagent confirmation callback
      const onSubagentConfirm = async (tasks: SubagentTask[]): Promise<SubagentTask[] | null> => {
        const requestId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2)}`

        // Send the request ID to the client so it knows which confirmation to respond to
        await stream.writeSSE({
          event: 'subagent_request',
          data: JSON.stringify({ type: 'subagent_request', tasks, requestId })
        })

        // Wait for confirmation from client
        return new Promise((resolve) => {
          pendingConfirmations.set(requestId, { resolve, tasks })

          // Timeout after 5 minutes
          setTimeout(() => {
            if (pendingConfirmations.has(requestId)) {
              pendingConfirmations.delete(requestId)
              resolve(null)
            }
          }, 5 * 60 * 1000)
        })
      }

      for await (const event of agentLoop(userMessage, history, workingDir, agentConfig, onSubagentConfirm)) {
        // Skip subagent_request since we handle it specially in onSubagentConfirm
        if (event.type === 'subagent_request') continue

        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })

        // Track content for session persistence
        if (event.type === 'text_delta') {
          assistantContent += event.delta
        } else if (event.type === 'tool_start') {
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: {},
            status: 'pending'
          })
        } else if (event.type === 'tool_result') {
          const tool = toolCalls.find(t => t.id === event.id)
          if (tool) {
            tool.output = event.output
            tool.status = event.error ? 'error' : 'done'
            tool.error = event.error
          }
        } else if (event.type === 'turn_complete' && event.usage) {
          tokenUsage = { input: event.usage.inputTokens, output: event.usage.outputTokens }
        }
      }

      // Save to session if we have one
      if (session) {
        // Add user message
        updateSessionMessage(session, { role: 'user', content: userMessage })

        // Add assistant message
        if (assistantContent || toolCalls.length > 0) {
          updateSessionMessage(
            session,
            {
              role: 'assistant',
              content: assistantContent,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined
            },
            tokenUsage
          )
        }

        await saveSession(session)

        // Send session update event
        await stream.writeSSE({
          event: 'session_updated',
          data: JSON.stringify({ sessionId: session.id })
        })
      }
    } catch (error) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        }),
      })
    }
  })
})

// ============================================================
// MCP (Model Context Protocol) Endpoints
// ============================================================

// Initialize MCP manager on startup
const mcpManager = getMCPManager()

// Initialize MCP when server starts (async)
async function initMCP() {
  try {
    const workingDir = process.cwd()
    const config = await loadMCPConfig(workingDir)
    await mcpManager.initialize(config)
    console.log(`MCP initialized with ${config.servers.length} configured servers`)
  } catch (error) {
    console.error('Failed to initialize MCP:', error)
  }
}
initMCP()

// Get MCP configuration
app.get('/api/mcp/config', async (c) => {
  const workingDir = c.req.query('workingDir') || process.cwd()
  try {
    const config = await loadMCPConfig(workingDir)
    return c.json({ config })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to load MCP config'
    }, 500)
  }
})

// Save MCP configuration
app.put('/api/mcp/config', async (c) => {
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const config: MCPConfig = body.config

  if (!config) {
    return c.json({ error: 'Missing config in request body' }, 400)
  }

  try {
    await saveMCPConfig(workingDir, config)
    await mcpManager.updateConfig(config)
    return c.json({ config })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to save MCP config'
    }, 500)
  }
})

// List all MCP server states
app.get('/api/mcp/servers', (c) => {
  const states = mcpManager.getAllServerStates()
  return c.json({
    servers: states.map(s => ({
      id: s.config.id,
      name: s.config.name,
      transport: s.config.transport,
      status: s.status,
      error: s.error,
      toolCount: s.tools.length,
      promptCount: s.prompts.length,
      resourceCount: s.resources.length,
      serverInfo: s.serverInfo,
      lastConnected: s.lastConnected
    }))
  })
})

// Get specific server state
app.get('/api/mcp/servers/:id', (c) => {
  const serverId = c.req.param('id')
  const state = mcpManager.getServerState(serverId)

  if (!state) {
    return c.json({ error: 'Server not found' }, 404)
  }

  return c.json({ server: state })
})

// Connect to an MCP server
app.post('/api/mcp/servers/:id/connect', async (c) => {
  const serverId = c.req.param('id')

  try {
    await mcpManager.connect(serverId)
    const state = mcpManager.getServerState(serverId)
    return c.json({ success: true, server: state })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to connect'
    }, 500)
  }
})

// Disconnect from an MCP server
app.post('/api/mcp/servers/:id/disconnect', async (c) => {
  const serverId = c.req.param('id')

  try {
    await mcpManager.disconnect(serverId)
    return c.json({ success: true })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to disconnect'
    }, 500)
  }
})

// Reconnect to an MCP server
app.post('/api/mcp/servers/:id/reconnect', async (c) => {
  const serverId = c.req.param('id')

  try {
    await mcpManager.reconnect(serverId)
    const state = mcpManager.getServerState(serverId)
    return c.json({ success: true, server: state })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to reconnect'
    }, 500)
  }
})

// Add a new MCP server
app.post('/api/mcp/servers', async (c) => {
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const serverConfig: MCPServerConfig = body.server

  if (!serverConfig) {
    return c.json({ error: 'Missing server config' }, 400)
  }

  // Validate
  const errors = validateServerConfig(serverConfig)
  if (errors.length > 0) {
    return c.json({ error: 'Invalid server config', details: errors }, 400)
  }

  try {
    const config = await loadMCPConfig(workingDir)

    // Check for duplicate ID
    if (config.servers.some(s => s.id === serverConfig.id)) {
      return c.json({ error: 'Server with this ID already exists' }, 400)
    }

    config.servers.push(serverConfig)
    await saveMCPConfig(workingDir, config)
    await mcpManager.updateConfig(config)

    return c.json({ success: true, server: serverConfig })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to add server'
    }, 500)
  }
})

// Update an MCP server
app.put('/api/mcp/servers/:id', async (c) => {
  const serverId = c.req.param('id')
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const updates: Partial<MCPServerConfig> = body.server

  try {
    const config = await loadMCPConfig(workingDir)
    const serverIndex = config.servers.findIndex(s => s.id === serverId)

    if (serverIndex === -1) {
      return c.json({ error: 'Server not found' }, 404)
    }

    const existingServer = config.servers[serverIndex]
    if (!existingServer) {
      return c.json({ error: 'Server not found' }, 404)
    }

    const updatedServer = { ...existingServer, ...updates }
    config.servers[serverIndex] = updatedServer

    // Validate
    const errors = validateServerConfig(updatedServer)
    if (errors.length > 0) {
      return c.json({ error: 'Invalid server config', details: errors }, 400)
    }

    await saveMCPConfig(workingDir, config)
    await mcpManager.updateConfig(config)

    return c.json({ success: true, server: updatedServer })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to update server'
    }, 500)
  }
})

// Delete an MCP server
app.delete('/api/mcp/servers/:id', async (c) => {
  const serverId = c.req.param('id')
  const workingDir = c.req.query('workingDir') || process.cwd()

  try {
    const config = await loadMCPConfig(workingDir)
    const serverIndex = config.servers.findIndex(s => s.id === serverId)

    if (serverIndex === -1) {
      return c.json({ error: 'Server not found' }, 404)
    }

    // Disconnect first
    await mcpManager.disconnect(serverId)

    config.servers.splice(serverIndex, 1)
    await saveMCPConfig(workingDir, config)
    await mcpManager.updateConfig(config)

    return c.json({ success: true })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to delete server'
    }, 500)
  }
})

// List all tools from connected MCP servers
app.get('/api/mcp/tools', (c) => {
  const tools = mcpManager.getAllTools()
  return c.json({ tools })
})

// List all prompts from connected MCP servers (user-facing commands)
app.get('/api/mcp/prompts', (c) => {
  const prompts = mcpManager.getAllPrompts()
  return c.json({ prompts })
})

// Get a specific prompt (execute user command)
app.post('/api/mcp/prompts/:serverId/:promptName', async (c) => {
  const serverId = c.req.param('serverId')
  const promptName = c.req.param('promptName')
  const body = await c.req.json()
  const args: Record<string, string> = body.arguments || {}

  try {
    const result = await mcpManager.getPrompt(serverId, promptName, args)
    return c.json({ result })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to get prompt'
    }, 500)
  }
})

// List all resources from connected MCP servers
app.get('/api/mcp/resources', (c) => {
  const resources = mcpManager.getAllResources()
  return c.json({ resources })
})

// Read a specific resource
app.get('/api/mcp/resources/:serverId/*', async (c) => {
  const serverId = c.req.param('serverId')
  const uri = c.req.path.replace(`/api/mcp/resources/${serverId}/`, '')

  try {
    const content = await mcpManager.readResource(serverId, uri)
    return c.json({ content })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to read resource'
    }, 500)
  }
})

// Helper endpoint: Create server config from common patterns
app.post('/api/mcp/create-server-config', async (c) => {
  const body = await c.req.json()
  try {
    const config = createServerConfig(body as Parameters<typeof createServerConfig>[0])
    return c.json({ config })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to create server config'
    }, 500)
  }
})

// List all MCP commands (prompts as user-facing commands)
app.get('/api/mcp/commands', (c) => {
  const commands = getAllMCPCommands()
  return c.json({ commands })
})

// Get MCP commands help text
app.get('/api/mcp/commands/help', (c) => {
  const help = formatMCPCommandsHelp()
  return c.json({ help })
})

// Execute an MCP command
app.post('/api/mcp/commands/:commandName', async (c) => {
  const commandName = c.req.param('commandName')
  const body = await c.req.json()
  const args: Record<string, string> = body.arguments || {}

  try {
    const result = await executeMCPCommand(commandName, args)
    if (!result) {
      return c.json({ error: 'Command not found or failed to execute' }, 404)
    }
    return c.json({ result })
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to execute command'
    }, 500)
  }
})

const port = parseInt(process.env.PORT || '3001')

// Export server config for Bun's auto-serve feature
// Bun automatically starts a server when default export has fetch + port
export default {
  fetch: app.fetch,
  port,
}
