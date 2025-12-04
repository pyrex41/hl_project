# SCUD Task Management

This project uses SCUD for task management.

## Session Workflow

1. **Start**: `scud warmup` - orient yourself
2. **Claim**: `/scud:task-next --claim --name "Claude"`
3. **Work**: Reference with `/scud:task-show <id>`
4. **Commit**: `scud commit -m "message"` (auto-prefixes task ID)
5. **Complete**: `/scud:task-status <id> done`

## Commands

| Command | Purpose |
|---------|---------|
| `scud warmup` | Session orientation |
| `scud next` | Find next task |
| `scud show <id>` | View task details |
| `scud set-status <id> <status>` | Update status |
| `scud commit` | Task-aware commit |
| `scud stats` | Completion stats |

## Slash Commands

All `/scud:task-*` commands are available for task management.
