import { moduleId, recentRolls } from "../constants";
import { FoundryRestApi } from "../types";
import { ModuleLogger } from "../utils/logger";
import { WebSocketManager } from "./webSocketManager";
import { parseFilterString, matchesAllFilters } from "../utils/search";

export function initializeWebSocket() {
    // Get settings
    const wsRelayUrl = game.settings.get(moduleId, "wsRelayUrl") as string;
    const apiKey = game.settings.get(moduleId, "apiKey") as string;
    const module = game.modules.get(moduleId) as FoundryRestApi;
    
    if (!wsRelayUrl) {
      ModuleLogger.error(`WebSocket relay URL is empty. Please configure it in module settings.`);
      return;
    }
    
    ModuleLogger.info(`Initializing WebSocket with URL: ${wsRelayUrl}`);
    
    try {
        // Create and connect the WebSocket manager
        module.socketManager = new WebSocketManager(wsRelayUrl, apiKey);
        module.socketManager.connect();
        
        // Register message handlers
        module.socketManager.onMessageType("ping", () => {
            ModuleLogger.info(`Received ping, sending pong`);
            module.socketManager.send({ type: "pong" });
        });
    
        module.socketManager.onMessageType("pong", () => {
            ModuleLogger.info(`Received pong`);
        });
        
        // Handle search requests
        module.socketManager.onMessageType("perform-search", async (data) => {
            ModuleLogger.info(`Received search request:`, data);
            
            try {
            if (!window.QuickInsert) {
                ModuleLogger.error(`QuickInsert not available`);
                module.socketManager.send({
                type: "search-results",
                requestId: data.requestId,
                query: data.query,
                error: "QuickInsert not available",
                results: []
                });
                return;
            }
            
            if (!window.QuickInsert.hasIndex) {
                ModuleLogger.info(`QuickInsert index not ready, forcing index creation`);
                try {
                window.QuickInsert.forceIndex();
                await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                ModuleLogger.error(`Failed to force QuickInsert index:`, error);
                module.socketManager.send({
                    type: "search-results",
                    requestId: data.requestId,
                    query: data.query,
                    error: "QuickInsert index not ready",
                    results: []
                });
                return;
                }
            }
    
            let filterFunc = null;
            if (data.filter) {
                const filters = typeof data.filter === 'string' ? 
                parseFilterString(data.filter) : data.filter;
    
                filterFunc = (result: any) => {
                return matchesAllFilters(result, filters);
                };
            }
            
            const filteredResults = await window.QuickInsert.search(data.query, filterFunc, 200);
            ModuleLogger.info(`Search returned ${filteredResults.length} results`);
            
            module.socketManager.send({
                type: "search-results",
                requestId: data.requestId,
                query: data.query,
                filter: data.filter,
                results: filteredResults.map(result => {
                const item = result.item;
                
                return {
                    documentType: item.documentType,
                    folder: item.folder,
                    id: item.id,
                    name: item.name,
                    package: item.package,
                    packageName: item.packageName,
                    subType: item.subType,
                    uuid: item.uuid,
                    icon: item.icon,
                    journalLink: item.journalLink,
                    tagline: item.tagline || "",
                    formattedMatch: result.formattedMatch || "",
                    resultType: item.constructor?.name
                };
                })
            });
            } catch (error) {
            ModuleLogger.error(`Error performing search:`, error);
            module.socketManager.send({
                type: "search-results",
                requestId: data.requestId,
                query: data.query,
                error: (error as Error).message,
                results: []
            });
            }
        });
        
        // Handle entity requests
        module.socketManager.onMessageType("get-entity", async (data) => {
            ModuleLogger.info(`Received entity request:`, data);
            
            try {
                let entity;
                let entityData = [];
                let entityUUID = data.uuid;
                if (data.selected) {
                    const controlledTokens = canvas?.tokens?.controlled;
                    if (controlledTokens) {
                        for (let token of controlledTokens) {
                            if (data.actor) {
                                entity = token.actor;
                            } else {
                                entity = token.document;
                            }
                            if (entity) {
                                entityUUID = entity.uuid;
                                entityData.push(entity.toObject());
                            }
                        }
                    }
                } else {
                    entity = await fromUuid(data.uuid);
                    entityData = entity?.toObject ? entity.toObject() : entity;
                }
                
                if (!entityData) {
                    ModuleLogger.error(`Entity not found: ${data.uuid}`);
                    module.socketManager.send({
                    type: "entity-data",
                    requestId: data.requestId,
                    uuid: data.uuid,
                    error: "Entity not found",
                    data: null
                    });
                    return;
                }
                
                ModuleLogger.info(`Sending entity data for: ${data.uuid}`, entityData);
                
                module.socketManager.send({
                    type: "entity-data",
                    requestId: data.requestId,
                    uuid: entityUUID,
                    data: entityData
                });
            } catch (error) {
                ModuleLogger.error(`Error getting entity:`, error);
                module.socketManager.send({
                    type: "entity-data",
                    requestId: data.requestId,
                    uuid: data.uuid,
                    error: (error as Error).message,
                    data: null
            });
            }
        });
    
        // Handle structure request
        module.socketManager.onMessageType("get-structure", async (data) => {
            ModuleLogger.info(`Received structure request`);
            
            try {
            // Get all folders
            const folders = Object.entries(game.folders?.contents || []).map(([_, folder]) => {
                return {
                id: folder.id,
                name: folder.name,
                type: folder.type,
                parent: folder.parent?.id,
                path: folder.uuid,
                sorting: (folder as any).sort,
                sortingMode: (folder as any).sortingMode
                };
            });
            
            // Get all compendiums
            const compendiums = game.packs.contents.map(pack => {
                return {
                id: pack.collection,
                name: pack.metadata.label,
                path: `Compendium.${pack.collection}`,
                entity: pack.documentName,
                package: pack.metadata.package,
                packageType: pack.metadata.type,
                system: pack.metadata.system
                };
            });
            
            module.socketManager.send({
                type: "structure-data",
                requestId: data.requestId,
                folders,
                compendiums
            });
            } catch (error) {
            ModuleLogger.error(`Error getting structure:`, error);
            module.socketManager.send({
                type: "structure-data",
                requestId: data.requestId,
                error: (error as Error).message,
                folders: [],
                compendiums: []
            });
            }
        });
        
        // Handle contents request
        module.socketManager.onMessageType("get-contents", async (data) => {
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
                    uuid: `${pack.collection}.${entry._id}`,
                    id: entry._id,
                    name: entry.name,
                    img: 'img' in entry ? entry.img : null,
                    type: 'type' in entry ? entry.type : null
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
            
            module.socketManager.send({
                type: "contents-data",
                requestId: data.requestId,
                path: data.path,
                entities: contents
            });
            } catch (error) {
            ModuleLogger.error(`Error getting contents:`, error);
            module.socketManager.send({
                type: "contents-data",
                requestId: data.requestId,
                path: data.path,
                error: (error as Error).message,
                entities: []
            });
            }
        });
        
        // Handle entity creation
        module.socketManager.onMessageType("create-entity", async (data) => {
            ModuleLogger.info(`Received create entity request for type: ${data.entityType}`);
            
            try {
            // Get the document class for the entity type
            const DocumentClass = getDocumentClass(data.entityType);
            if (!DocumentClass) {
                throw new Error(`Invalid entity type: ${data.entityType}`);
            }
            
            // Prepare creation data
            const createData = {
                ...data.data,
                folder: data.folder || null
            };
            
            // Create the entity
            const entity = await DocumentClass.create(createData);
            
            if (!entity) {
                throw new Error("Failed to create entity");
            }
            
            module.socketManager.send({
                type: "entity-created",
                requestId: data.requestId,
                uuid: entity.uuid,
                entity: entity.toObject()
            });
            } catch (error) {
            ModuleLogger.error(`Error creating entity:`, error);
            module.socketManager.send({
                type: "entity-created",
                requestId: data.requestId,
                error: (error as Error).message,
                message: "Failed to create entity"
            });
            }
        });
        
        // Handle entity update
        module.socketManager.onMessageType("update-entity", async (data) => {
            ModuleLogger.info(`Received update entity request for UUID: ${data.uuid}`);
            
            try {
            // Get the entities
            let entities = [];
            if (data.uuid) {
                entities.push(await fromUuid(data.uuid));
            } else if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled;
                if (controlledTokens) {
                    for (let token of controlledTokens) {
                        if (data.actor) {
                            entities.push(token.actor);
                        } else {
                            entities.push(token.document);
                        }
                    }
                }
            }
            
            if (entities.length === 0) {
                throw new Error(`Entity not found: ${data.uuid}`);
            }
            
            // Update the entities
            for (let entity of entities) {
                await entity?.update(data.updateData);
            }
            
            // Get the updated entities
            let updatedEntities = [];
            for (let entity of entities) {
                updatedEntities.push(await fromUuid((entity as any).uuid));
            }
            
            module.socketManager.send({
                type: "entity-updated",
                requestId: data.requestId,
                uuid: data.uuid,
                entity: updatedEntities.map(e => e?.toObject())
            });
            } catch (error) {
            ModuleLogger.error(`Error updating entity:`, error);
            module.socketManager.send({
                type: "entity-updated",
                requestId: data.requestId,
                uuid: data.uuid,
                error: (error as Error).message,
                message: "Failed to update entity"
            });
            }
        });
        
        // Handle entity deletion
        module.socketManager.onMessageType("delete-entity", async (data) => {
            ModuleLogger.info(`Received delete entity request for UUID: ${data.uuid}`);
            
            try {
            // Get the entities
            let entities = [];
            if (data.uuid) {
                entities.push(await fromUuid(data.uuid));
            } else if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled;
                if (controlledTokens) {
                    for (let token of controlledTokens) {
                        if (data.actor) {
                            entities.push(token.actor);
                        } else {
                            entities.push(token.document);
                        }
                    }
                }
            }
            
            if (!entities || entities.length === 0) {
                throw new Error(`Entity not found: ${data.uuid}`);
            }
            
            // Delete the entities
            for (let entity of entities) {
                await entity?.delete();
            }
            
            module.socketManager.send({
                type: "entity-deleted",
                requestId: data.requestId,
                uuid: data.uuid,
                success: true
            });
            } catch (error) {
            ModuleLogger.error(`Error deleting entity:`, error);
            module.socketManager.send({
                type: "entity-deleted",
                requestId: data.requestId,
                uuid: data.uuid,
                error: (error as Error).message,
                message: "Failed to delete entity"
            });
            }
        });
    
        // Handle roll data request (get list of rolls)
        module.socketManager.onMessageType("get-rolls", async (data) => {
            ModuleLogger.info(`Received request for roll data`);
            
            module.socketManager.send({
            type: "rolls-data",
            requestId: data.requestId,
            data: recentRolls.slice(0, data.limit || 20)
            });
        });
    
        // Handle last roll request
        module.socketManager.onMessageType("get-last-roll", (data) => {
            ModuleLogger.info(`Received request for last roll data`);
            
            module.socketManager.send({
            type: "last-roll-data",
            requestId: data.requestId,
            data: recentRolls.length > 0 ? recentRolls[0] : null
            });
        });
    
        // Handle roll request
        module.socketManager.onMessageType("perform-roll", async (data) => {
            try {
            const { formula, itemUuid, flavor, createChatMessage, speaker, target, whisper, requestId } = data;
            
            let rollResult;
            let speakerData = {};
            let rollMode = whisper && whisper.length > 0 ? CONST.DICE_ROLL_MODES.PRIVATE : CONST.DICE_ROLL_MODES.PUBLIC;
            
            // Process speaker if provided
            if (speaker) {
                try {
                // Check if it's a token UUID or actor UUID
                const speakerEntity = await fromUuid(speaker);
                
                if (speakerEntity) {
                    if (speakerEntity instanceof TokenDocument) {
                    // It's a token
                    speakerData = {
                        token: speakerEntity?.id,
                        actor: speakerEntity?.actor?.id,
                        scene: speakerEntity?.parent?.id,
                        alias: speakerEntity?.name || speakerEntity?.actor?.name
                    };
                    } else if (speakerEntity instanceof Actor) {
                    // It's an actor - try to find a token that represents it on the active scene
                    const activeScene = game.scenes?.active;
                    if (activeScene) {
                        const tokens = activeScene.tokens?.filter(t => t.actor?.id === speakerEntity.id);
                        if (tokens && tokens.length > 0) {
                        // Use the first token found
                        const token = tokens[0];
                        speakerData = {
                            token: token.id,
                            actor: speakerEntity.id,
                            scene: activeScene.id,
                            alias: token.name || speakerEntity.name
                        };
                        } else {
                        // No token found, just use actor
                        speakerData = {
                            actor: speakerEntity.id,
                            alias: speakerEntity.name
                        };
                        }
                    }
                    }
                }
                } catch (err) {
                ModuleLogger.warn(`Failed to process speaker: ${err}`);
                }
            }
            
            // Process the roll
            if (itemUuid) {
                try {
                // Get the item document
                const document = await fromUuid(itemUuid);
                if (!document) {
                    throw new Error(`Item with UUID ${itemUuid} not found`);
                }
                
                // Cast to an Item with any to access system-specific properties
                const item = document as any;
                
                ModuleLogger.info(`Creating chat message for item: ${(item as any).name}`);
                
                let messageId;
                let targetAcquired = false;
                let targetToken = null;
                
                // Process target if provided
                if (target) {
                    try {
                    const targetDocument = await fromUuid(target);
                    
                    if (targetDocument) {
                        if (targetDocument instanceof TokenDocument) {
                        // It's a token
                        targetToken = targetDocument;
                        targetAcquired = true;
                        ModuleLogger.info(`Target token acquired: ${targetDocument.name}`);
                        } else if (targetDocument instanceof Actor) {
                        // It's an actor - try to find a token that represents it on the active scene
                        const activeScene = game.scenes?.active;
                        if (activeScene) {
                            const tokens = activeScene.tokens?.filter(t => t.actor?.id === targetDocument.id);
                            if (tokens && tokens.length > 0) {
                            // Use the first token found
                            targetToken = tokens[0];
                            targetAcquired = true;
                            ModuleLogger.info(`Target token acquired from actor: ${tokens[0].name}`);
                            }
                        }
                        }
                        
                        // If we found a token, set it as the target
                        if (targetAcquired && targetToken) {
                        // For D&D 5e and similar systems, we need to target the token on the canvas
                        // This will ensure that systems like Midi-QOL can properly apply effects
                        if (canvas && canvas.ready) {
                            // Clear current targets first
                            if (canvas.tokens) {
                            game.user?.targets.forEach(t => t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: false }));
                            game.user?.targets.clear();
                            
                            // Get the actual token object from the canvas
                            if (targetToken.id) {  // Check that the ID is not null or undefined
                                const targetObject = canvas.tokens.get(targetToken.id);
                                if (targetObject) {
                                // Set as target
                                targetObject.setTarget(true, { user: game.user, releaseOthers: true, groupSelection: false });
                                ModuleLogger.info(`Token targeted on canvas: ${targetObject.name}`);
                                }
                            }
                            }
                        }
                        }
                    }
                    } catch (err) {
                    ModuleLogger.warn(`Failed to process target: ${err}`);
                    }
                }
                
                // Different systems have different methods for displaying items in chat
                if ((item as any).system?.actionType) {
                    // This is a D&D 5e item with an action type - use specific handling for Midi-QOL
                    ModuleLogger.info(`Using D&D 5e item with action type: ${(item as any).system.actionType}`);
                    
                    // For D&D 5e with Midi-QOL, we need to use the item's use method
                    if (((item as Record<string, any>).system as Record<string, any>)?.actionType) {
                    // Create options for item use
                    const useOptions: any = {
                        configureDialog: false,
                        createMessage: true,
                        skipDialog: true,
                        fastForward: true,
                        consume: false, // Don't consume limited uses by default
                        speaker: speakerData,
                        target: targetToken
                    };
                    
                    // If target was acquired, add it
                    if (targetAcquired && targetToken) {
                        useOptions.target = targetToken;
                    }
                    
                    // Set up automatic dialog handling before using the item
                    const originalRenderDialog = Dialog.prototype.render;
                    
                    // Override Dialog.prototype.render to add auto-clicking behavior
                    Dialog.prototype.render = function(...args) {
                        const result = originalRenderDialog.apply(this, args);
                        
                        // After the dialog renders, click the default or first button
                        setTimeout(() => {
                        if (this.element && this.element.length) {
                            const defaultButton = this.element.find('.dialog-button.default');
                            if (defaultButton.length) {
                            ModuleLogger.info(`Auto-clicking default button in rendered dialog`);
                            defaultButton.trigger('click');
                            } else {
                            const firstButton = this.element.find('.dialog-button').first();
                            if (firstButton.length) {
                                ModuleLogger.info(`Auto-clicking first button in rendered dialog`);
                                firstButton.trigger('click');
                            }
                            }
                        }
                        }, 100);
                        
                        return result;
                    };
                    
                    try {
                        // Use the item which should trigger Midi-QOL if installed
                        ModuleLogger.info(`Using item with dialog auto-click enabled: ${(item as any).name}`);
                        const useResult = await (((item as Record<string, any>).use) as Function)(useOptions);
                        messageId = useResult?.id || useResult; // Handle different return types
                        
                        ModuleLogger.info(`Item used with use() method, should trigger Midi-QOL: ${(item as any).name}`);
                    } finally {
                        Dialog.prototype.render = originalRenderDialog;
                        
                        ModuleLogger.info(`Restored original dialog methods after item use`);
                    }
                    } else if ((item as any).displayCard && typeof (item as any).displayCard === 'function') {
                    // Fallback to displayCard if use() not available
                    const cardResult = await (item as any).displayCard({
                        createMessage: true,
                        speaker: speakerData,
                        ...(targetAcquired ? { target: targetToken } : {})
                    });
                    messageId = cardResult?.id;
                    }
                } else if (typeof (item as any).toChat === 'function') {
                    // Some systems use toChat()
                    const chatOptions = targetAcquired ? { target: targetToken } : {};
                    const chatResult = await (item as any).toChat(chatOptions);
                    messageId = chatResult?.id;
                } else if (typeof (item as any).displayCard === 'function') {
                    // DnD5e uses displayCard()
                    // Use type assertion to ensure TypeScript knows displayCard is a function
                    const displayCard = (item as any).displayCard as (options: any) => Promise<any>;
                    const cardResult = await displayCard({
                    createMessage: true,
                    speaker: speakerData,
                    // If target acquired, add it to the options
                    ...(targetAcquired ? { target: targetToken } : {})
                    });
                    messageId = cardResult?.id;
                } else {
                    // Fallback: Create a simple chat message with item details
                    const chatData = {
                    user: game.user?.id,
                    speaker: speakerData,
                    content: `
                        <div class="item-card">
                        <div class="item-name">${(item as any).name}</div>
                        <div class="item-image"><img src="${(item as any).img}" width="50" height="50"/></div>
                        <div class="item-description">${(item as any).system?.description?.value || ""}</div>
                        ${targetAcquired ? `<div class="item-target">Target: ${targetToken?.name}</div>` : ""}
                        </div>
                    `,
                    type: CONST.CHAT_MESSAGE_TYPES.OTHER,
                    flavor: `Item: ${(item as any).name}${targetAcquired ? ` (Target: ${targetToken?.name})` : ""}`
                    };
                    
                    const message = await ChatMessage.create(chatData);
                    messageId = message?.id;
                }
                
                // Format the result
                rollResult = {
                    id: `item_display_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
                    chatMessageCreated: true,
                    itemDisplayed: {
                    uuid: (item as any).uuid,
                    name: (item as any).name,
                    type: (item as any).type,
                    img: (item as any).img
                    },
                    target: targetAcquired ? {
                    uuid: targetToken?.uuid,
                    name: targetToken?.name
                    } : null,
                    messageId: messageId
                };
                
                ModuleLogger.info(`Item chat message created with ID: ${messageId}`);
                } catch (err) {
                ModuleLogger.error(`Error displaying item in chat: ${err}`);
                module.socketManager.send({
                    type: "roll-result",
                    requestId: requestId,
                    success: false,
                    error: `Failed to display item in chat: ${(err as Error).message}`
                });
                return;
                }
            } else {
                // Roll from formula
                try {
                // Create the Roll instance
                const roll = new Roll(formula);
                
                // Evaluate the roll
                await roll.evaluate();
                
                // Create chat message if requested
                if (createChatMessage) {
                    await roll.toMessage({
                    speaker: speakerData,
                    flavor: flavor || "",
                    rollMode,
                    whisper: whisper || []
                    });
                }
                
                // Format the roll result
                rollResult = {
                    id: `manual_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
                    chatMessageCreated: !!createChatMessage,
                    roll: {
                    formula: formula,
                    total: roll.total,
                    isCritical: roll.terms.some(term => (term as DiceTerm).results?.some(result => result.result === (roll.terms[0] as DiceTerm).faces)),
                    isFumble: roll.terms.some(term => (term as DiceTerm).results?.some(result => result.result === 1)),
                    dice: roll.dice.map(d => ({
                    faces: d.faces,
                    results: d.results.map(r => ({
                    result: r.result,
                    active: r.active
                    }))
                    })),
                    timestamp: Date.now()
                    }
                };
                } catch (err) {
                ModuleLogger.error(`Error rolling formula: ${err}`);
                module.socketManager.send({
                    type: "roll-result",
                    requestId: requestId,
                    success: false,
                    error: `Failed to roll formula: ${(err as Error).message}`
                });
                return;
                }
            }
            
            // Send the result back
            module.socketManager.send({
                type: "roll-result",
                requestId: requestId,
                success: true,
                data: rollResult
            });
            } catch (error) {
            ModuleLogger.error(`Error in roll handler: ${error}`);
            module.socketManager.send({
                type: "roll-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message || "Unknown error occurred during roll"
            });
            }
        });
    
        // Handle actor (or entity) sheet HTML request
        module.socketManager.onMessageType("get-sheet-html", async (data) => {
            ModuleLogger.info(`Received sheet HTML request for UUID: ${data.uuid}`);
            
            try {
            let actor: Actor | TokenDocument | null = null;
            if (data.uuid) {
                // Get the actor from its UUID
                actor = await fromUuid(data.uuid) as Actor;
            } else if (data.selected) {
                // Get the controlled tokens
                const controlledTokens = canvas?.tokens?.controlled;
                if (controlledTokens && controlledTokens.length > 0) {
                    if (data.actor) {
                        actor = controlledTokens[0].actor;
                    } else {
                        actor = controlledTokens[0].document;
                    }
                }
            }
            if (!actor) {
                ModuleLogger.error(`Entity not found for UUID: ${data.uuid}`);
                module.socketManager.send({
                type: "actor-sheet-html-response",
                requestId: data.requestId,
                data: { error: "Entity not found", uuid: data.uuid }
                });
                return;
            }
            
            // Create a temporary sheet to render
            const sheet = actor.sheet?.render(true) as ActorSheet;
            
            // Wait for the sheet to render
            setTimeout(async () => {
                try {
                // Get the HTML content
                if (!sheet.element || !sheet.element[0]) {
                    throw new Error("Failed to render actor sheet");
                }
                
                let html = sheet.element[0].outerHTML;
                
                // Get the associated CSS - much more comprehensive approach
                let css = '';
                
                // Get the sheet's appId for later comparisons
                const sheetAppId = String(sheet.appId);
                
                // 1. Get CSS from style elements with data-appid matching the sheet
                const appStyles = document.querySelectorAll('style[data-appid]');
                appStyles.forEach(style => {
                    const styleAppId = (style as HTMLElement).dataset.appid;
                    if (styleAppId === sheetAppId) {
                    css += style.textContent + '\n';
                    }
                });
                
                // 2. Get global system styles that might apply to this sheet
                const systemStyles = document.querySelectorAll(`style[id^="system-${(actor as any).type}"]`);
                systemStyles.forEach(style => {
                    css += style.textContent + '\n';
                });
                
                // 3. Extract all classes and IDs from the HTML to capture all relevant styles
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = html;
                
                // Create sets to avoid duplicates
                const classNames = new Set<string>();
                const ids = new Set<string>();
                
                // Function to extract classes and IDs from an element and its children
                function extractClassesAndIds(element: Element) {
                    // Get classes
                    if (element.classList && element.classList.length) {
                    element.classList.forEach(className => classNames.add(className));
                    }
                    
                    // Get ID
                    if (element.id) {
                    ids.add(element.id);
                    }
                    
                    // Process children recursively
                    for (let i = 0; i < element.children.length; i++) {
                    extractClassesAndIds(element.children[i]);
                    }
                }
                
                // Extract classes and IDs from all elements
                extractClassesAndIds(tempDiv);
                
                // Convert sets to arrays
                const uniqueClassNames = Array.from(classNames);
                const uniqueIds = Array.from(ids);
                
                ModuleLogger.debug(`Extracted ${uniqueClassNames.length} unique classes and ${uniqueIds.length} unique IDs`);
                
                // 4. Collect all stylesheets in the document
                const allStyles = document.querySelectorAll('style');
                const allLinks = document.querySelectorAll('link[rel="stylesheet"]');
                
                // Process inline styles
                allStyles.forEach(style => {
                    // Skip if we already added this style sheet (avoid duplicates)
                    if (style.dataset.appid && style.dataset.appid === sheetAppId) {
                    return; // Already added above
                    }
                    
                    const styleContent = style.textContent || '';
                    
                    // Check if this style contains any of our classes or IDs
                    const isRelevant = uniqueClassNames.some(className => 
                    styleContent.includes(`.${className}`)) || 
                    uniqueIds.some(id => styleContent.includes(`#${id}`)) ||
                    // Common selectors that might apply
                    styleContent.includes('.window-app') || 
                    styleContent.includes('.sheet') || 
                    styleContent.includes('.actor-sheet') ||
                    styleContent.includes(`.${(actor as any).type}-sheet`);
                    
                    if (isRelevant) {
                    ModuleLogger.debug(`Adding relevant inline style`);
                    css += styleContent + '\n';
                    }
                });
                
                // 5. Process external stylesheets
                const stylesheetPromises = Array.from(allLinks).map(async (link) => {
                    try {
                    const href = link.getAttribute('href');
                    if (!href) return '';
                    
                    // Skip foundry-specific stylesheets that we'll handle separately
                    if (href.includes('fonts.googleapis.com')) return '';
                    
                    ModuleLogger.debug(`Fetching external CSS from: ${href}`);
                    const fullUrl = href.startsWith('http') ? href : 
                                    href.startsWith('/') ? `${window.location.origin}${href}` : 
                                    `${window.location.origin}/${href}`;
                    
                    const response = await fetch(fullUrl);
                    if (!response.ok) {
                        ModuleLogger.warn(`Failed to fetch CSS: ${fullUrl}, status: ${response.status}`);
                        return '';
                    }
                    
                    const styleContent = await response.text();
                    return styleContent;
                    } catch (e) {
                    ModuleLogger.warn(`Failed to fetch external CSS: ${e}`);
                    return '';
                    }
                });
                
                // 6. Important: Add foundry core styles
                const baseUrl = window.location.origin;
                ModuleLogger.debug(`Base URL for fetching CSS: ${baseUrl}`);
                
                // Try different path patterns that might work with Foundry
                const coreStylesheets = [
                    // Try various likely paths for foundry core styles
                    `${baseUrl}/css/style.css`,
                    `${baseUrl}/styles/style.css`,
                    `${baseUrl}/styles/foundry.css`,
                    `${baseUrl}/ui/sheets.css`,
                    // Try with /game path prefix (common in some Foundry setups)
                    `${baseUrl}/game/styles/foundry.css`,
                    `${baseUrl}/game/ui/sheets.css`,
                    // System-specific styles
                    `${baseUrl}/systems/${game.system.id}/system.css`,
                    `${baseUrl}/systems/${game.system.id}/styles/system.css`,
                    // Try with /game path prefix for system styles
                    `${baseUrl}/game/systems/${game.system.id}/system.css`,
                    `${baseUrl}/game/systems/${game.system.id}/styles/system.css`
                ];
                
                // Add more debugging to identify the correct paths
                ModuleLogger.debug(`All stylesheet links in document:`, 
                    Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                    .map(link => link.getAttribute('href'))
                    .filter(Boolean)
                );
                
                // Extract potential stylesheet paths from existing links
                const existingCSSPaths = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                    .map(link => link.getAttribute('href'))
                    .filter((href): href is string => 
                    href !== null && 
                    !href.includes('fonts.googleapis.com') && 
                    !href.includes('//'));
                
                // Add these paths to our core stylesheets
                coreStylesheets.push(...existingCSSPaths);
                
                // Debug current document styles to see what's actually loaded
                ModuleLogger.debug(`All style elements in document:`, 
                    document.querySelectorAll('style').length
                );
                
                const corePromises = coreStylesheets.map(async (path) => {
                    try {
                    ModuleLogger.debug(`Fetching core CSS from: ${path}`);
                    const response = await fetch(path);
                    if (!response.ok) {
                        ModuleLogger.warn(`Failed to fetch CSS: ${path}, status: ${response.status}`);
                        return '';
                    }
                    
                    // If successful, log it clearly
                    ModuleLogger.info(`Successfully loaded CSS from: ${path}`);
                    return await response.text();
                    } catch (e) {
                    ModuleLogger.warn(`Failed to fetch core CSS: ${e}`);
                    return '';
                    }
                });
                
                // Wait for all external CSS to be fetched
                const allPromises = [...stylesheetPromises, ...corePromises];
                const externalStyles = await Promise.all(allPromises);
                externalStyles.forEach(style => {
                    css += style + '\n';
                });
                
                // 7. Add fallback styles if needed
                if (css.length < 100) {
                    ModuleLogger.warn(`CSS fetch failed or returned minimal content. Adding fallback styles.`);
                    css += `
        /* Fallback styles for actor sheet */
        .window-app {
            font-family: "Signika", sans-serif;
            background: #f0f0e0;
            border-radius: 5px;
            box-shadow: 0 0 20px #000;
            color: #191813;
        }
        .window-content {
            background: rgba(255, 255, 240, 0.9);
            padding: 8px;
            overflow-y: auto;
            background: url(${window.location.origin}/ui/parchment.jpg) repeat;
        }
        input, select, textarea {
            border: 1px solid #7a7971;
            background: rgba(255, 255, 255, 0.8);
        }
        button {
            background: rgba(0, 0, 0, 0.1);
            border: 1px solid #7a7971;
            border-radius: 3px;
            cursor: pointer;
        }
        .profile-img {
            border: none;
            max-width: 100%;
            max-height: 220px;
        }
        `;
                }
                
                // Log the CSS collection results
                ModuleLogger.debug(`Collected CSS: ${css.length} bytes`);
                
                // Before sending the HTML, fix asset URLs
                html = html.replace(/src="([^"]+)"/g, (match, src) => {
                    if (src.startsWith('http')) return match;
                    if (src.startsWith('/')) return `src="${window.location.origin}${src}"`;
                    return `src="${window.location.origin}/${src}"`;
                });
    
                // Also fix background images in styles
                css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                    if (url.startsWith('http') || url.startsWith('data:')) return match;
                    if (url.startsWith('/')) return `url('${window.location.origin}${url}')`;
                    return `url('${window.location.origin}/${url}')`;
                });
    
                // Close the temporary sheet
                sheet.close();
                
                // Send the HTML and CSS back
                module.socketManager.send({
                    type: "actor-sheet-html-response",
                    requestId: data.requestId,
                    data: { html, css, uuid: data.uuid }
                });
    
                // Add confirmation log
                ModuleLogger.debug(`Sent actor sheet HTML response with requestId: ${data.requestId}`);
                ModuleLogger.debug(`HTML length: ${html.length}, CSS length: ${css.length}`);
                } catch (renderError) {
                ModuleLogger.error(`Error capturing actor sheet HTML:`, renderError);
                module.socketManager.send({
                    type: "actor-sheet-html-response",
                    requestId: data.requestId,
                    data: { error: "Failed to capture actor sheet HTML", uuid: data.uuid }
                });
                
                // Make sure to close the sheet if it was created
                if (sheet && typeof sheet.close === 'function') {
                    sheet.close();
                }
                }
            }, 500); // Small delay to ensure rendering is complete
            
            } catch (error) {
            ModuleLogger.error(`Error rendering actor sheet:`, error);
            module.socketManager.send({
                type: "actor-sheet-html-response",
                requestId: data.requestId,
                data: { error: "Failed to render actor sheet", uuid: data.uuid }
            });
            }
        });
    
        // Handle get macros request
        module.socketManager.onMessageType("get-macros", async (data) => {
            ModuleLogger.info(`Received request for macros`);
            
            try {
            // Get all macros the current user has access to
            const macros = game.macros?.contents.map(macro => {
                return {
                uuid: macro.uuid,
                id: macro.id,
                name: macro.name,
                type: (macro as any).type || (macro as any).data?.type || "unknown",
                author: (macro as any).author?.name || "unknown",
                command: (macro as any).command || "",
                img: (macro as any).img,
                scope: (macro as any).scope,
                canExecute: (macro as any).canExecute
                };
            }) || [];
    
            module.socketManager.send({
                type: "macros-list",
                requestId: data.requestId,
                macros
            });
            } catch (error) {
            ModuleLogger.error(`Error getting macros list:`, error);
            module.socketManager.send({
                type: "macros-list",
                requestId: data.requestId,
                error: (error as Error).message,
                macros: []
            });
            }
        });
    
        // Handle execute macro request
        module.socketManager.onMessageType("execute-macro", async (data) => {
            ModuleLogger.info(`Received request to execute macro: ${data.uuid}`);
            
            try {
            if (!data.uuid) {
                throw new Error("Macro UUID is required");
            }
            
            // Get the macro by UUID
            const macro = await fromUuid(data.uuid) as Macro;
            if (!macro) {
                throw new Error(`Macro not found with UUID: ${data.uuid}`);
            }
            
            // Check if it's actually a macro
            if (!(macro instanceof CONFIG.Macro.documentClass)) {
                throw new Error(`Entity with UUID ${data.uuid} is not a macro`);
            }
            
            // Check if the macro can be executed
            if (!macro.canExecute) {
                throw new Error(`Macro '${macro.name}' cannot be executed by the current user`);
            }

            const args = data.args || {};
            
            // Execute the macro with args defined in the scope
            let result;
            if (typeof args === "object") {
                // Execute with args available as a variable
                result = await macro.execute({ args } as any);
            } else {
                // Fallback for non-object args
                result = await macro.execute();
            }
            
            // Return success
            module.socketManager.send({
                type: "macro-execution-result",
                requestId: data.requestId,
                uuid: data.uuid,
                success: true,
                result: typeof result === 'object' ? result : { value: result }
            });
            } catch (error) {
            ModuleLogger.error(`Error executing macro:`, error);
            module.socketManager.send({
                type: "macro-execution-result",
                requestId: data.requestId,
                uuid: data.uuid || "",
                success: false,
                error: (error as Error).message
            });
            }
        });
    
        // Handle get encounters request
        module.socketManager.onMessageType("get-encounters", async (data) => {
            ModuleLogger.info(`Received request for encounters`);
            
            try {
            // Get all combats (encounters) in the world
            const encounters = game.combats?.contents.map(combat => {
                return {
                id: combat.id,
                name: combat.name,
                round: combat.round,
                turn: combat.turn,
                current: combat.id === game.combat?.id,
                combatants: combat.combatants.contents.map(c => ({
                    id: c.id,
                    name: c.name,
                    tokenUuid: c.token?.uuid,
                    actorUuid: c.actor?.uuid,
                    img: c.img,
                    initiative: c.initiative,
                    hidden: c.hidden,
                    defeated: c.isDefeated
                }))
                };
            }) || [];
    
            module.socketManager.send({
                type: "encounters-list",
                requestId: data.requestId,
                encounters
            });
            } catch (error) {
            ModuleLogger.error(`Error getting encounters list:`, error);
            module.socketManager.send({
                type: "encounters-list",
                requestId: data.requestId,
                error: (error as Error).message,
                encounters: []
            });
            }
        });
    
        // Handle start encounter request
        module.socketManager.onMessageType("start-encounter", async (data) => {
            ModuleLogger.info(`Received request to start encounter with options:`, data);
            
            try {
            // Create a new combat encounter
            const combat = await Combat.create({ name: data.name || "New Encounter" });
            
            if (combat) {
                await combat.startCombat();
                // Add the specified tokens if any were provided
                if (data.tokenUuids && data.tokenUuids.length > 0) {
                const tokensData = [];
                
                for (const uuid of data.tokenUuids) {
                    try {
                    const token = await fromUuid(uuid);
                    if (token) {
                        tokensData.push({
                        tokenId: token.id ?? '',
                        sceneId: token.parent.id
                        });
                    }
                    } catch (err) {
                    ModuleLogger.warn(`Failed to add token ${uuid} to combat:`, err);
                    }
                }
                
                if (tokensData.length > 0) {
                    await combat.createEmbeddedDocuments("Combatant", tokensData);
                }
                }
    
                let addedTokenIds = new Set();
    
                // Add player combatants if specified
                if (data.startWithPlayers) {
                // Get the current viewed scene
                const currentScene = game.scenes?.viewed;
                
                if (currentScene) {
                    // Get all tokens on the scene that have player actors
                    const playerTokens = currentScene.tokens?.filter(token => {
                    // Check if token has an actor and the actor is a player character
                    return !!token.actor && token.actor.hasPlayerOwner;
                    }) ?? [];
                    
                    // Create combatants from these tokens
                    const tokenData = playerTokens.map(token => {
                    addedTokenIds.add(token.id);
                    return {
                    tokenId: token.id,
                    sceneId: currentScene.id
                    };
                    });
                    
                    if (tokenData.length > 0) {
                    await combat.createEmbeddedDocuments("Combatant", tokenData);
                    }
                }
                }
    
                // Add selected tokens if specified, but only if they weren't already added
                if (data.startWithSelected) {
                const selectedTokens = canvas?.tokens?.controlled
                    .filter(token => !addedTokenIds.has(token.id))
                    .map(token => {
                    return {
                    tokenId: token.id,
                    sceneId: token.scene.id
                    };
                    }) ?? [];
                
                if (selectedTokens.length > 0) {
                    await combat.createEmbeddedDocuments("Combatant", selectedTokens);
                }
                } 
                
                // Roll initiative for all npc combatants
                if (data.rollNPC) {
                await combat.rollNPC();
                }
    
                // Roll initiative for all combatants
                if (data.rollAll) {
                await combat.rollAll();
                }
                
                // Activate this combat
                await combat.activate();
                
                module.socketManager.send({
                type: "encounter-started",
                requestId: data.requestId,
                encounterId: combat.id,
                encounter: {
                    id: combat.id,
                    name: combat.name,
                    round: combat.round,
                    turn: combat.turn,
                    combatants: combat.combatants.contents.map(c => ({
                    id: c.id,
                    name: c.name,
                    tokenUuid: c.token?.uuid,
                    actorUuid: c.actor?.uuid,
                    img: c.img,
                    initiative: c.initiative,
                    hidden: c.hidden,
                    defeated: c.isDefeated
                    }))
                }
                });
            } else {
                throw new Error("Failed to create encounter");
            }
            } catch (error) {
            ModuleLogger.error(`Error starting encounter:`, error);
            module.socketManager.send({
                type: "encounter-started",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
    
        // Handle next turn request
        module.socketManager.onMessageType("encounter-next-turn", async (data) => {
            ModuleLogger.info(`Received request for next turn in encounter: ${data.encounterId || 'active'}`);
            
            try {
            const combat = data.encounterId ? game.combats?.get(data.encounterId) : game.combat;
            
            if (!combat) {
                throw new Error(data.encounterId ? 
                `Encounter with ID ${data.encounterId} not found` : 
                "No active encounter");
            }
            
            await combat.nextTurn();
            
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                encounterId: combat.id,
                action: "nextTurn",
                currentTurn: combat.turn,
                currentRound: combat.round,
                actorTurn: combat.combatant?.actor?.uuid,
                tokenTurn: combat.combatant?.token?.uuid,
                encounter: {
                id: combat.id,
                name: combat.name,
                round: combat.round,
                turn: combat.turn
                }
            });
            } catch (error) {
            ModuleLogger.error(`Error advancing to next turn:`, error);
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
    
        // Handle next round request
        module.socketManager.onMessageType("encounter-next-round", async (data) => {
            ModuleLogger.info(`Received request for next round in encounter: ${data.encounterId || 'active'}`);
            
            try {
            const combat = data.encounterId ? game.combats?.get(data.encounterId) : game.combat;
            
            if (!combat) {
                throw new Error(data.encounterId ? 
                `Encounter with ID ${data.encounterId} not found` : 
                "No active encounter");
            }
            
            await combat.nextRound();
            
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                encounterId: combat.id,
                action: "nextRound",
                currentTurn: combat.turn,
                currentRound: combat.round,
                actorTurn: combat.combatant?.actor?.uuid,
                tokenTurn: combat.combatant?.token?.uuid,
                encounter: {
                id: combat.id,
                name: combat.name,
                round: combat.round,
                turn: combat.turn
                }
            });
            } catch (error) {
            ModuleLogger.error(`Error advancing to next round:`, error);
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
    
        // Handle previous turn request
        module.socketManager.onMessageType("encounter-previous-turn", async (data) => {
            ModuleLogger.info(`Received request for previous turn in encounter: ${data.encounterId || 'active'}`);
            
            try {
            const combat = data.encounterId ? game.combats?.get(data.encounterId) : game.combat;
            
            if (!combat) {
                throw new Error(data.encounterId ? 
                `Encounter with ID ${data.encounterId} not found` : 
                "No active encounter");
            }
            
            await combat.previousTurn();
            
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                encounterId: combat.id,
                action: "previousTurn",
                currentTurn: combat.turn,
                currentRound: combat.round,
                actorTurn: combat.combatant?.actor?.uuid,
                tokenTurn: combat.combatant?.token?.uuid,
                encounter: {
                id: combat.id,
                name: combat.name,
                round: combat.round,
                turn: combat.turn
                }
            });
            } catch (error) {
            ModuleLogger.error(`Error going back to previous turn:`, error);
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
    
        // Handle previous round request
        module.socketManager.onMessageType("encounter-previous-round", async (data) => {
            ModuleLogger.info(`Received request for previous round in encounter: ${data.encounterId || 'active'}`);
            
            try {
            const combat = data.encounterId ? game.combats?.get(data.encounterId) : game.combat;
            
            if (!combat) {
                throw new Error(data.encounterId ? 
                `Encounter with ID ${data.encounterId} not found` : 
                "No active encounter");
            }
            
            await combat.previousRound();
            
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                encounterId: combat.id,
                action: "previousRound",
                currentTurn: combat.turn,
                currentRound: combat.round,
                actorTurn: combat.combatant?.actor?.uuid,
                tokenTurn: combat.combatant?.token?.uuid,
                encounter: {
                id: combat.id,
                name: combat.name,
                round: combat.round,
                turn: combat.turn
                }
            });
            } catch (error) {
            ModuleLogger.error(`Error going back to previous round:`, error);
            module.socketManager.send({
                type: "encounter-navigation",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
    
        // Handle end encounter request
        module.socketManager.onMessageType("end-encounter", async (data) => {
            ModuleLogger.info(`Received request to end encounter: ${data.encounterId}`);
            
            try {
            let encounterId = data.encounterId;
            if (!encounterId) {
                encounterId = game.combat?.id;
            }
            
            const combat = game.combats?.get(encounterId);
            
            if (!combat) {
                throw new Error(`No encounter not found`);
            }
            
            await combat.delete();
            
            module.socketManager.send({
                type: "encounter-ended",
                requestId: data.requestId,
                encounterId: encounterId,
                message: "Encounter successfully ended"
            });
            } catch (error) {
            ModuleLogger.error(`Error ending encounter:`, error);
            module.socketManager.send({
                type: "encounter-ended",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });

        // Add these handlers after the other encounter-related handlers

        // Handle add-to-encounter request
        module.socketManager.onMessageType("add-to-encounter", async (data) => {
            ModuleLogger.info(`Received add-to-encounter request for encounter: ${data.encounterId}`);
            
            try {
            // Get the combat
            const combat = data.encounterId ? 
                game.combats?.get(data.encounterId) : 
                game.combat;
            
            if (!combat) {
                throw new Error(data.encounterId ? 
                `Encounter with ID ${data.encounterId} not found` : 
                "No active encounter");
            }
            
            const addedEntities: string[] = [];
            const failedEntities = [];
            
            // Process UUIDs to add
            if (data.uuids && Array.isArray(data.uuids)) {
                for (const uuid of data.uuids) {
                try {
                    // Get the entity from UUID
                    const entity = await fromUuid(uuid);
                    
                    if (!entity) {
                    failedEntities.push({ uuid, reason: "Entity not found" });
                    continue;
                    }
                    
                    // Handle depending on entity type - token or actor
                    if (entity.documentName === "Token") {
                    const token = entity;
                    const combatantData = {
                        tokenId: token.id,
                        sceneId: token.parent?.id
                    };
                    
                    await combat.createEmbeddedDocuments("Combatant", [combatantData]);
                    addedEntities.push(uuid);
                    } else if (entity.documentName === "Actor") {
                    // For actors, we need a token representation
                    // Here we check if actor has a token on the current scene
                    const scene = game.scenes?.viewed;
                    if (scene) {
                        const tokenForActor = scene.tokens?.find(t => t.actor?.id === entity.id);
                        if (tokenForActor) {
                        const combatantData = {
                            tokenId: tokenForActor.id,
                            sceneId: scene.id
                        };
                        
                        await combat.createEmbeddedDocuments("Combatant", [combatantData]);
                        addedEntities.push(uuid);
                        } else {
                        failedEntities.push({ uuid, reason: "No token found for this actor in the current scene" });
                        }
                    } else {
                        failedEntities.push({ uuid, reason: "No active scene" });
                    }
                    } else {
                    failedEntities.push({ uuid, reason: "Entity must be a Token or Actor" });
                    }
                } catch (err) {
                    failedEntities.push({ uuid, reason: (err as Error).message });
                }
                }
            }
            
            // If selected is true, add selected tokens
            if (data.selected === true) {
                const selectedTokens = canvas?.tokens?.controlled || [];
                
                for (const token of selectedTokens) {
                try {
                    if (!combat.combatants.find(c => c.token?.id === token.id && c.combat?.scene?.id === token.scene.id)) {
                        const combatantData = {
                        tokenId: token.id,
                        sceneId: token.scene.id
                        };
                        
                        await combat.createEmbeddedDocuments("Combatant", [combatantData]);
                        addedEntities.push(token.document.uuid);
                    }
                } catch (err) {
                    failedEntities.push({ uuid: token.document.uuid, reason: (err as Error).message });
                }
                }
            }
            
            // Roll initiative for new combatants if requested
            if (data.rollInitiative === true && addedEntities.length > 0) {
                combat.rollAll();
            }
            
            module.socketManager.send({
                type: "add-to-encounter-result",
                requestId: data.requestId,
                encounterId: combat.id,
                added: addedEntities,
                failed: failedEntities
            });
            } catch (error) {
            ModuleLogger.error(`Error adding to encounter:`, error);
            module.socketManager.send({
                type: "add-to-encounter-result",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
        
        // Handle remove-from-encounter request
        module.socketManager.onMessageType("remove-from-encounter", async (data) => {
            ModuleLogger.info(`Received remove-from-encounter request for encounter: ${data.encounterId}`);
            
            try {
            // Get the combat
            const combat = data.encounterId ? 
                game.combats?.get(data.encounterId) : 
                game.combat;
            
            if (!combat) {
                throw new Error(data.encounterId ? 
                `Encounter with ID ${data.encounterId} not found` : 
                "No active encounter");
            }
            
            const removedEntities = [];
            const failedEntities = [];
            const combatantIdsToRemove = [];
            
            // Process UUIDs to remove
            if (data.uuids && Array.isArray(data.uuids)) {
                for (const uuid of data.uuids) {
                try {
                    // Find combatant(s) related to this UUID
                    const entity = await fromUuid(uuid);
                    
                    if (!entity) {
                    failedEntities.push({ uuid, reason: "Entity not found" });
                    continue;
                    }
                    
                    let foundCombatant = false;
                    
                    if (entity.documentName === "Token") {
                    // Find combatant by token ID
                    const combatant = combat.combatants.find(c => 
                        c.token?.id === entity.id && c.combat?.scene?.id === entity.parent?.id
                    );
                    
                    if (combatant) {
                        combatantIdsToRemove.push(combatant.id);
                        foundCombatant = true;
                    }
                    } else if (entity.documentName === "Actor") {
                    // Find all combatants with this actor
                    const combatants = combat.combatants.filter(c => c.actor?.id === entity.id);
                    
                    if (combatants.length > 0) {
                        combatantIdsToRemove.push(...combatants.map(c => c.id));
                        foundCombatant = true;
                    }
                    }
                    
                    if (foundCombatant) {
                    removedEntities.push(uuid);
                    } else {
                    failedEntities.push({ uuid, reason: "No combatant found for this entity" });
                    }
                } catch (err) {
                    failedEntities.push({ uuid, reason: (err as Error).message });
                }
                }
            }
            
            // If selected is true, remove selected tokens
            if (data.selected === true) {
                const selectedTokens = canvas?.tokens?.controlled || [];
                
                for (const token of selectedTokens) {
                const combatant = combat.combatants.find(c => 
                    (c as any).tokenId === token.id && (c as any).sceneId === token.scene.id
                );
                
                if (combatant) {
                    combatantIdsToRemove.push(combatant.id);
                    removedEntities.push(token.document.uuid);
                }
                }
            }
            
            // Remove the combatants, filtering out any null IDs
            if (combatantIdsToRemove.length > 0) {
                const validIds = combatantIdsToRemove.filter((id): id is string => id !== null);
                if (validIds.length > 0) {
                    await combat.deleteEmbeddedDocuments("Combatant", validIds);
                }
            }
            
            module.socketManager.send({
                type: "remove-from-encounter-result",
                requestId: data.requestId,
                encounterId: combat.id,
                removed: removedEntities,
                failed: failedEntities
            });
            } catch (error) {
            ModuleLogger.error(`Error removing from encounter:`, error);
            module.socketManager.send({
                type: "remove-from-encounter-result",
                requestId: data.requestId,
                error: (error as Error).message
            });
            }
        });
        
        // Handle kill request (mark token/actor as defeated)
        module.socketManager.onMessageType("kill-entity", async (data) => {
            ModuleLogger.info(`Received kill request for UUID: ${data.uuid}`);
            
            try {
            const entities = [];

            if (data.uuid) {
                const entity = await fromUuid(data.uuid);
                if (entity) {
                entities.push(entity);
                } else {
                throw new Error(`Entity not found: ${data.uuid}`);
                }
            } else if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled || [];
                for (const token of controlledTokens) {
                if (token.document) {
                    entities.push(token.document);
                }
                }
            }

            if (entities.length === 0) {
                throw new Error("No entities found to mark as defeated");
            }

            const results = [];

            for (const entity of entities) {
                let success = false;
                let message = "";

                // Handle different entity types
                if (entity.documentName === "Token") {
                const token = entity;
                const actor = (token as any).actor;

                if (!actor) {
                    throw new Error("Token has no associated actor");
                }

                // 1. Mark as defeated in combat if in encounter
                const combat = game.combat;
                if (combat) {
                    const combatant = combat.combatants.find(c => 
                    c.token?.id === token.id && c.token?.parent?.id === token.parent?.id
                    );
                    
                    if (combatant) {
                    await combatant.update({ defeated: true });
                    ModuleLogger.info(`Marked token as defeated in combat`);
                    }
                }

                // 2. Reduce HP to 0 - try different possible HP paths for different systems
                try {
                    if (hasProperty(actor, "system.attributes.hp")) {
                    await actor.update({ "system.attributes.hp.value": 0 });
                    } 
                    else if (hasProperty(actor, "system.health")) {
                    await actor.update({ "system.health.value": 0 });
                    }
                    else if (hasProperty(actor, "system.hp")) {
                    await actor.update({ "system.hp.value": 0 });
                    }
                    else if (hasProperty(actor, "data.attributes.hp")) {
                    await actor.update({ "data.attributes.hp.value": 0 });
                    }
                    ModuleLogger.info(`Set actor HP to 0`);
                } catch (err) {
                    ModuleLogger.warn(`Could not set HP to 0: ${err}`);
                }

                // 3. Add dead status effect to token
                try {
                    const deadEffect = CONFIG.statusEffects?.find(e => 
                    e.id === "dead" || e.id === "unconscious" || e.id === "defeated"
                    );
                    
                    if (deadEffect) {
                    await (token as any).toggleActiveEffect(deadEffect);
                    ModuleLogger.info(`Added ${deadEffect.id} status effect to token`);
                    } else {
                    ModuleLogger.warn(`No dead status effect found`);
                    }
                } catch (err) {
                    ModuleLogger.warn(`Could not apply status effect: ${err}`);
                }

                success = true;
                message = "Token marked as defeated, HP set to 0, and dead effect applied";
                } else if (entity.documentName === "Actor") {
                const actor = entity;
                let tokensUpdated = 0;

                // 1. Find all tokens for this actor across visible scenes and update them
                const scenes = game.scenes;
                if (scenes?.viewed) {
                    const tokens = scenes.viewed.tokens.filter(t => t.actor?.id === actor.id);
                    
                    for (const token of tokens) {
                    try {
                        const deadEffect = CONFIG.statusEffects?.find(e => 
                        e.id === "dead" || e.id === "unconscious" || e.id === "defeated"
                        );
                        
                        if (deadEffect) {
                        await (token as any).toggleActiveEffect(deadEffect);
                        tokensUpdated++;
                        }
                    } catch (err) {
                        ModuleLogger.warn(`Could not apply status effect to token: ${err}`);
                    }
                    }
                }

                // 2. Mark all instances in combat as defeated
                const combat = game.combat;
                if (combat) {
                    const combatants = combat.combatants.filter(c => c.actor?.id === actor.id);
                    
                    if (combatants.length > 0) {
                    await Promise.all(combatants.map(c => c.update({ defeated: true })));
                    ModuleLogger.info(`Marked ${combatants.length} combatants as defeated`);
                    }
                }

                // 3. Reduce HP to 0 - try different possible HP paths for different systems
                try {
                    if (hasProperty(actor, "system.attributes.hp")) {
                    await actor.update({ "system.attributes.hp.value": 0 });
                    } 
                    else if (hasProperty(actor, "system.health")) {
                    await actor.update({ "system.health.value": 0 });
                    }
                    else if (hasProperty(actor, "system.hp")) {
                    await actor.update({ "system.hp.value": 0 });
                    }
                    else if (hasProperty(actor, "data.attributes.hp")) {
                    await actor.update({ "data.attributes.hp.value": 0 });
                    }
                    ModuleLogger.info(`Set actor HP to 0`);
                } catch (err) {
                    ModuleLogger.warn(`Could not set HP to 0: ${err}`);
                }

                success = true;
                message = `Actor marked as defeated, HP set to 0, and dead effect applied to ${tokensUpdated} tokens`;
                } else {
                throw new Error(`Cannot mark entity type ${entity.documentName} as defeated`);
                }

                results.push({
                uuid: (entity as any).uuid,
                success,
                message
                });
            }

            module.socketManager.send({
                type: "kill-entity-result",
                requestId: data.requestId,
                results
            });
            } catch (error) {
            ModuleLogger.error(`Error marking entities as defeated:`, error);
            module.socketManager.send({
                type: "kill-entity-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
            }
        });
        
        // Handle decrease attribute request
        module.socketManager.onMessageType("decrease-attribute", async (data) => {
            ModuleLogger.info(`Received decrease attribute request for attribute: ${data.attribute}, amount: ${data.amount}`);
            
            try {
            if (!data.uuid && !data.selected) {
                throw new Error("UUID or selected is required");
            }
            if (!data.attribute) throw new Error("Attribute path is required");
            if (typeof data.amount !== 'number') throw new Error("Amount must be a number");
            
            const entities = [];
            if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled || [];
                for (const token of controlledTokens) {
                if (token.actor) {
                    entities.push(token.actor);
                }
                }
            } else if (data.uuid) {
                const entity = await fromUuid(data.uuid);
                if (entity) {
                entities.push(entity);
                }
            }

            if (entities.length === 0) {
                throw new Error("No entities found to modify");
            }

            const results = [];
            for (const entity of entities) {
                // Get current value
                const currentValue = getProperty(entity, data.attribute);
                if (typeof currentValue !== 'number') {
                throw new Error(`Attribute ${data.attribute} is not a number, found: ${typeof currentValue}`);
                }

                // Calculate new value
                const newValue = currentValue - data.amount;

                // Prepare update data
                const updateData: { [key: string]: number } = {};
                updateData[data.attribute] = newValue;

                // Apply the update
                await entity.update(updateData);

                results.push({
                uuid: (entity as any).uuid,
                attribute: data.attribute,
                oldValue: currentValue,
                newValue: newValue
                });
            }

            module.socketManager.send({
                type: "modify-attribute-result",
                requestId: data.requestId,
                results,
                success: true
            });
            } catch (error) {
            ModuleLogger.error(`Error decreasing attribute:`, error);
            module.socketManager.send({
                type: "modify-attribute-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
            }
        });
        
        // Handle increase attribute request
        module.socketManager.onMessageType("increase-attribute", async (data) => {
            ModuleLogger.info(`Received increase attribute request for attribute: ${data.attribute}, amount: ${data.amount}`);
            
            try {
            if (!data.uuid && !data.selected) {
                throw new Error("UUID or selected is required");
            }
            if (!data.attribute) throw new Error("Attribute path is required");
            if (typeof data.amount !== 'number') throw new Error("Amount must be a number");
            
            const entities = [];
            if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled || [];
                for (const token of controlledTokens) {
                if (token.actor) {
                    entities.push(token.actor);
                }
                }
            } else if (data.uuid) {
                const entity = await fromUuid(data.uuid);
                if (entity) {
                entities.push(entity);
                }
            }

            if (entities.length === 0) {
                throw new Error("No entities found to modify");
            }

            const results = [];
            for (const entity of entities) {
                // Get current value
                const currentValue = getProperty(entity, data.attribute);
                if (typeof currentValue !== 'number') {
                throw new Error(`Attribute ${data.attribute} is not a number, found: ${typeof currentValue}`);
                }

                // Calculate new value
                const newValue = currentValue + data.amount;

                // Prepare update data
                const updateData: { [key: string]: unknown } = {};
                updateData[data.attribute] = newValue;

                // Apply the update
                await entity.update(updateData);

                results.push({
                uuid: (entity as any).uuid,
                attribute: data.attribute,
                oldValue: currentValue,
                newValue: newValue
                });
            }

            module.socketManager.send({
                type: "modify-attribute-result",
                requestId: data.requestId,
                results,
                success: true
            });
            } catch (error) {
            ModuleLogger.error(`Error increasing attribute:`, error);
            module.socketManager.send({
                type: "modify-attribute-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
            }
        });
        
        // Handle give item request
        module.socketManager.onMessageType("give-item", async (data) => {
            ModuleLogger.info(`Received give item request from ${data.fromUuid} to ${data.toUuid}`);
            
            try {
            if (!data.toUuid && !data.selected) {
                throw new Error("Target UUID or selected is required");
            };
            if (!data.itemUuid) throw new Error("Item UUID is required");
            
            // Get the source actor
            let fromEntity: any | null = null;
            if (data.fromUuid) {
                fromEntity = await fromUuid(data.fromUuid);
                
                // Make sure it's an actor
                if (fromEntity?.documentName !== "Actor") {
                    throw new Error(`Source entity must be an Actor, got ${fromEntity?.documentName}`);
                }
            }
            
            // Get the target actor
            if (data.selected) {
                data.toUuid = canvas?.tokens?.controlled[0]?.actor?.uuid;
            }
            const toEntity = await fromUuid(data.toUuid);
            if (!toEntity) throw new Error(`Target entity not found: ${data.toUuid}`);
            
            // Make sure it's an actor
            if (toEntity.documentName !== "Actor") {
                throw new Error(`Target entity must be an Actor, got ${toEntity.documentName}`);
            }
            
            // Get the item to transfer
            const itemEntity = await fromUuid(data.itemUuid);
            if (!itemEntity) throw new Error(`Item not found: ${data.itemUuid}`);
            
            // Make sure it's an item
            if (itemEntity.documentName !== "Item") {
                throw new Error(`Entity must be an Item, got ${itemEntity.documentName}`);
            }
            
            // Make sure the item belongs to the source actor
            if (data.fromUuid && itemEntity.parent?.id !== fromEntity.id) {
                throw new Error(`Item ${data.itemUuid} does not belong to source actor ${data.fromUuid}`);
            }
            
            // Create a new item on the target actor
            const itemData = itemEntity.toObject();
            delete itemData._id; // Remove the ID so a new one is created
            
            // Handle quantity if specified
            if (data.quantity && typeof data.quantity === 'number') {
                if (itemData.system && itemData.system.quantity) {
                const originalQuantity = itemData.system.quantity;
                itemData.system.quantity = data.quantity;
                    if (data.fromUuid) {
                        // If transferring all, delete from source
                        if (data.quantity >= originalQuantity) {
                            await itemEntity.delete();
                        } else {
                            // Otherwise reduce quantity on source
                            await itemEntity.update({"system.quantity": originalQuantity - data.quantity});
                        }
                    }
                }
            } else {
                if (data.fromUuid) {
                    // Default behavior with no quantity - remove from source
                    await itemEntity.delete();
                }
            }
            
            // Create on target
            const newItem = await toEntity.createEmbeddedDocuments("Item", [itemData]);
            
            module.socketManager.send({
                type: "give-item-result",
                requestId: data.requestId,
                fromUuid: data.fromUuid,
                selected: data.selected,
                toUuid: data.toUuid,
                quantity: data.quantity,
                itemUuid: data.itemUuid,
                newItemId: newItem[0].id,
                success: true
            });
            } catch (error) {
            ModuleLogger.error(`Error giving item:`, error);
            module.socketManager.send({
                type: "give-item-result",
                requestId: data.requestId,
                selected: data.selected,
                fromUuid: data.fromUuid || "",
                toUuid: data.toUuid || "",
                quantity: data.quantity,
                itemUuid: data.itemUuid || "",
                success: false,
                error: (error as Error).message
            });
        }
    });

    module.socketManager.onMessageType("execute-js", async (data) => {
        ModuleLogger.info(`Received execute-js request:`, data);
    
        try {
            const { script, requestId } = data;
    
            if (!script || typeof script !== "string") {
                throw new Error("Invalid script provided");
            }
    
            // Use an IIFE to safely execute the script
            let result;
            try {
                result = await (async () => {
                    return eval(`(async () => { ${script} })()`);
                })();
            } catch (executionError) {
                const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);
                throw new Error(`Error executing script: ${errorMessage}`);
            }
    
            // Send the result back
            module.socketManager.send({
                type: "execute-js-result",
                requestId,
                success: true,
                result
            });
        } catch (error) {
            ModuleLogger.error(`Error in execute-js handler:`, error);
            module.socketManager.send({
                type: "execute-js-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    });

    // Handle select entities request
    module.socketManager.onMessageType("select-entities", async (data) => {
        ModuleLogger.info(`Received select entities request:`, data);
        
        try {
            const scene = game.scenes?.active;
            if (!scene) {
                throw new Error("No active scene found");
            }

            if (data.overwrite) {
                // Deselect all tokens if overwrite is true
                canvas?.tokens?.releaseAll();
            }

            let targets: TokenDocument[] = [];
            if (data.all) {
                // Select all tokens on the active scene
                targets = scene.tokens?.contents || [];
            }
            if (data.uuids && Array.isArray(data.uuids)) {
                const matchingTokens = scene.tokens?.filter(token => 
                    data.uuids.includes(token.uuid)
                ) || [];
                targets = [...targets, ...matchingTokens];
            }
            if (data.name) {
                const matchingTokens = scene.tokens?.filter(token => 
                    token.name?.toLowerCase() === data.name?.toLowerCase()
                ) || [];
                targets = [...targets, ...matchingTokens];
            }
            if (data.data) {
                const matchingTokens = scene.tokens?.filter(token => 
                    Object.entries(data.data).every(([key, value]) => {
                        // Handle nested keys for actor data
                        if (key.startsWith("actor.") && token.actor) {
                            const actorKey = key.replace("actor.", "");
                            return getProperty(token.actor, actorKey) === value;
                        }
                        // Handle token-level properties
                        const tokenData = token.toObject();
                        return getProperty(tokenData, key) === value;
                    })
                ) || [];
                targets = [...targets, ...matchingTokens];
            }

            if (targets.length === 0) {
                throw new Error("No matching entities found");
            }

            // Select each token
            for (const token of targets) {
                const t = token.id ? canvas?.tokens?.get(token.id) : null;
                if (t) {
                    t.control({ releaseOthers: false });
                }
            }

            module.socketManager.send({
                type: "select-entities-result",
                requestId: data.requestId,
                success: true,
                count: targets.length,
                message: `${targets.length} entities selected`
            });
        } catch (error) {
            ModuleLogger.error(`Error selecting entities:`, error);
            module.socketManager.send({
                type: "select-entities-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    });

    // Handle get selected entities request
    module.socketManager.onMessageType("get-selected-entities", async (data) => {
        ModuleLogger.info(`Received get selected entities request:`, data);
        
        try {
            const scene = game.scenes?.active;
            if (!scene) {
                throw new Error("No active scene found");
            }

            const selectedTokens = canvas?.tokens?.controlled || [];
            const selectedUuids = selectedTokens.map(token => ({
                tokenUuid: token.document.uuid,
                actorUuid: token.actor?.uuid || null
            }));

            module.socketManager.send({
                type: "selected-entities-result",
                requestId: data.requestId,
                success: true,
                selected: selectedUuids
            });
        } catch (error) {
            ModuleLogger.error(`Error getting selected entities:`, error);
            module.socketManager.send({
                type: "selected-entities-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    });
  
    } catch (error) {
      ModuleLogger.error(`Error initializing WebSocket:`, error);
    }
}
