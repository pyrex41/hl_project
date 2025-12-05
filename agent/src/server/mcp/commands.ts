/**
 * MCP Commands Integration
 *
 * Integrates MCP prompts as user-facing commands that can be invoked
 * via the UI or as slash commands.
 */

import { getMCPManager } from './client'
import type { MCPPrompt, MCPPromptResult } from './types'

export interface MCPCommand {
  // Full command name including server prefix
  name: string

  // Display name for UI
  displayName: string

  // Description from the MCP prompt
  description?: string

  // Arguments the command accepts
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>

  // Server info
  serverId: string
  serverName: string
}

/**
 * Get all available MCP commands (prompts from connected servers)
 */
export function getAllMCPCommands(): MCPCommand[] {
  const manager = getMCPManager()
  const states = manager.getAllServerStates()
  const commands: MCPCommand[] = []

  for (const state of states) {
    if (state.status !== 'connected') continue

    for (const prompt of state.prompts) {
      commands.push({
        name: `mcp:${state.config.id}:${prompt.name}`,
        displayName: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
        serverId: state.config.id,
        serverName: state.config.name
      })
    }
  }

  return commands
}

/**
 * Execute an MCP command (prompt)
 *
 * Returns the expanded prompt content that should be sent to the LLM.
 */
export async function executeMCPCommand(
  commandName: string,
  args: Record<string, string> = {}
): Promise<{ content: string; description?: string } | null> {
  // Parse command name
  const match = commandName.match(/^mcp:([^:]+):(.+)$/)
  if (!match) {
    return null
  }

  const [, serverId, promptName] = match
  if (!serverId || !promptName) {
    return null
  }

  const manager = getMCPManager()

  try {
    const result = await manager.getPrompt(serverId, promptName, args)

    // Format the prompt result as content for the LLM
    const content = formatPromptResult(result)

    return {
      content,
      description: result.description
    }
  } catch (error) {
    console.error(`Failed to execute MCP command ${commandName}:`, error)
    return null
  }
}

/**
 * Format MCP prompt result as text content
 */
function formatPromptResult(result: MCPPromptResult): string {
  const parts: string[] = []

  for (const msg of result.messages) {
    const content = msg.content

    if (content.type === 'text' && content.text) {
      parts.push(content.text)
    } else if (content.type === 'image') {
      parts.push('[Image content]')
    } else if (content.type === 'resource' && content.uri) {
      parts.push(`[Resource: ${content.uri}]`)
    }
  }

  return parts.join('\n\n')
}

/**
 * Parse MCP command from user input
 *
 * Supports formats:
 * - /mcp:serverId:promptName arg1=value1 arg2=value2
 * - /promptName (if unique across servers)
 */
export function parseMCPCommandInput(input: string): {
  commandName: string
  args: Record<string, string>
} | null {
  // Check if it's an MCP command
  if (!input.startsWith('/mcp:') && !input.startsWith('/')) {
    return null
  }

  const parts = input.slice(1).split(/\s+/)
  const commandPart = parts[0]

  if (!commandPart) {
    return null
  }

  // Check if it matches mcp:server:prompt format
  if (commandPart.startsWith('mcp:')) {
    const args = parseCommandArgs(parts.slice(1))
    return { commandName: commandPart, args }
  }

  // Check if it's a short form that matches an MCP prompt
  const commands = getAllMCPCommands()
  const matching = commands.filter(c => c.displayName === commandPart)

  if (matching.length === 1 && matching[0]) {
    const args = parseCommandArgs(parts.slice(1))
    return { commandName: matching[0].name, args }
  }

  // Ambiguous or not found
  return null
}

/**
 * Parse command arguments from string parts
 */
function parseCommandArgs(parts: string[]): Record<string, string> {
  const args: Record<string, string> = {}

  for (const part of parts) {
    const eqIndex = part.indexOf('=')
    if (eqIndex > 0) {
      const key = part.slice(0, eqIndex)
      const value = part.slice(eqIndex + 1)
      args[key] = value
    }
  }

  return args
}

/**
 * Format MCP commands for help display
 */
export function formatMCPCommandsHelp(): string {
  const commands = getAllMCPCommands()

  if (commands.length === 0) {
    return 'No MCP commands available. Connect to an MCP server to enable commands.'
  }

  // Group by server
  const byServer = new Map<string, MCPCommand[]>()
  for (const cmd of commands) {
    const serverCmds = byServer.get(cmd.serverName) || []
    serverCmds.push(cmd)
    byServer.set(cmd.serverName, serverCmds)
  }

  const lines: string[] = ['## MCP Commands\n']

  for (const [serverName, serverCmds] of byServer) {
    lines.push(`### ${serverName}\n`)

    for (const cmd of serverCmds) {
      const argStr = cmd.arguments
        ? cmd.arguments.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')
        : ''

      lines.push(`- \`/${cmd.name}${argStr ? ' ' + argStr : ''}\``)
      if (cmd.description) {
        lines.push(`  ${cmd.description}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}
