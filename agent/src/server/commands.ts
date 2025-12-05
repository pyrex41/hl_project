/**
 * Slash Commands System
 *
 * File-based command system inspired by Claude Code.
 * Commands can be defined in:
 * - .agent/commands/ (project-specific)
 * - .claude/commands/ (Claude Code compatible)
 * - Built-in commands (bundled with agent)
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface CommandDef {
  name: string
  description: string
  allowedTools?: string[]
  argumentHint?: string
  content: string
  source: 'builtin' | 'project'
  path?: string
}

interface ParsedFrontmatter {
  description?: string
  'allowed-tools'?: string
  'argument-hint'?: string
}

/**
 * Parse YAML frontmatter from markdown content
 * Simple parser for key: value pairs
 */
function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter; body: string } {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)

  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterStr = frontmatterMatch[1] || ''
  const body = frontmatterMatch[2] || ''
  const frontmatter: ParsedFrontmatter = {}

  for (const line of frontmatterStr.split('\n')) {
    const match = line.match(/^(\S+):\s*(.*)$/)
    if (match && match[1] && match[2] !== undefined) {
      const key = match[1]
      const value = match[2]
      ;(frontmatter as Record<string, string>)[key] = value.trim()
    }
  }

  return { frontmatter, body }
}

/**
 * Load a command from a file path
 */
async function loadCommandFile(
  filePath: string,
  name: string,
  source: 'builtin' | 'project'
): Promise<CommandDef | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content)

    return {
      name,
      description: frontmatter.description || 'No description',
      allowedTools: frontmatter['allowed-tools']?.split(',').map((s) => s.trim()),
      argumentHint: frontmatter['argument-hint'],
      content: body.trim(),
      source,
      path: filePath,
    }
  } catch {
    return null
  }
}

/**
 * Recursively scan a directory for command files
 * Returns map of command name -> file path
 */
