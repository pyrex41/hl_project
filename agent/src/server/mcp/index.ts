/**
 * MCP Module Exports
 *
 * Central export point for all MCP functionality.
 */

// Types
export * from './types'

// Client manager
export { MCPClientManager, getMCPManager, type MCPEvent } from './client'

// Config integration
export {
  loadMCPConfig,
  saveMCPConfig,
  mergeMCPConfig,
  validateServerConfig,
  createServerConfig,
  addServerConfig,
  removeServerConfig,
  updateServerConfig
} from './config'

// Tool integration
export { executeMCPTool, getMCPToolDefinitions, isMCPTool, listMCPTools, getMCPToolInfo } from './tools'

// Commands integration (user-facing MCP prompts)
export {
  getAllMCPCommands,
  executeMCPCommand,
  parseMCPCommandInput,
  formatMCPCommandsHelp,
  type MCPCommand
} from './commands'
