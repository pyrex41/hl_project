---
description: Review a pull request
argument-hint: <PR number or URL>
---

Review the specified pull request thoroughly.

PR to review: $ARGUMENTS

Steps:
1. Get PR details using: `gh pr view $ARGUMENTS --json title,body,author,additions,deletions,changedFiles,commits`
2. Get the diff using: `gh pr diff $ARGUMENTS`
3. If the PR is large, examine files in logical groups

Review criteria:
- **Code Quality**: Clean code, proper naming, no code smells
- **Bugs & Logic**: Off-by-one errors, null handling, edge cases
- **Security**: Input validation, authentication, data exposure
- **Performance**: N+1 queries, unnecessary computation, memory leaks
- **Tests**: Adequate coverage, edge cases tested
- **Documentation**: Comments where needed, updated docs

Output format:
1. Summary of what the PR does
2. List of findings organized by severity (critical, high, medium, low)
3. Specific line-by-line feedback for important issues
4. Overall recommendation (approve, request changes, needs discussion)

Be constructive and specific. Reference file paths and line numbers when possible.
