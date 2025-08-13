import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("structureRouter");

router.addRoute({
  actionType: "structure",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received structure request with params:`, data);

    try {
      // Parse parameters with defaults
      const includeEntityData = data.includeEntityData ?? false;
      const path = data.path || null;
      const recursive = data.recursive ?? false;
      const recursiveDepth = data.recursiveDepth ?? 5;
      const types = data.type ? (Array.isArray(data.types) ? data.types : [data.types]) : 
        ["Scene", "Actor", "Item", "JournalEntry", "RollTable", "Cards", "Macro", "Playlist"];

      // Type mapping for game collections
      const typeCollectionMap = {
        "Scene": game.scenes,
        "Actor": game.actors,
        "Item": game.items,
        "JournalEntry": game.journal,
        "RollTable": game.tables,
        "Cards": game.cards,
        "Macro": game.macros,
        "Playlist": game.playlists
      };

      // Helper function to get entity data
      const getEntityData = (entity: any) => {
        if (includeEntityData) {
          return entity.toObject(false);
        } else {
          return {
            uuid: entity.uuid,
            name: entity.name,
            id: entity.id,
            type: entity.documentName
          };
        }
      };

      // Helper function to build folder structure recursively
      const buildFolderStructure = (parentFolder: any, currentDepth: number = 0): any => {
        if (!recursive || currentDepth >= recursiveDepth) {
          return {};
        }

        const structure: any = {};
        const allFolders = game.folders?.contents || [];

        // Get child folders
        const childFolders = allFolders.filter(f => 
          f.folder?.id === parentFolder?.id && types.includes(f.type)
        );

        for (const folder of childFolders) {
          const folderKey = folder.name || folder.id;
          structure[folderKey] = {
            id: folder.id,
            uuid: folder.uuid,
            type: folder.type,
            ...buildFolderStructure(folder, currentDepth + 1)
          };

          // Add entities in this folder
          const folderEntities = folder.contents
            .filter((entity: any) => types.includes(entity.documentName))
            .map(getEntityData);

          if (folderEntities.length > 0) {
            structure[folderKey].entities = folderEntities;
          }
        }

        return structure;
      };

      // Start building the response
      let result: any = {};

      if (path && path.startsWith("Compendium.")) {
        // Handle compendium path
        const pack = game.packs.get(path.replace("Compendium.", ""));
        if (!pack) {
          throw new Error(`Compendium not found: ${path}`);
        }

        const index = await pack.getIndex();
        const entities = index.contents.map(entry => {
          if (includeEntityData) {
            return { ...entry };
          } else {
            return {
              uuid: (entry as any).uuid || `${pack.collection}.${entry._id}`,
              name: entry.name,
              id: entry._id,
              type: pack.documentName
            };
          }
        });

        result = {
          compendium: {
            name: pack.title,
            type: pack.documentName,
            entities
          }
        };
      } else if (path && path.startsWith("Folder.")) {
        // Handle specific folder path
        const folderMatch = path.match(/Folder\.([a-zA-Z0-9]+)/);
        if (!folderMatch) {
          throw new Error(`Invalid folder path: ${path}`);
        }

        const folderId = folderMatch[1];
        const startFolder = game.folders?.get(folderId);

        if (!startFolder) {
          throw new Error(`Folder not found: ${path}`);
        }

        if (!types.includes(startFolder.type)) {
          throw new Error(`Folder type ${startFolder.type} not included in requested types`);
        }

        // Build structure starting from this folder
        result.folders = buildFolderStructure(startFolder);
        
        // Add entities in the start folder
        const folderEntities = startFolder.contents
          .filter((entity: any) => types.includes(entity.documentName))
          .map(getEntityData);

        if (folderEntities.length > 0) {
          result.entities = folderEntities;
        }
      } else {
        // Handle root level structure
        if (recursive) {
          result.folders = buildFolderStructure(null);
        } else {
          // Non-recursive: just return folder info without nesting
          const folders = game.folders?.contents || [];
          result.folders = {};
          
          for (const type of types) {
            const typeFolders = folders.filter(f => f.type === type && !f.folder);
            for (const folder of typeFolders) {
              const folderKey = folder.name || folder.id;
              result.folders[folderKey] = {
                id: folder.id,
                uuid: folder.uuid,
                type: folder.type
              };

              // Add entities in folder if requested
              if (includeEntityData || !recursive) {
                const folderEntities = folder.contents
                  .filter((entity: any) => types.includes(entity.documentName))
                  .map(getEntityData);

                if (folderEntities.length > 0) {
                  result.folders[folderKey].entities = folderEntities;
                }
              }
            }
          }
        }

        // Add root entities (entities without folders)
        const rootEntities: any = {};
        for (const type of types) {
          const collection = typeCollectionMap[type as keyof typeof typeCollectionMap];
          if (collection) {
            const entities = (collection as any).filter((e: any) => !e.folder).map(getEntityData);
            if (entities.length > 0) {
              rootEntities[type.toLowerCase() + 's'] = entities;
            }
          }
        }

        if (Object.keys(rootEntities).length > 0) {
          result.entities = rootEntities;
        }

        // Add compendium packs if requested, filtered by types
        if (!path) { // Only show compendiums at root level
          const compendiumPacks: any = {};
          
          for (const pack of game.packs.contents) {
            // Filter compendiums by requested types
            if (types.includes(pack.documentName)) {
              const packKey = pack.title || pack.collection;
              
              compendiumPacks[packKey] = {
                id: pack.collection,
                name: pack.title,
                type: pack.documentName,
                uuid: `Compendium.${pack.collection}`
              };

              try {
                const index = await pack.getIndex();
                const entities = index.contents.map(entry => {
                  if (includeEntityData) {
                    return { ...entry };
                  } else {
                    return {
                      uuid: (entry as any).uuid || `${pack.collection}.${entry._id}`,
                      name: entry.name,
                      id: entry._id,
                      type: pack.documentName
                    };
                  }
                });
                
                if (entities.length > 0) {
                  compendiumPacks[packKey].entities = entities;
                }
              } catch (error) {
                ModuleLogger.warn(`Failed to load entities for compendium ${pack.collection}:`, error);
              }
            }
          }

          if (Object.keys(compendiumPacks).length > 0) {
            result.compendiumPacks = compendiumPacks;
          }
        }
      }

      socketManager?.send({
        type: "structure-result",
        requestId: data.requestId,
        data: result
      });
    } catch (error) {
      ModuleLogger.error(`Error getting structure:`, error);
      socketManager?.send({
        type: "structure-result",
        requestId: data.requestId,
        error: (error as Error).message,
        data: {}
      });
    }
  }
});

router.addRoute({
  actionType: "get-folder",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received get-folder request for name: ${data.name}`);

    try {
      const folders = game.folders?.contents || [];
      const folder = folders.find(f => f.name === data.name);

      if (!folder) {
        throw new Error(`Folder not found with name: ${data.name}`);
      }

      // Get folder contents
      const contents = folder.contents.map(entity => ({
        uuid: entity.uuid,
        id: entity.id,
        name: entity.name,
        type: entity.documentName,
        img: 'img' in entity ? entity.img : null
      }));

      socketManager?.send({
        type: "get-folder-result",
        requestId: data.requestId,
        data: {
          id: folder.id,
          uuid: folder.uuid,
          name: folder.name,
          type: folder.type,
          parentFolder: folder.folder?.id || null,
          contents
        }
      });
    } catch (error) {
      ModuleLogger.error(`Error getting folder:`, error);
      socketManager?.send({
        type: "get-folder-result",
        requestId: data.requestId,
        error: (error as Error).message,
        data: null
      });
    }
  }
});

