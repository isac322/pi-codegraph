export interface CodeGraphSettings {
  autoSync: boolean;
  autoGc: boolean;
  indexStore: string;
  workerIdleTimeoutMs: number;
  maxWorkers: number;
  requestTimeoutMs: number;
  syncMinIntervalMs: number;
  maxOutputChars: number;
  allowedProjectRoots: string[];
  promptInjection: boolean;
  codegraphExecutable: string;
  configFile: string;
}

export interface WorkspaceIdentity {
  sourcePath: string;
  repoRoot: string;
  repoIdentity: string;
  worktreeIdentity: string;
  gitCommonDir: string;
}

export interface WorkspaceStatus {
  state: "ready" | "uninitialized" | "missing" | string;
  sourcePath: string;
  indexPath: string | null;
  lastSyncAt: string | number | null;
  identityMatches: boolean;
  managed?: boolean;
}

export interface JsonRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface JsonRpcErrorShape {
  code?: number | string;
  message: string;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export interface CodeGraphTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

export interface ToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}
