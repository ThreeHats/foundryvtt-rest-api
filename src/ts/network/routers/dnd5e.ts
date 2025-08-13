import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("dnd5eRouter");

Hooks.once('init', () => {
    const isDnd5e = game.system.id === "dnd5e";

    if (isDnd5e) {
        // Get an actor's resources, spells, items, and features
        router.addRoute({
            actionType: "get-actor-details",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received get-actor-details request:`, data);

                try {
                    const { actorUuid, details } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!details || !Array.isArray(details) || details.length === 0) {
                        throw new Error("details array is required and cannot be empty");
                    }

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    const results: any = { uuid: actorUuid };

                    if (details.includes("resources")) {
                        results.resources = actor.system.resources;
                    }

                    if (details.includes("spells")) {
                        results.spells = actor.items.filter((i: any) => i.type === 'spell');
                    }

                    if (details.includes("items")) {
                        results.items = actor.items.filter((i: any) => ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'backpack'].includes(i.type));
                    }

                    if (details.includes("features")) {
                        results.features = actor.items.filter((i: any) => ['feat', 'background', 'class'].includes(i.type));
                    }

                    socketManager?.send({
                        type: "get-actor-details-result",
                        requestId: data.requestId,
                        data: results,
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in get-actor-details:`, error);
                    socketManager?.send({
                        type: "get-actor-details-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Add or remove charges from an item
        router.addRoute({
            actionType: "modify-item-charges",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received modify-item-charges request:`, data);

                try {
                    const { actorUuid, itemUuid, itemName, amount } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!itemUuid && !itemName) throw new Error("itemUuid or itemName is required");
                    if (typeof amount !== 'number') throw new Error("amount must be a number");

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    let item: any = null;
                    if (itemUuid) {
                        item = actor.items.get(itemUuid.split('.').pop());
                    } else if (itemName) {
                        item = actor.items.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase());
                    }

                    if (!item) throw new Error(`Item not found on actor ${actor.name}`);

                    const uses = item.system.uses || {};
                    const currentSpent = uses.spent || 0;
                    const currentValue = uses.value ?? uses.max ?? 0;
                    const maxUses = uses.max || 0;

                    // When amount is negative (using a charge), spent increases and value decreases.
                    const newSpent = Math.max(0, Math.min(maxUses, currentSpent - amount));
                    const newValue = Math.max(0, Math.min(maxUses, currentValue + amount));

                    // Create a full update payload to avoid silent failures with partial data
                    const updatePayload = {
                        system: {
                            ...item.system,
                            uses: {
                                ...item.system.uses,
                                spent: newSpent,
                                value: newValue
                            }
                        }
                    };
                    
                    await item.update(updatePayload);

                    socketManager?.send({
                        type: "modify-item-charges-result",
                        requestId: data.requestId,
                        data: {
                            itemUuid: item.uuid,
                            oldCharges: currentValue,
                            newCharges: newValue,
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in modify-item-charges:`, error);
                    socketManager?.send({
                        type: "modify-item-charges-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Use an item, spell, or feature for an actor
        const useAbilityHandler = async (data: any, context: any, abilityType: string | null) => {
            const socketManager = context?.socketManager;
            const actionType = abilityType ? `use-${abilityType}` : 'use-ability';
            ModuleLogger.info(`Received ${actionType} request:`, data);

            try {
                const { actorUuid, abilityUuid, abilityName, targetUuid } = data;
                if (!actorUuid) throw new Error("actorUuid is required");
                if (!abilityUuid && !abilityName) throw new Error("abilityUuid or abilityName is required");

                const actor: any = await fromUuid(actorUuid);
                if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                let ability: any = null;
                if (abilityUuid) {
                    ability = await fromUuid(abilityUuid);
                } else if (abilityName) {
                    const allAbilities = actor.items;
                    ability = allAbilities.find((i: any) => {
                        const nameMatch = i.name.toLowerCase() === abilityName.toLowerCase();
                        if (!nameMatch) return false;

                        if (!abilityType) return true; // For /use-ability, no type filter

                        if (abilityType === 'item') {
                            return i.type !== 'feat' && i.type !== 'spell';
                        }
                        
                        return i.type === abilityType; // For /use-feature and /use-spell
                    });
                }

                if (!ability) throw new Error(`Ability not found on actor ${actor.name}`);

                let targetToken = null;
                if (targetUuid) {
                    const targetDoc: any = await fromUuid(targetUuid);
                    if (targetDoc && targetDoc.documentName === "Token") {
                        targetToken = targetDoc;
                    } else if (targetDoc && targetDoc.documentName === "Actor") {
                        const scene = game.scenes?.active;
                        if (scene) {
                            const tokens = scene.tokens?.filter(t => t.actor?.id === targetDoc.id);
                            if (tokens && tokens.length > 0) {
                                targetToken = tokens[0];
                            }
                        }
                    }
                    if (targetToken && canvas?.tokens) {
                        game.user?.targets.forEach(t => t.setTarget(false, { releaseOthers: false }));
                        const tokenObject = canvas.tokens.get(targetToken.id);
                        if(tokenObject) {
                            tokenObject.setTarget(true, { releaseOthers: true });
                        }
                    }
                }
                
                const useResult = await ability.use();

                socketManager?.send({
                    type: `${actionType}-result`,
                    requestId: data.requestId,
                    data: {
                        uuid: actorUuid,
                        ability: ability.name,
                        result: useResult ? useResult.id : null
                    },
                });

            } catch (error) {
                ModuleLogger.error(`Error in ${actionType}:`, error);
                socketManager?.send({
                    type: `${actionType}-result`,
                    requestId: data.requestId,
                    error: (error as Error).message,
                });
            }
        };

        router.addRoute({
            actionType: "use-ability",
            handler: (data, context) => useAbilityHandler(data, context, null)
        });

        router.addRoute({
            actionType: "use-feature",
            handler: (data, context) => useAbilityHandler(data, context, 'feat')
        });

        router.addRoute({
            actionType: "use-spell",
            handler: (data, context) => useAbilityHandler(data, context, 'spell')
        });

        router.addRoute({
            actionType: "use-item",
            handler: (data, context) => useAbilityHandler(data, context, 'item')
        });

        // Modify actor experience
        router.addRoute({
            actionType: "modify-experience",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received modify-experience request:`, data);

                try {
                    const { actorUuid, selected, amount } = data;
                    if (!actorUuid && !selected) throw new Error("Either actorUuid or selected must be provided");
                    if (typeof amount !== 'number') throw new Error("amount must be a number");

                    let actor: any = null;
                    if (actorUuid) {
                        actor = await fromUuid(actorUuid);
                    } else if (selected) {
                        const selectedTokens = canvas.tokens?.controlled;
                        if (!selectedTokens || selectedTokens.length === 0) {
                            throw new Error("No token selected");
                        }
                        if (selectedTokens.length > 1) {
                            ModuleLogger.warn("Multiple tokens selected, using the first one.");
                        }
                        actor = selectedTokens[0].actor;
                    }

                    if (!actor) throw new Error(`Actor not found`);

                    const currentXp = actor.system.details.xp.value;
                    const newXp = currentXp + amount;

                    await actor.update({ "system.details.xp.value": newXp });

                    socketManager?.send({
                        type: "modify-experience-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            oldXp: currentXp,
                            newXp: newXp,
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in modify-experience:`, error);
                    socketManager?.send({
                        type: "modify-experience-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

    }
});