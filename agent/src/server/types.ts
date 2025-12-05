// Message types for conversation history
export interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  output?: string
  details?: ToolResultDetails
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
}

// Structured tool result - keeps LLM context lean, UI data separate
export interface ToolResult {
  output: string        // For LLM (concise)
  details?: ToolResultDetails  // For UI (rich rendering)
}

export interface ToolResultDetails {
  type: 'file' | 'diff' | 'command' | 'error'
  data: unknown
}

// Agent events for SSE streaming
export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_running'; id: string; metadata?: { title?: string } }
  | { type: 'tool_result'; id: string; output: string; details?: ToolResultDetails; error?: string }
  | { type: 'turn_complete'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; error: string }
  | { type: 'retry_countdown'; seconds: number; reason: string }
