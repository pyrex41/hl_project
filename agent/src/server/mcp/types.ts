/**
 * MCP (Model Context Protocol) Types
 *
 * Types for MCP server configuration, tool/prompt discovery, and integration.
 */

import type { ToolDefinition } from '../providers/types'

// MCP Server configuration
export interface MCPServerConfig {
  // Unique identifier for this server
  id: string

  // Human-readable name
  name: string

  // Transport type
  transport: 'stdio' | 'sse' | 'streamable-http'

  // For stdio transport: command to spawn
  command?: string
  args?: string[]
  env?: Record<string, string>

  // For HTTP-based transports: URL
  url?: string

  // Optional: headers for HTTP transports
  headers?: Record<string, string>

  // Whether this server is enabled
  enabled: boolean

  // Auto-connect on startup
  autoConnect?: boolean

  // Timeout for operations (ms)
  timeout?: number
}

// MCP Server status
export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Runtime MCP server state
export interface MCPServerState {
  config: MCPServerConfig
  status: MCPServerStatus
  error?: string

  // Discovered capabilities
  tools: MCPTool[]
  prompts: MCPPrompt[]
  resources: MCPResource[]

  // Connection metadata
  serverInfo?: {
    name: string
    version: string
    protocolVersion?: string
  }

  lastConnected?: string
  lastError?: string
}

// MCP Tool (discovered from server)
export interface MCPTool {
  // Tool name (as exposed by MCP server)
  name: string

  // Description
  description?: string

  // JSON Schema for input parameters
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }

  // Server this tool belongs to
  serverId: string
}

// MCP Prompt (user-facing command)
export interface MCPPrompt {
  // Prompt name
  name: string

  // Description for users
  description?: string

  // Arguments the prompt accepts
  arguments?: MCPPromptArgument[]

  // Server this prompt belongs to
  serverId: string
}

export interface MCPPromptArgument {
  name: string
  description?: string
  required?: boolean
}

// MCP Resource (exposed data/content)
export interface MCPResource {
  // Resource URI
  uri: string

  // Human-readable name
  name: string

  // Description
  description?: string

  // MIME type
  mimeType?: string

  // Server this resource belongs to
  serverId: string
}

// MCP Tool call result
export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
    uri?: string
  }>
  isError?: boolean
}

// MCP Prompt result
export interface MCPPromptResult {
  description?: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: {
      type: 'text' | 'image' | 'resource'
      text?: string
      data?: string
      mimeType?: string
      uri?: string
    }
  }>
}

// Full MCP configuration (stored in config file)
export interface MCPConfig {
  // List of configured servers
  servers: MCPServerConfig[]

  // Global settings
  settings?: {
    // Default timeout for all servers (ms)
    defaultTimeout?: number

    // Whether to show MCP tools in UI by default
    showToolsInUI?: boolean

    // Prefix for MCP tool names (to avoid conflicts)
    toolPrefix?: string
  }
}

// Default MCP configuration
export const DEFAULT_MCP_CONFIG: MCPConfig = {
  servers: [],
  settings: {
    defaultTimeout: 30000,
    showToolsInUI: true,
    toolPrefix: 'mcp_'
  }
}

// Convert MCP tool to provider-agnostic tool definition
export function mcpToolToDefinition(tool: MCPTool, prefix: string = 'mcp_'): ToolDefinition {
  return {
    name: `${prefix}${tool.serverId}_${tool.name}`,
    description: `[MCP: ${tool.serverId}] ${tool.description || tool.name}`,
    parameters: {
      type: 'object',
      properties: tool.inputSchema.properties || {},
      required: tool.inputSchema.required || []
    }
  }
}

// Parse MCP tool name back to server ID and tool name
export function parseMCPToolName(fullName: string, prefix: string = 'mcp_'): { serverId: string; toolName: string } | null {
  if (!fullName.startsWith(prefix)) {
    return null
  }

  const withoutPrefix = fullName.slice(prefix.length)
  const underscoreIndex = withoutPrefix.indexOf('_')

  if (underscoreIndex === -1) {
    return null
  }

  return {
    serverId: withoutPrefix.slice(0, underscoreIndex),
    toolName: withoutPrefix.slice(underscoreIndex + 1)
  }
}
