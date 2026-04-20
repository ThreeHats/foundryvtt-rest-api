import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, assertGM } from "../../utils/permissions";

export const router = new Router("userRouter");

/**
 * Resolve a user target from request data by id or name.
 */
function resolveUserTarget(data: any): any | null {
    if (data.id) {
        return game.users?.get(data.id) ?? null;
    }
    if (data.name) {
        return game.users?.find(u => u.name?.toLowerCase() === data.name.toLowerCase()) ?? null;
    }
    return null;
}

/**
 * Serialize a user to safe fields (no password/salt).
 */
function serializeUser(u: any) {
    return {
        id: u.id,
        name: u.name,
        role: u.role,
        isGM: u.isGM,
        active: u.active,
        color: u.color ?? null,
        avatar: u.avatar ?? null,
        character: u.character ?? null,
    };
}

// List all users
router.addRoute({
    actionType: "get-users",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received get-users request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-users-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "list users");
            }

            const users = game.users?.contents.map(serializeUser) || [];

            socketManager?.send({
                type: "get-users-result",
                requestId: data.requestId,
                data: users,
            });
        } catch (error) {
            ModuleLogger.error(`Error listing users:`, error);
            socketManager?.send({
                type: "get-users-result",
                requestId: data.requestId,
                error: (error as Error).message,
                data: null,
            });
        }
    }
});

// Get a single user
router.addRoute({
    actionType: "get-user",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received get-user request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-user-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "get user");
            }

            const target = resolveUserTarget(data);
            if (!target) {
                socketManager?.send({
                    type: "get-user-result",
                    requestId: data.requestId,
                    error: "User not found",
                    data: null,
                });
                return;
            }

            socketManager?.send({
                type: "get-user-result",
                requestId: data.requestId,
                data: serializeUser(target),
            });
        } catch (error) {
            ModuleLogger.error(`Error getting user:`, error);
            socketManager?.send({
                type: "get-user-result",
                requestId: data.requestId,
                error: (error as Error).message,
                data: null,
            });
        }
    }
});

// Create a new user
router.addRoute({
    actionType: "create-user",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received create-user request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "create-user-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "create users");
            }

            if (!data.name) {
                throw new Error("User name is required");
            }

            const createData: any = {
                name: data.name,
                role: data.role ?? 1,
            };
            if (data.password) {
                createData.password = data.password;
            }

            const created = await (User as any).create(createData);
            if (!created) {
                throw new Error("Failed to create user");
            }

            socketManager?.send({
                type: "create-user-result",
                requestId: data.requestId,
                data: serializeUser(created),
            });
        } catch (error) {
            ModuleLogger.error(`Error creating user:`, error);
            socketManager?.send({
                type: "create-user-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Update an existing user
router.addRoute({
    actionType: "update-user",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received update-user request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "update-user-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "update users");
            }

            const target = resolveUserTarget(data);
            if (!target) {
                throw new Error("User not found");
            }

            // Safety: prevent demoting the last GM
            if (data.data?.role !== undefined && data.data.role < 4 && target.role === 4) {
                const gmCount = game.users?.contents.filter(u => u.role === 4).length ?? 0;
                if (gmCount <= 1) {
                    throw new Error("Cannot demote the last GM user");
                }
            }

            await target.update(data.data);
            const updated = game.users?.get(target.id);

            socketManager?.send({
                type: "update-user-result",
                requestId: data.requestId,
                data: serializeUser(updated ?? target),
            });
        } catch (error) {
            ModuleLogger.error(`Error updating user:`, error);
            socketManager?.send({
                type: "update-user-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Delete a user
router.addRoute({
    actionType: "delete-user",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received delete-user request`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "delete-user-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "delete users");
            }

            const target = resolveUserTarget(data);
            if (!target) {
                throw new Error("User not found");
            }

            // Safety: can't delete yourself
            if (target.id === game.user?.id) {
                throw new Error("Cannot delete the currently active GM user");
            }

            // Safety: can't delete the last GM
            if (target.role === 4) {
                const gmCount = game.users?.contents.filter(u => u.role === 4).length ?? 0;
                if (gmCount <= 1) {
                    throw new Error("Cannot delete the last GM user");
                }
            }

            await target.delete();

            socketManager?.send({
                type: "delete-user-result",
                requestId: data.requestId,
                success: true,
            });
        } catch (error) {
            ModuleLogger.error(`Error deleting user:`, error);
            socketManager?.send({
                type: "delete-user-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message,
            });
        }
    }
});
