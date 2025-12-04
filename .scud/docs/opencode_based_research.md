Now I have all the research. Let me synthesize this into a comprehensive architecture plan for your assessment:

---

## Your Agent Harness: Architecture Blueprint

Based on OpenCode patterns + xAI/Anthropic support, here's your full architecture:

### Project Structure

```
humanlayer-agent/
├── packages/
│   ├── agent/                     # Backend harness
│   │   ├── src/
│   │   │   ├── index.ts           # Entry + HTTP server (Hono)
│   │   │   ├── provider/
│   │   │   │   ├── index.ts       # Provider registry
│   │   │   │   ├── anthropic.ts   # Claude support
│   │   │   │   └── xai.ts         # Grok support
│   │   │   ├── agent/
│   │   │   │   ├── index.ts       # Agent registry
│   │   │   │   ├── types.ts       # Agent.Info schema
│   │   │   │   └── built-in.ts    # build, plan, explore, general
│   │   │   ├── session/
│   │   │   │   ├── index.ts       # Session CRUD
│   │   │   │   ├── loop.ts        # Main agent loop
│   │   │   │   ├── processor.ts   # Stream processing
│   │   │   │   ├── compaction.ts  # Context overflow handling
│   │   │   │   └── revert.ts      # Undo system
│   │   │   ├── tool/
│   │   │   │   ├── registry.ts    # Tool registration
│   │   │   │   ├── types.ts       # Tool.Context, Tool.Result
│   │   │   │   ├── read.ts
│   │   │   │   ├── write.ts
│   │   │   │   ├── edit.ts
│   │   │   │   ├── bash.ts
│   │   │   │   ├── glob.ts
│   │   │   │   ├── grep.ts
│   │   │   │   └── task.ts        # Sub-agent spawning
│   │   │   ├── snapshot/
│   │   │   │   └── index.ts       # Git-based snapshots
│   │   │   ├── message/
│   │   │   │   ├── types.ts       # Message, Part schemas
│   │   │   │   └── storage.ts     # File-based storage
│   │   │   ├── safety/
│   │   │   │   └── doom-loop.ts   # Doom loop detection
│   │   │   └── prompt/
│   │   │       ├── system.ts      # System prompt assembly
│   │   │       └── templates.ts   # Provider-specific prompts
│   │   └── package.json
│   │
│   └── web/                       # Frontend
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── Chat.tsx
│       │   │   ├── Message.tsx
│       │   │   ├── ToolCall.tsx   # Streaming tool display
│       │   │   ├── AgentSelector.tsx
│       │   │   └── SessionList.tsx
│       │   ├── hooks/
│       │   │   └── useStream.ts   # SSE hook
│       │   └── api/
│       │       └── client.ts
│       └── package.json
│
├── .humanlayer/                   # Config directory (your branding)
│   └── agent/
│       └── custom-agent.md
├── CLAUDE.md
└── README.md
```

---

### Core Data Types

```typescript
// === Agent System ===
interface Agent {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  model?: { provider: "anthropic" | "xai"; model: string }
  prompt?: string
  tools: Record<string, boolean>
  permission: {
    edit: Permission
    bash: Record<string, Permission>  // Glob patterns
    doom_loop: Permission
  }
}

type Permission = "allow" | "ask" | "deny"

// === Session System ===
interface Session {
  id: string
  parentID?: string           // For sub-agent sessions
  title: string
  directory: string
  status: "idle" | "busy" | "compacting"
  time: { created: number; updated: number }
  revert?: RevertState
}

interface RevertState {
  messageID: string
  partID?: string
  snapshot: string
}

// === Message System ===
interface Message {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  // User-specific
  agent?: string              // Which agent responds
  model?: { provider: string; model: string }
  // Assistant-specific
  parentID?: string           // References user message
  tokens?: TokenUsage
  cost?: number
  finish?: "stop" | "tool-calls" | "length" | "error"
  error?: string
  summary?: boolean           // Is this a compaction summary?
}

// === Part System (Streaming Units) ===
type Part =
  | TextPart
  | ToolPart
  | ReasoningPart
  | StepStartPart
  | StepFinishPart
  | PatchPart
  | SubtaskPart
  | CompactionPart

interface ToolPart {
  id: string
  messageID: string
  type: "tool"
  tool: string
  callID: string
  state: ToolState
}

type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; time: { start: number } }
  | { status: "completed"; input: unknown; output: string; time: { start: number; end: number } }
  | { status: "error"; input: unknown; error: string; time: { start: number; end: number } }

interface PatchPart {
  id: string
  type: "patch"
  hash: string        // Git tree hash
  files: string[]     // Changed file paths
}

interface SubtaskPart {
  id: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
}
```

