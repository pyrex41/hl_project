# Deep Dive: Claude Code vs. Pi vs. OpenCode Architecture Tradeoffs

This is excellent research. Let me distill the key architectural tradeoffs and map them to your take-home constraints.

---

## The Spectrum of Complexity

```
Simple ←──────────────────────────────────────────────→ Complex
   │                                                        │
   Pi                    Your Take-Home           Claude Code
   (~1k tokens)          (target zone)            (~12k tokens)
   4 tools                                        14+ tools
   No subagents                                   Subagent spawning
   YOLO mode                                      6-layer permission gates
```

---

## Architectural Philosophy Comparison

| Aspect | Pi (Minimal) | Claude Code (Production) | OpenCode (Balanced) |
|--------|--------------|--------------------------|---------------------|
| **System Prompt** | ~800 tokens | ~2,972 tokens | ~1,500 tokens |
| **Tool Definitions** | ~200 tokens (4 tools) | ~9,400 tokens (14 tools) | ~2,000 tokens (8 tools) |
| **Total Baseline** | **<1,000 tokens** | **~15,000+ tokens** | **~4,000 tokens** |
| **Tool Philosophy** | "Bash is all you need" | Explicit prohibitions + specialized tools | Middle ground |
| **Subagents** | None (use tmux) | 1-level deep, ~10 concurrent | Parent-child sessions |
| **Context Strategy** | Start fresh often | Compaction at 92% | Compaction + session branching |
| **Permissions** | YOLO (none) | 6-layer security gates | Configurable (allow/ask/deny) |
| **Model Routing** | Single model | Haiku for 50%+ calls | Configurable per agent |

---

## Key Tradeoffs to Consider

### 1. Tool Count: Few vs. Many

**Pi's 4-Tool Argument:**
```
read + write + edit + bash = everything
```
- Models are RL-trained to understand these primitives
- Bash subsumes `ls`, `grep`, `find`, `cat`
- Fewer tools = less context consumed = more room for actual work
- Terminal-Bench results prove this works

**Claude Code's 14-Tool Argument:**
- Specialized tools have **explicit prohibitions** baked in
- `Grep` tool forces ripgrep over native grep (better performance)
- `TodoWrite` provides structured task management
- `Task` enables parallelism without manual orchestration

