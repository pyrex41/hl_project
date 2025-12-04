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
│  • YOLO mode (no permission prompts - just execute)             │
│  • No subagents, no compaction                                  │
│  • Focus: observable agent loop with great streaming UX         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      Technical Stack                             │
│  Runtime:     Bun                                                │
│  Server:      Hono + SSE                                         │
│  Frontend:    Solid.js + minimal CSS (terminal-style)           │
│  LLM:         Direct Anthropic SDK (no Vercel AI SDK)           │
│  Validation:  Zod                                                │
└─────────────────────────────────────────────────────────────────┘
```

### System Prompt (Target: ~100-150 tokens)

Pi's Terminal-Bench results prove that minimal prompts work. Go even smaller:

```typescript
const SYSTEM_PROMPT = `You are a coding assistant. Help with coding tasks by reading files, executing commands, editing code, and writing files.

Tools: read_file, write_file, edit_file, bash

Guidelines:
- Read files before editing
- Use edit_file for precise changes (oldText must match exactly)
- Use bash for ls, grep, find, git
- Be concise`
```

That's ~60 tokens. The tools are self-documenting via their schemas.

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

## Structured Tool Results

Tools should return structured data that separates LLM-facing output from UI-facing details:

```typescript
interface ToolResult {
  output: string        // What goes back to the LLM (concise text)
  details?: {           // Rich data for UI rendering (not sent to LLM)
    type: 'file' | 'diff' | 'command' | 'error'
    data: unknown       // Type-specific structured data
  }
}

// Example: edit_file returns minimal text for LLM, rich diff for UI
{
  output: "Replaced text in src/index.ts (lines 15-20)",
  details: {
    type: 'diff',
    data: {
      path: "src/index.ts",
      before: "const x = 1",
      after: "const x = 2",
      lineRange: [15, 20]
    }
  }
}
```

This keeps LLM context lean while enabling rich tool visualization in the UI.

---

## External Task Management Support

The agent should support external task/todo systems via CLAUDE.md or AGENTS.md scaffolding. This is more flexible than a built-in todo system:

### Design

1. **Read instructions from CLAUDE.md/AGENTS.md at session start**
2. **Inject relevant sections into system prompt** (if present)
3. **Support common patterns:**
   - Task file paths (e.g., `.scud/tasks/tasks.scg`)
   - CLI commands (e.g., `scud warmup`, `scud next`)
   - Slash commands (e.g., `/scud:task-next`)

### Implementation

```typescript
// On session init, check for instruction files
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']

async function loadProjectInstructions(workDir: string): Promise<string | null> {
  for (const file of INSTRUCTION_FILES) {
    const path = join(workDir, file)
    if (await exists(path)) {
      return await readFile(path, 'utf-8')
    }
  }
  return null
}

// Append to system prompt if found
const projectInstructions = await loadProjectInstructions(cwd)
const systemPrompt = SYSTEM_PROMPT + (projectInstructions
  ? `\n\n<project_instructions>\n${projectInstructions}\n</project_instructions>`
  : '')
```

### Benefits
- No built-in todo complexity
- Works with any external system (SCUD, TaskMaster, etc.)
- User controls workflow via their own config files
- Matches how Claude Code and other agents handle project context

---

## Slash Commands

Simple user-defined prompts triggered by `/name` pattern. Low complexity, high value.

### Design

```
.claude/commands/
├── commit.md      # /commit → git commit workflow
├── review.md      # /review → code review checklist
└── test.md        # /test → test generation prompt
```

### Implementation

```typescript
// Detect slash command in user input
function parseSlashCommand(input: string): { command: string; args: string } | null {
  const match = input.match(/^\/(\w+)(?:\s+(.*))?$/)
  if (!match) return null
  return { command: match[1], args: match[2] || '' }
}

// Load and expand command
async function expandCommand(workDir: string, command: string, args: string): Promise<string | null> {
  const paths = [
    join(workDir, '.claude/commands', `${command}.md`),
    join(workDir, '.agent/commands', `${command}.md`),
  ]

  for (const path of paths) {
    if (await exists(path)) {
      let content = await readFile(path, 'utf-8')
      return content.replace(/\$ARGUMENTS/g, args)
    }
  }
  return null
}

// In message handler
const parsed = parseSlashCommand(userMessage)
if (parsed) {
  const expanded = await expandCommand(cwd, parsed.command, parsed.args)
  if (expanded) {
    userMessage = expanded  // Replace command with expanded prompt
  }
}
```

### Example Command: `/commit`

```markdown
<!-- .claude/commands/commit.md -->
Review the current git diff and create a commit with a descriptive message.

Steps:
1. Run `git diff --staged` to see changes
2. If nothing staged, run `git diff` and suggest what to stage
3. Write a concise commit message following conventional commits
4. Run `git commit -m "message"`

