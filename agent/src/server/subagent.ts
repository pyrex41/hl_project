import { getProvider, subagentToolDefinitions, type ChatMessage, type ContentBlock, type ProviderName } from './providers'
import { SUBAGENT_SYSTEM_PROMPT, loadProjectInstructions } from './prompt'
import { executeTool } from './tools'
import type { SubagentConfig, SubagentRole } from './config'
import type { AgentEvent, Message, SubagentTask, ToolCall, ToolResultDetails } from './types'

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

export interface ParentConfig {
  provider?: string
  model?: string
}

export interface SubagentOptions {
  task: SubagentTask
  workingDir: string
  config: SubagentConfig
  parentConfig?: ParentConfig  // Inherit provider/model from parent if not specified
  // NO parent history - subagents get fresh context only
}

/**
 * Build the prompt for a subagent based on its task and role
 */
function buildSubagentPrompt(task: SubagentTask): string {
  const rolePrompts: Record<SubagentRole, string> = {
    simple: 'Complete this task efficiently.',
    complex: 'Carefully work through this task step by step. Think before acting.',
    researcher: 'Explore and gather information thoroughly.'
  }

  return `${rolePrompts[task.role]}

Task: ${task.description}
${task.context ? `\nContext: ${task.context}` : ''}`
}

/**
 * Run a single subagent to completion
 * Yields progress events and returns the final result
 */
export async function* runSubagent(
  options: SubagentOptions
): AsyncGenerator<AgentEvent> {
  const { task, workingDir, config, parentConfig } = options

  // Get role config (with user overrides)
  // Priority: task override > parent config > role config
  const roleConfig = config.roles[task.role]
  const providerName = task.provider || parentConfig?.provider || roleConfig.provider
  const model = task.model || parentConfig?.model || roleConfig.model
  const maxIterations = roleConfig.maxIterations

  // Build subagent prompt
  const userPrompt = buildSubagentPrompt(task)

  // Get system prompt with project instructions
  const projectInstructions = await loadProjectInstructions(workingDir)
  const systemPrompt = projectInstructions
    ? `${SUBAGENT_SYSTEM_PROMPT}\n\n<project_instructions>\n${projectInstructions}\n</project_instructions>`
    : SUBAGENT_SYSTEM_PROMPT

  yield { type: 'subagent_start', taskId: task.id, description: task.description, role: task.role }

  // Get the LLM provider
  const provider = getProvider({
    provider: providerName as ProviderName,
    model: model
  })

  // Build messages - start fresh (no parent history)
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }]

  // Track history for UI expandable view
  const history: Message[] = [{ role: 'user', content: userPrompt }]

  const toolCallHistory: ToolCallTracker[] = []
  let iterations = 0
  let finalOutput = ''

  try {
    while (iterations < maxIterations) {
      iterations++

      // Track tool calls from this iteration
      const pendingTools: Map<string, { name: string; input: Record<string, unknown> }> = new Map()
      let textContent = ''

      // Stream from provider - use subagent tool definitions (no task tool)
      for await (const event of provider.stream(messages, systemPrompt, subagentToolDefinitions)) {
        switch (event.type) {
          case 'text_delta':
            textContent += event.delta
            yield { type: 'subagent_progress', taskId: task.id, event: { type: 'text_delta', delta: event.delta } }
            break

          case 'tool_start':
            yield { type: 'subagent_progress', taskId: task.id, event: { type: 'tool_start', id: event.id, name: event.name } }
            pendingTools.set(event.id, { name: event.name, input: {} })
            break

          case 'tool_input_delta':
            yield { type: 'subagent_progress', taskId: task.id, event: { type: 'tool_input_delta', id: event.id, partialJson: event.partialJson } }
            break

          case 'tool_complete':
            const tool = pendingTools.get(event.id)
            if (tool) {
              tool.input = event.input
            }
            break
        }
      }

      // Track assistant message in history
      if (textContent || pendingTools.size > 0) {
        const toolCalls: ToolCall[] = []
        for (const [id, tool] of pendingTools) {
          toolCalls.push({
            id,
            name: tool.name,
            input: tool.input,
            status: 'pending'
          })
        }
        history.push({
          role: 'assistant',
          content: textContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        })
      }

      // If no tools were called, we're done
      if (pendingTools.size === 0) {
        finalOutput = textContent
        break
      }

      // Build assistant message with tool uses
      const assistantContent: ContentBlock[] = []
      if (textContent) {
        assistantContent.push({ type: 'text', text: textContent })
      }
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
          const errorEvent: AgentEvent = {
            type: 'tool_result',
            id,
            output: '',
            error: `Doom loop detected: ${tool.name} called ${DOOM_LOOP_THRESHOLD}+ times with identical arguments.`
          }
          yield { type: 'subagent_progress', taskId: task.id, event: errorEvent }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: Detected repeated identical calls to ${tool.name}. Please try a different approach.`,
            is_error: true
          })

          // Update history
          const historyTool = history[history.length - 1]?.toolCalls?.find(t => t.id === id)
          if (historyTool) {
            historyTool.status = 'error'
            historyTool.error = 'Doom loop detected'
          }
          continue
        }

        yield { type: 'subagent_progress', taskId: task.id, event: { type: 'tool_running', id } }

        try {
          const result = await executeTool(tool.name, tool.input, workingDir)
          const resultEvent: AgentEvent = {
            type: 'tool_result',
            id,
            output: result.output,
            details: result.details
          }
          yield { type: 'subagent_progress', taskId: task.id, event: resultEvent }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: result.output
          })

          // Update history
          const historyTool = history[history.length - 1]?.toolCalls?.find(t => t.id === id)
          if (historyTool) {
            historyTool.status = 'done'
            historyTool.output = result.output
            historyTool.details = result.details
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          const errorEvent: AgentEvent = {
            type: 'tool_result',
            id,
            output: '',
            error: errorMsg
          }
          yield { type: 'subagent_progress', taskId: task.id, event: errorEvent }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: ${errorMsg}`,
            is_error: true
          })

          // Update history
          const historyTool = history[history.length - 1]?.toolCalls?.find(t => t.id === id)
          if (historyTool) {
            historyTool.status = 'error'
            historyTool.error = errorMsg
          }
        }
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults })
    }

    // If we hit max iterations without finishing, emit special event
    if (iterations >= maxIterations && !finalOutput) {
      yield {
        type: 'subagent_max_iterations',
        taskId: task.id,
        iterations: maxIterations,
        fullHistory: history
      }
      return
    }

    yield {
      type: 'subagent_complete',
      taskId: task.id,
      summary: finalOutput,
      fullHistory: history
    }
  } catch (error) {
    yield {
      type: 'subagent_error',
      taskId: task.id,
      error: error instanceof Error ? error.message : 'Unknown error',
      fullHistory: history
    }
  }
}

