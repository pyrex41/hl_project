# Session Management Fix Implementation Plan

## Overview

Fix the session management bug where sessions are not being saved/displayed properly. The root cause is that `POST /api/sessions` creates a session object but never persists it to disk.

## Current State Analysis

### The Bug

1. `POST /api/sessions` (index.ts:210-214) creates a session via `createSession()` but never calls `saveSession()`
2. The session ID is returned to the client and stored in state
3. When user sends a message, `/api/chat` tries to load the session by ID (index.ts:276-278)
4. Since the session was never saved to disk, `loadSession()` returns `null`
5. With `session` being `null`, the chat endpoint skips all session persistence (index.ts:361-385)
6. Result: Sessions are never saved, session list always shows empty

### Key Files

- `agent/src/server/sessions.ts` - Session CRUD operations
- `agent/src/server/index.ts:210-214` - POST /api/sessions endpoint (BUG HERE)
- `agent/src/client/App.tsx:705-721` - createNewSession() client function

## Desired End State

1. When a user starts the app, current session (if any) should be visible in session list
2. When user clicks "+", the current session should appear in the saved sessions list
3. Sessions should persist across page refreshes
4. Session list should update in real-time as messages are sent

### Verification
- Start app fresh → session list should show "No saved sessions"
- Send a message → session should appear in list (via SSE update)
- Click "+" → old session appears in list, new empty state
- Send message in new session → both sessions visible in list
- Refresh page → both sessions still visible

## What We're NOT Doing

- Adding session renaming UI (out of scope)
- Adding session search/filter (out of scope)
- Changing session storage format (unnecessary)
- Adding session export/import (out of scope)

## Implementation Approach

Simple one-line fix: Call `saveSession()` in the POST /api/sessions endpoint immediately after creating the session.

## Phase 1: Fix Session Persistence

### Overview
Add `saveSession()` call to the POST /api/sessions endpoint.

### Changes Required:

#### 1.1 Server Session Creation Endpoint

**File**: `agent/src/server/index.ts`
**Lines**: 210-214
**Changes**: Add saveSession() call after createSession()

Current code:
```typescript
app.post('/api/sessions', async (c) => {
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const session = await createSession(workingDir)
  return c.json({ session })
})
```

Fixed code:
```typescript
app.post('/api/sessions', async (c) => {
  const body = await c.req.json()
  const workingDir: string = body.workingDir || process.cwd()
  const session = await createSession(workingDir)
  await saveSession(session)  // <-- ADD THIS LINE
  return c.json({ session })
})
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd agent && bun run build`
- [x] No lint errors: `cd agent && bun run lint` (no lint script defined)

#### Manual Verification:
- [ ] Start fresh: Session list shows "No saved sessions" initially
- [ ] Send message: Session appears in list automatically
- [ ] Click "+": Current session moves to saved sessions, new chat starts
- [ ] Send message in new session: Both sessions visible in list
- [ ] Refresh browser: Both sessions persist and are visible
- [ ] Click on old session: Loads correctly with all messages

---

## Testing Strategy

### Unit Tests:
- N/A - existing session tests should still pass

### Manual Testing Steps:
1. Clear `.agent/sessions/` directory
2. Start the agent UI
3. Open sessions panel (≡ icon) - should show "No saved sessions"
4. Type and send a message
5. Open sessions panel - should show 1 session
6. Click "+" to start new chat
7. Open sessions panel - should still show 1 session (the old one)
8. Send a message in new chat
9. Open sessions panel - should show 2 sessions
10. Click on older session - should load with original messages
11. Refresh page - both sessions should persist

## Performance Considerations

None - this adds one file write operation when creating a session, which is negligible.

## Migration Notes

None required - existing saved sessions will continue to work. Previously unsaved sessions are already lost (never persisted).

## References

- `agent/src/server/sessions.ts:49-57` - saveSession() function
- `agent/src/server/index.ts:361-385` - existing session save logic in chat endpoint
