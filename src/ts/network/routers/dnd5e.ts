import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, serializeWithPermission, assertWritePermission } from "../../utils/permissions";
import { getFoundryVersionMajor } from "../../utils/version";

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
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-actor-details-result");
                    if (shouldReturn) return;

                    const { actorUuid, details } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!details || !Array.isArray(details) || details.length === 0) {
                        throw new Error("details array is required and cannot be empty");
                    }

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    // If userId provided, use permission-aware serialization
                    if (user) {
                        const serialized = serializeWithPermission(actor, user);
                        if (!serialized) {
                            throw new Error(`User '${user.name}' does not have permission to view actor '${actor.name}'`);
                        }
                    }

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

                    if (details.includes("stats")) {
                        const classItems = actor.items.filter((i: any) => i.type === 'class');
                        const level = classItems.reduce((sum: number, i: any) => sum + (i.system.levels ?? 0), 0);
                        results.stats = {
                            name: actor.name,
                            img: actor.img,
                            uuid: actor.uuid,
                            level,
                            profBonus: actor.system.attributes.prof ?? 2,
                            ac: actor.system.attributes.ac.value ?? actor.system.attributes.ac.flat ?? 10,
                            hp: {
                                value: actor.system.attributes.hp.value,
                                max: actor.system.attributes.hp.max,
                                temp: actor.system.attributes.hp.temp ?? 0,
                            },
                            speed: actor.system.attributes.movement.walk ?? 0,
                            exhaustion: actor.system.attributes.exhaustion ?? 0,
                            inspiration: actor.system.attributes.inspiration ?? false,
                        };
                    }

                    if (details.includes("abilities")) {
                        results.abilities = {};
                        for (const key of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
                            const ab = actor.system.abilities[key];
                            // dnd5e v3: ab.save is a number; v4+: ab.save is { value, ... }
                            const saveVal = typeof ab.save === 'object' ? (ab.save as any)?.value ?? 0 : (ab.save ?? 0);
                            results.abilities[key] = {
                                value: ab.value,
                                mod: ab.mod,
                                save: saveVal,
                                proficient: ab.proficient,
                            };
                        }
                    }

                    if (details.includes("skills")) {
                        results.skills = {};
                        for (const [key, skill] of Object.entries(actor.system.skills as Record<string, any>)) {
                            results.skills[key] = {
                                ability: skill.ability,
                                total: skill.total,
                                mod: skill.mod,
                                value: skill.value,
                                passive: skill.passive,
                            };
                        }
                    }

                    if (details.includes("details")) {
                        const d = actor.system.details;
                        const raceItem = actor.items.find((i: any) => i.type === 'race');
                        const bgItem = actor.items.find((i: any) => i.type === 'background');
                        const classNames = actor.items
                            .filter((i: any) => i.type === 'class')
                            .map((i: any) => i.name)
                            .join('/');
                        results.details = {
                            race: raceItem?.name ?? '?',
                            background: bgItem?.name ?? '?',
                            class: classNames || '?',
                            alignment: d.alignment ?? '',
                            biography: d.biography?.value ?? '',
                            age: d.age ?? '',
                            height: d.height ?? '',
                            weight: d.weight ?? '',
                            eyes: d.eyes ?? '',
                            skin: d.skin ?? '',
                            hair: d.hair ?? '',
                            faith: d.faith ?? '',
                            gender: d.gender ?? '',
                        };
                    }

                    if (details.includes("conditions")) {
                        const statusIds: string[] = actor.statuses ? [...actor.statuses] : [];
                        results.conditions = statusIds.map((id: string) => {
                            const statusConfig = (CONFIG as any).statusEffects?.find((s: any) => s.id === id);
                            return { id, name: statusConfig?.name ?? id };
                        });
                        const concEffect = actor.effects.find((e: any) =>
                            e.statuses?.has?.('concentrating') || e.statuses?.has?.('concentration')
                        );
                        results.concentration = concEffect
                            ? { active: true, name: concEffect.name }
                            : { active: false };
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
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "modify-item-charges-result");
                    if (shouldReturn) return;

                    const { actorUuid, itemUuid, itemName, amount } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!itemUuid && !itemName) throw new Error("itemUuid or itemName is required");
                    if (typeof amount !== 'number') throw new Error("amount must be a number");

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    if (user) {
                        assertWritePermission(actor, user, "modify item charges on");
                    }

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
        const useAbilityHandler = async (data: any, context: any, abilityType: string | null, actionType: string) => {
            const socketManager = context?.socketManager;
            ModuleLogger.info(`Received ${actionType} request:`, data);

            try {
                const { user, shouldReturn } = resolveRequestUser(data, socketManager, `${actionType}-result`);
                if (shouldReturn) return;

                const { actorUuid, abilityUuid, abilityName, targetUuid } = data;
                if (!actorUuid) throw new Error("actorUuid is required");
                if (!abilityUuid && !abilityName) throw new Error("abilityUuid or abilityName is required");

                const actor: any = await fromUuid(actorUuid);
                if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                if (user) {
                    assertWritePermission(actor, user, `use abilities on`);
                }

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
                            return i.type !== 'feat' && i.type !== 'spell'
                                && i.type !== 'class' && i.type !== 'subclass' && i.type !== 'background';
                        }

                        if (abilityType === 'feat') {
                            // Match all feature-like types (feat, class, subclass, background)
                            return ['feat', 'class', 'subclass', 'background'].includes(i.type);
                        }

                        return i.type === abilityType; // For /use-spell
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

                // Skip configuration dialogs (spell slot selection, etc.)
                // v12 dnd5e: use(config, { configureDialog: false })
                // v13 dnd5e: use(usage, { configure: false }, message)
                const useResult = await ability.use({}, { configure: false, configureDialog: false });

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
            handler: (data, context) => useAbilityHandler(data, context, null, 'use-ability')
        });

        router.addRoute({
            actionType: "use-feature",
            handler: (data, context) => useAbilityHandler(data, context, 'feat', 'use-feature')
        });

        router.addRoute({
            actionType: "use-spell",
            handler: (data, context) => useAbilityHandler(data, context, 'spell', 'use-spell')
        });

        router.addRoute({
            actionType: "use-item",
            handler: (data, context) => useAbilityHandler(data, context, 'item', 'use-item')
        });

        // Modify actor experience
        router.addRoute({
            actionType: "modify-experience",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received modify-experience request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "modify-experience-result");
                    if (shouldReturn) return;

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

                    if (user) {
                        assertWritePermission(actor, user, "modify experience on");
                    }

                    const xp = actor.system.details?.xp;
                    if (!xp) throw new Error(`Actor '${actor.name}' does not have experience points (may be an NPC or using milestone leveling)`);

                    const currentXp = xp.value;
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

        // Short rest
        router.addRoute({
            actionType: "short-rest",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received short-rest request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "short-rest-result");
                    if (shouldReturn) return;

                    const { actorUuid, selected, autoHD, autoHDThreshold } = data;
                    if (!actorUuid && !selected) throw new Error("Either actorUuid or selected must be provided");

                    let actor: any = null;
                    if (actorUuid) {
                        actor = await fromUuid(actorUuid);
                    } else if (selected) {
                        const selectedTokens = canvas.tokens?.controlled;
                        if (!selectedTokens || selectedTokens.length === 0) throw new Error("No token selected");
                        actor = selectedTokens[0].actor;
                    }

                    if (!actor) throw new Error("Actor not found");

                    if (user) {
                        assertWritePermission(actor, user, "perform a short rest on");
                    }

                    const restOptions: any = { dialog: false, chat: true };
                    if (autoHD !== undefined) restOptions.autoHD = autoHD;
                    if (autoHDThreshold !== undefined) restOptions.autoHDThreshold = autoHDThreshold;

                    const result = await actor.shortRest(restOptions);

                    socketManager?.send({
                        type: "short-rest-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            result: result || { completed: true },
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in short-rest:`, error);
                    socketManager?.send({
                        type: "short-rest-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Long rest
        router.addRoute({
            actionType: "long-rest",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received long-rest request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "long-rest-result");
                    if (shouldReturn) return;

                    const { actorUuid, selected, newDay } = data;
                    if (!actorUuid && !selected) throw new Error("Either actorUuid or selected must be provided");

                    let actor: any = null;
                    if (actorUuid) {
                        actor = await fromUuid(actorUuid);
                    } else if (selected) {
                        const selectedTokens = canvas.tokens?.controlled;
                        if (!selectedTokens || selectedTokens.length === 0) throw new Error("No token selected");
                        actor = selectedTokens[0].actor;
                    }

                    if (!actor) throw new Error("Actor not found");

                    if (user) {
                        assertWritePermission(actor, user, "perform a long rest on");
                    }

                    const restOptions: any = { dialog: false, chat: true };
                    if (newDay !== undefined) restOptions.newDay = newDay;
                    else restOptions.newDay = true;

                    const result = await actor.longRest(restOptions);

                    socketManager?.send({
                        type: "long-rest-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            result: result || { completed: true },
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in long-rest:`, error);
                    socketManager?.send({
                        type: "long-rest-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Skill check
        router.addRoute({
            actionType: "skill-check",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received skill-check request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "skill-check-result");
                    if (shouldReturn) return;

                    const { actorUuid, skill, advantage, disadvantage, bonus, createChatMessage } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!skill) throw new Error("skill is required");

                    const validSkills = ['acr', 'ani', 'arc', 'ath', 'dec', 'his', 'ins', 'itm', 'inv', 'med', 'nat', 'prc', 'prf', 'per', 'rel', 'slt', 'ste', 'sur'];
                    if (!validSkills.includes(skill)) {
                        throw new Error(`Invalid skill '${skill}'. Valid skills: ${validSkills.join(', ')}`);
                    }

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    if (user) {
                        const serialized = serializeWithPermission(actor, user);
                        if (!serialized) {
                            throw new Error(`User '${user.name}' does not have permission to view actor '${actor.name}'`);
                        }
                    }

                    let roll: any;
                    const isV13 = getFoundryVersionMajor() >= 13;

                    if (isV13) {
                        // dnd5e v4 (Foundry v13): rollSkill(config, dialog, message)
                        const config: any = { skill };
                        if (bonus) config.rolls = [{ parts: [bonus] }];

                        const dialogConfig: any = { configure: false };
                        if (advantage) {
                            dialogConfig.options = { advantageMode: 1 };
                        } else if (disadvantage) {
                            dialogConfig.options = { advantageMode: -1 };
                        } else {
                            dialogConfig.options = { advantageMode: 0 };
                        }

                        const messageConfig: any = {};
                        if (createChatMessage !== undefined) messageConfig.create = createChatMessage;

                        const rolls = await actor.rollSkill(config, dialogConfig, messageConfig);
                        roll = rolls?.[0];
                    } else {
                        // dnd5e v3 (Foundry v12): rollSkill(skillId, options)
                        const rollOptions: any = { fastForward: true };
                        if (advantage) rollOptions.advantage = true;
                        if (disadvantage) rollOptions.disadvantage = true;
                        if (bonus) rollOptions.parts = [bonus];
                        if (createChatMessage !== undefined) rollOptions.chatMessage = createChatMessage;

                        roll = await actor.rollSkill(skill, rollOptions);
                    }

                    socketManager?.send({
                        type: "skill-check-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            skill,
                            total: roll?.total,
                            formula: roll?.formula,
                            result: roll?.result,
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in skill-check:`, error);
                    socketManager?.send({
                        type: "skill-check-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Ability saving throw
        router.addRoute({
            actionType: "ability-save",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received ability-save request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "ability-save-result");
                    if (shouldReturn) return;

                    const { actorUuid, ability, advantage, disadvantage, bonus, createChatMessage } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!ability) throw new Error("ability is required");

                    const validAbilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                    if (!validAbilities.includes(ability)) {
                        throw new Error(`Invalid ability '${ability}'. Valid abilities: ${validAbilities.join(', ')}`);
                    }

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    if (user) {
                        const serialized = serializeWithPermission(actor, user);
                        if (!serialized) {
                            throw new Error(`User '${user.name}' does not have permission to view actor '${actor.name}'`);
                        }
                    }

                    let roll: any;
                    const isV13 = getFoundryVersionMajor() >= 13;

                    if (isV13) {
                        // dnd5e v4 (Foundry v13): rollSavingThrow(config, dialog, message)
                        const config: any = { ability };
                        if (bonus) config.rolls = [{ parts: [bonus] }];

                        const dialogConfig: any = { configure: false };
                        if (advantage) {
                            dialogConfig.options = { advantageMode: 1 };
                        } else if (disadvantage) {
                            dialogConfig.options = { advantageMode: -1 };
                        } else {
                            dialogConfig.options = { advantageMode: 0 };
                        }

                        const messageConfig: any = {};
                        if (createChatMessage !== undefined) messageConfig.create = createChatMessage;

                        const rolls = await actor.rollSavingThrow(config, dialogConfig, messageConfig);
                        roll = rolls?.[0];
                    } else {
                        // dnd5e v3 (Foundry v12): rollAbilitySave(abilityId, options)
                        const rollOptions: any = { fastForward: true };
                        if (advantage) rollOptions.advantage = true;
                        if (disadvantage) rollOptions.disadvantage = true;
                        if (bonus) rollOptions.parts = [bonus];
                        if (createChatMessage !== undefined) rollOptions.chatMessage = createChatMessage;

                        roll = await actor.rollAbilitySave(ability, rollOptions);
                    }

                    socketManager?.send({
                        type: "ability-save-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            ability,
                            total: roll?.total,
                            formula: roll?.formula,
                            result: roll?.result,
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in ability-save:`, error);
                    socketManager?.send({
                        type: "ability-save-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Ability check (raw ability test)
        router.addRoute({
            actionType: "ability-check",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received ability-check request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "ability-check-result");
                    if (shouldReturn) return;

                    const { actorUuid, ability, advantage, disadvantage, bonus, createChatMessage } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");
                    if (!ability) throw new Error("ability is required");

                    const validAbilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                    if (!validAbilities.includes(ability)) {
                        throw new Error(`Invalid ability '${ability}'. Valid abilities: ${validAbilities.join(', ')}`);
                    }

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    if (user) {
                        const serialized = serializeWithPermission(actor, user);
                        if (!serialized) {
                            throw new Error(`User '${user.name}' does not have permission to view actor '${actor.name}'`);
                        }
                    }

                    let roll: any;
                    const isV13 = getFoundryVersionMajor() >= 13;

                    if (isV13) {
                        // dnd5e v4 (Foundry v13): rollAbilityCheck(config, dialog, message)
                        const config: any = { ability };
                        if (bonus) config.rolls = [{ parts: [bonus] }];

                        const dialogConfig: any = { configure: false };
                        if (advantage) {
                            dialogConfig.options = { advantageMode: 1 };
                        } else if (disadvantage) {
                            dialogConfig.options = { advantageMode: -1 };
                        } else {
                            dialogConfig.options = { advantageMode: 0 };
                        }

                        const messageConfig: any = {};
                        if (createChatMessage !== undefined) messageConfig.create = createChatMessage;

                        const rolls = await actor.rollAbilityCheck(config, dialogConfig, messageConfig);
                        roll = rolls?.[0];
                    } else {
                        // dnd5e v3 (Foundry v12): rollAbilityTest(abilityId, options)
                        const rollOptions: any = { fastForward: true };
                        if (advantage) rollOptions.advantage = true;
                        if (disadvantage) rollOptions.disadvantage = true;
                        if (bonus) rollOptions.parts = [bonus];
                        if (createChatMessage !== undefined) rollOptions.chatMessage = createChatMessage;

                        roll = await actor.rollAbilityTest(ability, rollOptions);
                    }

                    socketManager?.send({
                        type: "ability-check-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            ability,
                            total: roll?.total,
                            formula: roll?.formula,
                            result: roll?.result,
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in ability-check:`, error);
                    socketManager?.send({
                        type: "ability-check-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // Death saving throw
        router.addRoute({
            actionType: "death-save",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received death-save request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "death-save-result");
                    if (shouldReturn) return;

                    const { actorUuid, advantage, createChatMessage } = data;
                    if (!actorUuid) throw new Error("actorUuid is required");

                    const actor: any = await fromUuid(actorUuid);
                    if (!actor) throw new Error(`Actor not found with UUID: ${actorUuid}`);

                    if (user) {
                        assertWritePermission(actor, user, "roll death saves for");
                    }

                    let roll: any;
                    const isV13 = getFoundryVersionMajor() >= 13;

                    if (isV13) {
                        // dnd5e v4 (Foundry v13): rollDeathSave(config, dialog, message)
                        const config: any = {};

                        const dialogConfig: any = { configure: false };
                        if (advantage) {
                            dialogConfig.options = { advantageMode: 1 };
                        } else {
                            dialogConfig.options = { advantageMode: 0 };
                        }

                        const messageConfig: any = {};
                        if (createChatMessage !== undefined) messageConfig.create = createChatMessage;

                        const rolls = await actor.rollDeathSave(config, dialogConfig, messageConfig);
                        roll = rolls?.[0];
                    } else {
                        // dnd5e v3 (Foundry v12): rollDeathSave(options)
                        const rollOptions: any = { fastForward: true };
                        if (advantage) rollOptions.advantage = true;
                        if (createChatMessage !== undefined) rollOptions.chatMessage = createChatMessage;

                        roll = await actor.rollDeathSave(rollOptions);
                    }

                    const deathSaves = actor.system?.attributes?.death || {};

                    socketManager?.send({
                        type: "death-save-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            total: roll?.total,
                            formula: roll?.formula,
                            result: roll?.result,
                            deathSaves: {
                                success: deathSaves.success || 0,
                                failure: deathSaves.failure || 0,
                            },
                        },
                    });

                } catch (error) {
                    ModuleLogger.error(`Error in death-save:`, error);
                    socketManager?.send({
                        type: "death-save-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // --- Shared helper: resolve actor by UUID or name ---
        const resolveActor = async (data: any): Promise<any> => {
            const { actorUuid, actorName } = data;
            if (!actorUuid && !actorName) throw new Error("actorUuid or actorName is required");

            let actor: any = null;
            if (actorUuid) {
                actor = await fromUuid(actorUuid);
            } else if (actorName) {
                actor = game.actors?.find((a: any) => a.name.toLowerCase() === actorName.toLowerCase());
            }
            if (!actor) throw new Error(`Actor not found: ${actorUuid || actorName}`);
            if (actor.actor) actor = actor.actor;
            return actor;
        };

        // --- Shared helper: resolve item on actor by UUID or name ---
        const resolveItem = (actor: any, data: any): any => {
            const { itemUuid, itemName } = data;
            if (!itemUuid && !itemName) throw new Error("itemUuid or itemName is required");

            let item: any = null;
            if (itemUuid) {
                item = actor.items.get(itemUuid.split('.').pop());
                if (!item) item = actor.items.find((i: any) => i.uuid === itemUuid);
            } else if (itemName) {
                item = actor.items.find((i: any) => i.name.toLowerCase() === itemName.toLowerCase());
            }
            if (!item) throw new Error(`Item not found on actor ${actor.name}: ${itemUuid || itemName}`);
            return item;
        };

        // --- Concentration Tracking ---

        router.addRoute({
            actionType: "get-concentration",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received get-concentration request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "get-concentration-result");
                    if (shouldReturn) return;

                    const actor = await resolveActor(data);

                    if (user) {
                        const serialized = serializeWithPermission(actor, user);
                        if (!serialized) throw new Error(`User '${user.name}' does not have permission to view actor '${actor.name}'`);
                    }

                    const concentrationEffect = actor.effects?.find((e: any) =>
                        e.statuses?.has("concentrating") || e.statuses?.has("concentration")
                    );

                    let spellName: string | null = null;
                    if (concentrationEffect?.origin) {
                        try {
                            const originItem: any = await fromUuid(concentrationEffect.origin);
                            spellName = originItem?.name || null;
                        } catch { /* origin may not resolve */ }
                    }

                    socketManager?.send({
                        type: "get-concentration-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            isConcentrating: !!concentrationEffect,
                            effect: concentrationEffect ? {
                                id: concentrationEffect.id,
                                uuid: concentrationEffect.uuid,
                                name: concentrationEffect.name || concentrationEffect.label,
                                icon: concentrationEffect.icon || concentrationEffect.img,
                                statuses: Array.from(concentrationEffect.statuses || []),
                                origin: concentrationEffect.origin,
                            } : null,
                            spell: spellName,
                        },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in get-concentration:`, error);
                    socketManager?.send({
                        type: "get-concentration-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        router.addRoute({
            actionType: "break-concentration",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received break-concentration request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "break-concentration-result");
                    if (shouldReturn) return;

                    const actor = await resolveActor(data);
                    if (user) assertWritePermission(actor, user, "break concentration on");

                    const concentrationEffect = actor.effects?.find((e: any) =>
                        e.statuses?.has("concentrating") || e.statuses?.has("concentration")
                    );

                    if (!concentrationEffect) {
                        throw new Error(`Actor '${actor.name}' is not concentrating`);
                    }

                    await actor.deleteEmbeddedDocuments("ActiveEffect", [concentrationEffect.id]);

                    socketManager?.send({
                        type: "break-concentration-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            broken: true,
                            removedEffectId: concentrationEffect.id,
                        },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in break-concentration:`, error);
                    socketManager?.send({
                        type: "break-concentration-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        router.addRoute({
            actionType: "concentration-save",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received concentration-save request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "concentration-save-result");
                    if (shouldReturn) return;

                    const actor = await resolveActor(data);
                    if (user) assertWritePermission(actor, user, "roll concentration saves for");

                    const concentrationEffect = actor.effects?.find((e: any) =>
                        e.statuses?.has("concentrating") || e.statuses?.has("concentration")
                    );

                    if (!concentrationEffect) {
                        throw new Error(`Actor '${actor.name}' is not concentrating`);
                    }

                    const { damage, advantage, disadvantage, bonus, createChatMessage } = data;
                    if (typeof damage !== 'number') throw new Error("damage must be a number");

                    const dc = Math.max(10, Math.floor(damage / 2));

                    let roll: any;
                    const isV13 = getFoundryVersionMajor() >= 13;

                    if (isV13) {
                        const config: any = { ability: "con" };
                        if (bonus) config.rolls = [{ parts: [bonus] }];

                        const dialogConfig: any = { configure: false };
                        if (advantage) dialogConfig.options = { advantageMode: 1 };
                        else if (disadvantage) dialogConfig.options = { advantageMode: -1 };
                        else dialogConfig.options = { advantageMode: 0 };

                        const messageConfig: any = {};
                        if (createChatMessage !== undefined) messageConfig.create = createChatMessage;

                        const rolls = await actor.rollSavingThrow(config, dialogConfig, messageConfig);
                        roll = rolls?.[0];
                    } else {
                        const rollOptions: any = { fastForward: true };
                        if (advantage) rollOptions.advantage = true;
                        if (disadvantage) rollOptions.disadvantage = true;
                        if (bonus) rollOptions.parts = [bonus];
                        if (createChatMessage !== undefined) rollOptions.chatMessage = createChatMessage;

                        roll = await actor.rollAbilitySave("con", rollOptions);
                    }

                    const maintained = (roll?.total ?? 0) >= dc;

                    if (!maintained) {
                        await actor.deleteEmbeddedDocuments("ActiveEffect", [concentrationEffect.id]);
                    }

                    socketManager?.send({
                        type: "concentration-save-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            dc,
                            total: roll?.total,
                            formula: roll?.formula,
                            result: roll?.result,
                            maintained,
                        },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in concentration-save:`, error);
                    socketManager?.send({
                        type: "concentration-save-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        // --- Inventory Management ---

        router.addRoute({
            actionType: "equip-item",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received equip-item request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "equip-item-result");
                    if (shouldReturn) return;

                    const actor = await resolveActor(data);
                    if (user) assertWritePermission(actor, user, "modify items on");

                    const item = resolveItem(actor, data);
                    const equipped = data.equipped;
                    if (typeof equipped !== 'boolean') throw new Error("equipped must be a boolean");

                    await item.update({ "system.equipped": equipped });

                    socketManager?.send({
                        type: "equip-item-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            itemUuid: item.uuid,
                            itemName: item.name,
                            equipped,
                        },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in equip-item:`, error);
                    socketManager?.send({
                        type: "equip-item-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        router.addRoute({
            actionType: "attune-item",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received attune-item request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "attune-item-result");
                    if (shouldReturn) return;

                    const actor = await resolveActor(data);
                    if (user) assertWritePermission(actor, user, "modify items on");

                    const item = resolveItem(actor, data);
                    const attuned = data.attuned;
                    if (typeof attuned !== 'boolean') throw new Error("attuned must be a boolean");

                    const isV13 = getFoundryVersionMajor() >= 13;

                    if (isV13) {
                        await item.update({ "system.attuned": attuned });
                    } else {
                        const currentReq = item.system.attunement || 0;
                        if (attuned) {
                            await item.update({ "system.attunement": 2 });
                        } else {
                            await item.update({ "system.attunement": currentReq === 2 ? 1 : currentReq });
                        }
                    }

                    socketManager?.send({
                        type: "attune-item-result",
                        requestId: data.requestId,
                        data: {
                            actorUuid: actor.uuid,
                            itemUuid: item.uuid,
                            itemName: item.name,
                            attuned,
                        },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in attune-item:`, error);
                    socketManager?.send({
                        type: "attune-item-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        router.addRoute({
            actionType: "transfer-currency",
            handler: async (data, context) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received transfer-currency request:`, data);

                try {
                    const { user, shouldReturn } = resolveRequestUser(data, socketManager, "transfer-currency-result");
                    if (shouldReturn) return;

                    const { sourceActorUuid, sourceActorName, targetActorUuid, targetActorName, currency } = data;
                    if (!sourceActorUuid && !sourceActorName) throw new Error("sourceActorUuid or sourceActorName is required");
                    if (!targetActorUuid && !targetActorName) throw new Error("targetActorUuid or targetActorName is required");
                    if (!currency || typeof currency !== 'object') throw new Error("currency object is required");

                    const sourceActor = await resolveActor({ actorUuid: sourceActorUuid, actorName: sourceActorName });
                    const targetActor = await resolveActor({ actorUuid: targetActorUuid, actorName: targetActorName });

                    if (user) {
                        assertWritePermission(sourceActor, user, "transfer currency from");
                        assertWritePermission(targetActor, user, "transfer currency to");
                    }

                    const denominations = ['pp', 'gp', 'ep', 'sp', 'cp'];
                    const sourceCurrency = sourceActor.system.currency || {};
                    const targetCurrency = targetActor.system.currency || {};

                    for (const denom of denominations) {
                        const amount = currency[denom];
                        if (amount && typeof amount === 'number' && amount > 0) {
                            if ((sourceCurrency[denom] || 0) < amount) {
                                throw new Error(`Insufficient ${denom}: ${sourceActor.name} has ${sourceCurrency[denom] || 0}, needs ${amount}`);
                            }
                        }
                    }

                    const sourceUpdate: any = {};
                    const targetUpdate: any = {};
                    for (const denom of denominations) {
                        const amount = currency[denom];
                        if (amount && typeof amount === 'number' && amount > 0) {
                            sourceUpdate[`system.currency.${denom}`] = (sourceCurrency[denom] || 0) - amount;
                            targetUpdate[`system.currency.${denom}`] = (targetCurrency[denom] || 0) + amount;
                        }
                    }

                    await sourceActor.update(sourceUpdate);
                    await targetActor.update(targetUpdate);

                    socketManager?.send({
                        type: "transfer-currency-result",
                        requestId: data.requestId,
                        data: {
                            sourceActorUuid: sourceActor.uuid,
                            targetActorUuid: targetActor.uuid,
                            transferred: currency,
                            sourceBalance: sourceActor.system.currency,
                            targetBalance: targetActor.system.currency,
                        },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in transfer-currency:`, error);
                    socketManager?.send({
                        type: "transfer-currency-result",
                        requestId: data.requestId,
                        error: (error as Error).message,
                    });
                }
            }
        });

        router.addRoute({
            actionType: "modify-currency",
            handler: async (data: any, context: any) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received modify-currency request:`, data);
                try {
                    const { shouldReturn } = resolveRequestUser(data, socketManager, "modify-currency-result");
                    if (shouldReturn) return;

                    const actorUuid = data.uuid || data.actorUuid;
                    const currency: string = data.currency;
                    const amount: number = data.amount;

                    if (!actorUuid || !currency || amount === undefined) {
                        socketManager?.send({ type: "modify-currency-result", requestId: data.requestId, error: "Missing required params: uuid, currency, amount" });
                        return;
                    }

                    const actor = await fromUuid(actorUuid);
                    if (!actor || !("system" in actor)) {
                        socketManager?.send({ type: "modify-currency-result", requestId: data.requestId, error: `Actor not found: ${actorUuid}` });
                        return;
                    }

                    const currentAmount: number = (actor as any).system?.currency?.[currency] || 0;
                    const newAmount = Math.max(0, currentAmount + amount);
                    await (actor as any).update({ [`system.currency.${currency}`]: newAmount });

                    socketManager?.send({
                        type: "modify-currency-result",
                        requestId: data.requestId,
                        data: { currency, previous: currentAmount, current: newAmount, delta: amount },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in modify-currency:`, error);
                    socketManager?.send({ type: "modify-currency-result", requestId: data.requestId, error: (error as Error).message });
                }
            }
        });

        router.addRoute({
            actionType: "prepare-spell",
            handler: async (data: any, context: any) => {
                const socketManager = context?.socketManager;
                ModuleLogger.info(`Received prepare-spell request:`, data);
                try {
                    const { shouldReturn } = resolveRequestUser(data, socketManager, "prepare-spell-result");
                    if (shouldReturn) return;

                    const actorUuid = data.uuid || data.actorUuid;
                    const spellName: string = data.spellName || data.name;
                    const prepared: boolean = data.prepared;

                    if (!actorUuid || !spellName || prepared === undefined) {
                        socketManager?.send({ type: "prepare-spell-result", requestId: data.requestId, error: "Missing required params: uuid, spellName, prepared" });
                        return;
                    }

                    const actor = await fromUuid(actorUuid);
                    if (!actor || !("items" in actor)) {
                        socketManager?.send({ type: "prepare-spell-result", requestId: data.requestId, error: `Actor not found: ${actorUuid}` });
                        return;
                    }

                    const spell = (actor as any).items.find((i: any) =>
                        i.type === "spell" && i.name.toLowerCase() === spellName.toLowerCase()
                    );
                    if (!spell) {
                        socketManager?.send({ type: "prepare-spell-result", requestId: data.requestId, error: `Spell not found: ${spellName}` });
                        return;
                    }

                    await spell.update({ "system.preparation.prepared": prepared });

                    socketManager?.send({
                        type: "prepare-spell-result",
                        requestId: data.requestId,
                        data: { spellName: spell.name, prepared, uuid: spell.uuid },
                    });
                } catch (error) {
                    ModuleLogger.error(`Error in prepare-spell:`, error);
                    socketManager?.send({ type: "prepare-spell-result", requestId: data.requestId, error: (error as Error).message });
                }
            }
        });

    }
});