router.addRoute({
  actionType: "create-folder",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received create-folder request:`, data);

    try {
      const folderData: any = {
        name: data.name,
        type: data.folderType
      };

      if (data.parentFolderId) {
        const parentFolder = game.folders?.get(data.parentFolderId);
        if (!parentFolder) {
          throw new Error(`Parent folder not found with ID: ${data.parentFolderId}`);
        }
        folderData.folder = data.parentFolderId;
      }

      const folder = await Folder.create(folderData);

      socketManager?.send({
        type: "create-folder-result",
        requestId: data.requestId,
        data: {
          id: folder!.id,
          uuid: folder!.uuid,
          name: folder!.name,
          type: folder!.type,
          parentFolder: folder!.folder?.id || null
        }
      });
    } catch (error) {
      ModuleLogger.error(`Error creating folder:`, error);
      socketManager?.send({
        type: "create-folder-result",
        requestId: data.requestId,
        error: (error as Error).message,
        data: null
      });
    }
  }
});

router.addRoute({
  actionType: "delete-folder",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received delete-folder request:`, data);

    try {
      const folder = game.folders?.get(data.folderId);
      if (!folder) {
        throw new Error(`Folder not found with ID: ${data.folderId}`);
      }

      const deleteAll = data.deleteAll ?? false;
      let entitiesDeleted = 0;
      let foldersDeleted = 0;

      // Helper function to recursively delete folders and count entities
      const recursiveDelete = async (folderToDelete: any): Promise<{ entities: number, folders: number }> => {
        let entityCount = 0;
        let folderCount = 0;

        // Get all child folders first
        const allFolders = game.folders?.contents || [];
        const childFolders = allFolders.filter(f => f.folder?.id === folderToDelete.id);

        // Recursively delete child folders first
        for (const childFolder of childFolders) {
          const childCounts = await recursiveDelete(childFolder);
          entityCount += childCounts.entities;
          folderCount += childCounts.folders;
        }

        // Count and delete entities in this folder
        const entitiesToDelete = folderToDelete.contents;
        entityCount += entitiesToDelete.length;
        
        for (const entity of entitiesToDelete) {
          await entity.delete();
        }

        // Delete the folder itself
        await folderToDelete.delete();
        folderCount += 1;

        return { entities: entityCount, folders: folderCount };
      };
      
      if (deleteAll) {
        // Recursively delete the folder and all its contents
        const counts = await recursiveDelete(folder);
        entitiesDeleted = counts.entities;
        foldersDeleted = counts.folders;
      } else {
        // Check if folder has any contents (entities or child folders) and refuse to delete if it does
        const allFolders = game.folders?.contents || [];
        const childFolders = allFolders.filter(f => f.folder?.id === folder.id);
        
        if (folder.contents.length > 0) {
          throw new Error(`Folder contains ${folder.contents.length} entities. Use deleteAll=true to delete them or move them first.`);
        }
        
        if (childFolders.length > 0) {
          throw new Error(`Folder contains ${childFolders.length} child folders. Use deleteAll=true to delete them or move them first.`);
        }

        // Delete the empty folder
        await folder.delete();
        foldersDeleted = 1;
      }

      socketManager?.send({
        type: "delete-folder-result",
        requestId: data.requestId,
        data: {
          deleted: true,
          folderId: data.folderId,
          entitiesDeleted,
          foldersDeleted
        }
      });
    } catch (error) {
      ModuleLogger.error(`Error deleting folder:`, error);
      socketManager?.send({
        type: "delete-folder-result",
        requestId: data.requestId,
        error: (error as Error).message,
        data: null
      });
    }
  }
});

router.addRoute({
  actionType: "contents",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received contents request for path: ${data.path}`);

    try {
      let contents = [];

      if (data.path.startsWith("Compendium.")) {
        // Handle compendium path
        const pack = game.packs.get(data.path.replace("Compendium.", ""));
        if (!pack) {
          throw new Error(`Compendium not found: ${data.path}`);
        }

        // Get the index if not already loaded
        const index = await pack.getIndex();

        // Return entries from the index
        contents = index.contents.map(entry => {
          return {
            ...entry
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
        const folder = game.folders?.get(folderId);

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
        type: "contents-result",
        requestId: data.requestId,
        path: data.path,
        entities: contents
      });
    } catch (error) {
      ModuleLogger.error(`Error getting contents:`, error);
      socketManager?.send({
        type: "contents-result",
        requestId: data.requestId,
        path: data.path,
        error: (error as Error).message,
        entities: []
      });
    }
  }
});
