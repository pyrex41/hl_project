/**
 * MCP Configuration Management
 *
 * Handles loading, saving, and merging MCP configuration.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { exists } from '../tools'
import type { MCPConfig, MCPServerConfig } from './types'
import { DEFAULT_MCP_CONFIG } from './types'

// Config file path relative to working directory
const MCP_CONFIG_PATH = '.agent/mcp.json'

/**
 * Load MCP configuration from the working directory
 * Falls back to defaults if not present
 */
export async function loadMCPConfig(workingDir: string): Promise<MCPConfig> {
  const configPath = join(workingDir, MCP_CONFIG_PATH)

  try {
    if (await exists(configPath)) {
      const content = await readFile(configPath, 'utf-8')
      const loaded = JSON.parse(content) as Partial<MCPConfig>
      return mergeMCPConfig(DEFAULT_MCP_CONFIG, loaded)
    }
  } catch (error) {
    console.warn(`Failed to load MCP config from ${configPath}:`, error)
  }

  return { ...DEFAULT_MCP_CONFIG }
}

/**
 * Save MCP configuration to the working directory
 */
export async function saveMCPConfig(workingDir: string, config: MCPConfig): Promise<void> {
  const configPath = join(workingDir, MCP_CONFIG_PATH)

  // Ensure directory exists
  await mkdir(dirname(configPath), { recursive: true })

  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * Deep merge MCP configuration with defaults
 */
export function mergeMCPConfig(defaults: MCPConfig, loaded: Partial<MCPConfig>): MCPConfig {
  return {
    servers: loaded.servers || defaults.servers,
    settings: {
      ...defaults.settings,
      ...loaded.settings
    }
  }
}

/**
 * Add a server to the configuration
 */
export function addServerConfig(config: MCPConfig, server: MCPServerConfig): MCPConfig {
  // Remove existing server with same ID if present
  const servers = config.servers.filter(s => s.id !== server.id)
  servers.push(server)

  return {
    ...config,
    servers
  }
}

/**
 * Remove a server from the configuration
 */
export function removeServerConfig(config: MCPConfig, serverId: string): MCPConfig {
  return {
    ...config,
    servers: config.servers.filter(s => s.id !== serverId)
  }
}

/**
 * Update a server in the configuration
 */
export function updateServerConfig(
  config: MCPConfig,
  serverId: string,
  updates: Partial<MCPServerConfig>
): MCPConfig {
  return {
    ...config,
    servers: config.servers.map(s =>
      s.id === serverId ? { ...s, ...updates } : s
    )
  }
}

/**
 * Validate server configuration
 */
export function validateServerConfig(server: MCPServerConfig): string[] {
  const errors: string[] = []

  if (!server.id) {
    errors.push('Server ID is required')
  }

  if (!server.name) {
    errors.push('Server name is required')
  }

  if (!['stdio', 'sse', 'streamable-http'].includes(server.transport)) {
    errors.push(`Invalid transport type: ${server.transport}`)
  }

  if (server.transport === 'stdio' && !server.command) {
    errors.push('stdio transport requires a command')
  }

  if ((server.transport === 'sse' || server.transport === 'streamable-http') && !server.url) {
    errors.push(`${server.transport} transport requires a URL`)
  }

  if (server.url) {
    try {
      new URL(server.url)
    } catch {
      errors.push(`Invalid URL: ${server.url}`)
    }
  }

  return errors
}

/**
 * Create a server config from common patterns
 */
export function createServerConfig(options: {
  id: string
  name: string
  // For npm package MCP servers
  npmPackage?: string
  // For local command
  command?: string
  args?: string[]
  // For remote servers
  url?: string
  transport?: 'stdio' | 'sse' | 'streamable-http'
}): MCPServerConfig {
  // NPM package pattern: npx -y <package>
  if (options.npmPackage) {
    return {
      id: options.id,
      name: options.name,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', options.npmPackage, ...(options.args || [])],
      enabled: true,
      autoConnect: true
    }
  }

  // Local command pattern
  if (options.command) {
    return {
      id: options.id,
      name: options.name,
      transport: 'stdio',
      command: options.command,
      args: options.args || [],
      enabled: true,
      autoConnect: true
    }
  }

  // Remote server pattern
  if (options.url) {
    return {
      id: options.id,
      name: options.name,
      transport: options.transport || 'streamable-http',
      url: options.url,
      enabled: true,
      autoConnect: true
    }
  }

  throw new Error('Must provide npmPackage, command, or url')
}
