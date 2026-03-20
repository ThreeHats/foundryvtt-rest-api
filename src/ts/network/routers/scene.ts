import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { deepSerializeEntity } from "../../utils/serialization";
import { resolveRequestUser, serializeWithPermission, filterByPermission, assertWritePermission, assertGM } from "../../utils/permissions";

export const router = new Router("sceneRouter");

/**
 * Resolve a scene from request data by sceneId, name, or active/viewed flags.
 */
function resolveScene(data: any): any | null {
    if (data.sceneId) {
        return game.scenes?.get(data.sceneId) ?? null;
    }
    if (data.name) {
        return game.scenes?.find(s => s.name === data.name) ?? null;
    }
    if (data.active) {
        return game.scenes?.active ?? null;
    }
    if (data.viewed) {
        return game.scenes?.viewed ?? null;
    }
    return null;
}

// Get scene(s)
router.addRoute({
    actionType: "get-scene",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received get-scene request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-scene-result");
            if (shouldReturn) return;

            let result: any;

            if (data.all) {
                const scenes = game.scenes?.contents || [];
                if (user) {
                    result = filterByPermission(scenes, user);
                } else {
                    result = scenes.map(s => deepSerializeEntity(s));
                }
            } else {
                const scene = resolveScene(data);
                if (!scene) {
                    socketManager?.send({
                        type: "get-scene-result",
                        requestId: data.requestId,
                        error: "Scene not found",
                        data: null
                    });
                    return;
                }

                if (user) {
                    result = serializeWithPermission(scene, user);
                    if (!result) {
                        socketManager?.send({
                            type: "get-scene-result",
                            requestId: data.requestId,
                            error: `User '${user.name}' does not have permission to view this scene`,
                            data: null
                        });
                        return;
                    }
                } else {
                    result = deepSerializeEntity(scene);
                }
            }

            socketManager?.send({
                type: "get-scene-result",
                requestId: data.requestId,
                data: result
            });
        } catch (error) {
            ModuleLogger.error(`Error getting scene:`, error);
            socketManager?.send({
                type: "get-scene-result",
                requestId: data.requestId,
                error: (error as Error).message,
                data: null
            });
        }
    }
});

// Create a scene
router.addRoute({
    actionType: "create-scene",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received create-scene request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "create-scene-result");
            if (shouldReturn) return;

            if (user) {
                if (!(user as any).can("SCENE_CREATE") && !user.isGM) {
                    throw new Error(`User '${user.name}' does not have permission to create scenes`);
                }
            }

            const scene = await (Scene as any).create(data.data);
            if (!scene) {
                throw new Error("Failed to create scene");
            }

            socketManager?.send({
                type: "create-scene-result",
                requestId: data.requestId,
                data: scene.toObject()
            });
        } catch (error) {
            ModuleLogger.error(`Error creating scene:`, error);
            socketManager?.send({
                type: "create-scene-result",
                requestId: data.requestId,
                error: (error as Error).message
            });
        }
    }
});

// Update a scene
router.addRoute({
    actionType: "update-scene",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received update-scene request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "update-scene-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error("Scene not found");
            }

            if (user) {
                assertWritePermission(scene, user, "update");
            }

            await scene.update(data.data);
            const updated = game.scenes?.get(scene.id);

            socketManager?.send({
                type: "update-scene-result",
                requestId: data.requestId,
                data: updated ? updated.toObject() : scene.toObject()
            });
        } catch (error) {
            ModuleLogger.error(`Error updating scene:`, error);
            socketManager?.send({
                type: "update-scene-result",
                requestId: data.requestId,
                error: (error as Error).message
            });
        }
    }
});

// Delete a scene
router.addRoute({
    actionType: "delete-scene",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received delete-scene request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "delete-scene-result");
            if (shouldReturn) return;

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error("Scene not found");
            }

            if (user) {
                assertWritePermission(scene, user, "delete");
            }

            await scene.delete();

            socketManager?.send({
                type: "delete-scene-result",
                requestId: data.requestId,
                success: true
            });
        } catch (error) {
            ModuleLogger.error(`Error deleting scene:`, error);
            socketManager?.send({
                type: "delete-scene-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});

// Switch (activate) a scene
router.addRoute({
    actionType: "switch-scene",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received switch-scene request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "switch-scene-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "switch scenes");
            }

            const scene = resolveScene(data);
            if (!scene) {
                throw new Error("Scene not found");
            }

            await scene.activate();

            socketManager?.send({
                type: "switch-scene-result",
                requestId: data.requestId,
                success: true,
                data: scene.toObject()
            });
        } catch (error) {
            ModuleLogger.error(`Error switching scene:`, error);
            socketManager?.send({
                type: "switch-scene-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});
