# Server-Side Refactoring Guide

## Quick Reference: Issues Found

| # | Issue | File | Severity | Fix Time |
|---|-------|------|----------|----------|
| 1 | Wrong framework (Hono + Node instead of Bun) | `index.ts` | 🔴 | 1h |
| 2 | No input validation | All endpoints | 🔴 | 2-3h |
| 3 | Memory leak (pendingConfirmations) | `index.ts` | 🟠 | 30m |
| 4 | Race condition in provider caching | `providers/index.ts` | 🟠 | 30m |
| 5 | Session collision risk (weak ID) | `sessions.ts` | 🟠 | 15m |
| 6 | No rate limiting | `index.ts` | 🟠 | 1h |
| 7 | No structured logging | All files | 🟡 | 1h |
| 8 | Duplicate subagent code | `subagent.ts` | 🟡 | 2h |
| 9 | No test coverage | N/A | 🟡 | 4-5h |
| 10 | Path traversal risk | `index.ts`, `tools.ts` | 🔴 | 1h |

---

## Fix #1: Migrate to Bun.serve()

### Problem
```typescript
// ❌ WRONG - Uses Node.js HTTP server
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

serve({
  fetch: app.fetch,
  port,
})
```

### Solution
```typescript
// ✅ RIGHT - Uses Bun native server
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'

const app = new Hono()
app.use('*', cors())

// ... all your routes ...

Bun.serve({
  fetch: app.fetch,
  port: parseInt(process.env.PORT || '3001'),
})
```

### Changes to package.json
```json
{
  "devDependencies": {
    "@types/bun": "latest"
    // Keep: "@types/node"
  },
  "dependencies": {
    // REMOVE: "@hono/node-server"
    "hono": "^4.10.7"
    // Keep everything else
  },
  "scripts": {
    "dev": "bun --watch src/server/index.ts",
    "build": "bun build src/server/index.ts --target=bun --outdir=dist",
    "start": "bun dist/index.js"
  }
}
```

---

## Fix #2: Add Input Validation with Zod

### Problem
```typescript
// ❌ No validation - user can send anything
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const userMessage: string = body.message  // Could be null, huge, etc.
  const workingDir: string = body.workingDir || process.cwd()  // Path traversal?
})
```

### Solution
Create `src/server/validation.ts`:
```typescript
import { z } from 'zod'

// Shared validators
const workingDirValidator = z.string()
  .max(1000)
  .refine(p => !p.includes('..'), 'Parent directory references not allowed')
  .refine(p => !p.startsWith('/etc'), 'System directories not allowed')

const messageValidator = z.string()
  .min(1, 'Message cannot be empty')
  .max(10000, 'Message too long')
  .trim()

// Endpoint schemas
export const ChatInputSchema = z.object({
  message: messageValidator,
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    toolCalls: z.array(z.any()).optional()
  })).optional(),
  workingDir: workingDirValidator.optional(),
  sessionId: z.string().uuid().optional(),
  provider: z.enum(['anthropic', 'xai', 'openai']).optional(),
  model: z.string().max(200).optional()
})

export const ConfigInputSchema = z.object({
  workingDir: workingDirValidator.optional(),
  config: z.object({
    mainChat: z.object({
      provider: z.enum(['anthropic', 'xai', 'openai']),
      model: z.string().max(200)
    }).optional(),
    subagents: z.object({
      confirmMode: z.enum(['always', 'never', 'multiple']).optional(),
      timeout: z.number().min(1).max(600).optional(),
      maxConcurrent: z.number().min(1).max(50).optional(),
      roles: z.object({
        simple: z.object({
          provider: z.enum(['anthropic', 'xai', 'openai']).optional(),
          model: z.string().optional(),
          maxIterations: z.number().min(1).max(100).optional()
        }).optional(),
        complex: z.any().optional(),
        researcher: z.any().optional()
      }).optional()
    }).optional()
  })
})

export const BashInputSchema = z.object({
  command: z.string()
    .max(5000)
    .refine(cmd => !cmd.includes('rm -rf /'), 'Dangerous command blocked'),
  timeout: z.number().min(1).max(300).optional()
})

// Helper for safe parse with error response
export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ValidationError(result.error.format())
  }
  return result.data
}

export class ValidationError extends Error {
  constructor(public details: any) {
    super('Validation failed')
  }
}
```

