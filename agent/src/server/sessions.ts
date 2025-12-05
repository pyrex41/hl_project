import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { join, dirname } from 'path'
import type { Message, ToolCall } from './types'

// Session data model
export interface Session {
  id: string
  name?: string
  workingDir: string
  messages: Message[]
  createdAt: string
  updatedAt: string
  metadata: {
    totalTokens: { input: number; output: number }
    toolCalls: number
  }
}

// Default sessions directory
const SESSIONS_DIR = '.agent/sessions'

function getSessionsDir(workingDir: string): string {
  return join(workingDir, SESSIONS_DIR)
}

function generateSessionId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 19).replace(/:/g, '')
  const random = Math.random().toString(36).slice(2, 6)
  return `${date}-${time}-${random}`
}

export async function createSession(workingDir: string): Promise<Session> {
  const session: Session = {
    id: generateSessionId(),
    workingDir,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      totalTokens: { input: 0, output: 0 },
      toolCalls: 0
    }
  }
  return session
}

export async function saveSession(session: Session): Promise<void> {
  const sessionsDir = getSessionsDir(session.workingDir)
  await mkdir(sessionsDir, { recursive: true })

  const filePath = join(sessionsDir, `${session.id}.json`)
  session.updatedAt = new Date().toISOString()

  await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8')
}

export async function loadSession(workingDir: string, sessionId: string): Promise<Session | null> {
  const filePath = join(getSessionsDir(workingDir), `${sessionId}.json`)

  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as Session
  } catch {
    return null
  }
}

export async function listSessions(workingDir: string): Promise<{ id: string; name?: string; updatedAt: string; messageCount: number }[]> {
  const sessionsDir = getSessionsDir(workingDir)

  try {
    const files = await readdir(sessionsDir)
    const sessions: { id: string; name?: string; updatedAt: string; messageCount: number }[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const content = await readFile(join(sessionsDir, file), 'utf-8')
        const session = JSON.parse(content) as Session
        sessions.push({
          id: session.id,
          name: session.name,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length
        })
      } catch {
        // Skip invalid session files
      }
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return sessions
  } catch {
    return []
  }
}

export async function deleteSession(workingDir: string, sessionId: string): Promise<boolean> {
  const filePath = join(getSessionsDir(workingDir), `${sessionId}.json`)

  try {
    const { unlink } = await import('fs/promises')
    await unlink(filePath)
    return true
  } catch {
    return false
  }
}

// Update session with new message and token usage
export function updateSessionMessage(
  session: Session,
  message: Message,
  tokens?: { input: number; output: number }
): void {
  session.messages.push(message)

  if (tokens) {
    session.metadata.totalTokens.input += tokens.input
    session.metadata.totalTokens.output += tokens.output
  }

  // Count tool calls
  if (message.toolCalls) {
    session.metadata.toolCalls += message.toolCalls.length
  }
}
