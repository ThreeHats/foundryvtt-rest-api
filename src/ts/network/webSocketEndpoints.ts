import { moduleId } from "../constants";
import { FoundryRestApi } from "../types";
import { ModuleLogger } from "../utils/logger";
import { WebSocketManager } from "./webSocketManager";
import { routers } from "./routers/all"
import { Router } from "./routers/baseRouter";

export function initializeWebSocket() {
    // Get settings
    const wsRelayUrl = (game as Game).settings.get(moduleId, "wsRelayUrl") as string;
    const apiKey = (game as Game).settings.get(moduleId, "apiKey") as string;
    const module = (game as Game).modules.get(moduleId) as FoundryRestApi;
    
    if (!wsRelayUrl) {
      ModuleLogger.error(`WebSocket relay URL is empty. Please configure it in module settings.`);
      return;
    }
    
    ModuleLogger.info(`Initializing WebSocket with URL: ${wsRelayUrl}`);
    
    try {
        // Create and connect the WebSocket manager - only if it doesn't exist already
        if (!module.socketManager) {
            module.socketManager = WebSocketManager.getInstance(wsRelayUrl, apiKey);
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
        
        ModuleLogger.info(`Registered ${routers.length} routers with WebSocket manager`);
        
    } catch (error) {
      ModuleLogger.error(`Error initializing WebSocket:`, error);
    }
}
