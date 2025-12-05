/**
 * MCP Client Manager
 *
 * Manages connections to MCP servers, tool discovery, and tool execution.
 * Uses the official @modelcontextprotocol/sdk for protocol implementation.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  MCPServerConfig,
  MCPServerState,
  MCPTool,
  MCPPrompt,
  MCPResource,
  MCPToolResult,
  MCPPromptResult,
  MCPConfig
} from './types'
import { DEFAULT_MCP_CONFIG } from './types'

// Event types for MCP status changes
export type MCPEvent =
  | { type: 'server_connecting'; serverId: string }
  | { type: 'server_connected'; serverId: string; serverInfo?: MCPServerState['serverInfo'] }
  | { type: 'server_disconnected'; serverId: string }
  | { type: 'server_error'; serverId: string; error: string }
  | { type: 'tools_discovered'; serverId: string; tools: MCPTool[] }
  | { type: 'prompts_discovered'; serverId: string; prompts: MCPPrompt[] }
  | { type: 'resources_discovered'; serverId: string; resources: MCPResource[] }

type EventCallback = (event: MCPEvent) => void

/**
 * MCP Client Manager
 *
 * Singleton that manages all MCP server connections and provides
 * unified access to tools, prompts, and resources.
 */
export class MCPClientManager {
  private clients: Map<string, Client> = new Map()
  private transports: Map<string, StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport> = new Map()
  private serverStates: Map<string, MCPServerState> = new Map()
  private config: MCPConfig = DEFAULT_MCP_CONFIG
  private eventListeners: Set<EventCallback> = new Set()

  /**
   * Initialize the MCP client manager with configuration
   */
  async initialize(config: MCPConfig): Promise<void> {
    this.config = config

    // Auto-connect to enabled servers
    for (const serverConfig of config.servers) {
      if (serverConfig.enabled && serverConfig.autoConnect !== false) {
        try {
          await this.connect(serverConfig.id)
        } catch (error) {
          console.error(`Failed to auto-connect to MCP server ${serverConfig.id}:`, error)
        }
      }
    }
  }

  /**
   * Add event listener for MCP events
   */
  addEventListener(callback: EventCallback): () => void {
    this.eventListeners.add(callback)
    return () => this.eventListeners.delete(callback)
  }

