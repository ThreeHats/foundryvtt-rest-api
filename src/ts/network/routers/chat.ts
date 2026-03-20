import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, assertGM } from "../../utils/permissions";

export const router = new Router("chatRouter");

/**
 * Serialize a ChatMessage into a clean data object for the API response.
 * Includes full roll details (dice, critical/fumble, individual results).
 */
function serializeChatMessage(message: any): any {
    const rolls = message.rolls?.map((r: any) => ({
        formula: r.formula,
        total: r.total,
        isCritical: r.isCritical || false,
        isFumble: r.isFumble || false,
        dice: r.dice?.map((d: any) => ({
            faces: d.faces,
            results: d.results?.map((res: any) => ({
                result: res.result,
                active: res.active
            })) || []
        })) || []
    })) || [];

    return {
        id: message.id,
        uuid: message.uuid,
        content: message.content,
        speaker: message.speaker,
        timestamp: message.timestamp,
        whisper: message.whisper || [],
        type: message.type,
        author: message.author ? {
            id: message.author.id,
            name: message.author.name
        } : null,
        flavor: message.flavor || "",
        isRoll: message.isRoll || false,
        rolls,
        flags: message.flags || {}
    };
}

/**
 * Check if a user can see a given chat message.
 * Public messages are visible to all; whispered messages only to recipients and GMs.
 */
function canUserSeeMessage(message: any, user: any): boolean {
    // No whisper targets means it's public
    if (!message.whisper || message.whisper.length === 0) return true;
    // GMs can see all messages
    if (user.isGM) return true;
    // User is the author
    if (message.author?.id === user.id) return true;
    // User is a whisper recipient
    return message.whisper.includes(user.id);
}

// Get chat messages (paginated, filtered)
router.addRoute({
    actionType: "chat-messages",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received request for chat messages`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "chat-messages-result");
            if (shouldReturn) return;

            let messages = Array.from(game.messages || []);

            // Filter by user visibility
            if (user) {
                messages = messages.filter((m: any) => canUserSeeMessage(m, user));
            }

            // Filter by message type (chatType to avoid collision with WS message type)
            if (data.chatType !== undefined && data.chatType !== null) {
                messages = messages.filter((m: any) => m.type === data.chatType);
            }

            // Filter by speaker alias
            if (data.speaker) {
                messages = messages.filter((m: any) => m.speaker?.alias === data.speaker);
            }

            // Sort newest first
            messages.sort((a: any, b: any) => b.timestamp - a.timestamp);

            // Pagination
            const offset = data.offset || 0;
            const limit = data.limit || 50;
            const total = messages.length;
            const paginated = messages.slice(offset, offset + limit);

            socketManager?.send({
                type: "chat-messages-result",
                requestId: data.requestId,
                success: true,
                data: {
                    messages: paginated.map(serializeChatMessage),
                    total,
                    offset,
                    limit
                }
            });
        } catch (error) {
            ModuleLogger.error(`Error getting chat messages:`, error);
            socketManager?.send({
                type: "chat-messages-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});

// Send a chat message
router.addRoute({
    actionType: "chat-send",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received request to send chat message`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "chat-send-result");
            if (shouldReturn) return;

            const messageData: any = {
                content: data.content
            };

            if (data.whisper) messageData.whisper = data.whisper;
            if (data.flavor) messageData.flavor = data.flavor;
            if (data.chatType !== undefined) messageData.type = data.chatType;

            // Handle speaker
            if (data.speaker) {
                try {
                    const speakerEntity = await fromUuid(data.speaker);
                    if (speakerEntity) {
                        messageData.speaker = ChatMessage.getSpeaker({ actor: speakerEntity as any });
                    }
                } catch (err) {
                    ModuleLogger.warn(`Failed to resolve speaker UUID: ${err}`);
                }
            }

            if (data.alias) {
                messageData.speaker = messageData.speaker || {};
                messageData.speaker.alias = data.alias;
            }

            // Set the user if specified
            if (user) {
                messageData.user = user.id;
            }

            const message = await ChatMessage.create(messageData);

            if (!message) {
                throw new Error("Failed to create chat message");
            }

            socketManager?.send({
                type: "chat-send-result",
                requestId: data.requestId,
                success: true,
                data: serializeChatMessage(message)
            });
        } catch (error) {
            ModuleLogger.error(`Error sending chat message:`, error);
            socketManager?.send({
                type: "chat-send-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});

// Delete a specific chat message
router.addRoute({
    actionType: "chat-delete",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received request to delete chat message: ${data.messageId}`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "chat-delete-result");
            if (shouldReturn) return;

            const message = game.messages?.get(data.messageId);
            if (!message) {
                throw new Error(`Chat message not found: ${data.messageId}`);
            }

            // Only GM or message author can delete
            if (user) {
                const isAuthor = (message as any).author?.id === user.id;
                if (!isAuthor && !user.isGM) {
                    throw new Error(`User '${user.name}' does not have permission to delete this message`);
                }
            }

            await message.delete();

            socketManager?.send({
                type: "chat-delete-result",
                requestId: data.requestId,
                success: true,
                data: { messageId: data.messageId }
            });
        } catch (error) {
            ModuleLogger.error(`Error deleting chat message:`, error);
            socketManager?.send({
                type: "chat-delete-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});

// Flush all chat messages (GM only)
router.addRoute({
    actionType: "chat-flush",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received request to flush all chat messages`);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "chat-flush-result");
            if (shouldReturn) return;

            if (user) {
                assertGM(user, "flush chat messages");
            }

            await ChatMessage.deleteDocuments([], { deleteAll: true });

            socketManager?.send({
                type: "chat-flush-result",
                requestId: data.requestId,
                success: true,
                data: { message: "All chat messages have been deleted" }
            });
        } catch (error) {
            ModuleLogger.error(`Error flushing chat messages:`, error);
            socketManager?.send({
                type: "chat-flush-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});
