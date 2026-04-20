import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, hasPermission } from "../../utils/permissions";
import { startSession, handleInput, endSession } from "../streaming/interactiveSession";

export const router = new Router("interactiveSessionRouter");

router.addRoute({
    actionType: "interactive-session-start",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        const sessionId = data.sessionId;

        ModuleLogger.info(`Received interactive session start for UUID: ${data.uuid}, sessionId: ${sessionId}`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "interactive-session-error");
            if (shouldReturn) return;

            let actor: Actor | null = null;
            if (data.uuid) {
                actor = await fromUuid(data.uuid) as Actor;
            } else if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled;
                if (controlledTokens && controlledTokens.length > 0) {
                    actor = data.actor ? controlledTokens[0].actor : controlledTokens[0].document as any;
                }
            }

            if (user && actor) {
                if (!hasPermission(actor, user, "OBSERVER")) {
                    socketManager?.send({
                        type: "interactive-session-error",
                        sessionId,
                        error: `User '${user.name}' does not have permission to view this sheet`,
                        fatal: true,
                    });
                    return;
                }
            }

            if (!actor) {
                socketManager?.send({
                    type: "interactive-session-error",
                    sessionId,
                    error: "Entity not found",
                    fatal: true,
                });
                return;
            }

            const sendMessage = (msg: any) => socketManager?.send(msg);

            const initialFrame = await startSession(
                sessionId,
                actor,
                { quality: data.quality, scale: data.scale, subscribeMutations: data.subscribeMutations },
                sendMessage
            );

            if (!initialFrame) {
                socketManager?.send({
                    type: "interactive-session-error",
                    sessionId,
                    error: "Failed to start interactive session",
                    fatal: true,
                });
                return;
            }

            socketManager?.send({
                type: "interactive-session-started",
                sessionId,
                imageData: initialFrame.imageData,
                mimeType: 'image/jpeg',
                width: initialFrame.width,
                height: initialFrame.height,
            });

        } catch (error) {
            ModuleLogger.error(`Error starting interactive session:`, error);
            socketManager?.send({
                type: "interactive-session-error",
                sessionId,
                error: "Failed to start interactive session",
                fatal: true,
            });
        }
    }
});

router.addRoute({
    actionType: "interactive-input",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        const { sessionId } = data;

        try {
            const frame = await handleInput(sessionId, data);

            if (!frame) {
                // Session doesn't exist — send a non-fatal warning, not a session error
                ModuleLogger.warn(`Interactive input for unknown/inactive session: ${sessionId}`);
                return;
            }

            socketManager?.send({
                type: "interactive-frame",
                sessionId,
                imageData: frame.imageData,
                mimeType: 'image/jpeg',
                width: frame.width,
                height: frame.height,
                trigger: 'input',
            });
        } catch (error) {
            ModuleLogger.error(`Error handling interactive input:`, error);
            // Don't send interactive-session-error for transient input failures —
            // that would kill the session on the relay side
        }
    }
});

router.addRoute({
    actionType: "interactive-session-end",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        const { sessionId } = data;

        const ended = endSession(sessionId);
        socketManager?.send({
            type: "interactive-session-ended",
            sessionId,
            reason: ended ? 'client-requested' : 'not-found',
        });
    }
});