### Update endpoints in index.ts:
```typescript
import { ChatInputSchema, validateInput, ValidationError } from './validation'

app.post('/api/chat', async (c) => {
  try {
    const input = validateInput(ChatInputSchema, await c.req.json())
    const userMessage = input.message
    const workingDir = input.workingDir || process.cwd()
    // ... rest of handler
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: 'Invalid input', details: error.details }, 400)
    }
    throw error
  }
})
```

---

## Fix #3: Fix Memory Leak in Pending Confirmations

### Problem
```typescript
// ❌ Unbounded map can grow indefinitely
const pendingConfirmations: Map<string, {
  resolve: (tasks: SubagentTask[] | null) => void
  tasks: SubagentTask[]
}> = new Map()

// Only cleaned after 5 minutes, could have 5000+ entries
setTimeout(() => {
  if (pendingConfirmations.has(requestId)) {
    pendingConfirmations.delete(requestId)
  }
}, 5 * 60 * 1000)
```

### Solution - Create `src/server/utils/confirmation-cache.ts`:
```typescript
export interface ConfirmationEntry {
  resolve: (tasks: SubagentTask[] | null) => void
  tasks: SubagentTask[]
  createdAt: number
}

export class ConfirmationCache {
  private cache = new Map<string, ConfirmationEntry>()
  private timeoutMs: number
  private maxSize: number
  private cleanupIntervalMs: number

  constructor(
    timeoutMs = 5 * 60 * 1000,  // 5 minutes
    maxSize = 1000,
    cleanupIntervalMs = 60 * 1000  // Check every minute
  ) {
    this.timeoutMs = timeoutMs
    this.maxSize = maxSize
    this.cleanupIntervalMs = cleanupIntervalMs
    this.startCleanupInterval()
  }

  set(key: string, entry: ConfirmationEntry): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.getOldestEntry()
      if (oldest) {
        this.cache.delete(oldest[0])
      }
    }
    this.cache.set(key, entry)
  }

  get(key: string): ConfirmationEntry | undefined {
    return this.cache.get(key)
  }

  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  private getOldestEntry(): [string, ConfirmationEntry] | null {
    let oldest: [string, ConfirmationEntry] | null = null
    for (const entry of this.cache.entries()) {
      if (!oldest || entry[1].createdAt < oldest[1].createdAt) {
        oldest = entry
      }
    }
    return oldest
  }

  private startCleanupInterval(): void {
    setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.createdAt > this.timeoutMs) {
          // Expired, remove it
          entry.resolve(null)  // Auto-reject
          this.cache.delete(key)
        }
      }
    }, this.cleanupIntervalMs)
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilization: ((this.cache.size / this.maxSize) * 100).toFixed(1) + '%'
    }
  }
}

// Usage in index.ts
const confirmationCache = new ConfirmationCache()

app.post('/api/subagents/confirm', async (c) => {
  const body = await c.req.json()
  const requestId: string = body.requestId
  
  const pending = confirmationCache.get(requestId)
  if (!pending) {
    return c.json({ error: 'No pending confirmation found' }, 404)
  }

  if (body.confirmed && body.tasks) {
    pending.resolve(body.tasks)
  } else {
    pending.resolve(null)
  }

  confirmationCache.delete(requestId)
  return c.json({ success: true })
})
```

---

## Fix #4: Fix Provider Caching Race Condition

### Problem
```typescript
// ❌ Two concurrent requests can both create providers
if (providers.has(cacheKey)) {
  return providers.get(cacheKey)!
}

const provider = createProvider(...)
providers.set(cacheKey, provider)
```

### Solution
```typescript
// ✅ Use Map constructor guarantee + early return
export function getProvider(config?: Partial<ProviderConfig>): LLMProvider {
  const providerName = config?.provider || detectProvider()

  if (!providerName) {
    throw new Error(
      'No LLM provider configured. Set one of: ANTHROPIC_API_KEY, XAI_API_KEY, or OPENAI_API_KEY'
    )
  }

  const model = config?.model || getDefaultModel(providerName)
  const cacheKey = `${providerName}:${model}`

  // Atomic check-and-create using Map.get pattern
  let provider = providers.get(cacheKey)
  if (!provider) {
    provider = createProvider(providerName, config?.apiKey, model)
    providers.set(cacheKey, provider)
  }

  return provider
}
```

