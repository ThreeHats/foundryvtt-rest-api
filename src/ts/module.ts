import "../styles/style.scss";
import { CommunicationPanel } from "./apps/communicationPanel";
import { moduleId } from "./constants";
import { FoundryGetActorsExternal } from "./types";
import { exportScene } from "../utils/export";
import { importScene } from "../utils/import";
import { WebSocketManager } from "./network/webSocketManager";
import { exportActors } from "../utils/actorExport";
import { ActorExportForm } from "./apps/actorExportForm"; // Add this import

// Declare QuickInsert interface
declare global {
  interface Window {
    QuickInsert: {
      open: (context: any) => void;
      search: (text: string, filter?: ((item: any) => boolean) | null, max?: number) => Promise<any[]>;
      forceIndex: () => void;
      handleKeybind: (event: KeyboardEvent, context: any) => void;
      hasIndex: boolean;
    };
  }
}

let module: FoundryGetActorsExternal;

Hooks.once("init", () => {
  console.log(`Initializing ${moduleId}`);

  module = (game as Game).modules.get(moduleId) as FoundryGetActorsExternal;
  module.communicationPanel = new CommunicationPanel();
  
  // Register module settings for WebSocket configuration
  (game as Game).settings.register(moduleId, "wsRelayUrl", {
    name: "WebSocket Relay URL",
    hint: "URL for the WebSocket relay server",
    scope: "world",
    config: true,
    type: String,
    default: "ws://localhost:3010",
    onChange: () => {
      if (module.socketManager) {
        module.socketManager.disconnect();
        initializeWebSocket();
      }
    }
  });
  
  (game as Game).settings.register(moduleId, "wsRelayToken", {
    name: "WebSocket Relay Token",
    hint: "Token for the WebSocket relay server (groups users together)",
    scope: "world",
    config: true,
    type: String,
    default: (game as Game).world.id,
    onChange: () => {
      if (module.socketManager) {
        module.socketManager.disconnect();
        initializeWebSocket();
      }
    }
  });

  // Register module settings
  (game as Game).settings.register(moduleId, "actorFolderUuid", {
    name: "Actor Folder UUID",
    hint: "UUID of the folder from which to retrieve actors for export",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  (game as Game).settings.register(moduleId, "exportPath", {
    name: "Disk Folder Path",
    hint: "Path where actor data will be exported",
    scope: "world",
    config: true,
    type: String,
    default: `data/external/${(game as Game).world.id}/actors`
  });

  (game as Game).settings.register(moduleId, "backupLimit", {
    name: "Backup Limit",
    hint: "Number of backup folders to keep (0 = keep all)",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  // Add export button
  (game as Game).settings.registerMenu(moduleId, "exportActors", {
    name: "Export Actors",
    label: "Export Actors to Disk",
    hint: "Export all actors from the specified folder to disk",
    icon: "fas fa-file-export",
    type: ActorExportForm,
    restricted: true
  });
  // Create and expose module API
  module.api = {
    exportActors,
    getWebSocketManager: () => module.socketManager,
    search: async (query: string, filter?: string) => {
      if (!window.QuickInsert) {
        console.error(`${moduleId} | QuickInsert not available`);
        return [];
      }
      
      // Check if QuickInsert has an index and try to force index if needed
      if (!window.QuickInsert.hasIndex) {
        console.log(`${moduleId} | QuickInsert index not ready, forcing index creation`);
        try {
          window.QuickInsert.forceIndex();
          // Wait a moment for indexing to complete
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`${moduleId} | Failed to force QuickInsert index:`, error);
        }
      }
      
      // Convert string filter to a filter function if provided
      let filterFunc = null;
      if (filter) {
        filterFunc = (item: any) => item.documentType === filter;
      }
      
      return window.QuickInsert.search(query, filterFunc, 100);
    },
    getByUuid: async (uuid: string) => {
      try {
        return await fromUuid(uuid);
      } catch (error) {
        console.error(`${moduleId} | Error getting entity by UUID:`, error);
        return null;
      }
    }
  };
});

Hooks.once("ready", () => {
  setTimeout(() => {
    initializeWebSocket();
  }, 1000);
});

function initializeWebSocket() {
  // Get settings
  const wsRelayUrl = (game as Game).settings.get(moduleId, "wsRelayUrl") as string;
  const wsRelayToken = (game as Game).settings.get(moduleId, "wsRelayToken") as string;
  
  if (!wsRelayUrl) {
    console.error(`${moduleId} | WebSocket relay URL is empty. Please configure it in module settings.`);
    return;
  }
  
  console.log(`${moduleId} | Initializing WebSocket with URL: ${wsRelayUrl}, token: ${wsRelayToken}`);
  
  try {
    // Create and connect the WebSocket manager
    module.socketManager = new WebSocketManager(wsRelayUrl, wsRelayToken);
    module.socketManager.connect();
    
    // Register message handlers
    
    // Handle ping messages
    module.socketManager.onMessageType("ping", () => {
      console.log(`${moduleId} | Received ping, sending pong`);
      module.socketManager.send({ type: "pong" });
    });

    // Handle pong messages
    module.socketManager.onMessageType("pong", () => {
      console.log(`${moduleId} | Received pong`);
    });
    
    // Handle search requests
    module.socketManager.onMessageType("perform-search", async (data) => {
      console.log(`${moduleId} | Received search request:`, data);
      
      try {
        // Use QuickInsert to perform the search
        if (!window.QuickInsert) {
          console.error(`${moduleId} | QuickInsert not available`);
          module.socketManager.send({
            type: "search-results",
            requestId: data.requestId,
            error: "QuickInsert not available",
            results: []
          });
          return;
        }
        
        // Check if QuickInsert has an index
        if (!window.QuickInsert.hasIndex) {
          console.log(`${moduleId} | QuickInsert index not ready, forcing index creation`);
          try {
            window.QuickInsert.forceIndex();
            // Wait a moment for indexing to complete
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            console.error(`${moduleId} | Failed to force QuickInsert index:`, error);
            module.socketManager.send({
              type: "search-results",
              requestId: data.requestId,
              error: "QuickInsert index not ready",
              results: []
            });
            return;
          }
        }
        
        // Convert string filter to a filter function if provided
        let filterFunc = null;
        if (data.filter) {
          filterFunc = (result: any) => {
            if (!result.item.documentType) return false;
            return result.item.documentType.toLowerCase() === data.filter.toLowerCase();
          };
        }
        
        // Perform the search with the filter function
        const results = await window.QuickInsert.search(data.query, filterFunc, 100);
        console.log(`${moduleId} | Search results:`, results);
        
        // Send results back to the server
        module.socketManager.send({
          type: "search-results",
          requestId: data.requestId,
          results: results.map(result => {
            // Each result has an 'item' property containing the actual data
            const item = result.item;
            return {
              name: item.name,
              id: item.id,
              img: item.img,
              documentType: item.documentType,
              uuid: item.uuid,
              tagline: item.tagline || "",
              // Also include the formatted match for highlighting
              formattedMatch: result.formattedMatch || ""
            };
          })
        });
      } catch (error) {
        console.error(`${moduleId} | Error performing search:`, error);
        module.socketManager.send({
          type: "search-results",
          requestId: data.requestId,
          error: (error as Error).message,
          results: []
        });
      }
    });
    
    // Handle entity requests
    module.socketManager.onMessageType("get-entity", async (data) => {
      console.log(`${moduleId} | Received entity request:`, data);
      
      try {
        // Use Foundry's fromUuid to get the entity
        const entity = await fromUuid(data.uuid);
        
        if (!entity) {
          console.error(`${moduleId} | Entity not found for UUID: ${data.uuid}`);
          module.socketManager.send({
            type: "entity-data",
            requestId: data.requestId,
            uuid: data.uuid,
            error: "Entity not found",
            data: null
          });
          return;
        }
        
        // Convert entity to plain object and send back
        const entityData = entity.toObject ? entity.toObject() : entity;
        console.log(`${moduleId} | Sending entity data for: ${data.uuid}`, entityData);
        
        module.socketManager.send({
          type: "entity-data",
          requestId: data.requestId,
          uuid: data.uuid,
          data: entityData
        });
      } catch (error) {
        console.error(`${moduleId} | Error getting entity:`, error);
        module.socketManager.send({
          type: "entity-data",
          requestId: data.requestId,
          uuid: data.uuid,
          error: (error as Error).message,  // Add type assertion
          data: null
        });
      }
    });
  } catch (error) {
    console.error(`${moduleId} | Error initializing WebSocket:`, error);
  }
}

// Add button to the sidebar
Hooks.on("renderActorDirectory", (_: Application, html: JQuery) => {
  const button = $(
    `<button class="cc-sidebar-button" type="button">💬</button>`
  );
  button.on("click", () => {
    module.communicationPanel.render(true);
  });
  html.find(".directory-header .action-buttons").append(button);
});

// Scene directory context menu
Hooks.on(
  "getSceneDirectoryEntryContext",
  (
    _html: JQuery,
    options: {
      name: string;
      icon: string;
      condition: ((li: any) => any) | (() => any);
      callback: ((li: any) => Promise<void>) | (() => Promise<void>);
    }[]
  ) => {
    options.push({
      name: "Export Scene Package",
      icon: '<i class="fas fa-file-export"></i>',
      condition: (_) => (game as Game).user?.isGM,
      callback: (li) => exportScene(li.data("documentId")),
    });

    options.push({
      name: "Import Scene Package", 
      icon: '<i class="fas fa-file-import"></i>',
      condition: () => (game as Game).user?.isGM,
      callback: async () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".zip";
        input.onchange = async (event: Event) => {
          const file = (event.target as HTMLInputElement).files?.[0];
          if (file) {
            await importScene(file);
          }
        };
        input.click();
      },
    });
  }
);