---

### Core Algorithms

#### 1. Main Agent Loop

```typescript
// session/loop.ts
async function agentLoop(sessionID: string, abort: AbortSignal): AsyncGenerator<StreamEvent> {
  while (!abort.aborted) {
    const messages = await Message.list(sessionID)
    const lastUser = messages.findLast(m => m.role === "user")
    const lastAssistant = messages.findLast(m => m.role === "assistant")
    
    // Exit conditions
    if (lastAssistant?.finish === "stop") break
    if (lastAssistant?.finish === "length") break
    
    // Check for pending tasks
    const pendingTasks = await getPendingTasks(messages)
    
    // Priority 1: Process subtasks
    const subtask = pendingTasks.find(t => t.type === "subtask")
    if (subtask) {
      yield* processSubtask(sessionID, subtask, abort)
      continue
    }
    
    // Priority 2: Process compaction
    const compaction = pendingTasks.find(t => t.type === "compaction")
    if (compaction) {
      yield* processCompaction(sessionID, messages, abort)
      continue
    }
    
    // Priority 3: Check overflow, queue compaction
    if (lastAssistant && isOverflow(lastAssistant.tokens)) {
      await queueCompaction(sessionID, lastUser!.agent)
      continue
    }
    
    // Normal processing
    const agent = await Agent.get(lastUser!.agent)
    const tools = await resolveTools(agent)
    const systemPrompt = await buildSystemPrompt(agent, lastUser!.model)
    
    yield* streamResponse({
      sessionID,
      messages,
      tools,
      systemPrompt,
      model: lastUser!.model,
      agent,
      abort
    })
  }
}
```

#### 2. Stream Processor with Doom Loop

