import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { agentLoop, type AgentConfig } from './agent'
import { createSession, saveSession, loadSession, listSessions, deleteSession, updateSessionMessage } from './sessions'
import { listAvailableProviders } from './providers'
import type { Message } from './types'
import type { Session } from './sessions'

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

      for await (const event of agentLoop(userMessage, history, workingDir, agentConfig)) {
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
