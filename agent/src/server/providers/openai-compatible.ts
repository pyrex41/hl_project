import OpenAI from 'openai'
import type { LLMProvider, ProviderEvent, ChatMessage, ToolDefinition, ProviderName, ContentBlock, ModelInfo } from './types'

// Works with xAI, OpenAI, and any OpenAI-compatible API
export class OpenAICompatibleProvider implements LLMProvider {
  name: ProviderName
  private client: OpenAI
  private model: string
  private baseURL?: string

  constructor(config: {
    name: ProviderName
    apiKey: string
    baseURL?: string
    model: string
  }) {
    this.name = config.name
    this.model = config.model
    this.baseURL = config.baseURL
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list()
      const models: ModelInfo[] = []
      for await (const model of response) {
        models.push({
          id: model.id,
          name: model.id,
          created: model.created
        })
      }
      // Sort by created date, newest first
      return models.sort((a, b) => (b.created || 0) - (a.created || 0))
    } catch (error) {
      console.error(`Failed to list ${this.name} models:`, error)
      // Return known models as fallback based on provider
      return this.getFallbackModels()
    }
  }

  private getFallbackModels(): ModelInfo[] {
    switch (this.name) {
      case 'xai':
        return [
          { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning' },
          { id: 'grok-4-1-fast', name: 'Grok 4.1 Fast' },
          { id: 'grok-4-0125', name: 'Grok 4' },
          { id: 'grok-3-beta', name: 'Grok 3 Beta' },
        ]
      case 'openai':
        return [
          { id: 'gpt-5.1-max-high', name: 'GPT-5.1 Max High' },
          { id: 'gpt-5.1', name: 'GPT-5.1' },
          { id: 'gpt-4.1', name: 'GPT-4.1' },
          { id: 'o3', name: 'o3' },
        ]
      default:
        return [{ id: this.model, name: this.model }]
    }
  }

  async *stream(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[]
  ): AsyncGenerator<ProviderEvent> {
    // Convert to OpenAI format
    const openaiMessages = this.convertMessages(messages, systemPrompt)
    const openaiTools = this.convertTools(tools)

    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
      stream_options: { include_usage: true },
    })

    // Track tool calls being built
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
    let inputTokens = 0
    let outputTokens = 0

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue

      const delta = choice.delta

      // Track usage if available
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0
        outputTokens = chunk.usage.completion_tokens || 0
      }

      // Text content
      if (delta.content) {
        yield { type: 'text_delta', delta: delta.content }
      }

      // Reasoning content (xAI Grok 3 models, some future models)
      // @ts-expect-error - reasoning_content is not in the official types yet
      if (delta.reasoning_content) {
        // @ts-expect-error
        yield { type: 'text_delta', delta: `[Thinking] ${delta.reasoning_content}` }
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index

          if (!toolCalls.has(index)) {
            // New tool call starting
            const id = toolCall.id || `tool_${index}_${Date.now()}`
            const name = toolCall.function?.name || ''
            toolCalls.set(index, { id, name, arguments: '' })

            if (name) {
              yield { type: 'tool_start', id, name }
            }
          }

          const tc = toolCalls.get(index)!

          // Update name if we get it
          if (toolCall.function?.name && !tc.name) {
            tc.name = toolCall.function.name
            yield { type: 'tool_start', id: tc.id, name: tc.name }
          }

          // Accumulate arguments
          if (toolCall.function?.arguments) {
            tc.arguments += toolCall.function.arguments
            yield { type: 'tool_input_delta', id: tc.id, partialJson: tc.arguments }
          }
        }
      }

      // Check if we're done
      if (choice.finish_reason) {
        // Emit tool_complete for all accumulated tool calls
        for (const [_, tc] of toolCalls) {
          if (tc.name) {
            try {
              const input = JSON.parse(tc.arguments || '{}')
              yield { type: 'tool_complete', id: tc.id, name: tc.name, input }
            } catch {
              yield { type: 'tool_complete', id: tc.id, name: tc.name, input: {} }
            }
          }
        }
      }
    }

    yield { type: 'message_complete', usage: { inputTokens, outputTokens } }
  }

  private convertMessages(messages: ChatMessage[], systemPrompt: string): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt }
    ]

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({
          role: msg.role === 'tool' ? 'tool' : msg.role,
          content: msg.content
        } as OpenAI.ChatCompletionMessageParam)
        continue
      }

      // Handle content blocks
      if (msg.role === 'assistant') {
        // Check for tool calls
        const toolUses = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use'
        )
        const textBlocks = msg.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> =>
          b.type === 'text'
        )

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textBlocks.map(b => b.text).join('\n') || null
        }

        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map(tu => ({
            id: tu.id,
            type: 'function' as const,
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input)
            }
          }))
        }

        result.push(assistantMsg)
      } else if (msg.role === 'user') {
        // Check for tool results
        const toolResults = msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
          b.type === 'tool_result'
        )

        if (toolResults.length > 0) {
          // Add each tool result as a separate message
          for (const tr of toolResults) {
            result.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: tr.content
            })
          }
        } else {
          // Regular user message with text
          const textBlocks = msg.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> =>
            b.type === 'text'
          )
          result.push({
            role: 'user',
            content: textBlocks.map(b => b.text).join('\n')
          })
        }
      }
    }

    return result
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties: tool.parameters.properties,
          required: tool.parameters.required
        }
      }
    }))
  }
}

// Factory functions for specific providers
export function createXAIProvider(apiKey?: string, model?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: 'xai',
    apiKey: apiKey || process.env.XAI_API_KEY || '',
    baseURL: 'https://api.x.ai/v1',
    model: model || process.env.XAI_MODEL || 'grok-4-1-fast-reasoning'
  })
}

export function createOpenAIProvider(apiKey?: string, model?: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: 'openai',
    apiKey: apiKey || process.env.OPENAI_API_KEY || '',
    model: model || process.env.OPENAI_MODEL || 'gpt-5.1-max-high'
  })
}
