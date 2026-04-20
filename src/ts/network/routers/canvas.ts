import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, assertWritePermission, hasPermission, assertGM } from "../../utils/permissions";
import { getFoundryVersionMajor } from "../../utils/version";

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

// Move a token to specific coordinates
router.addRoute({
    actionType: "move-token",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received move-token request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "move-token-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "move tokens");

            const scene = resolveScene(data);
            if (!scene) throw new Error(data.sceneId ? `Scene not found: ${data.sceneId}` : "No active scene");

            const { uuid, name, x, y, waypoints, animate } = data;
            if (typeof x !== 'number' || typeof y !== 'number') throw new Error("x and y coordinates are required");
            if (!uuid && !name) throw new Error("uuid or name is required");

            let token: any = null;
            if (uuid) {
                const doc: any = await fromUuid(uuid);
                if (doc?.documentName === "Token") token = doc;
                else if (doc?.documentName === "Actor") {
                    token = scene.tokens?.find((t: any) => t.actor?.id === doc.id);
                }
            } else if (name) {
                token = scene.tokens?.find((t: any) =>
                    t.name?.toLowerCase() === name.toLowerCase()
                );
            }

            if (!token) throw new Error(`Token not found: ${uuid || name}`);

            const shouldAnimate = animate !== false;

            if (waypoints && Array.isArray(waypoints) && waypoints.length > 0) {
                for (const wp of waypoints) {
                    if (typeof wp.x !== 'number' || typeof wp.y !== 'number') {
                        throw new Error("Each waypoint must have x and y coordinates");
                    }
                    await token.update({ x: wp.x, y: wp.y }, { animate: shouldAnimate });
                    if (shouldAnimate) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
            }

            await token.update({ x, y }, { animate: shouldAnimate });

            socketManager?.send({
                type: "move-token-result",
                requestId: data.requestId,
                data: {
                    tokenUuid: token.uuid,
                    name: token.name,
                    x, y,
                    sceneId: scene.id,
                },
            });
        } catch (error) {
            ModuleLogger.error(`Error in move-token:`, error);
            socketManager?.send({
                type: "move-token-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Measure distance between two points or tokens
router.addRoute({
    actionType: "measure-distance",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received measure-distance request:`, data);

        try {
            const { shouldReturn } = resolveRequestUser(data, socketManager, "measure-distance-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) throw new Error(data.sceneId ? `Scene not found: ${data.sceneId}` : "No active scene");

            let originX: number, originY: number, targetX: number, targetY: number;

            // Resolve origin
            if (typeof data.originX === 'number' && typeof data.originY === 'number') {
                originX = data.originX;
                originY = data.originY;
            } else if (data.originUuid || data.originName) {
                let token: any = null;
                if (data.originUuid) {
                    const doc: any = await fromUuid(data.originUuid);
                    if (doc?.documentName === "Token") token = doc;
                    else if (doc?.documentName === "Actor") {
                        token = scene.tokens?.find((t: any) => t.actor?.id === doc.id);
                    }
                } else {
                    token = scene.tokens?.find((t: any) =>
                        t.name?.toLowerCase() === data.originName.toLowerCase()
                    );
                }
                if (!token) throw new Error(`Origin token not found: ${data.originUuid || data.originName}`);
                originX = token.x;
                originY = token.y;
            } else {
                throw new Error("Origin must be specified as originX/originY or originUuid/originName");
            }

            // Resolve target
            if (typeof data.targetX === 'number' && typeof data.targetY === 'number') {
                targetX = data.targetX;
                targetY = data.targetY;
            } else if (data.targetUuid || data.targetName) {
                let token: any = null;
                if (data.targetUuid) {
                    const doc: any = await fromUuid(data.targetUuid);
                    if (doc?.documentName === "Token") token = doc;
                    else if (doc?.documentName === "Actor") {
                        token = scene.tokens?.find((t: any) => t.actor?.id === doc.id);
                    }
                } else {
                    token = scene.tokens?.find((t: any) =>
                        t.name?.toLowerCase() === data.targetName.toLowerCase()
                    );
                }
                if (!token) throw new Error(`Target token not found: ${data.targetUuid || data.targetName}`);
                targetX = token.x;
                targetY = token.y;
            } else {
                throw new Error("Target must be specified as targetX/targetY or targetUuid/targetName");
            }

            const origin = { x: originX, y: originY };
            const target = { x: targetX, y: targetY };

            let distance: number;
            const isV13 = getFoundryVersionMajor() >= 13;

            if (isV13 && (canvas?.grid as any)?.measurePath) {
                const result = (canvas!.grid as any).measurePath([origin, target]);
                distance = result.distance ?? result.totalDistance ?? 0;
            } else if (canvas?.grid?.measureDistance) {
                distance = canvas.grid.measureDistance(origin, target);
            } else {
                // Fallback: Euclidean distance in pixels
                const dx = targetX - originX;
                const dy = targetY - originY;
                distance = Math.sqrt(dx * dx + dy * dy);
            }

            const gridUnits = (scene as any).grid?.units || (scene as any).data?.gridUnits || "ft";

            socketManager?.send({
                type: "measure-distance-result",
                requestId: data.requestId,
                data: {
                    distance,
                    units: gridUnits,
                    origin,
                    target,
                    sceneId: scene.id,
                },
            });
        } catch (error) {
            ModuleLogger.error(`Error in measure-distance:`, error);
            socketManager?.send({
                type: "measure-distance-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});
