# Slash Commands Implementation Plan

## Overview
Add a file-based slash command system inspired by Claude Code, allowing users to invoke predefined workflows via `/command` syntax.

## Requirements (from user)
- Support both `.agent/commands/` and `.claude/commands/` directories
- Built-in commands: help, commit, status, review
- SCUD commands as separate files that use the scud tool
- Main agent only (not subagents)
- Commands are for user to tell the agent what to do

## Architecture

### Command File Format
```markdown
---
description: Short description shown in /help
allowed-tools: Optional tool restrictions (e.g., Bash(git:*))
argument-hint: Optional hint for arguments
---

# Command Title

Prompt content that gets expanded when command is invoked.
$ARGUMENTS is replaced with user-provided args.
```

### Command Resolution Order
1. Project-specific: `.agent/commands/` → `.claude/commands/`
2. Built-in defaults (bundled with agent)

### Message Flow
```
User: /commit -m "feat: add login"
  ↓
index.ts: Detect /command pattern
  ↓
commands.ts: Load & expand command file
  ↓
Replace $ARGUMENTS with "-m \"feat: add login\""
  ↓
Send expanded prompt to agentLoop()
```

---

## Phase 1: Core Infrastructure

### 1.1 Create commands.ts module

**File:** `agent/src/server/commands.ts`

```typescript
interface CommandDef {
  name: string
  description: string
  allowedTools?: string[]
  argumentHint?: string
  content: string
  source: 'builtin' | 'project'
  path?: string
}

// Load command from file path
async function loadCommandFile(path: string): Promise<CommandDef | null>

// Find command by name (checks project dirs, then builtins)
async function findCommand(name: string, workingDir: string): Promise<CommandDef | null>

// List all available commands
async function listCommands(workingDir: string): Promise<CommandDef[]>

// Expand command with arguments
function expandCommand(command: CommandDef, args: string): string
```

### 1.2 Built-in Command Files

**Location:** `agent/src/server/commands/` (bundled at build time)

Files to create:
- `help.md` - List available commands
- `commit.md` - Git commit workflow
- `status.md` - Git status summary
- `review.md` - PR review workflow

### 1.3 Message Interception

**File:** `agent/src/server/index.ts`

In `/api/chat` handler, before calling agentLoop:
```typescript
// Check if message starts with /
if (userMessage.startsWith('/')) {
  const expanded = await expandSlashCommand(userMessage, workingDir)
  if (expanded) {
    userMessage = expanded
  }
}
```

---

## Phase 2: Built-in Commands

### 2.1 /help
```markdown
---
description: List available slash commands
---

List all available slash commands with their descriptions.
Format as a clean table or list.
```

### 2.2 /commit
```markdown
---
description: Create git commit(s) for current changes
---

Review the current git changes and create appropriate commit(s).

1. Run `git status` and `git diff --staged`
2. If nothing staged, suggest what to stage
3. Propose commit message(s)
4. Ask for confirmation before committing
5. Execute `git commit` with the approved message

$ARGUMENTS
```

### 2.3 /status
```markdown
---
description: Show project status (git, tasks)
---

Show current project status:
1. Git status (branch, changes, unpushed commits)
2. If SCUD is available, show task stats
```

### 2.4 /review
```markdown
---
description: Review a pull request
argument-hint: [PR number or URL]
---

Review the specified pull request.

1. Get PR details: `gh pr view $ARGUMENTS --json title,body,additions,deletions,changedFiles`
2. Get the diff: `gh pr diff $ARGUMENTS`
3. Analyze the changes for:
   - Code quality issues
   - Potential bugs
   - Missing tests
   - Documentation gaps
4. Provide constructive feedback

$ARGUMENTS
```

---

## Phase 3: SCUD Command Files

Create in `.claude/commands/scud/` (project-level, using scud tool):

### 3.1 /scud:tasks (alias for list)
```markdown
---
description: List SCUD tasks
argument-hint: [--status pending|in-progress|done|blocked] [--tag <tag>]
---

Use the scud tool to list tasks. Parse arguments for status and tag filters.
$ARGUMENTS
```

### 3.2 /scud:next
```markdown
---
description: Get and optionally claim next task
argument-hint: [--claim] [--tag <tag>]
---

Use the scud tool with action "next" to find available work.
$ARGUMENTS
```

### 3.3 /scud:stats
```markdown
---
description: Show task completion statistics
argument-hint: [--tag <tag>]
---

Use the scud tool with action "stats".
$ARGUMENTS
```

---

## Phase 4: Enhanced Features

### 4.1 Namespaced Commands
- `/scud:tasks` → loads from `scud/tasks.md`
- `/cl:commit` → loads from `cl/commit.md`
- `/review` → loads from `review.md` (no namespace)

### 4.2 Command Discovery
- Scan directories recursively
- Support nested namespaces

### 4.3 Argument Parsing
- Support `$ARGUMENTS` placeholder (full string)
- Support `$1`, `$2`, etc. for positional args
- Support `$FLAG_name` for named flags

---

## Implementation Checklist

### Phase 1 (Core)
- [x] Create `commands.ts` module
- [x] Implement command file parser (YAML frontmatter + markdown)
- [x] Implement command discovery (project + builtin paths)
- [x] Add message interception in `index.ts`
- [x] Bundle builtin commands directory

### Phase 2 (Builtins)
- [x] Create `/help` command
- [x] Create `/commit` command
- [x] Create `/status` command
- [x] Create `/review` command

### Phase 3 (SCUD Commands)
- [x] Create `/scud:tasks` command file (pre-existing in .claude/commands/scud/)
- [x] Create `/scud:next` command file (pre-existing in .claude/commands/scud/)
- [x] Create `/scud:stats` command file (pre-existing in .claude/commands/scud/)

### Phase 4 (Polish)
- [ ] Add namespace support
- [ ] Improve argument parsing
- [ ] Add command autocomplete hints to frontend

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `agent/src/server/commands.ts` | Create | Command loading/expansion logic |
| `agent/src/server/commands/*.md` | Create | Built-in command files |
| `agent/src/server/index.ts` | Modify | Add slash command interception |
| `.claude/commands/scud/*.md` | Create | SCUD command files |

---

## Success Criteria

1. `/help` lists all available commands
2. `/commit` guides through commit workflow
3. `/review 123` reviews PR #123
4. `/scud:next --claim` claims next available task
5. Custom commands in `.agent/commands/` are discovered
6. Commands expand to full prompts sent to agent
