# MCP Panel Fixes Implementation Plan

## Overview

Fix three issues with the MCP server panel:
1. **"process not defined" error** - Browser code references Node.js `process.cwd()` which doesn't exist in browser context
2. **Hokey plug icon** - The emoji 🔌 doesn't match the Unicode symbol style used by other header buttons
3. **Add MCP servers UI** - Already exists in MCPPanel.tsx but the panel doesn't open due to the error above

## Current State Analysis

### Key Discoveries:
- The "process not defined" error occurs at `App.tsx:2783` where `process.cwd` is referenced in browser code
- Header buttons use Unicode symbols: `≡` (sessions), `+` (new chat), `⚙` (settings), but MCP uses emoji `🔌`
- The "Add MCP Server" UI is already fully implemented in `MCPPanel.tsx:319-406` with a complete form
- The MCPPanel needs a `workingDir` prop which should come from the server, not `process.cwd()`

### Root Cause:
The code `workingDir={process.cwd ? process.cwd() : '.'}` at `App.tsx:2783` attempts to use a Node.js API that doesn't exist in the browser. This throws "process not defined" when the MCP panel tries to open.

## Desired End State

1. MCP panel opens without errors
2. Icon matches overall header button style (Unicode symbol instead of emoji)
3. Working directory is fetched from the server or uses a sensible default

## What We're NOT Doing

- Not changing the MCPPanel functionality (it already has "Add MCP Server" feature)
- Not changing server-side MCP implementation
- Not adding new MCP server management features beyond what exists

## Implementation Approach

Two-phase approach: First fix the icon for quick visual win, then fix the process error with proper server integration.

## Phase 1: Fix the MCP Icon

### Overview
Replace the emoji plug icon with a Unicode symbol that matches the other header buttons.

### Changes Required:

#### 1.1 Update MCP Button Icon

**File**: `/Users/reuben/gauntlet/hl_project/agent/src/client/App.tsx`
**Line**: 1738
**Changes**: Replace emoji `🔌` with Unicode symbol `⌁` (electric arrow) or `⚡` (high voltage) or `◈` (diamond with inside)

Looking at the existing icons:
- Sessions: `≡` (hamburger menu)
- New Chat: `+` (plus)
- Settings: `⚙` (gear)

For MCP servers/connections, a good Unicode symbol would be `⬡` (hexagon - represents interconnection/network) or `⧫` (filled diamond) or simpler `⋯` (horizontal ellipsis for connections).

Recommended: Use `⬡` (U+2B21 White Hexagon) as it suggests network/connection nodes.

```tsx
// Before (line 1738):
<span class="btn-icon">🔌</span>

// After:
<span class="btn-icon">⬡</span>
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd /Users/reuben/gauntlet/hl_project/agent && bun run build`
- [x] No lint errors: `cd /Users/reuben/gauntlet/hl_project/agent && bun run lint` (no lint script, but build succeeded)

#### Manual Verification:
- [ ] MCP icon visually matches the style of other header buttons
- [ ] Icon renders properly at 16px font size
- [ ] No emoji "color" appearance - should be monochrome like other icons

---

## Phase 2: Fix "process not defined" Error

### Overview
Replace the browser-side `process.cwd()` call with a working directory value from the server or a sensible default.

### Changes Required:

#### 2.1 Add Server-Side Working Directory State

**File**: `/Users/reuben/gauntlet/hl_project/agent/src/client/App.tsx`

**Option A (Simpler - Recommended)**: Use current window location or empty string

The `workingDir` is only used for API calls to scope which MCP config file to read. Since the server already knows its working directory, we can:
1. Pass an empty string or `.` as the working dir
2. Let the server use its own `process.cwd()` when the client doesn't specify one

**Changes**:

```tsx
// Before (lines 2782-2784):
<MCPPanel
  workingDir={process.cwd ? process.cwd() : '.'}
  onClose={() => setShowMCPPanel(false)}

// After:
<MCPPanel
  workingDir="."
  onClose={() => setShowMCPPanel(false)}
```

This is the minimal fix. The server already handles the working directory via `process.cwd()` in its API handlers.

**Option B (Alternative - if server needs explicit path)**: Fetch working directory from server

Add a new API endpoint and fetch it on mount, but this adds complexity. Option A should work.

### Success Criteria:

#### Automated Verification:
- [x] Build succeeds: `cd /Users/reuben/gauntlet/hl_project/agent && bun run build`
- [x] No type errors: `cd /Users/reuben/gauntlet/hl_project/agent && bun run typecheck` (pre-existing type errors in unrelated files)

#### Manual Verification:
- [ ] Clicking MCP button opens the panel without "process not defined" error
- [ ] MCP panel loads and shows servers (if any are configured)
- [ ] "Add MCP Server" button is visible and functional
- [ ] Can add a new MCP server via the form
- [ ] Can connect/disconnect servers

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the MCP panel opens correctly before proceeding.

---

## Testing Strategy

### Unit Tests:
- No new tests needed - this is a bug fix

### Manual Testing Steps:
1. Start the agent: `cd agent && bun run dev`
2. Click the MCP button in the header
3. Verify panel opens without JavaScript errors
4. Click "+ Add MCP Server" button
5. Fill in form fields and verify they work
6. Verify icon looks consistent with other header icons

## References

- MCP Panel component: `agent/src/client/MCPPanel.tsx`
- App header buttons: `agent/src/client/App.tsx:1712-1739`
- CSS styles: `agent/src/client/styles.css:99-122`