Or better, use a WeakMap for auto-cleanup:
```typescript
// Better: WeakMap for automatic cleanup when no references exist
// But since we want cache, use explicit cleanup
const providers = new Map<string, LLMProvider>()
const providerLocks = new Map<string, Promise<LLMProvider>>()

export async function getProviderAsync(config?: Partial<ProviderConfig>): Promise<LLMProvider> {
  const providerName = config?.provider || detectProvider()
  const model = config?.model || getDefaultModel(providerName)
  const cacheKey = `${providerName}:${model}`

  // Return cached provider
  if (providers.has(cacheKey)) {
    return providers.get(cacheKey)!
  }

  // Prevent race condition: if creation in progress, wait for it
  if (providerLocks.has(cacheKey)) {
    return providerLocks.get(cacheKey)!
  }

  // Start creation
  const creationPromise = Promise.resolve(createProvider(providerName, config?.apiKey, model))
  providerLocks.set(cacheKey, creationPromise)

  try {
    const provider = await creationPromise
    providers.set(cacheKey, provider)
    return provider
  } finally {
    providerLocks.delete(cacheKey)
  }
}
```

---

## Fix #5: Improve Session ID Generation

### Problem
```typescript
// ❌ Only 4 random characters = 36^4 = 1.67M possible IDs
// Plus no uniqueness check
function generateSessionId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 19).replace(/:/g, '')
  const random = Math.random().toString(36).slice(2, 6)
  return `${date}-${time}-${random}`
}
```

### Solution
```typescript
// ✅ Cryptographically secure ID generation
import { randomUUID } from 'crypto'

function generateSessionId(): string {
  // Use UUID v4 - guaranteed unique
  return randomUUID()
}

// Or Bun-native:
function generateSessionIdBun(): string {
  return crypto.randomUUID()
}

// Or if you want readable IDs with better randomness:
function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const randomBytes = crypto.getRandomValues(new Uint8Array(12))
  const random = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `${timestamp}-${random}`
}
```

---

## Fix #6: Add Rate Limiting Middleware

### Create `src/server/middleware/rate-limit.ts`:
```typescript
import type { Context, Next } from 'hono'

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
  keyGenerator?: (c: Context) => string
}

export function rateLimitMiddleware(config: RateLimitConfig) {
  const { maxRequests, windowMs, keyGenerator } = config
  const requests = new Map<string, number[]>()

  return async (c: Context, next: Next) => {
    const key = keyGenerator?.(c) || c.req.header('x-forwarded-for') || 'unknown'
    const now = Date.now()

    // Get requests for this client
    let clientRequests = requests.get(key) || []

    // Filter to only requests within the window
    clientRequests = clientRequests.filter(t => now - t < windowMs)

    if (clientRequests.length >= maxRequests) {
      return c.json(
        {
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((clientRequests[0]! + windowMs - now) / 1000)
        },
        429
      )
    }

    // Add current request
    clientRequests.push(now)
    requests.set(key, clientRequests)

    // Optional: clean up old entries to prevent memory leak
    if (requests.size > 10000) {
      for (const [k, v] of requests.entries()) {
        if (v.filter(t => now - t < windowMs).length === 0) {
          requests.delete(k)
        }
      }
    }

    await next()
  }
}
```

### Update index.ts:
```typescript
import { rateLimitMiddleware } from './middleware/rate-limit'

// Apply different limits to different endpoints
app.post('/api/chat', rateLimitMiddleware({
  maxRequests: 10,
  windowMs: 60 * 1000  // 10 per minute
}), async (c) => {
  // ... handler
})

app.post('/api/subagents/continue', rateLimitMiddleware({
  maxRequests: 5,
  windowMs: 60 * 1000  // 5 per minute
}), async (c) => {
  // ... handler
})

app.put('/api/config', rateLimitMiddleware({
  maxRequests: 30,
  windowMs: 60 * 1000  // 30 per minute
}), async (c) => {
  // ... handler
})
```

---

## Fix #7: Add Structured Logging