$ARGUMENTS
```

---

## Skills (Optional)

Reusable prompt fragments loaded on-demand. Lower priority than commands.

### Design

Skills are markdown files that can be:
1. **Explicitly invoked**: `/skill:code-review` injects the skill prompt
2. **Auto-triggered**: Based on patterns in conversation (stretch goal)

```
.claude/skills/
├── code-review.md     # Code review checklist
├── test-gen.md        # Test generation template
└── refactor.md        # Refactoring guidelines
```

### Implementation

```typescript
// Load available skills at session start
async function loadSkills(workDir: string): Promise<Map<string, string>> {
  const skills = new Map<string, string>()
  const dirs = ['.claude/skills', '.agent/skills']

  for (const dir of dirs) {
    const skillDir = join(workDir, dir)
    if (await exists(skillDir)) {
      for (const file of await readdir(skillDir)) {
        if (file.endsWith('.md')) {
          const name = file.replace('.md', '')
          const content = await readFile(join(skillDir, file), 'utf-8')
          skills.set(name, content)
        }
      }
    }
  }
  return skills
}

// Invoke skill via /skill:name
function parseSkillCommand(input: string): string | null {
  const match = input.match(/^\/skill:(\w+)/)
  return match ? match[1] : null
}
```

### Example Skill: `code-review.md`

```markdown
<!-- .claude/skills/code-review.md -->
## Code Review Checklist

When reviewing code, check for:

### Correctness
- [ ] Logic errors
- [ ] Edge cases handled
- [ ] Error handling present

### Security
- [ ] No hardcoded secrets
- [ ] Input validation
- [ ] SQL/command injection prevention

### Style
- [ ] Consistent naming
- [ ] No dead code
- [ ] Comments where needed
```

### Priority

- **Commands**: Medium priority - useful for workflow automation
- **Skills**: Low priority - nice-to-have, can skip for MVP

---

## Terminal-Style UI

Keep the UI simple and focused. A terminal aesthetic reduces complexity while still looking polished.

### Design Principles

```
┌─────────────────────────────────────────────────────────────────┐
│  agent v0.1                              [tokens: 1.2k/200k] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  > read_file src/index.ts                          [done ✓]    │
│    ─────────────────────────────────────                        │
│    const app = new Hono()                                       │
│    app.get('/', (c) => c.text('Hello'))                         │
│    ...                                                          │
│                                                                 │
│  > edit_file src/index.ts                      [running...]    │
│    - oldText: "Hello"                                           │
│    + newText: "Hello World"                                     │
│                                                                 │
│  The file has been updated successfully.                        │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  > _                                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Key Elements

- **Monospace everything** - no complex typography
- **Dark background, light text** - terminal aesthetic
- **Tool calls as indented blocks** - no fancy cards
- **Status indicators** - `[running...]`, `[done ✓]`, `[error ✗]`
- **Streaming is natural** - text appends like a terminal
- **Minimal CSS** - ~50-100 lines max

### What to Include

| Feature | Include | Reason |
|---------|---------|--------|
| Monospace fonts | Yes | Terminal aesthetic |
| Auto-scroll | Yes | Essential UX |
| Syntax highlighting | Yes | High value, low effort (Prism) |
| Visual diffs | Yes | `- old` / `+ new` with colors |
| Status bar | Yes | Token count, agent status |
| Collapsible sections | No | Adds complexity |
| Animations | No | Not terminal-like |
| Copy buttons | No | Users can select text |

---

## Agent DAG Visualization (Stretch Goal)

For HumanLayer specifically, observability into agent execution is valuable. A DAG visualization shows:

```
User Message
    │
    ▼
┌─────────────┐
│ LLM Call #1 │ 1.2s, 450 tokens
└─────────────┘
    │
    ├──▶ [tool] read_file src/index.ts ──▶ 1.5kb content
    │
    ├──▶ [tool] bash "ls -la" ──▶ 12 files
    │
    ▼
┌─────────────┐
│ LLM Call #2 │ 0.8s, 320 tokens
└─────────────┘
    │
    ├──▶ [tool] edit_file src/index.ts ──▶ success
    │
    ▼
┌─────────────┐
│ LLM Call #3 │ 0.3s, 80 tokens
└─────────────┘
    │
    ▼
Final Response: "I've updated the file..."
```

### Implementation Ideas

- **Slide-out panel** triggered by button/keyboard shortcut
- **Or separate `/debug` route** showing execution history
- **Each node expandable** to show full content
- **Timing and token usage** per step
- **Could use simple ASCII art** or a library like dagre-d3

### Why It's Valuable

- Shows exactly what the agent did
- Helps debug unexpected behavior
- Demonstrates understanding of agent architecture
- Aligns with HumanLayer's human-in-the-loop focus

### Priority

Low - only if time permits after core features are complete.

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
