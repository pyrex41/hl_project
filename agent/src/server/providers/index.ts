import { AnthropicProvider } from './anthropic'
import { createXAIProvider, createOpenAIProvider, OpenAICompatibleProvider } from './openai-compatible'
import type { LLMProvider, ProviderName, ProviderConfig, ToolDefinition, ModelInfo } from './types'
import { getMCPToolDefinitions } from '../mcp/tools'
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
      return process.env.ANTHROPIC_MODEL || 'claude-opus-4-5-20251101'
    case 'xai':
      return process.env.XAI_MODEL || 'grok-4-1-fast-reasoning'
    case 'openai':
      return process.env.OPENAI_MODEL || 'gpt-5.1-max-high'
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
  {
    name: 'task',
    description: `Spawn subagent(s) to handle tasks in parallel. Use for:
- Parallel work that doesn't depend on each other
- Delegating research or exploration
- Complex subtasks that need focused attention

Role selection guide:
- simple: Quick, straightforward tasks (file reads, simple edits, commands)
- complex: Multi-step tasks requiring reasoning and iteration
- researcher: Exploring codebases, finding patterns, gathering information

Multiple tasks execute in parallel. Results are returned when all complete.`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'List of tasks to spawn as subagents',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'What the subagent should accomplish'
              },
              role: {
                type: 'string',
                enum: ['simple', 'complex', 'researcher'],
                description: 'Task complexity/type for model selection'
              },
              context: {
                type: 'string',
                description: 'Optional additional context for the subagent'
              }
            },
            required: ['description', 'role']
          }
        }
      },
      required: ['tasks'],
    },
  },
  {
    name: 'scud',
    description: `Manage SCUD tasks (task graph system for tracking work).

Actions:
- list: List tasks. Optional: status (pending|in-progress|done|blocked), tag
- show: Show task details. Required: id. Optional: tag
- set-status: Update task status. Required: id, status. Optional: tag
- next: Find next available task. Optional: tag, claim (boolean), name (for claiming)
- stats: Show completion statistics. Optional: tag
- parse-prd: Parse PRD file into tasks. Required: file, tag
- expand: Expand complex task into subtasks. Optional: id (specific task), all (expand all >=13 points), tag

Examples:
- List pending tasks: action="list" status="pending"
- Show task 3: action="show" id="3"
- Start task: action="set-status" id="3" status="in-progress"
- Complete task: action="set-status" id="3" status="done"
- Get next task: action="next"
- Parse PRD: action="parse-prd" file="epic.md" tag="epic-1"
- Expand task: action="expand" id="5"`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'show', 'set-status', 'next', 'stats', 'parse-prd', 'expand'],
          description: 'The SCUD action to perform'
        },
        id: {
          type: 'string',
          description: 'Task ID (for show, set-status, expand)'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in-progress', 'done', 'blocked', 'review', 'deferred', 'cancelled'],
          description: 'Task status (for set-status) or filter (for list)'
        },
        tag: {
          type: 'string',
          description: 'Tag/epic name to operate on'
        },
        name: {
          type: 'string',
          description: 'Agent name for claiming tasks'
        },
        claim: {
          type: 'boolean',
          description: 'Auto-claim when using next action'
        },
        file: {
          type: 'string',
          description: 'File path (for parse-prd)'
        },
        all: {
          type: 'boolean',
          description: 'Expand all complex tasks (for expand)'
        }
      },
      required: ['action']
    },
  },
]

// Tool definitions without the task tool (for subagents to prevent nesting)
export const subagentToolDefinitions: ToolDefinition[] = toolDefinitions.filter(t => t.name !== 'task')

/**
 * Get all tool definitions including MCP tools
 * This is called dynamically to include tools from connected MCP servers
 */
export function getAllToolDefinitions(includeTask: boolean = true): ToolDefinition[] {
  const baseTols = includeTask ? toolDefinitions : subagentToolDefinitions
  const mcpTools = getMCPToolDefinitions()
  return [...baseTols, ...mcpTools]
}

/**
 * Get subagent tool definitions including MCP tools
 */
export function getSubagentToolDefinitions(): ToolDefinition[] {
  const mcpTools = getMCPToolDefinitions()
  return [...subagentToolDefinitions, ...mcpTools]
}

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
