import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, assertWritePermission, hasPermission } from "../../utils/permissions";

export const router = new Router("canvasRouter");

/**
 * Map from URL documentType to Foundry embedded collection name.
 */
const COLLECTION_MAP: Record<string, string> = {
    tokens: "tokens",
    tiles: "tiles",
    drawings: "drawings",
    lights: "lights",
    sounds: "sounds",
    notes: "notes",
    templates: "templates",
    walls: "walls"
};

/**
 * Resolve the target scene. Uses sceneId if provided, otherwise falls back to active scene.
 */
function resolveScene(data: any): any | null {
    if (data.sceneId) {
        return game.scenes?.get(data.sceneId) ?? null;
    }
    return game.scenes?.active ?? null;
}

// Get canvas embedded documents
router.addRoute({
    actionType: "get-canvas-documents",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received get-canvas-documents request for ${data.documentType}`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-canvas-documents-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error(data.sceneId ? `Scene not found: ${data.sceneId}` : "No active scene");
            }

            if (user && !hasPermission(scene, user, "LIMITED")) {
                throw new Error(`User '${user.name}' does not have permission to view this scene's documents`);
            }

            const collectionName = COLLECTION_MAP[data.documentType];
            if (!collectionName) {
                throw new Error(`Invalid document type: ${data.documentType}`);
            }

            const collection = scene[collectionName];
            if (!collection) {
                throw new Error(`Collection '${collectionName}' not found on scene`);
            }

            let result: any[];
            if (data.documentId) {
                const doc = collection.get(data.documentId);
                if (!doc) {
                    throw new Error(`Document not found: ${data.documentId}`);
                }
                result = [doc.toObject()];
            } else {
                result = collection.contents.map((d: any) => d.toObject());
            }

            socketManager?.send({
                type: "get-canvas-documents-result",
                requestId: data.requestId,
                sceneId: scene.id,
                documentType: data.documentType,
                data: result
            });
        } catch (error) {
            ModuleLogger.error(`Error getting canvas documents:`, error);
            socketManager?.send({
                type: "get-canvas-documents-result",
                requestId: data.requestId,
                error: (error as Error).message,
                data: null
            });
        }
    }
});

// Create canvas embedded document(s)
router.addRoute({
    actionType: "create-canvas-document",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received create-canvas-document request for ${data.documentType}`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "create-canvas-document-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error(data.sceneId ? `Scene not found: ${data.sceneId}` : "No active scene");
            }

            if (user) {
                assertWritePermission(scene, user, "create embedded documents on");
            }

            const className = data.className;
            const dataArray = Array.isArray(data.data) ? data.data : [data.data];

            const created = await scene.createEmbeddedDocuments(className, dataArray);

            socketManager?.send({
                type: "create-canvas-document-result",
                requestId: data.requestId,
                sceneId: scene.id,
                documentType: data.documentType,
                data: created.map((d: any) => d.toObject())
            });
        } catch (error) {
            ModuleLogger.error(`Error creating canvas document:`, error);
            socketManager?.send({
                type: "create-canvas-document-result",
                requestId: data.requestId,
                error: (error as Error).message
            });
        }
    }
});

// Update a canvas embedded document
router.addRoute({
    actionType: "update-canvas-document",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received update-canvas-document request for ${data.documentType} ${data.documentId}`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "update-canvas-document-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error(data.sceneId ? `Scene not found: ${data.sceneId}` : "No active scene");
            }

            if (user) {
                assertWritePermission(scene, user, "update embedded documents on");
            }

            const className = data.className;
            const updateData = { _id: data.documentId, ...data.data };

            const updated = await scene.updateEmbeddedDocuments(className, [updateData]);

            socketManager?.send({
                type: "update-canvas-document-result",
                requestId: data.requestId,
                sceneId: scene.id,
                documentType: data.documentType,
                data: updated.map((d: any) => d.toObject())
            });
        } catch (error) {
            ModuleLogger.error(`Error updating canvas document:`, error);
            socketManager?.send({
                type: "update-canvas-document-result",
                requestId: data.requestId,
                error: (error as Error).message
            });
        }
    }
});

// Delete a canvas embedded document
router.addRoute({
    actionType: "delete-canvas-document",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received delete-canvas-document request for ${data.documentType} ${data.documentId}`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "delete-canvas-document-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error(data.sceneId ? `Scene not found: ${data.sceneId}` : "No active scene");
            }

            if (user) {
                assertWritePermission(scene, user, "delete embedded documents from");
            }

            const className = data.className;
            const ids = Array.isArray(data.documentId) ? data.documentId : [data.documentId];

            await scene.deleteEmbeddedDocuments(className, ids);

            socketManager?.send({
                type: "delete-canvas-document-result",
                requestId: data.requestId,
                sceneId: scene.id,
                documentType: data.documentType,
                success: true
            });
        } catch (error) {
            ModuleLogger.error(`Error deleting canvas document:`, error);
            socketManager?.send({
                type: "delete-canvas-document-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});