### Create `src/server/utils/logger.ts`:
```typescript
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export interface LogEntry {
  level: string
  timestamp: string
  message: string
  [key: string]: any
}

class Logger {
  private level: LogLevel
  private isDev: boolean

  constructor(level = LogLevel.INFO) {
    this.level = level
    this.isDev = process.env.NODE_ENV === 'development'
  }

  private log(level: LogLevel, message: string, data?: Record<string, any>) {
    if (level < this.level) return

    const entry: LogEntry = {
      level: LogLevel[level],
      timestamp: new Date().toISOString(),
      message,
      ...data
    }

    const output = this.isDev
      ? this.formatDev(entry)
      : JSON.stringify(entry)

    const stream = level === LogLevel.ERROR ? console.error : console.log
    stream(output)
  }

  private formatDev(entry: LogEntry): string {
    const { level, timestamp, message, ...data } = entry
    const prefix = `[${level}] ${timestamp}`
    const dataStr = Object.keys(data).length > 0
      ? ` ${JSON.stringify(data, null, 2)}`
      : ''
    return `${prefix} ${message}${dataStr}`
  }

  debug(message: string, data?: Record<string, any>) {
    this.log(LogLevel.DEBUG, message, data)
  }

  info(message: string, data?: Record<string, any>) {
    this.log(LogLevel.INFO, message, data)
  }

  warn(message: string, data?: Record<string, any>) {
    this.log(LogLevel.WARN, message, data)
  }

  error(message: string, error?: Error | Record<string, any>) {
    const data = error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error
    this.log(LogLevel.ERROR, message, data)
  }
}

export const logger = new Logger(
  process.env.LOG_LEVEL
    ? LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel]
    : LogLevel.INFO
)
```

### Update index.ts:
```typescript
import { logger } from './utils/logger'

const port = parseInt(process.env.PORT || '3001')
logger.info('Starting agent server', { port, env: process.env.NODE_ENV })

Bun.serve({
  fetch: app.fetch,
  port
})

logger.info('Agent server started', { port, url: `http://localhost:${port}` })
```

---

## Fix #8: Extract Duplicate Subagent Code

### Problem
`runSubagent()` and `continueSubagent()` have ~250 lines of duplicate logic

### Solution: Create shared executor function

Create `src/server/subagent-executor.ts`:
```typescript
export interface ExecutorOptions {
  messages: ChatMessage[]
  systemPrompt: string
  maxIterations: number
  provider: LLMProvider
  taskId: string
  history: Message[]
}

export async function* executeAgentLoop(
  options: ExecutorOptions
): AsyncGenerator<AgentEvent> {
  const { messages, systemPrompt, maxIterations, provider, taskId, history } = options
  const toolCallHistory: ToolCallTracker[] = []
  let iterations = 0
  let finalOutput = ''

  try {
    while (iterations < maxIterations) {
      iterations++

      const pendingTools: Map<string, { name: string; input: Record<string, unknown> }> = new Map()
      let textContent = ''

      // Common streaming logic
      for await (const event of provider.stream(messages, systemPrompt, subagentToolDefinitions)) {
        switch (event.type) {
          case 'text_delta':
            textContent += event.delta
            yield { type: 'subagent_progress', taskId, event: { type: 'text_delta', delta: event.delta }, timestamp: Date.now() }
            break
          // ... rest of event handling
        }
      }

      // Common tool execution logic
      // ... (extract duplicated code)
    }

    // Emit completion or max iterations event
    if (iterations >= maxIterations && !finalOutput) {
      yield {
        type: 'subagent_max_iterations',
        taskId,
        iterations: maxIterations,
        fullHistory: history
      }
      return
    }

    yield {
      type: 'subagent_complete',
      taskId,
      summary: finalOutput,
      fullHistory: history
    }
  } catch (error) {
    yield {
      type: 'subagent_error',
      taskId,
      error: error instanceof Error ? error.message : 'Unknown error',
      fullHistory: history
    }
  }
}
```

Then refactor both functions:
```typescript
export async function* runSubagent(
  options: SubagentOptions
): AsyncGenerator<AgentEvent> {
  // Just setup
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }]
  const history: Message[] = [{ role: 'user', content: userPrompt }]

  // Delegate to executor
  yield* executeAgentLoop({
    messages,
    systemPrompt,
    maxIterations: roleConfig.maxIterations,
    provider,
    taskId: options.task.id,
    history
  })
}