async function scanCommandDir(
  dir: string,
  prefix = ''
): Promise<Map<string, string>> {
  const commands = new Map<string, string>()

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        // Recurse into subdirectory with namespace prefix
        const subCommands = await scanCommandDir(fullPath, entry.name)
        for (const [name, path] of subCommands) {
          // Use colon for namespace: scud:tasks, cl:commit
          const namespacedName = prefix ? `${prefix}:${name}` : `${entry.name}:${name}`
          commands.set(namespacedName, path)
        }
      } else if (entry.name.endsWith('.md')) {
        // Command file
        const cmdName = entry.name.replace(/\.md$/, '')
        const fullName = prefix ? `${prefix}:${cmdName}` : cmdName
        commands.set(fullName, fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return commands
}

/**
 * Get the path to built-in commands directory
 */
function getBuiltinCommandsDir(): string {
  // In development: src/server/commands/
  // In production: dist/server/commands/
  const currentFile = fileURLToPath(import.meta.url)
  const currentDir = dirname(currentFile)
  return join(currentDir, 'commands')
}

/**
 * Find a command by name
 * Search order: .agent/commands/ -> .claude/commands/ -> builtins
 */
export async function findCommand(
  name: string,
  workingDir: string
): Promise<CommandDef | null> {
  // Project-specific directories
  const projectDirs = [
    join(workingDir, '.agent', 'commands'),
    join(workingDir, '.claude', 'commands'),
  ]

  // Check project directories first
  for (const dir of projectDirs) {
    const commands = await scanCommandDir(dir)
    const filePath = commands.get(name)
    if (filePath) {
      return loadCommandFile(filePath, name, 'project')
    }
  }

  // Check built-in commands
  const builtinDir = getBuiltinCommandsDir()
  const builtinCommands = await scanCommandDir(builtinDir)
  const builtinPath = builtinCommands.get(name)
  if (builtinPath) {
    return loadCommandFile(builtinPath, name, 'builtin')
  }

  return null
}

/**
 * List all available commands
 */
export async function listCommands(workingDir: string): Promise<CommandDef[]> {
  const commandMap = new Map<string, { path: string; source: 'builtin' | 'project' }>()

  // Load built-ins first (can be overridden)
  const builtinDir = getBuiltinCommandsDir()
  const builtinCommands = await scanCommandDir(builtinDir)
  for (const [name, path] of builtinCommands) {
    commandMap.set(name, { path, source: 'builtin' })
  }

  // Project directories override builtins
  const projectDirs = [
    join(workingDir, '.claude', 'commands'),
    join(workingDir, '.agent', 'commands'),
  ]

  for (const dir of projectDirs) {
    const commands = await scanCommandDir(dir)
    for (const [name, path] of commands) {
      commandMap.set(name, { path, source: 'project' })
    }
  }

  // Load all commands
  const results: CommandDef[] = []
  for (const [name, { path, source }] of commandMap) {
    const cmd = await loadCommandFile(path, name, source)
    if (cmd) {
      results.push(cmd)
    }
  }

  // Sort by name
  return results.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Expand a command with arguments
 */
export function expandCommand(command: CommandDef, args: string): string {
  let content = command.content

  // Replace $ARGUMENTS with the full argument string
  content = content.replace(/\$ARGUMENTS/g, args)

  // Replace positional args $1, $2, etc.
  const argParts = args.split(/\s+/).filter(Boolean)
  for (let i = 0; i < argParts.length; i++) {
    const argValue = argParts[i]
    if (argValue) {
      content = content.replace(new RegExp(`\\$${i + 1}`, 'g'), argValue)
    }
  }

  return content
}

/**
 * Parse a slash command from user input
 * Returns { commandName, args } or null if not a command
 */
export function parseSlashCommand(input: string): { commandName: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return null
  }

  // Match /command or /namespace:command followed by optional args
  const match = trimmed.match(/^\/([a-zA-Z_][\w-]*(?::[a-zA-Z_][\w-]*)?)(?:\s+(.*))?$/)
  if (!match) {
    return null
  }

  const commandName = match[1]
  if (!commandName) {
    return null
  }

  return {
    commandName,
    args: match[2] || '',
  }
}

/**
 * Expand a slash command to its full prompt
 * Returns the expanded prompt or null if not a valid command
 */
export async function expandSlashCommand(
  input: string,
  workingDir: string
): Promise<{ expanded: string; command: CommandDef } | null> {
  const parsed = parseSlashCommand(input)
  if (!parsed) {
    return null
  }

  const command = await findCommand(parsed.commandName, workingDir)
  if (!command) {
    return null
  }

  const expanded = expandCommand(command, parsed.args)
  return { expanded, command }
}

/**
 * Format command list for /help output
 */
export async function formatHelpText(workingDir: string): Promise<string> {
  const commands = await listCommands(workingDir)

  if (commands.length === 0) {
    return 'No commands available.'
  }

  const lines = ['Available Commands:', '']

  // Group by namespace
  const grouped = new Map<string, CommandDef[]>()
  for (const cmd of commands) {
    const parts = cmd.name.split(':')
    const namespace = cmd.name.includes(':') && parts[0] ? parts[0] : '_default'
    const existing = grouped.get(namespace)
    if (existing) {
      existing.push(cmd)
    } else {
      grouped.set(namespace, [cmd])
    }
  }

  // Output default commands first
  const defaultCmds = grouped.get('_default') || []
  for (const cmd of defaultCmds) {
    const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : ''
    lines.push(`  /${cmd.name}${hint}`)
    lines.push(`    ${cmd.description}`)
    lines.push('')
  }

  // Then namespaced commands
  for (const [namespace, cmds] of grouped) {
    if (namespace === '_default') continue

    lines.push(`${namespace}:`)
    for (const cmd of cmds) {
      const shortName = cmd.name.split(':')[1]
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : ''
      lines.push(`  /${cmd.name}${hint}`)
      lines.push(`    ${cmd.description}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