**For Your Take-Home:**
Go with **4-5 tools** (Pi's approach). You're time-constrained, and the assessment wants to see *how you think*, not feature completeness. A minimal tool set that works well is more impressive than 14 half-baked tools.

---

### 2. System Prompt: Minimal vs. Elaborate

**Pi's Minimal Prompt (~800 tokens):**
```
You are an expert coding assistant...
[Tool descriptions]
[Guidelines: use bash, read before edit, be concise]
[Path to documentation]
```

**Claude Code's Elaborate Prompt (~3,000 tokens):**
- XML-structured sections
- Explicit prohibitions ("NEVER start with praise")
- Behavioral constraints ("fewer than 4 lines")
- Memory structure instructions
- Git workflow guidance

**Key Insight from Reverse Engineering:**
> "Tool result instructions" — fixed warnings appended to every tool result dramatically increase adherence vs. system prompt alone.

**For Your Take-Home:**
Start **minimal** (~500-800 tokens), but consider one advanced technique:

```typescript
// Append context-aware hints to tool results
function formatToolResult(toolName: string, output: string): string {
  const hints: Record<string, string> = {
    bash: "Note: Prefer tool-based file operations over cat/head/tail.",
    read_file: "Examine this content carefully before making edits.",
    edit_file: "Verify your edit was applied correctly.",
  }
  return output + (hints[toolName] ? `\n\n[Hint: ${hints[toolName]}]` : '')
}
```

---

### 3. Context Management: Fresh Starts vs. Compaction

| Strategy | When to Use | Complexity |
|----------|-------------|------------|
| **Fresh start** | Short tasks, clear scope | None |
| **Manual compaction** | User-triggered summary | Low |
| **Auto-compaction** | Long sessions, 92% threshold | Medium |
| **Checkpoints** | Recovery, branching | High |

**Pi's Approach:** No compaction. Sessions are cheap, start fresh.

**Claude Code's Approach:** Auto-compaction + checkpoints + `/rewind` command.

**For Your Take-Home:**
Skip compaction entirely. It's a nice-to-have that adds significant complexity. If you have extra time, add a simple "context usage" indicator in the UI (token count / max tokens).

---

### 4. Streaming Granularity

**What Claude Code Streams:**
- Text deltas
- Tool call start (with partial JSON as it arrives)
- Tool execution metadata updates
- Tool results
- Session status changes

**What Pi Streams:**
- Same events, but simpler event types
- Differential rendering in TUI

**Critical for Your Assessment:**
The requirement explicitly says **"streaming tool calls to the interface"**. This means:

1. **Tool call start** — show the tool name + spinner immediately
2. **Input streaming** — show partial arguments as they arrive (impressive)
3. **Execution status** — show "running" state
4. **Result** — show output (truncated if large)

```typescript
// Event types that satisfy the streaming requirement
type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }  // <-- This is impressive
  | { type: 'tool_running'; id: string; metadata?: { title?: string } }
  | { type: 'tool_result'; id: string; output: string; error?: string }
  | { type: 'turn_complete' }
```

---

### 5. Permission Model: YOLO vs. Gates

**Pi (YOLO):**
> "Security theater. As soon as your agent can write code and run code, it's game over."

**Claude Code (6-layer gates):**
- Command injection detection
- Pattern-based allow/deny lists
- Session/project/global permission levels
- Haiku pre-screening for malicious content

**OpenCode (Configurable):**
```json
{
  "permission": {
    "bash": {
      "rm *": "deny",
      "git push": "ask",
      "*": "allow"
    }
  }
}
```

**For Your Take-Home:**
YOLO is fine. Add a **single** safety measure for demo purposes:

```typescript
// Simple command preview (not real security, just UX)
const DANGEROUS_PATTERNS = [/rm\s+-rf/, />\s*\/dev/, /mkfs/, /dd\s+if=/]

function previewCommand(cmd: string): { safe: boolean; warning?: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { safe: false, warning: `Potentially destructive: ${cmd}` }
    }
  }
  return { safe: true }
}
```

This shows awareness without implementing a full permission system.

---

## Recommended Architecture for Your Take-Home

Based on all the research, here's the "sweet spot" that balances impressiveness with achievability:

### Target: "Pi-like simplicity + OpenCode-like events + Claude Code-like streaming UX"

```
┌─────────────────────────────────────────────────────────────────┐
│                         Philosophy                               │
│  • Minimal system prompt (<1000 tokens)                         │
│  • 4 core tools (read, write, edit, bash)                       │
│  • Event-driven architecture for clean streaming                │
│  • No permissions, no subagents, no compaction                  │
│  • Focus: observable agent loop with great streaming UX         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      Technical Stack                             │
│  Runtime:     Bun                                                │
│  Server:      Hono + SSE                                         │
│  Frontend:    Solid.js + Tailwind                               │
│  LLM:         Direct Anthropic SDK (no Vercel AI SDK)           │
│  Validation:  Zod                                                │
└─────────────────────────────────────────────────────────────────┘
```

### System Prompt (Target: ~600 tokens)

```typescript
const SYSTEM_PROMPT = `You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

<tools>
- read_file: Read file contents. Use offset/limit for large files.
- write_file: Create or overwrite files. Creates parent directories automatically.
- edit_file: Replace exact text in a file. oldText must match exactly.
- bash: Execute shell commands. Use for ls, grep, find, git, etc.
</tools>

<guidelines>
- Use bash for file discovery (ls, find, grep)
- Read files before editing to understand context
- Use edit_file for surgical changes, write_file for new files or rewrites
- Be concise. Short responses are better.
- Show file paths clearly when working with files.
</guidelines>`
```

### Tool Definitions (Target: ~400 tokens total)

```typescript
const tools: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read file contents. Supports offset/limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Max lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file. Creates parent directories.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in a file. oldText must match exactly.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        oldText: { type: 'string', description: 'Text to find (exact match)' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command. Returns stdout/stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['command'],
    },
  },
]
```

---

## What Would Impress Reviewers

Based on the HumanLayer assessment criteria, here's what matters most:

| Priority | Feature | Why It Matters |
|----------|---------|----------------|
| **1** | **Streaming tool calls visible in UI** | Explicit requirement. Must work. |
| **2** | Clean, typed event architecture | Shows system design thinking |
| **3** | Minimal but effective prompt | Shows you understand the research |
| **4** | Working agent loop | Core functionality |
| **5** | Polished UI | Makes demo impressive |

### Differentiators (if time permits):

1. **Partial JSON streaming** — Show tool arguments as they arrive
2. **Token counter** — Display context usage in UI
3. **Command preview** — Show bash commands before execution
4. **Session persistence** — Save/load conversations (simple JSON file)

---

## Time Budget (Revised for Research Depth)

| Phase | Time | Focus |
|-------|------|-------|
| **Setup** | 15min | Bun + Hono + Vite + Solid scaffold |
| **Agent Core** | 45min | Streaming loop, 4 tools, event bus |
| **SSE Endpoint** | 20min | Stream events to frontend |
| **UI: Basic Chat** | 30min | Message list, input, streaming text |
| **UI: Tool Calls** | 30min | Visual tool call cards with status |
| **Polish** | 20min | Error handling, README, styling |
| **Testing** | 20min | Manual testing, edge cases |

**Total: ~3 hours** for a solid submission

---

Would you like me to scaffold out the actual project files now? I can create a working starting point with the architecture we've discussed.
