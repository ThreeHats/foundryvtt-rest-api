import { ModuleLogger } from "../utils/logger";
import type { WebSocketManager } from "./webSocketManager";

// remoteRequest.ts implements the cross-world tunnel CLIENT side. It's the
// public API exported as `module.api.remoteRequest(...)` that other modules
// (like the server-to-server transfer module) call to invoke actions on
// other Foundry worlds owned by the same relay account.
//
// Architecture:
//   1. Source module calls module.api.remoteRequest(targetClientId, action, payload)
//   2. We send a "remote-request" WS message via the existing connection
//   3. The relay validates source's connection token has allowedTargetClients
//      including targetClientId AND remoteScopes including the action's scope
//   4. The relay forwards the action to the target Foundry module
//   5. Target processes, responds — relay routes the response back to source
//      as a "remote-response" message with our requestId
//   6. We resolve the matching pending Promise
//
// The source module never holds an HTTP API key. The cross-world capability
// is bounded by what the source's connection token explicitly allows.

interface PendingRemoteRequest {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeoutHandle: number;
}

const pendingRemoteRequests = new Map<string, PendingRemoteRequest>();

// Default timeout — generous because some actions (like uploading a large
// file or transferring an entity that requires a headless auto-start) can
// take a while to complete.
const DEFAULT_TIMEOUT_MS = 60_000;

let nextRequestSeq = 0;
function nextRequestId(action: string): string {
  nextRequestSeq++;
  return `rr_${Date.now()}_${nextRequestSeq}_${action}`;
}

export interface RemoteRequestOptions {
  // Auto-start a headless session for the target if it's offline AND the
  // target's KnownClient row has autoStartOnRemoteRequest enabled. Default true.
  autoStartIfOffline?: boolean;
  // Per-call timeout override (milliseconds).
  timeoutMs?: number;
}

// remoteRequest sends a cross-world action through the relay. Returns a
// Promise that resolves with the target's response data, or rejects with an
// Error if anything fails.
//
// Common actions (the relay enforces ActionToScopeRequired in scopes.go):
//   - "create"          → entity:write
//   - "entity"          → entity:read
//   - "create-user"     → user:write  (creates a user with name/role/password)
//   - "upload-file"     → file:write
//   - "download-file"   → file:read
//   - "file-system"     → file:read
//   - "create-folder"   → structure:write
//   - "structure"       → structure:read
//   - "get-users"       → user:read
//   - "macro-execute"   → macro:execute
//   - "chat-messages"   → chat:read
//   - "chat-send"       → chat:write
//   - "get-scene"       → scene:read
//   - "switch-scene"    → scene:write
//
// Example:
//   const result = await module.api.remoteRequest("fvtt_other_world", "create-user", {
//     name: "Alice", role: 1, password: "secret"
//   });
export function remoteRequest(
  socketManager: WebSocketManager | null,
  targetClientId: string,
  action: string,
  payload: Record<string, any> = {},
  opts: RemoteRequestOptions = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!socketManager) {
      reject(new Error("WebSocketManager is not initialized — module is not connected to the relay"));
      return;
    }
    if (!socketManager.isConnected()) {
      reject(new Error("Not connected to the relay — cannot send remote-request"));
      return;
    }
    if (!targetClientId) {
      reject(new Error("targetClientId is required"));
      return;
    }
    if (!action) {
      reject(new Error("action is required"));
      return;
    }

    const requestId = nextRequestId(action);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const autoStartIfOffline = opts.autoStartIfOffline ?? true;

    const timeoutHandle = window.setTimeout(() => {
      pendingRemoteRequests.delete(requestId);
      reject(new Error(`remote-request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRemoteRequests.set(requestId, {
      resolve,
      reject,
      timeoutHandle,
    });

    const sent = socketManager.send({
      type: "remote-request",
      requestId,
      targetClientId,
      action,
      payload,
      autoStartIfOffline,
    });

    if (!sent) {
      clearTimeout(timeoutHandle);
      pendingRemoteRequests.delete(requestId);
      reject(new Error("Failed to send remote-request over WebSocket"));
    }
  });
}

// handleRemoteResponse is the WS message handler that resolves a pending
// remoteRequest Promise. Called by the router registered in routers/all.ts.
export function handleRemoteResponse(data: any): void {
  const requestId = data?.requestId as string | undefined;
  if (!requestId) {
    ModuleLogger.warn("remote-response received with no requestId");
    return;
  }
  const pending = pendingRemoteRequests.get(requestId);
  if (!pending) {
    ModuleLogger.warn(`remote-response received for unknown requestId: ${requestId}`);
    return;
  }
  pendingRemoteRequests.delete(requestId);
  clearTimeout(pending.timeoutHandle);

  if (data.success === false) {
    pending.reject(new Error(data.error || "remote-request failed"));
    return;
  }
  pending.resolve(data.data ?? null);
}