  private emit(event: MCPEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Error in MCP event listener:', error)
      }
    }
  }

  /**
   * Get server configuration by ID
   */
  getServerConfig(serverId: string): MCPServerConfig | undefined {
    return this.config.servers.find(s => s.id === serverId)
  }

  /**
   * Get all server states
   */
  getAllServerStates(): MCPServerState[] {
    return Array.from(this.serverStates.values())
  }

  /**
   * Get server state by ID
   */
  getServerState(serverId: string): MCPServerState | undefined {
    return this.serverStates.get(serverId)
  }

  /**
   * Connect to an MCP server
   */
  async connect(serverId: string): Promise<void> {
    const serverConfig = this.getServerConfig(serverId)
    if (!serverConfig) {
      throw new Error(`MCP server not found: ${serverId}`)
    }

    // Initialize state
    const state: MCPServerState = {
      config: serverConfig,
      status: 'connecting',
      tools: [],
      prompts: [],
      resources: []
    }
    this.serverStates.set(serverId, state)
    this.emit({ type: 'server_connecting', serverId })

    try {
      // Create transport based on type
      const transport = await this.createTransport(serverConfig)
      this.transports.set(serverId, transport)

      // Create client
      const client = new Client(
        {
          name: 'hl-agent',
          version: '1.0.0'
        },
        {
          capabilities: {}
        }
      )

      // Connect
      await client.connect(transport)
      this.clients.set(serverId, client)

      // Get server info
      const serverInfo = client.getServerVersion()
      state.serverInfo = serverInfo ? {
        name: serverInfo.name,
        version: serverInfo.version,
        protocolVersion: (serverInfo as { protocolVersion?: string }).protocolVersion
      } : undefined

      state.status = 'connected'
      state.lastConnected = new Date().toISOString()
      this.emit({ type: 'server_connected', serverId, serverInfo: state.serverInfo })

      // Discover capabilities
      await this.discoverCapabilities(serverId)

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      state.status = 'error'
      state.error = errorMsg
      state.lastError = new Date().toISOString()
      this.emit({ type: 'server_error', serverId, error: errorMsg })
      throw error
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    const transport = this.transports.get(serverId)

    if (client) {
      try {
        await client.close()
      } catch (error) {
        console.error(`Error closing MCP client ${serverId}:`, error)
      }
      this.clients.delete(serverId)
    }

    if (transport) {
      try {
        await transport.close()
      } catch (error) {
        console.error(`Error closing MCP transport ${serverId}:`, error)
      }
      this.transports.delete(serverId)
    }

    const state = this.serverStates.get(serverId)
    if (state) {
      state.status = 'disconnected'
      state.tools = []
      state.prompts = []
      state.resources = []
    }

    this.emit({ type: 'server_disconnected', serverId })
  }

  /**
   * Reconnect to an MCP server
   */
  async reconnect(serverId: string): Promise<void> {
    await this.disconnect(serverId)
    await this.connect(serverId)
  }

  /**
   * Create transport based on server config
   */
  private async createTransport(
    config: MCPServerConfig
  ): Promise<StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport> {
    const timeout = config.timeout || this.config.settings?.defaultTimeout || 30000

    switch (config.transport) {
      case 'stdio':
        if (!config.command) {
          throw new Error('stdio transport requires command')
        }
        return new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined
        })

      case 'sse':
        if (!config.url) {
          throw new Error('sse transport requires url')
        }
        return new SSEClientTransport(new URL(config.url))

      case 'streamable-http':
        if (!config.url) {
          throw new Error('streamable-http transport requires url')
        }
        return new StreamableHTTPClientTransport(new URL(config.url))

      default:
        throw new Error(`Unknown transport type: ${config.transport}`)
    }
  }

  /**
   * Discover tools, prompts, and resources from a connected server
   */
  private async discoverCapabilities(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    const state = this.serverStates.get(serverId)

    if (!client || !state) {
      throw new Error(`Server not connected: ${serverId}`)
    }

    // Discover tools
    try {
      const toolsResult = await client.listTools()
      state.tools = toolsResult.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as MCPTool['inputSchema'],
        serverId
      }))
      this.emit({ type: 'tools_discovered', serverId, tools: state.tools })
    } catch (error) {
      console.error(`Failed to list tools from ${serverId}:`, error)
    }

    // Discover prompts
    try {
      const promptsResult = await client.listPrompts()
      state.prompts = promptsResult.prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map(arg => ({
          name: arg.name,
          description: arg.description,
          required: arg.required
        })),
        serverId
      }))
      this.emit({ type: 'prompts_discovered', serverId, prompts: state.prompts })
    } catch (error) {
      // Prompts may not be supported
      console.debug(`Failed to list prompts from ${serverId}:`, error)
    }

    // Discover resources
    try {
      const resourcesResult = await client.listResources()
      state.resources = resourcesResult.resources.map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        serverId
      }))
      this.emit({ type: 'resources_discovered', serverId, resources: state.resources })
    } catch (error) {
      // Resources may not be supported
      console.debug(`Failed to list resources from ${serverId}:`, error)
    }
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = []
    for (const state of this.serverStates.values()) {
      if (state.status === 'connected') {
        tools.push(...state.tools)
      }
    }
    return tools
  }

  /**
   * Get all available prompts from all connected servers
   */
  getAllPrompts(): MCPPrompt[] {
    const prompts: MCPPrompt[] = []
    for (const state of this.serverStates.values()) {
      if (state.status === 'connected') {
        prompts.push(...state.prompts)
      }
    }
    return prompts
  }

  /**
   * Get all available resources from all connected servers
   */
  getAllResources(): MCPResource[] {
    const resources: MCPResource[] = []
    for (const state of this.serverStates.values()) {
      if (state.status === 'connected') {
        resources.push(...state.resources)
      }
    }
    return resources
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`Server not connected: ${serverId}`)
    }

    const result = await client.callTool({
      name: toolName,
      arguments: args
    })

    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { uri: string } }>

    return {
      content: content.map(c => {
        if (c.type === 'text') {
          return { type: 'text' as const, text: c.text }
        } else if (c.type === 'image') {
          return { type: 'image' as const, data: c.data, mimeType: c.mimeType }
        } else if (c.type === 'resource') {
          return {
            type: 'resource' as const,
            uri: c.resource?.uri
          }
        }
        return { type: 'text' as const, text: JSON.stringify(c) }
      }),
      isError: result.isError as boolean | undefined
    }
  }

  /**
   * Get a prompt from an MCP server
   */
  async getPrompt(serverId: string, promptName: string, args?: Record<string, string>): Promise<MCPPromptResult> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`Server not connected: ${serverId}`)
    }

    const result = await client.getPrompt({
      name: promptName,
      arguments: args
    })

    return {
      description: result.description,
      messages: result.messages.map(msg => ({
        role: msg.role,
        content: msg.content as MCPPromptResult['messages'][0]['content']
      }))
    }
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(serverId: string, uri: string): Promise<string> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`Server not connected: ${serverId}`)
    }

    const result = await client.readResource({ uri })

    // Combine all content
    return result.contents
      .map(c => {
        if ('text' in c) return c.text
        if ('blob' in c) return `[Binary data: ${c.mimeType || 'unknown'}]`
        return JSON.stringify(c)
      })
      .join('\n')
  }

  /**
   * Update configuration and reconnect affected servers
   */
  async updateConfig(newConfig: MCPConfig): Promise<void> {
    const oldConfig = this.config
    this.config = newConfig

    // Find servers that need to be disconnected
    for (const oldServer of oldConfig.servers) {
      const newServer = newConfig.servers.find(s => s.id === oldServer.id)
      if (!newServer || !newServer.enabled) {
        await this.disconnect(oldServer.id)
      }
    }

    // Connect to new or updated servers
    for (const newServer of newConfig.servers) {
      const oldServer = oldConfig.servers.find(s => s.id === newServer.id)

      if (newServer.enabled) {
        // New server or config changed
        if (!oldServer || JSON.stringify(oldServer) !== JSON.stringify(newServer)) {
          try {
            await this.disconnect(newServer.id)
            await this.connect(newServer.id)
          } catch (error) {
            console.error(`Failed to connect to ${newServer.id}:`, error)
          }
        }
      }
    }
  }

  /**
   * Shutdown all connections
   */
  async shutdown(): Promise<void> {
    for (const serverId of this.clients.keys()) {
      try {
        await this.disconnect(serverId)
      } catch (error) {
        console.error(`Error disconnecting ${serverId}:`, error)
      }
    }
  }
}

// Singleton instance
let mcpManager: MCPClientManager | null = null

export function getMCPManager(): MCPClientManager {
  if (!mcpManager) {
    mcpManager = new MCPClientManager()
  }
  return mcpManager
}
