---
description: Create git commit(s) for current changes
argument-hint: [-m "message"]
---

Review the current git changes and create appropriate commit(s).

Steps:
1. Run `git status` to see the current state
2. Run `git diff` to see unstaged changes
3. Run `git diff --staged` to see staged changes
4. If nothing is staged, suggest what files to stage based on the changes
5. Propose a clear, conventional commit message
6. Ask for user confirmation before committing
7. Execute `git commit` with the approved message

If the user provided arguments, use them:
$ARGUMENTS

Guidelines:
- Use conventional commit format (feat:, fix:, docs:, refactor:, etc.)
- Keep the first line under 72 characters
- Add body text for complex changes
- Never force push or amend without explicit permission
