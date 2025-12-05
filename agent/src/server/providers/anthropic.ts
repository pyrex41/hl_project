import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, ProviderEvent, ChatMessage, ToolDefinition, ContentBlock, ModelInfo } from './types'

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic' as const
  private client: Anthropic
  private model: string

  constructor(apiKey?: string, model?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY
    })
    this.model = model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-5-20250514'
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list()
      return response.data.map(m => ({
        id: m.id,
        name: m.display_name || m.id,
        created: m.created_at ? new Date(m.created_at).getTime() / 1000 : undefined
      }))
    } catch (error) {
      console.error('Failed to list Anthropic models:', error)
      // Return known models as fallback (best/latest first)
      return [
        { id: 'claude-opus-4-5-20250514', name: 'Claude Opus 4.5' },
        { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
        { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5' },
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
      ]
    }
  }

  async *stream(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[]
  ): AsyncGenerator<ProviderEvent> {
    // Convert to Anthropic format
    const anthropicMessages = this.convertMessages(messages)
    const anthropicTools = this.convertTools(tools)

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      tools: anthropicTools,
      messages: anthropicMessages,
    })

    let currentToolId: string | null = null
    let currentToolName: string | null = null
    let currentToolInput = ''
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage?.input_tokens || 0
      }

      if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens || 0
      }

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolId = event.content_block.id
          currentToolName = event.content_block.name
          currentToolInput = ''
          yield { type: 'tool_start', id: currentToolId, name: currentToolName }
        }
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', delta: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          currentToolInput += event.delta.partial_json
          if (currentToolId) {
            yield { type: 'tool_input_delta', id: currentToolId, partialJson: currentToolInput }
          }
        }
      }

      if (event.type === 'content_block_stop') {
        if (currentToolId && currentToolName) {
          yield {
            type: 'tool_complete',
            id: currentToolId,
            name: currentToolName,
            input: JSON.parse(currentToolInput || '{}')
          }
          currentToolId = null
          currentToolName = null
          currentToolInput = ''
        }
      }
    }

    yield { type: 'message_complete', usage: { inputTokens, outputTokens } }
  }

  private convertMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    return messages.map(msg => {
      if (typeof msg.content === 'string') {
        return { role: msg.role as 'user' | 'assistant', content: msg.content }
      }

      // Convert content blocks
      const content: Anthropic.ContentBlockParam[] = msg.content.map(block => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text }
        } else if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input
          }
        } else if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error
          }
        }
        throw new Error(`Unknown block type: ${(block as ContentBlock).type}`)
      })

      return { role: msg.role as 'user' | 'assistant', content }
    })
  }

  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.parameters.properties,
        required: tool.parameters.required
      }
    }))
  }
}
