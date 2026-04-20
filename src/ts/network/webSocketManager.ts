import { WSCloseCodes } from "../types";
import { ModuleLogger } from "../utils/logger";
import {
  moduleId,
  SETTINGS,
} from "../constants";
import { HandlerContext } from "./routers/baseRouter"
import { openConnectionDialog } from "../utils/connectionDialog";

type MessageHandler = (data: any, context: HandlerContext) => void;

type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

export class WebSocketManager {
  private url: string;
  // Token is encapsulated in a closure via sendAuth() — never stored as a field.
  private sendAuth: () => void;
  private socket: WebSocket | null = null;
  private messageHandlers: Map<string, MessageHandler> = new Map();
  private reconnectTimer: number | null = null;
  private reconnectAttempts: number = 0;
  private isReconnecting: boolean = false;
  private clientId: string;
  private pairedUrl: string;
  private pingInterval: number | null = null;
  private connectionState: ConnectionState = 'disconnected';
  // true after receiving 4004 DuplicateConnection — cleared when we successfully connect
  private deferredByDuplicate: boolean = false;
  // Polling timer used to periodically retry the slot when deferred by 4004.
  // Runs independently of reconnectTimer so it doesn't exhaust the reconnect budget.
  private deferredRetryTimer: number | null = null;
  private static readonly DEFERRED_RETRY_INTERVAL_MS = 30_000;

  // Singleton instance
  private static instance: WebSocketManager | null = null;

