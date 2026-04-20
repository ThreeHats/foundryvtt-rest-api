import { moduleId, SETTINGS } from "../constants";
import { FoundryRestApi } from "../types";
import { ModuleLogger } from "../utils/logger";
import { WebSocketManager } from "./webSocketManager";
import { routers } from "./routers/all"
import { Router } from "./routers/baseRouter";
import { enableEventChannel, disableEventChannel } from "./eventChannels";

export function initializeWebSocket() {
    const wsRelayUrl = game.settings.get(moduleId, SETTINGS.WS_RELAY_URL) as string;
    // Connection credentials live in the new storage model:
    //   - clientId / pairedRelayUrl: world settings (shared across all GMs)
    //   - connectionToken: client-scope setting (per-browser, per-device,
    //     never broadcast — the only Foundry storage that hides from players)
    const clientId = (game.settings.get(moduleId, SETTINGS.CLIENT_ID) as string) || "";
    const pairedUrl = (game.settings.get(moduleId, SETTINGS.PAIRED_RELAY_URL) as string) || "";
    const token = (game.settings.get(moduleId, SETTINGS.CONNECTION_TOKEN) as string) || "";
    const module = game.modules.get(moduleId) as FoundryRestApi;

    if (!wsRelayUrl) {
      ModuleLogger.error(`WebSocket relay URL is empty. Please configure it in module settings.`);
      return;
    }

    if (!clientId) {
      ModuleLogger.warn(`World is not paired with the REST API relay. Open the REST API Connection menu to pair.`);
      return;
    }

    if (!token) {
      // World is paired but THIS browser doesn't have a token. The init
      // wizard in module.ts handles the prompting/active-probe logic;
      // we just return silently here so a non-paired browser doesn't
      // attempt to connect with an empty token.
      ModuleLogger.warn(`This browser is not paired. The Connection menu will prompt to pair.`);
      return;
    }

    ModuleLogger.info(`Initializing WebSocket with relay: ${wsRelayUrl}`);

    try {
        // Create and connect the WebSocket manager - only if it doesn't exist already
        if (!module.socketManager) {
            module.socketManager = WebSocketManager.getInstance(wsRelayUrl, token, clientId, pairedUrl);
            // Only attempt to connect if we got a valid instance (meaning this GM is the primary GM)
            if (module.socketManager) {
                module.socketManager.connect();
            }
        } else {
            ModuleLogger.info(`WebSocket manager already exists, not creating a new one`);
        }

        // If we don't have a valid socket manager, exit early
        if (!module.socketManager) {
            ModuleLogger.warn(`No WebSocket manager available, skipping message handler setup`);
            return;
        }

        // Register message handlers using routers
        const socketManager = module.socketManager;
        routers.forEach((router: Router) => {
            router.reflect(socketManager);
        });

        // Handle on-demand event channel activation from the relay.
        // The relay sends this message when SSE/WS subscriber counts change.
        socketManager.onMessageType("event-subscription-update", (data: any) => {
            const { channel, count } = data ?? {};
            if (typeof channel !== "string") return;
            if (count > 0) {
                enableEventChannel(channel);
            } else {
                disableEventChannel(channel);
            }
        });

        ModuleLogger.info(`Registered ${routers.length} routers with WebSocket manager`);

    } catch (error) {
      ModuleLogger.error(`Error initializing WebSocket:`, error);
    }
}
