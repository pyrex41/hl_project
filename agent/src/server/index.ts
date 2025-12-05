import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { agentLoop, type AgentConfig } from './agent'
import { createSession, saveSession, loadSession, listSessions, deleteSession, updateSessionMessage } from './sessions'
import { listAvailableProviders, listModelsForProvider, type ProviderName } from './providers'
import { loadFullConfig, saveFullConfig, DEFAULT_CONFIG, type AgentConfig as FullAgentConfig, type SubagentConfig } from './config'
import { continueSubagent } from './subagent'
import type { Message, SubagentTask } from './types'
import type { Session } from './sessions'

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
  const userMessage: string = body.message
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

  return streamSSE(c, async (stream) => {
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

const port = parseInt(process.env.PORT || '3001')
console.log(`Agent server running on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port,
})

export default app
