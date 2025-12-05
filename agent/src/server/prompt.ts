import { readFile } from 'fs/promises'
import { join } from 'path'
import { exists } from './tools'

// Minimal system prompt (~100-150 tokens) - pi-style
export const SYSTEM_PROMPT = `You are a coding assistant. Help with coding tasks by reading files, executing commands, editing code, and writing files.

Tools: read_file, write_file, edit_file, bash

Guidelines:
- Read files before editing
- Use edit_file for precise changes (oldText must match exactly)
- Use bash for ls, grep, find, git
- Be concise`

// Instruction files to look for
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', '.agent/AGENTS.md']

export async function loadProjectInstructions(workDir: string): Promise<string | null> {
  for (const file of INSTRUCTION_FILES) {
    const path = join(workDir, file)
    if (await exists(path)) {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        // File exists but can't be read
        continue
      }
    }
  }
  return null
}

export async function getSystemPrompt(workDir: string): Promise<string> {
  const projectInstructions = await loadProjectInstructions(workDir)

  if (projectInstructions) {
    return `${SYSTEM_PROMPT}

<project_instructions>
${projectInstructions}
</project_instructions>`
  }

  return SYSTEM_PROMPT
}