```typescript
// session/processor.ts
const DOOM_LOOP_THRESHOLD = 3

async function* streamResponse(opts: StreamOpts): AsyncGenerator<StreamEvent> {
  const { sessionID, messages, tools, model, agent, abort } = opts
  
  // Create assistant message
  const assistantMsg = await Message.create({ 
    sessionID, 
    role: "assistant",
    parentID: messages.at(-1)?.id
  })
  
  let snapshot: string | undefined
  const recentToolCalls: Array<{ tool: string; input: string }> = []
  
  const provider = getProvider(model.provider)
  const stream = await provider.stream({
    model: model.model,
    messages: toProviderMessages(messages),
    tools,
    system: opts.systemPrompt
  })
  
  for await (const event of stream) {
    if (abort.aborted) throw new Error("Aborted")
    
    switch (event.type) {
      case "text-delta":
        yield { type: "text-delta", text: event.text, messageID: assistantMsg.id }
        break
        
      case "tool-call-start":
        // Create pending part
        const part = await Part.create({
          messageID: assistantMsg.id,
          type: "tool",
          tool: event.toolName,
          callID: event.callID,
          state: { status: "pending", input: event.args }
        })
        yield { type: "tool-start", part }
        break
        
      case "tool-call":
        // Doom loop detection
        const inputHash = JSON.stringify(event.args)
        recentToolCalls.push({ tool: event.toolName, input: inputHash })
        
        if (recentToolCalls.length >= DOOM_LOOP_THRESHOLD) {
          const last3 = recentToolCalls.slice(-DOOM_LOOP_THRESHOLD)
          const allSame = last3.every(c => 
            c.tool === event.toolName && c.input === inputHash
          )
          
          if (allSame) {
            const permission = agent.permission.doom_loop
            if (permission === "deny") {
              throw new DoomLoopError(event.toolName, event.args)
            }
            if (permission === "ask") {
              yield { type: "permission-request", kind: "doom_loop", tool: event.toolName }
              // Wait for user confirmation...
            }
          }
        }
        
        // Update to running
        await Part.update(part.id, { 
          state: { status: "running", input: event.args, time: { start: Date.now() } }
        })
        yield { type: "tool-running", partID: part.id }
        
        // Execute tool
        const result = await executeTool(event.toolName, event.args, {
          sessionID,
          messageID: assistantMsg.id,
          agent: agent.name,
          abort
        })
        
        // Update to completed
        await Part.update(part.id, {
          state: { 
            status: "completed", 
            input: event.args,
            output: result.output,
            time: { start: part.state.time.start, end: Date.now() }
          }
        })
        yield { type: "tool-completed", partID: part.id, result }
        break
        
      case "step-start":
        snapshot = await Snapshot.track()
        await Part.create({ type: "step-start", snapshot, messageID: assistantMsg.id })
        break
        
      case "step-finish":
        if (snapshot) {
          const patch = await Snapshot.diff(snapshot)
          if (patch.files.length > 0) {
            await Part.create({ type: "patch", hash: patch.hash, files: patch.files, messageID: assistantMsg.id })
            yield { type: "patch", files: patch.files }
          }
        }
        
        await Message.update(assistantMsg.id, { 
          finish: event.finishReason,
          tokens: event.usage,
          time: { completed: Date.now() }
        })
        break
    }
  }
}
```

#### 3. Sub-Agent Task Tool

```typescript
// tool/task.ts
export const TaskTool = defineTool({
  name: "task",
  description: "Spawn a sub-agent to handle a complex task",
  parameters: z.object({
    description: z.string().describe("Short 3-5 word description"),
    prompt: z.string().describe("Full task instructions"),
    agent: z.string().describe("Which agent to use: general, explore, plan")
  }),
  
  async execute(params, ctx) {
    const agent = await Agent.get(params.agent)
    if (!agent || agent.mode === "primary") {
      throw new Error(`Invalid sub-agent: ${params.agent}`)
    }
    
    // Create child session
    const childSession = await Session.create({
      parentID: ctx.sessionID,
      title: `${params.description} (@${agent.name})`,
      directory: ctx.directory
    })
    
    // Subscribe to child events for progress
    const toolParts: ToolPart[] = []
    const unsubscribe = events.subscribe(childSession.id, (event) => {
      if (event.type === "tool-completed") {
        toolParts.push(event.part)
        ctx.metadata({ 
          title: params.description,
          toolSummary: toolParts 
        })
      }
    })
    
    try {
      // Run sub-agent with restricted tools
      const result = await runAgent({
        sessionID: childSession.id,
        prompt: params.prompt,
        agent: agent.name,
        model: agent.model ?? ctx.model,
        tools: {
          ...agent.tools,
          task: false,  // Prevent recursion
        },
        abort: ctx.abort
      })
      
      return {
        output: result.finalText,
        metadata: { 
          sessionID: childSession.id,
          toolsCalled: toolParts.length 
        }
      }
    } finally {
      unsubscribe()
    }
  }
})
```

#### 4. Snapshot/Undo System

