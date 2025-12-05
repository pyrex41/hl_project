import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { exists } from './tools'
import type { ProviderName } from './providers/types'

// Main chat configuration
export interface MainChatConfig {
  provider: ProviderName
  model: string
}

// Subagent role types
export type SubagentRole = 'simple' | 'complex' | 'researcher'

// Role-specific configuration
export interface RoleConfig {
  provider: ProviderName
  model: string
  maxIterations: number
}

// Subagent configuration
export interface SubagentConfig {
  // When to confirm with user: always, never, or only when multiple agents
  confirmMode: 'always' | 'never' | 'multiple'

  // Default timeout per subagent (seconds)
  timeout: number

  // Max concurrent subagents
  maxConcurrent: number

  // Role-specific defaults
  roles: Record<SubagentRole, RoleConfig>
}

// Full agent configuration (main chat + subagents)
export interface AgentConfig {
  // Main chat defaults
  mainChat?: MainChatConfig

  // Subagent settings
  subagents: SubagentConfig
}

// Default subagent configuration
export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  confirmMode: 'always',
  timeout: 120,
  maxConcurrent: 5,
  roles: {
    simple: {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      maxIterations: 10
    },
    complex: {
      provider: 'anthropic',
      model: 'claude-opus-4-5-20251101',
      maxIterations: 25
    },
    researcher: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250514',
      maxIterations: 15
    }
  }
}

// Default full configuration
export const DEFAULT_CONFIG: AgentConfig = {
  mainChat: undefined, // Will use first available provider
  subagents: DEFAULT_SUBAGENT_CONFIG
}

// Config file path relative to working directory
const CONFIG_PATH = '.agent/config.json'

/**
 * Load full configuration from the working directory
 * Falls back to defaults if not present
 */
export async function loadFullConfig(workingDir: string): Promise<AgentConfig> {
  const configPath = join(workingDir, CONFIG_PATH)

  try {
    if (await exists(configPath)) {
      const content = await readFile(configPath, 'utf-8')
      const loaded = JSON.parse(content)

      // Handle legacy format (flat subagent config) or new format
      if (loaded.subagents) {
        // New format with mainChat and subagents
        return mergeFullConfig(DEFAULT_CONFIG, loaded)
      } else if (loaded.roles) {
        // Legacy format - just subagent config at root
        return {
          mainChat: undefined,
          subagents: mergeSubagentConfig(DEFAULT_SUBAGENT_CONFIG, loaded)
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to load config from ${configPath}:`, error)
  }

  return { ...DEFAULT_CONFIG, subagents: { ...DEFAULT_SUBAGENT_CONFIG } }
}

/**
 * Load just subagent configuration (for backward compatibility)
 */
export async function loadConfig(workingDir: string): Promise<SubagentConfig> {
  const full = await loadFullConfig(workingDir)
  return full.subagents
}

/**
 * Save full configuration to the working directory
 */
export async function saveFullConfig(workingDir: string, config: AgentConfig): Promise<void> {
  const configPath = join(workingDir, CONFIG_PATH)

  // Ensure directory exists
  await mkdir(dirname(configPath), { recursive: true })

  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * Save just subagent configuration (for backward compatibility)
 */
export async function saveConfig(workingDir: string, config: SubagentConfig): Promise<void> {
  const existing = await loadFullConfig(workingDir)
  existing.subagents = config
  await saveFullConfig(workingDir, existing)
}

/**
 * Deep merge full configuration with defaults
 */
function mergeFullConfig(defaults: AgentConfig, loaded: Partial<AgentConfig>): AgentConfig {
  return {
    mainChat: loaded.mainChat ?? defaults.mainChat,
    subagents: mergeSubagentConfig(defaults.subagents, loaded.subagents || {})
  }
}

/**
 * Deep merge subagent configuration with defaults
 */
function mergeSubagentConfig(defaults: SubagentConfig, loaded: Partial<SubagentConfig>): SubagentConfig {
  return {
    confirmMode: loaded.confirmMode ?? defaults.confirmMode,
    timeout: loaded.timeout ?? defaults.timeout,
    maxConcurrent: loaded.maxConcurrent ?? defaults.maxConcurrent,
    roles: {
      simple: { ...defaults.roles.simple, ...loaded.roles?.simple },
      complex: { ...defaults.roles.complex, ...loaded.roles?.complex },
      researcher: { ...defaults.roles.researcher, ...loaded.roles?.researcher }
    }
  }
}

/**
 * Get configuration for a specific role
 */
export function getRoleConfig(config: SubagentConfig, role: SubagentRole): RoleConfig {
  return config.roles[role]
}

/**
 * Check if confirmation is needed based on config and task count
 */
export function needsConfirmation(config: SubagentConfig, taskCount: number): boolean {
  switch (config.confirmMode) {
    case 'always':
      return true
    case 'never':
      return false
    case 'multiple':
      return taskCount > 1
  }
}