export interface ContinueSubagentOptions {
  task: SubagentTask
  workingDir: string
  config: SubagentConfig
  existingHistory: Message[]
  parentConfig?: ParentConfig
}

/**
 * Continue a subagent that hit max iterations
 * Resumes from existing history with fresh iteration count
 */
export async function* continueSubagent(
  options: ContinueSubagentOptions
): AsyncGenerator<AgentEvent> {
  const { task, workingDir, config, existingHistory, parentConfig } = options

  // Get role config (with user overrides)
  const roleConfig = config.roles[task.role]
  const providerName = task.provider || parentConfig?.provider || roleConfig.provider
  const model = task.model || parentConfig?.model || roleConfig.model
  const maxIterations = roleConfig.maxIterations

  // Build system prompt
  const projectInstructions = await loadProjectInstructions(workingDir)
  const systemPrompt = projectInstructions
    ? `${SUBAGENT_SYSTEM_PROMPT}\n\n<project_instructions>\n${projectInstructions}\n</project_instructions>`
    : SUBAGENT_SYSTEM_PROMPT

  yield { type: 'subagent_start', taskId: task.id, description: task.description, role: task.role }

  // Get the LLM provider
  const provider = getProvider({
    provider: providerName as ProviderName,
    model: model
  })

  // Convert existing history to ChatMessage format
  const messages: ChatMessage[] = []
  for (const msg of existingHistory) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'assistant') {
      const content: ContentBlock[] = []
      if (msg.content) {
        content.push({ type: 'text', text: msg.content })
      }
      if (msg.toolCalls) {
        for (const tool of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: tool.input
          })
        }
      }
      messages.push({ role: 'assistant', content })

      // Add tool results as user message if tools were called
      if (msg.toolCalls?.length) {
        const toolResults: ContentBlock[] = msg.toolCalls.map(tool => ({
          type: 'tool_result' as const,
          tool_use_id: tool.id,
          content: tool.output || '',
          is_error: tool.status === 'error'
        }))
        messages.push({ role: 'user', content: toolResults })
      }
    }
  }

  // Add a continuation prompt
  messages.push({
    role: 'user',
    content: 'Continue working on the task. You have more iterations available now.'
  })

  // Track history for UI expandable view (start from existing)
  const history: Message[] = [...existingHistory, { role: 'user', content: 'Continue working on the task. You have more iterations available now.' }]

  const toolCallHistory: ToolCallTracker[] = []
  let iterations = 0
  let finalOutput = ''

  try {
    while (iterations < maxIterations) {
      iterations++

      // Track tool calls from this iteration
      const pendingTools: Map<string, { name: string; input: Record<string, unknown> }> = new Map()
      let textContent = ''

      // Stream from provider
      for await (const event of provider.stream(messages, systemPrompt, subagentToolDefinitions)) {
        switch (event.type) {
          case 'text_delta':
            textContent += event.delta
            yield { type: 'subagent_progress', taskId: task.id, event: { type: 'text_delta', delta: event.delta } }
            break

          case 'tool_start':
            yield { type: 'subagent_progress', taskId: task.id, event: { type: 'tool_start', id: event.id, name: event.name } }
            pendingTools.set(event.id, { name: event.name, input: {} })
            break

          case 'tool_input_delta':
            yield { type: 'subagent_progress', taskId: task.id, event: { type: 'tool_input_delta', id: event.id, partialJson: event.partialJson } }
            break

          case 'tool_complete':
            const tool = pendingTools.get(event.id)
            if (tool) {
              tool.input = event.input
            }
            break
        }
      }

      // Track assistant message in history
      if (textContent || pendingTools.size > 0) {
        const toolCalls: ToolCall[] = []
        for (const [id, tool] of pendingTools) {
          toolCalls.push({
            id,
            name: tool.name,
            input: tool.input,
            status: 'pending'
          })
        }
        history.push({
          role: 'assistant',
          content: textContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        })
      }

      // If no tools were called, we're done
      if (pendingTools.size === 0) {
        finalOutput = textContent
        break
      }

      // Build assistant message with tool uses
      const assistantContent: ContentBlock[] = []
      if (textContent) {
        assistantContent.push({ type: 'text', text: textContent })
      }
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
          const errorEvent: AgentEvent = {
            type: 'tool_result',
            id,
            output: '',
            error: `Doom loop detected: ${tool.name} called ${DOOM_LOOP_THRESHOLD}+ times with identical arguments.`
          }
          yield { type: 'subagent_progress', taskId: task.id, event: errorEvent }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: Detected repeated identical calls to ${tool.name}. Please try a different approach.`,
            is_error: true
          })

          // Update history
          const historyTool = history[history.length - 1]?.toolCalls?.find(t => t.id === id)
          if (historyTool) {
            historyTool.status = 'error'
            historyTool.error = 'Doom loop detected'
          }
          continue
        }

        yield { type: 'subagent_progress', taskId: task.id, event: { type: 'tool_running', id } }

        try {
          const result = await executeTool(tool.name, tool.input, workingDir)
          const resultEvent: AgentEvent = {
            type: 'tool_result',
            id,
            output: result.output,
            details: result.details
          }
          yield { type: 'subagent_progress', taskId: task.id, event: resultEvent }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: result.output
          })

          // Update history
          const historyTool = history[history.length - 1]?.toolCalls?.find(t => t.id === id)
          if (historyTool) {
            historyTool.status = 'done'
            historyTool.output = result.output
            historyTool.details = result.details
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          const errorEvent: AgentEvent = {
            type: 'tool_result',
            id,
            output: '',
            error: errorMsg
          }
          yield { type: 'subagent_progress', taskId: task.id, event: errorEvent }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: `Error: ${errorMsg}`,
            is_error: true
          })

          // Update history
          const historyTool = history[history.length - 1]?.toolCalls?.find(t => t.id === id)
          if (historyTool) {
            historyTool.status = 'error'
            historyTool.error = errorMsg
          }
        }
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults })
    }

    // If we hit max iterations without finishing, emit special event
    if (iterations >= maxIterations && !finalOutput) {
      yield {
        type: 'subagent_max_iterations',
        taskId: task.id,
        iterations: maxIterations,
        fullHistory: history
      }
      return
    }

    yield {
      type: 'subagent_complete',
      taskId: task.id,
      summary: finalOutput,
      fullHistory: history
    }
  } catch (error) {
    yield {
      type: 'subagent_error',
      taskId: task.id,
      error: error instanceof Error ? error.message : 'Unknown error',
      fullHistory: history
    }
  }
}

/**
 * Run multiple subagents in parallel
 * Merges their event streams and collects results
 */
export async function* runSubagentsParallel(
  tasks: SubagentTask[],
  workingDir: string,
  config: SubagentConfig,
  parentConfig?: ParentConfig
): AsyncGenerator<AgentEvent> {
  const results: Map<string, { summary: string; fullHistory: Message[] }> = new Map()
  const errors: Map<string, { error: string; fullHistory: Message[] }> = new Map()

  // Create generators for each subagent
  const generators = tasks.map(task => ({
    taskId: task.id,
    gen: runSubagent({ task, workingDir, config, parentConfig })
  }))

  // Process all generators concurrently
  // We'll use a simple round-robin approach to yield events
  const pending = new Set(generators.map(g => g.taskId))

  while (pending.size > 0) {
    // Process one event from each active generator
    const iterPromises = generators
      .filter(g => pending.has(g.taskId))
      .map(async ({ taskId, gen }) => {
        const result = await gen.next()
        return { taskId, result }
      })

    // Wait for all current iterations
    const iterations = await Promise.all(iterPromises)

    for (const { taskId, result } of iterations) {
      if (result.done) {
        pending.delete(taskId)
        continue
      }

      const event = result.value
      yield event

      // Track completion/error for final aggregation
      if (event.type === 'subagent_complete') {
        results.set(event.taskId, {
          summary: event.summary,
          fullHistory: event.fullHistory
        })
      } else if (event.type === 'subagent_error') {
        errors.set(event.taskId, {
          error: event.error,
          fullHistory: event.fullHistory
        })
      }
    }
  }
}