```typescript
// snapshot/index.ts
import { $ } from "bun"

const SNAPSHOT_DIR = ".humanlayer/snapshots"

export async function track(directory: string): Promise<string> {
  const snapshotDir = path.join(directory, SNAPSHOT_DIR)
  
  // Initialize if needed
  if (!await exists(snapshotDir)) {
    await $`git init --bare ${snapshotDir}`.quiet()
  }
  
  // Stage all files and write tree
  const env = { GIT_DIR: snapshotDir, GIT_WORK_TREE: directory }
  await $`git add -A`.env(env).cwd(directory).quiet()
  const hash = await $`git write-tree`.env(env).text()
  
  return hash.trim()
}

export async function diff(directory: string, fromHash: string): Promise<Patch> {
  const snapshotDir = path.join(directory, SNAPSHOT_DIR)
  const env = { GIT_DIR: snapshotDir, GIT_WORK_TREE: directory }
  
  await $`git add -A`.env(env).cwd(directory).quiet()
  const currentHash = await $`git write-tree`.env(env).text()
  
  const diffOutput = await $`git diff-tree --name-only -r ${fromHash} ${currentHash.trim()}`
    .env(env).text()
  
  const files = diffOutput.split('\n').filter(Boolean).map(f => path.join(directory, f))
  
  return { hash: fromHash, files }
}

export async function revert(directory: string, patches: Patch[]): Promise<void> {
  const snapshotDir = path.join(directory, SNAPSHOT_DIR)
  const env = { GIT_DIR: snapshotDir, GIT_WORK_TREE: directory }
  
  // Revert in reverse order
  for (const patch of patches.reverse()) {
    for (const file of patch.files) {
      const relativePath = path.relative(directory, file)
      try {
        // Restore file from snapshot
        await $`git checkout ${patch.hash} -- ${relativePath}`.env(env).cwd(directory)
      } catch {
        // File didn't exist in snapshot, delete it
        await fs.unlink(file).catch(() => {})
      }
    }
  }
}
```

#### 5. Session Compaction

```typescript
// session/compaction.ts
const CONTEXT_PROTECT = 40_000  // Protect recent 40k tokens
const PRUNE_MINIMUM = 20_000    // Only prune if >20k tokens saveable

export function isOverflow(tokens: TokenUsage, model: Model): boolean {
  const used = tokens.input + tokens.output + (tokens.cache?.read ?? 0)
  const available = model.contextLimit - model.maxOutputTokens
  return used > available
}

export async function compact(sessionID: string, opts: CompactOpts): AsyncGenerator<StreamEvent> {
  const messages = await Message.list(sessionID)
  
  // Step 1: Prune old tool outputs
  let tokenCount = 0
  const toPrune: Part[] = []
  
  for (const msg of messages.reverse()) {
    if (msg.role !== "assistant") continue
    
    const parts = await Part.list(msg.id)
    for (const part of parts) {
      if (part.type === "tool" && part.state.status === "completed") {
        tokenCount += estimateTokens(part.state.output)
        if (tokenCount > CONTEXT_PROTECT) {
          toPrune.push(part)
        }
      }
    }
  }
  
  if (toPrune.length > 0 && tokenCount > PRUNE_MINIMUM) {
    for (const part of toPrune) {
      await Part.update(part.id, { 
        state: { ...part.state, compacted: Date.now() } 
      })
    }
  }
  
  // Step 2: Generate summary
  const summaryMsg = await Message.create({
    sessionID,
    role: "assistant",
    summary: true
  })
  
  yield* streamResponse({
    sessionID,
    messages: messages.filter(m => !m.error),
    systemPrompt: COMPACTION_PROMPT,
    model: opts.model,
    agent: opts.agent
  })
}

const COMPACTION_PROMPT = `
Summarize the conversation so far. Include:
1. Key decisions made
2. Files created/modified  
3. Current state of the task
4. Any pending work

Be concise but complete.
`
```

---

### Multi-Provider Support

```typescript
// provider/index.ts
import { anthropic } from "@ai-sdk/anthropic"
import { xai } from "@ai-sdk/xai"
import { streamText } from "ai"

export type ProviderID = "anthropic" | "xai"

const providers = {
  anthropic: {
    create: (model: string) => anthropic(model),
    models: ["claude-sonnet-4-20250514", "claude-haiku-4-20250514", "claude-opus-4-20250514"],
    defaultModel: "claude-sonnet-4-20250514"
  },
  xai: {
    create: (model: string) => xai(model),
    models: ["grok-3-beta", "grok-2", "grok-2-mini"],
    defaultModel: "grok-3-beta"
  }
}

export async function stream(opts: StreamOpts) {
  const provider = providers[opts.provider]
  const model = provider.create(opts.model)
  
  return streamText({
    model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    abortSignal: opts.abort,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature
  })
}
```

