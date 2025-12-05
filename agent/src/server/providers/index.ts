import { AnthropicProvider } from './anthropic'
import { createXAIProvider, createOpenAIProvider, OpenAICompatibleProvider } from './openai-compatible'
import type { LLMProvider, ProviderName, ProviderConfig, ToolDefinition, ModelInfo } from './types'
export * from './types'

// Provider registry
const providers: Map<string, LLMProvider> = new Map()

// Get or create a provider instance
export function getProvider(config?: Partial<ProviderConfig>): LLMProvider {
  const providerName = config?.provider || detectProvider()

  if (!providerName) {
    throw new Error(
      'No LLM provider configured. Set one of: ANTHROPIC_API_KEY, XAI_API_KEY, or OPENAI_API_KEY'
    )
  }

  // Create cache key including model
  const model = config?.model || getDefaultModel(providerName)
  const cacheKey = `${providerName}:${model}`

  // Return cached provider if available
  if (providers.has(cacheKey)) {
    return providers.get(cacheKey)!
  }

  // Create new provider
  const provider = createProvider(providerName, config?.apiKey, model)
  providers.set(cacheKey, provider)
  return provider
}

// Detect which provider to use based on environment
function detectProvider(): ProviderName | null {
  // Check for explicit preference
  const preferred = process.env.LLM_PROVIDER?.toLowerCase() as ProviderName | undefined
  if (preferred && isValidProvider(preferred)) {
    return preferred
  }

  // Fall back to first available
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.XAI_API_KEY) return 'xai'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return null
}

function isValidProvider(name: string): name is ProviderName {
  return ['anthropic', 'xai', 'openai'].includes(name)
}

function getDefaultModel(provider: ProviderName): string {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250514'
    case 'xai':
      return process.env.XAI_MODEL || 'grok-4-0125'
    case 'openai':
      return process.env.OPENAI_MODEL || 'gpt-4.1'
  }
}

function createProvider(name: ProviderName, apiKey?: string, model?: string): LLMProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, model)
    case 'xai':
      return createXAIProvider(apiKey, model)
    case 'openai':
      return createOpenAIProvider(apiKey, model)
    default:
      throw new Error(`Unknown provider: ${name}`)
  }
}

// Export tool definitions in provider-agnostic format
export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read file contents. Supports offset/limit for large files. Returns error with directory listing if file not found.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Max lines to read (default: 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file. Creates parent directories automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in a file. oldText must match exactly (including whitespace).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        oldText: { type: 'string', description: 'Text to find (exact match required)' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command. Returns stdout/stderr. Use for ls, grep, find, git, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['command'],
    },
  },
]

// List available providers based on environment
export function listAvailableProviders(): { provider: ProviderName; defaultModel: string }[] {
  const available: { provider: ProviderName; defaultModel: string }[] = []

  if (process.env.ANTHROPIC_API_KEY) {
    available.push({ provider: 'anthropic', defaultModel: getDefaultModel('anthropic') })
  }
  if (process.env.XAI_API_KEY) {
    available.push({ provider: 'xai', defaultModel: getDefaultModel('xai') })
  }
  if (process.env.OPENAI_API_KEY) {
    available.push({ provider: 'openai', defaultModel: getDefaultModel('openai') })
  }

  return available
}

// List models for a specific provider
export async function listModelsForProvider(providerName: ProviderName): Promise<ModelInfo[]> {
  const provider = getProvider({ provider: providerName })
  return provider.listModels()
}
