/**
 * MCP Tool Integration
 *
 * Provides tool definitions and execution for MCP tools,
 * integrating them with the agent's tool system.
 */

import type { ToolDefinition } from '../providers/types'
import type { ToolResult } from '../types'
import { getMCPManager } from './client'
import { mcpToolToDefinition, parseMCPToolName, type MCPTool } from './types'

/**
 * Check if a tool name is an MCP tool
 */
export function isMCPTool(toolName: string, prefix: string = 'mcp_'): boolean {
  return toolName.startsWith(prefix)
}

/**
 * Get tool definitions for all connected MCP servers
 */
export function getMCPToolDefinitions(prefix: string = 'mcp_'): ToolDefinition[] {
  const manager = getMCPManager()
  const tools = manager.getAllTools()

  return tools.map(tool => mcpToolToDefinition(tool, prefix))
}

/**
 * Execute an MCP tool
 */
export async function executeMCPTool(
  toolName: string,
  input: Record<string, unknown>,
  prefix: string = 'mcp_'
): Promise<ToolResult> {
  const parsed = parseMCPToolName(toolName, prefix)

  if (!parsed) {
    return {
      output: `Error: Invalid MCP tool name: ${toolName}`,
      details: { type: 'error', data: { invalidToolName: toolName } }
    }
  }

  const { serverId, toolName: actualToolName } = parsed
  const manager = getMCPManager()

  // Check if server is connected
  const state = manager.getServerState(serverId)
  if (!state || state.status !== 'connected') {
    return {
      output: `Error: MCP server not connected: ${serverId}`,
      details: {
        type: 'error',
        data: {
          serverId,
          status: state?.status || 'not_found',
          error: state?.error
        }
      }
    }
  }

  // Check if tool exists
  const tool = state.tools.find(t => t.name === actualToolName)
  if (!tool) {
    return {
      output: `Error: Tool not found on server ${serverId}: ${actualToolName}`,
      details: {
        type: 'error',
        data: {
          serverId,
          toolName: actualToolName,
          availableTools: state.tools.map(t => t.name)
        }
      }
    }
  }

  try {
    const result = await manager.callTool(serverId, actualToolName, input)

    // Format output for LLM
    const output = result.content
      .map(c => {
        if (c.type === 'text' && c.text) {
          return c.text
        } else if (c.type === 'image') {
          return `[Image: ${c.mimeType || 'unknown type'}]`
        } else if (c.type === 'resource' && c.uri) {
          return `[Resource: ${c.uri}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')

    if (result.isError) {
      return {
        output: `Error from MCP tool: ${output}`,
        details: {
          type: 'error',
          data: {
            serverId,
            toolName: actualToolName,
            mcpError: true,
            content: result.content
          }
        }
      }
    }

    return {
      output: output || '(no output)',
      details: {
        type: 'command',
        data: {
          serverId,
          toolName: actualToolName,
          mcpTool: true,
          content: result.content
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    return {
      output: `Error executing MCP tool ${actualToolName} on ${serverId}: ${errorMsg}`,
      details: {
        type: 'error',
        data: {
          serverId,
          toolName: actualToolName,
          error: errorMsg
        }
      }
    }
  }
}

/**
 * Get MCP tool metadata for display
 */
export function getMCPToolInfo(toolName: string, prefix: string = 'mcp_'): {
  serverId: string
  toolName: string
  tool: MCPTool | undefined
  serverName: string | undefined
} | null {
  const parsed = parseMCPToolName(toolName, prefix)
  if (!parsed) return null

  const manager = getMCPManager()
  const state = manager.getServerState(parsed.serverId)

  return {
    serverId: parsed.serverId,
    toolName: parsed.toolName,
    tool: state?.tools.find(t => t.name === parsed.toolName),
    serverName: state?.config.name
  }
}

/**
 * List all available MCP tools with their server info
 */
export function listMCPTools(): Array<{
  serverId: string
  serverName: string
  tools: MCPTool[]
}> {
  const manager = getMCPManager()
  const states = manager.getAllServerStates()

  return states
    .filter(s => s.status === 'connected' && s.tools.length > 0)
    .map(s => ({
      serverId: s.config.id,
      serverName: s.config.name,
      tools: s.tools
    }))
}