  constructor(url: string, token: string, clientId: string, pairedUrl: string) {
    if (!clientId) {
      throw new Error("WebSocketManager requires a non-empty clientId");
    }
    this.url = url;
    this.clientId = clientId;
    this.pairedUrl = pairedUrl || "";

    // Encapsulate token in a closure so it is not accessible via `this`.
    const capturedToken = token;
    this.sendAuth = () => {
      // Bypass send()'s state logging for the auth payload.
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: "auth", token: capturedToken }));
        } catch (err) {
          ModuleLogger.error(`Error sending auth:`, err);
        }
      }
    };

    ModuleLogger.info(`Created WebSocketManager with clientId: ${this.clientId}`);

    // Listen for user join/leave events so idle GMs can take over when the
    // connected GM leaves. First-come, first-serve: the relay enforces single-
    // connection via close code 4004 (DuplicateConnection).
    if (game.user?.isGM && game.user?.role === 4) {
      Hooks.on("userDisconnected", this.onUserDisconnected.bind(this));
      Hooks.on("createUser", () => this.sendUserList());
      Hooks.on("updateUser", () => this.sendUserList());
      Hooks.on("deleteUser", () => this.sendUserList());
    }
  }

  /**
   * Factory method that ensures only one instance is created and only for GM users
   */
  public static getInstance(url: string, token: string, clientId: string, pairedUrl: string): WebSocketManager | null {
    // Only create an instance if the user is a full GM (role 4), not Assistant GM
    if (!game.user?.isGM || game.user?.role !== 4) {
      ModuleLogger.info(`WebSocketManager not created - user is not a full GM`);
      return null;
    }

    // Only create the instance once
    if (!WebSocketManager.instance) {
      ModuleLogger.info(`Creating new WebSocketManager instance`);
      WebSocketManager.instance = new WebSocketManager(url, token, clientId, pairedUrl);
    }

    return WebSocketManager.instance;
  }

  /**
   * Called when any user disconnects from Foundry.
   * If this GM was deferred due to a DuplicateConnection (4004), try immediately —
   * the slot may be free. If already connected or not deferred, no-op.
   */
  private onUserDisconnected(): void {
    if (this.isConnected()) return; // We already hold the slot

    if (this.deferredByDuplicate) {
      ModuleLogger.info(`A GM disconnected — retrying connection immediately (was deferred by 4004)`);
      // Cancel any pending deferred retry so we don't double-connect.
      if (this.deferredRetryTimer !== null) {
        window.clearTimeout(this.deferredRetryTimer);
        this.deferredRetryTimer = null;
      }
      this.deferredByDuplicate = false;
      this.connect();
    }
  }

  /**
   * Schedules a periodic retry to claim the relay slot while deferred by 4004.
   * This is a safety net for cases where `userDisconnected` fires too early
   * (race between Foundry detecting the disconnect and the relay releasing the slot),
   * or never fires at all (abrupt close, network drop, same-account multi-tab).
   * If the retry still gets 4004, onClose will call this again to keep polling.
   * No-ops if a retry is already scheduled.
   */
  private scheduleDeferredRetry(): void {
    if (this.deferredRetryTimer !== null) return; // already scheduled
    this.deferredRetryTimer = window.setTimeout(() => {
      this.deferredRetryTimer = null;
      if (this.deferredByDuplicate && !this.isConnected()) {
        ModuleLogger.info(`Deferred retry: polling relay for available slot`);
        this.connect();
      }
    }, WebSocketManager.DEFERRED_RETRY_INTERVAL_MS);
  }

  connect(): void {
    // Only full GMs (role 4) connect. WebSocketManager is never instantiated
    // for non-GMs (see getInstance()), but guard here defensively.
    if (!game.user?.isGM || game.user?.role !== 4) {
      ModuleLogger.info(`WebSocket connection aborted - user is not a full GM`);
      return;
    }
    
    if (this.connectionState === 'connecting' || this.connectionState === 'authenticating') {
      ModuleLogger.info(`Already attempting to connect`);
      return;
    }

    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      ModuleLogger.info(`WebSocket already connected or connecting`);
      return;
    }

    // URL pinning — refuse to connect if the configured URL has changed since pairing.
    // Normalize both sides so wss://host and wss://host/relay compare equal.
    const normRelayUrl = (u: string) => u.replace(/\/relay\/?$/, '');
    if (this.pairedUrl && normRelayUrl(this.pairedUrl) !== normRelayUrl(this.url)) {
      const msg = `REST API: Relay URL has been changed since pairing. Please re-pair via module settings.`;
      ModuleLogger.error(msg + ` (paired=${this.pairedUrl}, current=${this.url})`);
      ui.notifications?.error(msg);
      try {
        const gmIds = (game.users?.filter((u: any) => u.isGM && u.active) ?? []).map((u: any) => u.id);
        ChatMessage.create({
          whisper: gmIds,
          speaker: { alias: "REST API Module" } as any,
          content: `<b>⚠ REST API URL mismatch:</b> paired with <code>${this.pairedUrl}</code>, but current relay is <code>${this.url}</code>. Re-pair to reconnect.`,
        });
      } catch (err) {
        ModuleLogger.warn(`Failed to post URL-mismatch chat message:`, err);
      }
      // URL mismatch happens BEFORE we connect, so we can't proxy a notification
      // through the WebSocket. The chat whisper + ui.notifications above are the
      // only signal we can give the GM in this state.
      return;
    }

    // H4 hardening: warn loudly if the configured relay URL is plaintext
    // ws:// and the host is NOT localhost. The connection token would
    // travel over the wire unencrypted, and any network attacker between
    // the browser and the relay could read it.
    try {
      const checkUrl = new URL(this.url.replace(/\/relay\/?$/, ''));
      const isPlaintext = checkUrl.protocol === "ws:";
      const host = checkUrl.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (isPlaintext && !isLocal) {
        const msg = `REST API: relay URL uses plaintext ws:// to a non-local host (${host}). The connection token will be sent unencrypted. Use wss:// for production.`;
        ModuleLogger.warn(msg);
        ui.notifications?.warn(msg, { permanent: true } as any);
      }
    } catch {
      // If URL parsing fails, the actual connect attempt below will fail
      // with a more specific error.
    }

    this.connectionState = 'connecting';

    try {
      // Build the WebSocket URL — normalize to always connect to /relay.
      // Accepts both wss://host (base URL) and wss://host/relay (full URL).
      const wsUrl = new URL(this.url.replace(/\/relay\/?$/, '') + '/relay');
      wsUrl.searchParams.set('id', this.clientId);
      // Send metadata as query params (not sensitive)
      if (game.world) {
        wsUrl.searchParams.set('worldId', game.world.id);
        wsUrl.searchParams.set('worldTitle', (game.world as any).title);
      }
      wsUrl.searchParams.set('foundryVersion', game.version);
      wsUrl.searchParams.set('systemId', game.system.id);
      wsUrl.searchParams.set('systemTitle', (game.system as any).title || game.system.id);
      wsUrl.searchParams.set('systemVersion', (game.system as any).version || 'unknown');

      const customName = game.settings.get(moduleId, "customName") as string;
      if (customName) {
        wsUrl.searchParams.set('customName', customName);
      }

      // Token is intentionally NOT in the URL — it's sent as the first message
      ModuleLogger.info(`Connecting to WebSocket relay at ${wsUrl.host}`);

      this.socket = new WebSocket(wsUrl.toString());

      // Add timeout for connection attempt
      const connectionTimeout = window.setTimeout(() => {
        if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
          ModuleLogger.error(`Connection timed out`);
          this.socket.close();
          this.socket = null;
          this.connectionState = 'disconnected';
          this.scheduleReconnect();
        }
      }, 5000); // 5 second timeout

      this.socket.addEventListener('open', (event) => {
        window.clearTimeout(connectionTimeout);
        this.onOpen(event);
      });
      
      this.socket.addEventListener('close', (event) => {
        window.clearTimeout(connectionTimeout);
        this.onClose(event);
      });
      
      this.socket.addEventListener('error', (event) => {
        window.clearTimeout(connectionTimeout);
        this.onError(event);
      });
      
      this.socket.addEventListener('message', this.onMessage.bind(this));
    } catch (error) {
      ModuleLogger.error(`Error creating WebSocket:`, error);
      this.connectionState = 'disconnected';
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.socket) {
      ModuleLogger.info(`Disconnecting WebSocket`);
      this.socket.close(WSCloseCodes.Normal, "Disconnecting");
      this.socket = null;
    }

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.deferredRetryTimer !== null) {
      window.clearTimeout(this.deferredRetryTimer);
      this.deferredRetryTimer = null;
    }

    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.deferredByDuplicate = false;
    this.connectionState = 'disconnected';
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  getClientId(): string {
    return this.clientId;
  }

  send(data: any): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(data));
        return true;
      } catch (error) {
        ModuleLogger.error(`Error sending message:`, error);
        return false;
      }
    } else {
      ModuleLogger.debug(`WebSocket not ready, state: ${this.socket?.readyState}`);
      return false;
    }
  }

  onMessageType(type: string, handler: MessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  private onOpen(_event: Event): void {
    ModuleLogger.info(`WebSocket transport connected, sending authentication...`);
    this.connectionState = 'authenticating';

    // Send auth token via closure — token is never stored on `this`.
    this.sendAuth();

    // The auth-success handler in onMessage will complete the connection setup
  }

  private onAuthSuccess(): void {
    ModuleLogger.info(`WebSocket authenticated successfully`);
    this.connectionState = 'connected';
    this.reconnectAttempts = 0;
    this.deferredByDuplicate = false;
    if (this.deferredRetryTimer !== null) {
      window.clearTimeout(this.deferredRetryTimer);
      this.deferredRetryTimer = null;
    }

    // Auto-pin the relay URL on first successful connection if not already
    // pinned. The pairedRelayUrl is a world setting (shared across all GMs)
    // so the write requires GM privilege — which we always have at this
    // point because the WebSocketManager only spawns for full GMs.
    if (!this.pairedUrl) {
      this.pairedUrl = this.url;
      try {
        void game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, this.url);
        ModuleLogger.info(`Auto-pinned paired relay URL to ${this.url}`);
      } catch (err) {
        ModuleLogger.warn(`Failed to auto-pin paired relay URL:`, err);
      }
    }

    // Visible connect notifications
    let relayHost = this.url;
    try { relayHost = new URL(this.url).host; } catch { /* noop */ }

    ui.notifications?.info(`REST API: Connected to ${relayHost}`);

    try {
      const gmIds = (game.users?.filter((u: any) => u.isGM && u.active) ?? []).map((u: any) => u.id);
      ChatMessage.create({
        whisper: gmIds,
        speaker: { alias: "REST API Module" } as any,
        content: `<i class="fas fa-link"></i> REST API connected to <code>${relayHost}</code>`,
      });
    } catch (err) {
      ModuleLogger.warn(`Failed to post connect chat message:`, err);
    }

    // Note: connect/disconnect Discord and email notifications are handled
    // server-side by the relay's notification dispatcher (it sees the WS auth
    // succeed/close) — no need for the module to also fire them.

    // Now safe to send pings and process messages
    this.send({ type: "ping" });
    this.sendUserList();

    const pingIntervalSeconds = game.settings.get(moduleId, SETTINGS.PING_INTERVAL) as number;
    const pingIntervalMs = pingIntervalSeconds * 1000;
    ModuleLogger.info(`Starting application ping interval: ${pingIntervalSeconds} seconds`);

    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
    }

    this.pingInterval = window.setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: "ping" });
      }
    }, pingIntervalMs);
  }

  private onClose(event: CloseEvent): void {
    ModuleLogger.info(`WebSocket disconnected: ${event.code} - ${event.reason}`);
    const wasConnected = this.connectionState === 'connected';
    this.socket = null;
    this.connectionState = 'disconnected';

    // Clear ping interval
    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Only show disconnect notifications when a live connection actually dropped.
    // Suppress during initial connect/reconnect attempts so a relay that isn't
    // running doesn't spam the GM with a notification on every retry.
    if (wasConnected && event.code !== WSCloseCodes.Normal) {
      let relayHost = this.url;
      try { relayHost = new URL(this.url).host; } catch { /* noop */ }

      ui.notifications?.warn(`REST API: Disconnected (${event.code})`);

      try {
        const gmIds = (game.users?.filter((u: any) => u.isGM && u.active) ?? []).map((u: any) => u.id);
        ChatMessage.create({
          whisper: gmIds,
          speaker: { alias: "REST API Module" } as any,
          content: `<i class="fas fa-unlink"></i> REST API disconnected from <code>${relayHost}</code> (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        });
      } catch (err) {
        ModuleLogger.warn(`Failed to post disconnect chat message:`, err);
      }

      // Disconnect Discord/email notifications are handled server-side by the
      // relay's notification dispatcher (the relay sees the WS close and fires
      // EventDisconnect via OnClientRemoved). The chat whisper above is the
      // in-Foundry UX cue.
    }

    // Don't reconnect for these cases:
    //   1000 (Normal)             — clean disconnect, intentional
    //   1008 (PolicyViolation)    — auth rejected
    //   4002 (NoAuth)             — auth-via-first-message failed (bad token,
    //                               invalid pairing, IP not allowed, etc.)
    //   4001 (NoClientId)         — missing or invalid client ID
    //   4004 (DuplicateConnection) — another GM already holds this world's slot
    //
    // For permanent auth failures, clear the bad token and notify the user
    // so they can re-pair via the connection dialog. Without this we'd loop
    // forever trying the same bad token.
    //
    // For 4004, mark ourselves as deferred so we retry when a GM disconnects.
    const isPermanentAuthFailure =
      event.code === WSCloseCodes.PolicyViolation ||
      event.code === WSCloseCodes.NoAuth ||
      event.code === WSCloseCodes.NoClientId;

    if (event.code === WSCloseCodes.DuplicateConnection) {
      ModuleLogger.info(`Connection slot held by another GM (4004) — waiting for them to disconnect`);
      ui.notifications?.info(`REST API: connected via another GM's browser`);
      this.deferredByDuplicate = true;
      this.scheduleDeferredRetry();
      return;
    }

    if (event.code === WSCloseCodes.Normal || isPermanentAuthFailure) {
      if (isPermanentAuthFailure) {
        const reason = event.reason || `code ${event.code}`;
        ModuleLogger.error(`Connection rejected (${reason}). Token may be invalid; clearing flags and prompting re-pair.`);
        ui.notifications?.error(
          `Foundry REST API: connection rejected (${reason}). Click "Manage Connection" in module settings to re-pair.`,
          { permanent: true } as any
        );

        // Clear ONLY this browser's client-scope token. World settings
        // (clientId, pairedRelayUrl) stay intact — other GMs may still have
        // valid tokens for the same world, and clearing the world setting
        // would force them to re-pair too.
        void (async () => {
          try {
            await game.settings.set(moduleId, SETTINGS.CONNECTION_TOKEN, "");
            ModuleLogger.info("Cleared invalid connection token from this browser's local storage.");
            // Auto-open the Connection dialog so re-pairing is one click away
            openConnectionDialog();
          } catch (err) {
            ModuleLogger.warn("Failed to clear invalid token from client-scope settings:", err);
          }
        })();
      }
      return;
    }

    // Reconnect for other transient failures (any full GM can attempt)
    this.scheduleReconnect();
  }

  private onError(event: Event): void {
    ModuleLogger.error(`WebSocket error:`, event);
    this.connectionState = 'disconnected';
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    try {
      const data = JSON.parse(event.data);

      // Handle auth-success before anything else
      if (data.type === 'auth-success') {
        this.onAuthSuccess();
        return;
      }

      // During authentication phase, only process auth messages
      if (this.connectionState === 'authenticating') {
        ModuleLogger.warn(`Received non-auth message during authentication: ${data.type}`);
        return;
      }

      if (data.type && this.messageHandlers.has(data.type)) {
          this.messageHandlers.get(data.type)!(data, {socketManager: this} as HandlerContext);
      } else if (data.type) {
        ModuleLogger.debug(`No handler for message type: ${data.type}`);
      }
    } catch (error) {
      ModuleLogger.error(`Error processing message:`, error);
    }
  }

  private sendUserList(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const users = (game.users?.contents ?? []).map((u: any) => ({
      id: u.id,
      name: u.name ?? '',
      role: u.role,
      active: u.active,
    }));
    if (users.length === 0) return;
    try {
      this.socket.send(JSON.stringify({ type: 'player-list', users }));
    } catch (err) {
      ModuleLogger.warn('Failed to send player-list:', err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.isReconnecting) {
      return; // Already scheduled or in progress
    }
    this.isReconnecting = true;
    
    // Read settings for reconnection parameters
    const maxAttempts = game.settings.get(moduleId, SETTINGS.RECONNECT_MAX_ATTEMPTS) as number;
    const baseDelay = game.settings.get(moduleId, SETTINGS.RECONNECT_BASE_DELAY) as number;
    
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > maxAttempts) {
      ModuleLogger.error(`Maximum reconnection attempts (${maxAttempts}) reached`);
      this.reconnectAttempts = 0; // Reset for future disconnections
      return;
    }
    
    // Calculate delay with exponential backoff (max 30 seconds)
    const delay = Math.min(30000, baseDelay * Math.pow(2, this.reconnectAttempts - 1));
    ModuleLogger.info(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);
    
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.isReconnecting = false;
      ModuleLogger.info(`Attempting reconnect...`);
      this.connect();
    }, delay);
  }
}