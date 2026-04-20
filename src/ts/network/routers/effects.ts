import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, serializeWithPermission, assertWritePermission } from "../../utils/permissions";


export const router = new Router("effectsRouter");

// List all available status effects (does not require init hook)
router.addRoute({
    actionType: "get-status-effects",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received get-status-effects request`);

        try {
            const effects = (CONFIG.statusEffects || []).map((s: any) => ({
                id: s.id,
                name: s.name || s.label || s.id,
                icon: s.icon || s.img || null,
            }));

            socketManager?.send({
                type: "get-status-effects-result",
                requestId: data.requestId,
                data: { effects },
            });
        } catch (error) {
            ModuleLogger.error(`Error in get-status-effects:`, error);
            socketManager?.send({
                type: "get-status-effects-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

Hooks.once('init', () => {

    // Get all active effects on an actor
    router.addRoute({
        actionType: "get-effects",
        handler: async (data, context) => {
            const socketManager = context?.socketManager;
            ModuleLogger.info(`Received get-effects request:`, data);

            try {
                const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-effects-result");
                if (shouldReturn) return;

                const { uuid } = data;
                if (!uuid) throw new Error("uuid is required");

                const document: any = await fromUuid(uuid);
                if (!document) throw new Error(`Document not found with UUID: ${uuid}`);

                // Resolve to the actor (handle both actor and token UUIDs)
                const actor = document.actor || document;

                if (user) {
                    const serialized = serializeWithPermission(actor, user);
                    if (!serialized) {
                        throw new Error(`User '${user.name}' does not have permission to view '${actor.name}'`);
                    }
                }

                const effects = actor.effects?.map((e: any) => ({
                    id: e.id,
                    uuid: e.uuid,
                    name: e.name || e.label,
                    icon: e.icon || e.img,
                    disabled: e.disabled,
                    duration: e.duration,
                    statuses: Array.from(e.statuses || []),
                    changes: e.changes || [],
                    origin: e.origin,
                })) || [];

                socketManager?.send({
                    type: "get-effects-result",
                    requestId: data.requestId,
                    data: {
                        uuid: actor.uuid,
                        effects,
                    },
                });

            } catch (error) {
                ModuleLogger.error(`Error in get-effects:`, error);
                socketManager?.send({
                    type: "get-effects-result",
                    requestId: data.requestId,
                    error: (error as Error).message,
                });
            }
        }
    });

    // Add an active effect to an actor
    router.addRoute({
        actionType: "add-effect",
        handler: async (data, context) => {
            const socketManager = context?.socketManager;
            ModuleLogger.info(`Received add-effect request:`, data);

            try {
                const { user, shouldReturn } = resolveRequestUser(data, socketManager, "add-effect-result");
                if (shouldReturn) return;

                const { uuid, statusId, effectData } = data;
                if (!uuid) throw new Error("uuid is required");
                if (!statusId && !effectData) throw new Error("Either statusId or effectData is required");

                const document: any = await fromUuid(uuid);
                if (!document) throw new Error(`Document not found with UUID: ${uuid}`);

                const actor = document.actor || document;

                if (user) {
                    assertWritePermission(actor, user, "add effects to");
                }

                let createdEffect: any;

                if (statusId) {
                    // Apply a standard status effect
                    const statusEffect = CONFIG.statusEffects?.find((s: any) => s.id === statusId);
                    if (!statusEffect) {
                        throw new Error(`Unknown status effect: '${statusId}'. Available: ${(CONFIG.statusEffects || []).map((s: any) => s.id).join(', ')}`);
                    }

                    // Check if the actor already has this status
                    const existing = actor.effects?.find((e: any) => e.statuses?.has(statusId));
                    if (existing) {
                        throw new Error(`Actor '${actor.name}' already has status '${statusId}'`);
                    }

                    // Use token toggle if available, otherwise create directly
                    const token = document.documentName === "Token" ? document : null;
                    if (token && token.object?.toggleActiveEffect) {
                        await token.object.toggleActiveEffect(statusEffect, { active: true });
                        createdEffect = actor.effects?.find((e: any) => e.statuses?.has(statusId));
                    } else {
                        // Create the effect directly on the actor
                        const effectPayload = {
                            name: (statusEffect as any).name || (statusEffect as any).label || statusId,
                            icon: statusEffect.icon || (statusEffect as any).img,
                            statuses: [statusId],
                        };
                        const created = await actor.createEmbeddedDocuments("ActiveEffect", [effectPayload]);
                        createdEffect = created?.[0];
                    }
                } else if (effectData) {
                    // Create a custom ActiveEffect
                    const created = await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
                    createdEffect = created?.[0];
                }

                socketManager?.send({
                    type: "add-effect-result",
                    requestId: data.requestId,
                    data: {
                        uuid: actor.uuid,
                        effect: createdEffect ? {
                            id: createdEffect.id,
                            uuid: createdEffect.uuid,
                            name: createdEffect.name || createdEffect.label,
                            icon: createdEffect.icon || createdEffect.img,
                            statuses: Array.from(createdEffect.statuses || []),
                        } : null,
                    },
                });

            } catch (error) {
                ModuleLogger.error(`Error in add-effect:`, error);
                socketManager?.send({
                    type: "add-effect-result",
                    requestId: data.requestId,
                    error: (error as Error).message,
                });
            }
        }
    });

    // Remove an active effect from an actor
    router.addRoute({
        actionType: "remove-effect",
        handler: async (data, context) => {
            const socketManager = context?.socketManager;
            ModuleLogger.info(`Received remove-effect request:`, data);

            try {
                const { user, shouldReturn } = resolveRequestUser(data, socketManager, "remove-effect-result");
                if (shouldReturn) return;

                const { uuid, effectId, statusId } = data;
                if (!uuid) throw new Error("uuid is required");
                if (!effectId && !statusId) throw new Error("Either effectId or statusId is required");

                const document: any = await fromUuid(uuid);
                if (!document) throw new Error(`Document not found with UUID: ${uuid}`);

                const actor = document.actor || document;

                if (user) {
                    assertWritePermission(actor, user, "remove effects from");
                }

                let removedId: string | null = null;

                if (statusId) {
                    // Find the effect by status ID
                    const effect = actor.effects?.find((e: any) => e.statuses?.has(statusId));
                    if (!effect) {
                        throw new Error(`Status '${statusId}' not found on actor '${actor.name}'`);
                    }

                    // Use token toggle if available, otherwise delete directly
                    const token = document.documentName === "Token" ? document : null;
                    const statusEffect = CONFIG.statusEffects?.find((s: any) => s.id === statusId);
                    if (token && token.object?.toggleActiveEffect && statusEffect) {
                        await token.object.toggleActiveEffect(statusEffect, { active: false });
                    } else {
                        await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
                    }
                    removedId = effect.id;
                } else if (effectId) {
                    // Delete by effect document ID
                    const effect = actor.effects?.get(effectId);
                    if (!effect) {
                        throw new Error(`Effect with ID '${effectId}' not found on actor '${actor.name}'`);
                    }
                    await actor.deleteEmbeddedDocuments("ActiveEffect", [effectId]);
                    removedId = effectId;
                }

                socketManager?.send({
                    type: "remove-effect-result",
                    requestId: data.requestId,
                    data: {
                        uuid: actor.uuid,
                        removedEffectId: removedId,
                    },
                });

            } catch (error) {
                ModuleLogger.error(`Error in remove-effect:`, error);
                socketManager?.send({
                    type: "remove-effect-result",
                    requestId: data.requestId,
                    error: (error as Error).message,
                });
            }
        }
    });

});
