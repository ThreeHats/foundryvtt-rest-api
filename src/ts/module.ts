import "../styles/style.scss";
import { FoundryRestApi } from "./types";
import {
  moduleId,
  CONSTANTS,
  SETTINGS,
  FLAG_SKIP_SETUP_PROMPT,
} from "./constants";
import { ModuleLogger } from "./utils/logger";
import { initializeWebSocket } from "./network/webSocketEndpoints";
import { openConnectionDialog, ConnectionSettingsApp } from "./utils/connectionDialog";
import { notifyRelay } from "./utils/moduleNotify";
import { remoteRequest, type RemoteRequestOptions } from "./network/remoteRequest";
import { searchIndex, INDEXED_TYPES } from "./utils/searchIndex";
import { parseFilterString } from "./utils/search";

Hooks.once("init", () => {
  console.log(`Initializing ${moduleId}`);

  for (let [name, data] of Object.entries(SETTINGS.GET_DEFAULT())) {
    game.settings.register(CONSTANTS.MODULE_ID, name, <any>data);
  }

  // Register the Connection settings menu (GM only). Replaces the old
  // renderSettingsConfig pairing UI.
  (game.settings as any).registerMenu(CONSTANTS.MODULE_ID, "connectionSettings", {
    name: "REST API Connection",
    label: "Manage Connection",
    hint: "Pair with relay, configure URL, set up Discord notifications.",
    icon: "fas fa-link",
    type: ConnectionSettingsApp,
    restricted: true,
  });

  // Create and expose module API
  const module = game.modules.get(moduleId) as FoundryRestApi;
  module.api = {
    openConnectionDialog,
    getWebSocketManager: () => {
      if (!module.socketManager) {
        ModuleLogger.warn(`WebSocketManager requested but not initialized`);
        return null;
      }
      return module.socketManager;
    },
    search: async (query: string, filter?: string) => {
      if (!searchIndex.isReady) searchIndex.build();
      const filters = filter ? parseFilterString(filter) : undefined;
      const results = await searchIndex.search(query, { filters, limit: 100 });
      return results.map(r => r.entry);
    },
    getByUuid: async (uuid: string) => {
      try {
        return await fromUuid(uuid);
      } catch (error) {
        ModuleLogger.error(`Error getting entity by UUID:`, error);
        return null;
      }
    },

    // remoteRequest is the cross-world tunnel API. Other modules (like the
    // server-to-server transfer module) call this to invoke actions on
    // OTHER Foundry worlds owned by the same relay account, gated by what
    // this browser's connection token explicitly allows.
    //
    // Example:
    //   const restApi = game.modules.get("foundry-rest-api");
    //   const result = await restApi.api.remoteRequest("fvtt_other_world",
    //     "create-user", { name: "Alice", role: 1, password: "secret" });
    //
    // The Foundry module never holds an HTTP API key. Cross-world authority
    // lives entirely in the connection token's allowedTargetClients +
    // remoteScopes (configured at pair time via the relay dashboard).
    remoteRequest: (targetClientId: string, action: string, payload?: Record<string, any>, opts?: RemoteRequestOptions) => {
      return remoteRequest(module.socketManager ?? null, targetClientId, action, payload, opts);
    },
  };
});

// Legacy renderSettingsConfig pairing UI has been removed. Pairing is now
// managed by the "Manage Connection" settings menu (ConnectionSettingsApp).

// Detect sensitive settings changes and notify GMs + optionally Discord.
Hooks.on("updateSetting", (setting: any) => {
  const key: string | undefined = setting?.key;
  if (!key || !key.startsWith(moduleId + ".")) return;
  const settingName = key.substring(moduleId.length + 1);
  const sensitiveKeys = [
    "wsRelayUrl",
    "allowExecuteJs",
    "allowMacroExecute",
  ];
  if (!sensitiveKeys.includes(settingName)) return;

  const gmUserIds = (game.users?.filter((u: any) => u.isGM && u.active) ?? []).map((u: any) => u.id);

  try {
    ChatMessage.create({
      whisper: gmUserIds,
      speaker: { alias: "REST API Module" } as any,
      content: `<b>⚠ REST API setting changed:</b> <code>${settingName}</code> was modified by ${game.user?.name}`,
    });
  } catch (err) {
    ModuleLogger.warn(`Failed to post settings-change chat message:`, err);
  }

  ui.notifications?.warn(`REST API setting "${settingName}" was changed`);

  // Emit module-notify event to the relay; the relay's dispatcher routes it
  // to the user's configured destinations (account-level Discord/email).
  notifyRelay({
    event: "settings-change",
    details: `Setting \`${settingName}\` was changed`,
  });
});

