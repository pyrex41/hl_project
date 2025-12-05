# AI-Assisted MCP Server Setup Implementation Plan

## Overview

Add an "Setup with AI" button to the MCP panel that triggers an AI-guided flow for configuring MCP servers. Users can paste documentation or GitHub URLs, and the agent will parse them, extract configuration, ask for required API keys, and save the config directly.

## Current State Analysis

### Key Discoveries:
- MCP config stored at `.agent/mcp.json` - simple JSON file
- `MCPServerConfig` supports `env` for environment variables (API keys) - `types.ts:23`
- `MCPServerConfig` supports `headers` for HTTP auth - `types.ts:29`
- Agent has WebFetch tool to grab README content from URLs
- Agent has Write tool to update config files directly
- MCPPanel already has `onClose` prop and can insert text into chat via parent

### Config Structure:
```json
{
  "servers": [
    {
      "id": "skyfi",
      "name": "SkyFi MCP",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "skyfi-mcp-client", "--server", "https://...", "--api-key", "..."],
      "env": { "SKYFI_API_KEY": "..." },
      "enabled": true,
      "autoConnect": true
    }
  ]
}
```

## Desired End State

1. MCP panel has "Setup with AI ✨" button
2. Clicking it closes panel and inserts a prompt into the chat
3. User pastes docs or URL
4. Agent fetches/parses docs, extracts config pattern
5. Agent asks for required API keys/secrets
6. Agent writes config to `.agent/mcp.json`
7. User can then connect via MCP panel

## What We're NOT Doing

- Not building a complex in-panel wizard
- Not creating new API endpoints
- Not storing secrets in a separate secure store (using existing `env` field)
- Not auto-connecting after setup (user does this manually)

## Implementation Approach

Simple UI change + leverage existing agent capabilities. The "smarts" come from the agent's natural ability to parse docs and use existing tools.

## Phase 1: Add "Setup with AI" Button

### Overview
Add a button to MCPPanel that closes the panel and triggers the AI setup flow in the main chat.

### Changes Required:

#### 1.1 Update MCPPanel Props

**File**: `/Users/reuben/gauntlet/hl_project/agent/src/client/MCPPanel.tsx`
**Changes**: Add callback prop for AI setup

```tsx
export interface MCPPanelProps {
  workingDir: string
  onCommandSelect?: (command: MCPCommand) => void
  onClose?: () => void
  onSetupWithAI?: () => void  // NEW: Trigger AI setup flow
}
```

#### 1.2 Add Setup with AI Button

**File**: `/Users/reuben/gauntlet/hl_project/agent/src/client/MCPPanel.tsx`
**Changes**: Add button below "Add MCP Server" in the servers tab

Add after the "+ Add MCP Server" button (around line 345):

```tsx
<Show when={!showAddServer()}>
  <button onClick={() => setShowAddServer(true)} class="mcp-btn mcp-btn-full">
    + Add MCP Server
  </button>
  <button
    onClick={() => props.onSetupWithAI?.()}
    class="mcp-btn mcp-btn-full mcp-btn-ai"
  >
    Setup with AI ✨
  </button>
</Show>
```

#### 1.3 Add Button Styling

**File**: `/Users/reuben/gauntlet/hl_project/agent/src/client/MCPPanel.tsx`
**Changes**: Add CSS for the AI button (in the style block)

```css
.mcp-btn-ai {
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  border-color: #6366f1;
  margin-top: 4px;
}

.mcp-btn-ai:hover {
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
}
```

#### 1.4 Wire Up in App.tsx

**File**: `/Users/reuben/gauntlet/hl_project/agent/src/client/App.tsx`
**Changes**: Pass callback that closes panel and inserts prompt

Find the MCPPanel usage (around line 2782) and add the handler:

```tsx
<MCPPanel
  workingDir="."
  onClose={() => setShowMCPPanel(false)}
  onSetupWithAI={() => {
    setShowMCPPanel(false)
    setInput(`Help me set up an MCP server.

Paste the documentation, GitHub README URL, or describe the MCP server you want to configure:

`)
  }}
  onCommandSelect={(cmd) => {
    setInput(`/${cmd.name} `)
    setShowMCPPanel(false)
  }}
/>
```

### Success Criteria:

#### Automated Verification:
- [x] Build succeeds: `cd /Users/reuben/gauntlet/hl_project/agent && bun run build`

#### Manual Verification:
- [ ] "Setup with AI ✨" button appears in MCP panel below "Add MCP Server"
- [ ] Button has purple gradient styling
- [ ] Clicking button closes MCP panel
- [ ] Clicking button inserts setup prompt into chat input
- [ ] Cursor is in the input ready to paste docs

---

## Phase 2: Test the AI Flow

### Overview
No code changes needed - test that the agent can successfully configure an MCP server using existing tools.

### Test Scenarios:

#### 2.1 Test with GitHub URL (SkyFi example)
1. Click "Setup with AI ✨"
2. Paste: `https://github.com/pyrex41/skyfi_mcp`
3. Agent should:
   - Use WebFetch to get README
   - Extract that it's an npx-based server
   - Identify required: server URL, access key, API key
   - Ask user for these values
   - Write config to `.agent/mcp.json`

#### 2.2 Test with Pasted Docs (PAL MCP example)
1. Click "Setup with AI ✨"
2. Paste the PAL MCP README content
3. Agent should:
   - Parse the uvx/npx installation pattern
   - Identify GEMINI_API_KEY etc as needed
   - Ask for API keys
   - Write config

#### 2.3 Test with Simple Description
1. Click "Setup with AI ✨"
2. Type: "I want to add the filesystem MCP server"
3. Agent should:
   - Use WebSearch to find @modelcontextprotocol/server-filesystem
   - Extract config pattern
   - Write config

### Success Criteria:

#### Manual Verification:
- [ ] Agent successfully fetches GitHub README via WebFetch
- [ ] Agent correctly parses MCP config patterns from docs
- [ ] Agent asks for required API keys/secrets
- [ ] Agent writes valid JSON to `.agent/mcp.json`
- [ ] New server appears in MCP panel after refresh
- [ ] Server can be connected successfully

---

## Testing Strategy

### Manual Testing Steps:
1. Start the agent: `cd agent && bun run dev`
2. Click MCP button (⬡) in header
3. Click "Setup with AI ✨"
4. Verify panel closes and prompt appears in input
5. Paste a GitHub URL (e.g., https://github.com/anthropics/anthropic-quickstarts)
6. Follow agent prompts to provide API keys
7. Verify `.agent/mcp.json` is created/updated
8. Open MCP panel and verify new server appears
9. Try to connect to the server

## References

- MCP Panel component: `agent/src/client/MCPPanel.tsx`
- MCP config: `agent/src/server/mcp/config.ts`
- MCP types: `agent/src/server/mcp/types.ts`
- App component: `agent/src/client/App.tsx:2782`
- Example MCP READMEs:
  - SkyFi: https://github.com/pyrex41/skyfi_mcp
  - PAL MCP: https://github.com/BeehiveInnovations/pal-mcp-server
