import { spawn } from 'child_process'
import { readFile, writeFile, mkdir, stat, readdir } from 'fs/promises'
import { dirname, join, isAbsolute } from 'path'
import type { ToolResult } from './types'

// Tool definitions are now in providers/index.ts for provider-agnostic format

// Helper to check if file exists
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Helper to resolve path
function resolvePath(path: string, workingDir: string): string {
  return isAbsolute(path) ? path : join(workingDir, path)
}

// Helper to detect binary files
async function isBinaryFile(path: string): Promise<boolean> {
  try {
    const buffer = Buffer.alloc(512)
    const fd = await import('fs').then(fs =>
      new Promise<number>((resolve, reject) =>
        fs.open(path, 'r', (err, fd) => err ? reject(err) : resolve(fd))
      )
    )
    const fs = await import('fs')
    const bytesRead = await new Promise<number>((resolve, reject) =>
      fs.read(fd, buffer, 0, 512, 0, (err, bytesRead) => {
        fs.close(fd, () => {})
        err ? reject(err) : resolve(bytesRead)
      })
    )

    // Check for null bytes (common in binary files)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return false
  }
}

// Tool implementations
async function readFileTool(
  input: { path: string; offset?: number; limit?: number },
  workingDir: string
): Promise<ToolResult> {
  const filePath = resolvePath(input.path, workingDir)
  const limit = input.limit || 2000
  const offset = (input.offset || 1) - 1 // Convert to 0-indexed

  try {
    // Check if path exists
    const pathStat = await stat(filePath)

    if (pathStat.isDirectory()) {
      const entries = await readdir(filePath)
      return {
        output: `Error: ${input.path} is a directory. Contents: ${entries.slice(0, 20).join(', ')}${entries.length > 20 ? '...' : ''}`,
        details: { type: 'error', data: { isDirectory: true, entries } }
      }
    }

    // Check for binary
    if (await isBinaryFile(filePath)) {
      return {
        output: `Error: ${input.path} appears to be a binary file`,
        details: { type: 'error', data: { isBinary: true } }
      }
    }

    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const selectedLines = lines.slice(offset, offset + limit)
    const totalLines = lines.length

    const numberedContent = selectedLines
      .map((line, i) => `${offset + i + 1}: ${line}`)
      .join('\n')

    const truncated = totalLines > offset + limit

    return {
      output: truncated
        ? `${numberedContent}\n\n[Truncated: showing lines ${offset + 1}-${offset + selectedLines.length} of ${totalLines}]`
        : numberedContent,
      details: {
        type: 'file',
        data: {
          path: input.path,
          content: selectedLines.join('\n'),
          startLine: offset + 1,
          endLine: offset + selectedLines.length,
          totalLines,
          truncated
        }
      }
    }
  } catch (error) {
    // File not found - try to help by listing directory
    const dir = dirname(filePath)
    try {
      const entries = await readdir(dir)
      return {
        output: `Error: File not found at ${input.path}. Directory "${dirname(input.path)}" contains: ${entries.slice(0, 15).join(', ')}${entries.length > 15 ? '...' : ''}`,
        details: { type: 'error', data: { notFound: true, dirContents: entries } }
      }
    } catch {
      return {
        output: `Error: ${input.path} not found and parent directory doesn't exist`,
        details: { type: 'error', data: { notFound: true } }
      }
    }
  }
}