export async function* continueSubagent(
  options: ContinueSubagentOptions
): AsyncGenerator<AgentEvent> {
  // Convert existing history and setup
  const messages = convertHistoryToMessages(options.existingHistory)
  messages.push({
    role: 'user',
    content: 'Continue working on the task. You have more iterations available now.'
  })

  // Delegate to executor
  yield* executeAgentLoop({
    messages,
    systemPrompt,
    maxIterations: roleConfig.maxIterations,
    provider,
    taskId: options.task.id,
    history: [
      ...options.existingHistory,
      { role: 'user', content: 'Continue working on the task...' }
    ]
  })
}
```

**Estimated savings:** 250+ lines of code, easier to maintain

---

## Fix #9: Add Comprehensive Tests

### Create `src/server/__tests__/agent.test.ts`:
```typescript
import { test, expect, describe } from 'bun:test'
import { checkDoomLoop, type ToolCallTracker } from '../agent'

describe('Doom Loop Detection', () => {
  test('allows first tool call', () => {
    const history: ToolCallTracker[] = []
    const result = checkDoomLoop(history, 'bash', { command: 'ls' })
    expect(result).toBe(false)
  })

  test('allows second identical tool call', () => {
    const history: ToolCallTracker[] = []
    checkDoomLoop(history, 'bash', { command: 'ls' })
    const result = checkDoomLoop(history, 'bash', { command: 'ls' })
    expect(result).toBe(false)
  })

  test('detects doom loop on third identical call', () => {
    const history: ToolCallTracker[] = []
    checkDoomLoop(history, 'bash', { command: 'ls' })
    checkDoomLoop(history, 'bash', { command: 'ls' })
    const result = checkDoomLoop(history, 'bash', { command: 'ls' })
    expect(result).toBe(true)
  })

  test('distinguishes between different arguments', () => {
    const history: ToolCallTracker[] = []
    checkDoomLoop(history, 'bash', { command: 'ls' })
    checkDoomLoop(history, 'bash', { command: 'ls' })
    checkDoomLoop(history, 'bash', { command: 'ls' })
    
    // Different command should not trigger loop
    const result = checkDoomLoop(history, 'bash', { command: 'pwd' })
    expect(result).toBe(false)
  })
})

describe('Session ID Generation', () => {
  test('generates valid UUIDs', () => {
    const id = generateSessionId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('generates unique IDs', () => {
    const ids = new Set()
    for (let i = 0; i < 100; i++) {
      ids.add(generateSessionId())
    }
    expect(ids.size).toBe(100)  // All unique
  })
})
```

---

## Fix #10: Add Path Traversal Prevention

### Problem
```typescript
// ❌ No validation
const workingDir: string = body.workingDir || process.cwd()
// User could pass: "../../../etc" or "/etc/passwd"
```

### Solution - already covered in Fix #2 with Zod validation

Summary:
```typescript
const safeWorkingDir = z.string()
  .max(1000)
  .refine(p => !p.includes('..'), 'Parent directory references not allowed')
  .refine(p => !p.startsWith('/etc'), 'System directories not allowed')
  .parse(input.workingDir)
```

---

## Testing Checklist

Run these commands to validate fixes:

```bash
# Bun migration
bun --watch src/server/index.ts

# Type checking
bun run typecheck

# Run tests (once implemented)
bun test src/server/__tests__

# Build
bun build src/server/index.ts --target=bun --outdir=dist

# Start
bun dist/index.js
```

---

## Summary of All Fixes

| Fix | Time | Priority | Status |
|-----|------|----------|--------|
| Migrate to Bun | 1h | 1 | 🔴 TODO |
| Input validation | 2-3h | 1 | 🔴 TODO |
| Path traversal fix | 1h | 1 | 🔴 TODO |
| Memory leak fix | 30m | 2 | 🔴 TODO |
| Provider race condition | 30m | 2 | 🔴 TODO |
| Session ID generation | 15m | 2 | 🔴 TODO |
| Rate limiting | 1h | 2 | 🔴 TODO |
| Structured logging | 1h | 3 | 🔴 TODO |
| Dedup subagent code | 2h | 3 | 🔴 TODO |
| Test coverage | 4-5h | 3 | 🔴 TODO |

**Total estimated time:** 12-16 hours