Hooks.once("ready", async () => {
  // One-time migration: rewrite the old Fly.io relay URL to the new domain.
  // Self-hosted users (any URL that doesn't contain the old fly.dev host) are unaffected.
  if (game.user?.isGM && game.user?.role === 4) {
    const OLD_FLY_HOST = "foundryvtt-rest-api-relay.fly.dev";
    const relayUrl = (game.settings.get(moduleId, SETTINGS.WS_RELAY_URL) as string) || "";
    const pairedUrl = (game.settings.get(moduleId, SETTINGS.PAIRED_RELAY_URL) as string) || "";
    let migrated = false;
    if (relayUrl.includes(OLD_FLY_HOST)) {
      await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, "wss://foundryrestapi.com");
      migrated = true;
    }
    if (pairedUrl.includes(OLD_FLY_HOST)) {
      await game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, "wss://foundryrestapi.com");
      migrated = true;
    }
    if (migrated) {
      ui.notifications?.info("REST API: Relay URL updated to foundryrestapi.com");
      ModuleLogger.info("Migrated relay URL from old fly.dev host to foundryrestapi.com");
    }
  }

  setTimeout(() => {
    searchIndex.build();
    initializeWebSocket();
  }, 1000);

  // Socket delegation: allow GMs whose browser doesn't hold the relay WS slot
  // (e.g. received 4004 DuplicateConnection) to proxy operations through us.
  // Only the GM whose socketManager.isConnected() responds; all others ignore.
  (game.socket as any)?.on(`module.${moduleId}`, async (data: any) => {
    if (!data || typeof data !== "object") return;
    const mod = game.modules.get(moduleId) as FoundryRestApi;
    if (!mod.socketManager?.isConnected()) return;

    const { type, delegateId } = data;
    if (!delegateId) return;

    const respond = (success: boolean, payload: any) => {
      (game.socket as any).emit(`module.${moduleId}`, {
        type: "ws-delegate-result",
        delegateId,
        success,
        ...(success ? { data: payload } : { error: String(payload) }),
      });
    };

    if (type === "ws-send-and-wait") {
      const { message, responseType, timeoutMs } = data;
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        respond(false, "Relay request timed out");
      }, timeoutMs ?? 30_000);
      mod.socketManager.onMessageType(responseType, (msg: any) => {
        if (msg?.requestId !== message?.requestId) return;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        respond(true, msg);
      });
      mod.socketManager.send(message);
    }

    if (type === "remoteRequest-delegate") {
      const { targetClientId, action, payload, opts } = data;
      try {
        const result = await remoteRequest(mod.socketManager, targetClientId, action, payload, opts);
        respond(true, result);
      } catch (err) {
        respond(false, (err as Error).message);
      }
    }
  });

  // Keep the search index in sync with world entity changes
  for (const type of INDEXED_TYPES) {
    Hooks.on(`create${type}`, (doc: any) => searchIndex.updateFromDocument(doc));
    Hooks.on(`update${type}`, (doc: any) => searchIndex.updateFromDocument(doc));
    Hooks.on(`delete${type}`, (doc: any) => searchIndex.removeWorldEntry(doc.uuid));
  }

  // Init wizard: prompt full GM to pair if no token is configured on
  // this browser. Three branches:
  //
  //   1. localToken set, clientId set
  //      → Browser is paired. Existing primary-GM logic decides whether
  //        this user opens the WS connection. Already handled by
  //        initializeWebSocket above.
  //
  //   2. clientId set in world settings, but localToken empty
  //      → World is paired but THIS browser isn't. Probe the relay's
  //        public /api/clients/:id/active endpoint to see if another GM
  //        is currently holding the slot. If yes, stay silent (one
  //        connection per world rule). If no, prompt to "add this
  //        browser" via the Connection dialog.
  //
  //   3. clientId empty
  //      → Fresh world, never paired. Prompt the GM to start the pairing
  //        flow.
  //
  // The user flag `skipSetupPrompt` suppresses the prompt for THIS user
  // only — other GMs in the same world still see it. (Per-user flags ARE
  // broadcast to all clients, but a "skip the prompt" preference being
  // readable is harmless.)
  if (game.user?.isGM && game.user?.role === 4) {
    const localToken = (game.settings.get(moduleId, SETTINGS.CONNECTION_TOKEN) as string) || "";
    const clientId = (game.settings.get(moduleId, SETTINGS.CLIENT_ID) as string) || "";
    const skip = !!game.user.getFlag(moduleId, FLAG_SKIP_SETUP_PROMPT);

    if (localToken && clientId) {
      // Already paired — initializeWebSocket above is doing the work.
    } else if (clientId && !localToken) {
      // World paired, this browser isn't. Check if another GM holds the slot.
      void (async () => {
        try {
          const wsRelayUrl = game.settings.get(moduleId, SETTINGS.WS_RELAY_URL) as string;
          // Derive the http(s) base from the wss:// relay URL
          const httpBase = wsRelayUrl
            .replace(/^wss:\/\//, "https://")
            .replace(/^ws:\/\//, "http://")
            .replace(/\/relay\/?$/, "");
          const probeUrl = `${httpBase}/api/clients/${encodeURIComponent(clientId)}/active`;
          let active = true; // fail-closed: if probe fails, stay silent
          let worldUnregistered = false;
          try {
            const r = await fetch(probeUrl, { method: "GET" });
            if (r.status === 404) {
              // The relay has no record of this clientId — the world was removed
              // from the dashboard. Clear the stale world-scope settings so the
              // fresh-pair prompt is shown.
              worldUnregistered = true;
            } else if (r.ok) {
              const body = await r.json();
              active = !!body.active;
            }
          } catch {
            // network error; treat as active to avoid nagging when relay is down
          }

          if (worldUnregistered) {
            // Clear stale pairing data so fresh-pair prompt is shown on next load.
            await game.settings.set(moduleId, SETTINGS.CLIENT_ID, "");
            await game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, "");
            ui.notifications?.warn("REST API: This world's relay registration was removed. Please re-pair.");
            if (!skip) {
              new Dialog({
                title: "REST API — World No Longer Registered",
                content: `
                  <p>This world was registered with the relay, but that registration has been removed from the dashboard.</p>
                  <p>Would you like to pair this world again? You'll need a new pairing code from the relay dashboard.</p>
                `,
                buttons: {
                  pair: {
                    icon: '<i class="fas fa-link"></i>',
                    label: "Re-Pair Now",
                    callback: () => openConnectionDialog()
                  },
                  later: { label: "Later" }
                },
                default: "pair"
              }).render(true);
            }
            return;
          }

          if (active) {
            ui.notifications?.info("REST API: connected via another GM's browser");
            return;
          }
          if (skip) return;

          new Dialog({
            title: "REST API Setup — Add This Browser",
            content: `
              <p>This world is paired with the REST API relay (clientId: <code>${clientId}</code>),
              but this browser isn't paired yet. No GM is currently holding the relay
              connection slot.</p>
              <p>Would you like to pair this browser so it can take over?
              You'll need an "Add Browser" code from your relay dashboard's Known Clients page.</p>
            `,
            buttons: {
              pair: {
                icon: '<i class="fas fa-link"></i>',
                label: "Pair This Browser",
                callback: () => openConnectionDialog()
              },
              later: { label: "Later", callback: () => { /* no-op */ } },
              never: {
                label: "Don't Ask Again",
                callback: async () => {
                  await game.user?.setFlag(moduleId, FLAG_SKIP_SETUP_PROMPT, true);
                }
              }
            },
            default: "pair"
          }).render(true);
        } catch (err) {
          ModuleLogger.warn("Init wizard probe failed:", err);
        }
      })();
    } else {
      // Fresh world (no clientId in world settings). Prompt to start the pair flow.
      if (!skip) {
        new Dialog({
          title: "REST API Setup",
          content: `
            <p>The Foundry REST API module isn't connected to a relay yet.</p>
            <p>Would you like to set it up now? You'll need a 6-character pairing code from the relay dashboard.</p>
          `,
          buttons: {
            pair: {
              icon: '<i class="fas fa-link"></i>',
              label: "Pair Now",
              callback: () => openConnectionDialog()
            },
            later: { label: "Later", callback: () => { /* no-op */ } },
            never: {
              label: "Don't Ask Again",
              callback: async () => {
                await game.user?.setFlag(moduleId, FLAG_SKIP_SETUP_PROMPT, true);
              }
            }
          },
          default: "pair"
        }).render(true);
      }
    }
  }
});


// Event hooks are registered on-demand via enableEventChannel / disableEventChannel
// in response to "event-subscription-update" messages from the relay.
// See src/ts/network/eventChannels.ts and webSocketEndpoints.ts.