async function writeFileTool(
  input: { path: string; content: string },
  workingDir: string
): Promise<ToolResult> {
  const filePath = resolvePath(input.path, workingDir)

  try {
    // Create parent directories
    await mkdir(dirname(filePath), { recursive: true })

    // Write file (atomic via temp file would be better for production)
    await writeFile(filePath, input.content, 'utf-8')

    const bytes = Buffer.byteLength(input.content, 'utf-8')
    const lines = input.content.split('\n').length

    return {
      output: `Wrote ${bytes} bytes (${lines} lines) to ${input.path}`,
      details: {
        type: 'file',
        data: { path: input.path, bytes, lines, action: 'write' }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return {
      output: `Error writing ${input.path}: ${msg}`,
      details: { type: 'error', data: { error: msg } }
    }
  }
}

async function editFileTool(
  input: { path: string; oldText: string; newText: string },
  workingDir: string
): Promise<ToolResult> {
  const filePath = resolvePath(input.path, workingDir)

  try {
    const content = await readFile(filePath, 'utf-8')

    // Check if oldText exists
    if (!content.includes(input.oldText)) {
      // Try to find similar lines to help
      const oldLines = input.oldText.split('\n')
      const contentLines = content.split('\n')
      const firstOldLine = oldLines[0]?.trim() ?? ''

      const similar: string[] = []
      contentLines.forEach((line, i) => {
        if (line.includes(firstOldLine.slice(0, 20)) ||
            firstOldLine.includes(line.trim().slice(0, 20))) {
          similar.push(`Line ${i + 1}: ${line.slice(0, 100)}`)
        }
      })

      const hint = similar.length > 0
        ? `\nSimilar lines found:\n${similar.slice(0, 5).join('\n')}`
        : '\nNo similar lines found. The text may not exist in this file.'

      return {
        output: `Error: oldText not found in ${input.path}.${hint}`,
        details: {
          type: 'error',
          data: { notFound: true, similarLines: similar.slice(0, 5) }
        }
      }
    }

    // Check for multiple matches
    const matchCount = content.split(input.oldText).length - 1
    if (matchCount > 1) {
      return {
        output: `Error: oldText found ${matchCount} times in ${input.path}. Please provide more context to make the match unique.`,
        details: { type: 'error', data: { multipleMatches: matchCount } }
      }
    }

    // Perform replacement
    const newContent = content.replace(input.oldText, input.newText)
    await writeFile(filePath, newContent, 'utf-8')

    // Calculate line numbers for the change
    const beforeLines = content.slice(0, content.indexOf(input.oldText)).split('\n')
    const startLine = beforeLines.length

    return {
      output: `Edited ${input.path} at line ${startLine}`,
      details: {
        type: 'diff',
        data: {
          path: input.path,
          before: input.oldText,
          after: input.newText,
          startLine
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return {
      output: `Error editing ${input.path}: ${msg}`,
      details: { type: 'error', data: { error: msg } }
    }
  }
}

async function bashTool(
  input: { command: string; timeout?: number },
  workingDir: string
): Promise<ToolResult> {
  const timeout = (input.timeout || 30) * 1000

  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', input.command], {
      cwd: workingDir,
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 1000)
    }, timeout)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
      // Truncate if too large
      if (stdout.length > 100000) {
        stdout = stdout.slice(0, 100000) + '\n[Output truncated...]'
      }
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
      if (stderr.length > 50000) {
        stderr = stderr.slice(0, 50000) + '\n[Stderr truncated...]'
      }
    })

    proc.on('close', (code) => {
      clearTimeout(timer)

      let output = ''
      if (stdout) output += stdout
      if (stderr) output += (output ? '\n\nSTDERR:\n' : 'STDERR:\n') + stderr
      if (killed) output += '\n[Command timed out after ' + (timeout / 1000) + 's]'
      if (code !== 0 && code !== null) output += `\n[Exit code: ${code}]`

      resolve({
        output: output || '(no output)',
        details: {
          type: 'command',
          data: {
            command: input.command,
            exitCode: code,
            stdout,
            stderr,
            killed
          }
        }
      })
    })

    proc.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        output: `Error executing command: ${error.message}`,
        details: { type: 'error', data: { error: error.message } }
      })
    })
  })
}

// Main tool executor
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  workingDir: string
): Promise<ToolResult> {
  switch (name) {
    case 'read_file':
      return readFileTool(input as { path: string; offset?: number; limit?: number }, workingDir)
    case 'write_file':
      return writeFileTool(input as { path: string; content: string }, workingDir)
    case 'edit_file':
      return editFileTool(input as { path: string; oldText: string; newText: string }, workingDir)
    case 'bash':
      return bashTool(input as { command: string; timeout?: number }, workingDir)
    default:
      return {
        output: `Unknown tool: ${name}`,
        details: { type: 'error', data: { unknownTool: name } }
      }
  }
}
