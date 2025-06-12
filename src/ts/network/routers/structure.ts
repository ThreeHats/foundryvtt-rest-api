import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("structureRouter");

router.addRoute({
  actionType: "get-structure",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received structure request`);

    try {
      // Get all folders
      const folders = Object.entries((game as Game).folders?.contents || []).map(([_, folder]) => {
        return {
          id: folder.id,
          name: folder.name,
          type: folder.type,
          parent: folder.parent?.id,
          path: folder.uuid,
          sorting: (folder as any).sort,
          sortingMode: (folder as any).sortingMode
        };
      });

      // Get all compendiums
      const compendiums = (game as Game).packs.contents.map(pack => {
        return {
          id: pack.collection,
          name: pack.metadata.label,
          path: `Compendium.${pack.collection}`,
          entity: pack.documentName,
          package: pack.metadata.package,
          packageType: pack.metadata.type,
          system: pack.metadata.system
        };
      });

      socketManager?.send({
        type: "structure-data",
        requestId: data.requestId,
        folders,
        compendiums
      });
    } catch (error) {
      ModuleLogger.error(`Error getting structure:`, error);
      socketManager?.send({
        type: "structure-data",
        requestId: data.requestId,
        error: (error as Error).message,
        folders: [],
        compendiums: []
      });
    }
  }
});

router.addRoute({
  actionType: "get-contents",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received contents request for path: ${data.path}`);

    try {
      let contents = [];

      if (data.path.startsWith("Compendium.")) {
        // Handle compendium path
        const pack = (game as Game).packs.get(data.path.replace("Compendium.", ""));
        if (!pack) {
          throw new Error(`Compendium not found: ${data.path}`);
        }

        // Get the index if not already loaded
        const index = await pack.getIndex();

        // Return entries from the index
        contents = index.contents.map(entry => {
          return {
            uuid: `${pack.collection}.${entry._id}`,
            id: entry._id,
            name: entry.name,
            img: 'img' in entry ? entry.img : null,
            type: 'type' in entry ? entry.type : null
          };
        });
      } else {
        // Handle folder path
        // Extract folder ID from path like "Folder.abcdef12345"
        const folderMatch = data.path.match(/Folder\.([a-zA-Z0-9]+)/);
        if (!folderMatch) {
          throw new Error(`Invalid folder path: ${data.path}`);
        }

        const folderId = folderMatch[1];
        const folder = (game as Game).folders?.get(folderId);

        if (!folder) {
          throw new Error(`Folder not found: ${data.path}`);
        }

        // Get entities in folder
        contents = folder.contents.map(entity => {
          return {
            uuid: entity.uuid,
            id: entity.id,
            name: entity.name,
            img: 'img' in entity ? entity.img : null,
            type: entity.documentName
          };
        });
      }

      socketManager?.send({
        type: "contents-data",
        requestId: data.requestId,
        path: data.path,
        entities: contents
      });
    } catch (error) {
      ModuleLogger.error(`Error getting contents:`, error);
      socketManager?.send({
        type: "contents-data",
        requestId: data.requestId,
        path: data.path,
        error: (error as Error).message,
        entities: []
      });
    }
  }
});