---

### Web UI Streaming

```typescript
// web/src/hooks/useStream.ts
export function useAgentStream(sessionID: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [parts, setParts] = useState<Map<string, Part>>(new Map())
  const [status, setStatus] = useState<"idle" | "busy">("idle")
  
  const startStream = useCallback(async (prompt: string) => {
    setStatus("busy")
    
    const response = await fetch(`/api/sessions/${sessionID}/chat`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
      headers: { "Content-Type": "application/json" }
    })
    
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const lines = decoder.decode(value).split("\n")
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const event = JSON.parse(line.slice(6))
        
        switch (event.type) {
          case "text-delta":
            // Append to current message text
            setMessages(msgs => {
              const last = msgs.at(-1)
              if (last?.role === "assistant") {
                return [...msgs.slice(0, -1), { ...last, text: (last.text ?? "") + event.text }]
              }
              return msgs
            })
            break
            
          case "tool-start":
            setParts(p => new Map(p).set(event.part.id, event.part))
            break
            
          case "tool-running":
          case "tool-completed":
            setParts(p => {
              const updated = new Map(p)
              const existing = updated.get(event.partID)
              if (existing) {
                updated.set(event.partID, { ...existing, state: event.state })
              }
              return updated
            })
            break
        }
      }
    }
    
    setStatus("idle")
  }, [sessionID])
  
  return { messages, parts, status, startStream }
}
```

---

### Built-in Agents

```typescript
// agent/built-in.ts
export const builtInAgents: Agent[] = [
  {
    name: "build",
    mode: "primary",
    description: "Default coding agent with full capabilities",
    tools: {},  // All tools enabled
    permission: {
      edit: "allow",
      bash: { "*": "allow" },
      doom_loop: "ask"
    }
  },
  {
    name: "plan", 
    mode: "primary",
    description: "Read-only planning and analysis",
    prompt: "You are in planning mode. Analyze the codebase but do NOT make changes.",
    tools: { edit: false, write: false },
    permission: {
      edit: "deny",
      bash: {
        "ls*": "allow",
        "cat*": "allow",
        "grep*": "allow",
        "find*": "allow",
        "git log*": "allow",
        "git status": "allow",
        "git diff*": "allow",
        "*": "ask"
      },
      doom_loop: "deny"
    }
  },
  {
    name: "explore",
    mode: "subagent",
    description: "Fast, read-only codebase exploration",
    prompt: "You are a search specialist. Find files and patterns quickly.",
    model: { provider: "anthropic", model: "claude-haiku-4-20250514" },
    tools: { edit: false, write: false, bash: false, task: false },
    permission: {
      edit: "deny",
      bash: { "*": "deny" },
      doom_loop: "deny"
    }
  },
  {
    name: "general",
    mode: "subagent", 
    description: "General-purpose sub-agent for complex multi-step tasks",
    tools: { task: false },  // No nested spawning
    permission: {
      edit: "allow",
      bash: { "*": "allow" },
      doom_loop: "ask"
    }
  }
]
```

---

### Key Dependencies

```json
{
  "dependencies": {
    "ai": "^4.0.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "@ai-sdk/xai": "^2.0.0",
    "hono": "^4.0.0",
    "zod": "^3.23.0",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "bun-types": "latest"
  }
}
```

For the frontend:
```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@tanstack/react-query": "^5.0.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^3.4.0"
  }
}
```

---

This gives you:
- ✅ Sub-agents via Task tool with parent-child sessions
- ✅ Multiple modes (build, plan, explore, general)  
- ✅ Doom loop detection with configurable thresholds
- ✅ Session compaction for long conversations
- ✅ Git-based snapshot/undo system
- ✅ Streaming tool calls to UI via SSE
- ✅ Multi-provider support (Anthropic + xAI)

Want me to help scaffold any specific component, or dive deeper into any of these patterns?
