// Unified types for multi-provider support

export type ProviderName = 'anthropic' | 'xai' | 'openai'

export interface ProviderConfig {
  provider: ProviderName
  model: string
  apiKey?: string  // Optional - falls back to env vars
}

// Supported providers and their default models (best/latest)
export const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; envKey: string }> = {
  anthropic: {
    model: 'claude-sonnet-4-5-20250514',
    envKey: 'ANTHROPIC_API_KEY'
  },
  xai: {
    model: 'grok-4-0125',
    envKey: 'XAI_API_KEY'
  },
  openai: {
    model: 'gpt-4.1',
    envKey: 'OPENAI_API_KEY'
  }
}

// Tool definition in a provider-agnostic format
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

// Streaming events from providers (normalized)
export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_complete'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_complete'; usage: { inputTokens: number; outputTokens: number } }

// Message format (provider-agnostic)
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

// Model info returned by providers
export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
  created?: number
}

// Provider interface - all providers must implement this
export interface LLMProvider {
  name: ProviderName

  // Stream a completion with tool support
  stream(
    messages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[]
  ): AsyncGenerator<ProviderEvent>

  // List available models from the provider API
  listModels(): Promise<ModelInfo[]>
}

// Helper to detect which provider is available
export function getAvailableProvider(): ProviderName | null {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.XAI_API_KEY) return 'xai'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return null
}

// Helper to get API key for a provider
export function getApiKey(provider: ProviderName): string | undefined {
  const envKey = PROVIDER_DEFAULTS[provider]?.envKey
  return envKey ? process.env[envKey] : undefined
}
