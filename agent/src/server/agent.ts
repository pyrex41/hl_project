import { getProvider, toolDefinitions, type ProviderConfig, type ChatMessage, type ContentBlock } from './providers'
import { getSystemPrompt } from './prompt'
import { executeTool } from './tools'
import type { AgentEvent, Message } from './types'

const MAX_ITERATIONS = 25
const DOOM_LOOP_THRESHOLD = 3

interface ToolCallTracker {
  name: string
  argsHash: string
  count: number
}

function hashArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args)
}

function checkDoomLoop(
  toolCallHistory: ToolCallTracker[],
  name: string,
  args: Record<string, unknown>
): boolean {
  const argsHash = hashArgs(args)
  const existing = toolCallHistory.find(t => t.name === name && t.argsHash === argsHash)

  if (existing) {
    existing.count++
    return existing.count >= DOOM_LOOP_THRESHOLD
  }

  toolCallHistory.push({ name, argsHash, count: 1 })
  return false
}

export interface AgentConfig {
  provider?: ProviderConfig['provider']
  model?: string
}

export async function* agentLoop(
  userMessage: string,
  history: Message[],
  workingDir: string,
  config?: AgentConfig
): AsyncGenerator<AgentEvent> {
  const systemPrompt = await getSystemPrompt(workingDir)
  const toolCallHistory: ToolCallTracker[] = []

  // Get the LLM provider
  const provider = getProvider({
    provider: config?.provider,
    model: config?.model
  })

  // Build messages for API (provider-agnostic format)
  const messages: ChatMessage[] = history.map(msg => ({
    role: msg.role,
    content: msg.content
  }))

  // Add user message
  messages.push({ role: 'user', content: userMessage })

  let iterations = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0

  while (iterations < MAX_ITERATIONS) {
    iterations++

    try {
      // Track tool calls from this iteration
      const pendingTools: Map<string, { name: string; input: Record<string, unknown> }> = new Map()
      let hasTextContent = false

      // Stream from provider
      for await (const event of provider.stream(messages, systemPrompt, toolDefinitions)) {
        switch (event.type) {
          case 'text_delta':
            hasTextContent = true
            yield { type: 'text_delta', delta: event.delta }
            break

          case 'tool_start':
            yield { type: 'tool_start', id: event.id, name: event.name }
            pendingTools.set(event.id, { name: event.name, input: {} })
            break

          case 'tool_input_delta':
            yield { type: 'tool_input_delta', id: event.id, partialJson: event.partialJson }
            break

          case 'tool_complete':
            const tool = pendingTools.get(event.id)
            if (tool) {
              tool.input = event.input
            }
            break

          case 'message_complete':
            totalInputTokens += event.usage.inputTokens
            totalOutputTokens += event.usage.outputTokens
            break
        }
      }

      // If no tools were called, we're done
      if (pendingTools.size === 0) {
        yield {
          type: 'turn_complete',
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        }
        return
      }

      // Build assistant message with tool uses
      const assistantContent: ContentBlock[] = []
      for (const [id, tool] of pendingTools) {
        assistantContent.push({
          type: 'tool_use',
          id,
          name: tool.name,
          input: tool.input
        })
      }
      messages.push({ role: 'assistant', content: assistantContent })

      // Execute tools and collect results
      const toolResults: ContentBlock[] = []

      for (const [id, tool] of pendingTools) {
        // Check for doom loop
        if (checkDoomLoop(toolCallHistory, tool.name, tool.input)) {
          yield {
            type: 'tool_result',
            id,
            output: '',
            error: `Doom loop detected: ${tool.name} called ${DOOM_LOOP_THRESHOLD}+ times with identical arguments. Breaking loop.`
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: Detected repeated identical calls to ${tool.name}. Please try a different approach.`,
            is_error: true
          })
          continue
        }

        yield { type: 'tool_running', id }

        try {
          const result = await executeTool(tool.name, tool.input, workingDir)
          yield {
            type: 'tool_result',
            id,
            output: result.output,
            details: result.details
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: result.output
          })
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          yield {
            type: 'tool_result',
            id,
            output: '',
            error: errorMsg
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: ${errorMsg}`,
            is_error: true
          })
        }
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults })

    } catch (error) {
      // Handle rate limits with exponential backoff
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.toLowerCase().includes('rate limit')) {
        const waitTime = Math.min(60, Math.pow(2, iterations) * 2)
        yield { type: 'retry_countdown', seconds: waitTime, reason: 'Rate limit exceeded' }
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000))
        iterations-- // Don't count rate limit retries
        continue
      }
      throw error
    }
  }

  yield { type: 'error', error: `Max iterations (${MAX_ITERATIONS}) reached` }
}
