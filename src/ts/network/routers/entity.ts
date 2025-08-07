import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { deepSerializeEntity } from "../../utils/serialization";

export const router = new Router("entityRouter");

router.addRoute({
  actionType: "entity",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
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
              // Use custom deep serialization
              entityData.push(deepSerializeEntity(entity));
            }
          }
        }
      } else {
        entity = await fromUuid(data.uuid);
        // Use custom deep serialization
        entityData = entity ? deepSerializeEntity(entity) : null;
      }

      if (!entityData) {
        ModuleLogger.error(`Entity not found: ${data.uuid}`);
        socketManager?.send({
          type: "entity-result",
          requestId: data.requestId,
          uuid: data.uuid,
          error: "Entity not found",
          data: null,
        });
        return;
      }

      ModuleLogger.info(`Sending entity data for: ${data.uuid}`, entityData);

      socketManager?.send({
        type: "entity-result",
        requestId: data.requestId,
        uuid: entityUUID,
        data: entityData,
      });
    } catch (error) {
      ModuleLogger.error(`Error getting entity:`, error);
      socketManager?.send({
        type: "entity-result",
        requestId: data.requestId,
        uuid: data.uuid,
        error: (error as Error).message,
        data: null,
      });
    }
  },
});

// Handle entity creation
router.addRoute({
  actionType: "create",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received create entity request for type: ${data.entityType}`);

    try {
      const DocumentClass = getDocumentClass(data.entityType);
      if (!DocumentClass) {
        throw new Error(`Invalid entity type: ${data.entityType}`);
      }

      const createData = {
        ...data.data,
        folder: data.folder || null
      };

      const entity = await DocumentClass.create(createData);

      if (!entity) {
        throw new Error("Failed to create entity");
      }

      socketManager?.send({
        type: "create-result",
        requestId: data.requestId,
        uuid: entity.uuid,
        entity: entity.toObject()
      });
    } catch (error) {
      ModuleLogger.error(`Error creating entity:`, error);
      socketManager?.send({
        type: "create-result",
        requestId: data.requestId,
        error: (error as Error).message,
        message: "Failed to create entity"
      });
    }
  }
});

// Handle decrease attribute request
router.addRoute({
  actionType: "decrease",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
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
        const currentValue = getProperty(entity, data.attribute);
        if (typeof currentValue !== 'number') {
          throw new Error(`Attribute ${data.attribute} is not a number, found: ${typeof currentValue}`);
        }

        const newValue = currentValue - data.amount;
        const updateData: { [key: string]: number } = {};
        updateData[data.attribute] = newValue;

        await entity.update(updateData);

        results.push({
          uuid: (entity as any).uuid,
          attribute: data.attribute,
          oldValue: currentValue,
          newValue: newValue
        });
      }

      socketManager?.send({
        type: "decrease-result",
        requestId: data.requestId,
        results,
        success: true
      });
    } catch (error) {
      ModuleLogger.error(`Error decreasing attribute:`, error);
      socketManager?.send({
        type: "decrease-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

// Handle increase attribute request
router.addRoute({
  actionType: "increase",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
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
        const currentValue = getProperty(entity, data.attribute);
        if (typeof currentValue !== 'number') {
          throw new Error(`Attribute ${data.attribute} is not a number, found: ${typeof currentValue}`);
        }

        const newValue = currentValue + data.amount;
        const updateData: { [key: string]: unknown } = {};
        updateData[data.attribute] = newValue;

        await entity.update(updateData);

        results.push({
          uuid: (entity as any).uuid,
          attribute: data.attribute,
          oldValue: currentValue,
          newValue: newValue
        });
      }

      socketManager?.send({
        type: "increase-result",
        requestId: data.requestId,
        results,
        success: true
      });
    } catch (error) {
      ModuleLogger.error(`Error increasing attribute:`, error);
      socketManager?.send({
        type: "increase-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

// Handle entity update
router.addRoute({
  actionType: "update",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received update entity request for UUID: ${data.uuid}`);

    try {
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

      for (let entity of entities) {
        await entity?.update(data.data);
      }

      let updatedEntities = [];
      for (let entity of entities) {
        updatedEntities.push(await fromUuid((entity as any).uuid));
      }

      socketManager?.send({
        type: "update-result",
        requestId: data.requestId,
        uuid: data.uuid,
        entity: updatedEntities.map(e => e?.toObject())
      });
    } catch (error) {
      ModuleLogger.error(`Error updating entity:`, error);
      socketManager?.send({
        type: "update-result",
        requestId: data.requestId,
        uuid: data.uuid,
        error: (error as Error).message,
        message: "Failed to update entity"
      });
    }
  }
});

// Handle entity deletion
router.addRoute({
  actionType: "delete",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received delete entity request for UUID: ${data.uuid}`);

    try {
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

      for (let entity of entities) {
        await entity?.delete();
      }

      socketManager?.send({
        type: "delete-result",
        requestId: data.requestId,
        uuid: data.uuid,
        success: true
      });
    } catch (error) {
      ModuleLogger.error(`Error deleting entity:`, error);
      socketManager?.send({
        type: "delete-result",
        requestId: data.requestId,
        uuid: data.uuid,
        error: (error as Error).message,
        message: "Failed to delete entity"
      });
    }
  }
});

// Handle kill request (mark token/actor as defeated)
router.addRoute({
  actionType: "kill",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
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

        if (entity.documentName === "Token") {
          const token = entity;
          const actor = (token as any).actor;

          if (!actor) {
            throw new Error("Token has no associated actor");
          }

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

          const combat = game.combat;
          if (combat) {
            const combatants = combat.combatants.filter(c => c.actor?.id === actor.id);
            
            if (combatants.length > 0) {
              await Promise.all(combatants.map(c => c.update({ defeated: true })));
              ModuleLogger.info(`Marked ${combatants.length} combatants as defeated`);
            }
          }

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

      socketManager?.send({
        type: "kill-result",
        requestId: data.requestId,
        results
      });
    } catch (error) {
      ModuleLogger.error(`Error marking entities as defeated:`, error);
      socketManager?.send({
        type: "kill-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

// Handle give item request
router.addRoute({
  actionType: "give",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received give item request from ${data.fromUuid} to ${data.toUuid}`);

    try {
      if (!data.toUuid && !data.selected) {
        throw new Error("Target UUID or selected is required");
      }
      if (!data.itemUuid && !data.itemName) {
        throw new Error("Item UUID or Item Name is required");
      }

      let fromEntity: any | null = null;
      if (data.fromUuid) {
        fromEntity = await fromUuid(data.fromUuid);
        if (fromEntity?.documentName !== "Actor") {
          throw new Error(`Source entity must be an Actor, got ${fromEntity?.documentName}`);
        }
      }

      if (data.selected) {
        data.toUuid = canvas?.tokens?.controlled[0]?.actor?.uuid;
      }
      const toEntity = await fromUuid(data.toUuid);
      if (!toEntity) throw new Error(`Target entity not found: ${data.toUuid}`);
      if (toEntity.documentName !== "Actor") {
        throw new Error(`Target entity must be an Actor, got ${toEntity.documentName}`);
      }

      let itemEntity: any | null = null;
      let itemData: any | null = null;

      if (data.itemUuid) {
        itemEntity = await fromUuid(data.itemUuid);
        if (itemEntity) {
          itemData = itemEntity.toObject();
        }
      } else if (data.itemName) {
        if (fromEntity) {
          itemEntity = fromEntity.items.find((i: any) => i.name.toLowerCase() === data.itemName.toLowerCase());
          if (itemEntity) {
            itemData = itemEntity.toObject();
          }
        } else {
          // Global search if no fromUuid
          if (!window.QuickInsert) {
            throw new Error("QuickInsert is not available for global item search.");
          }

          if (!window.QuickInsert.hasIndex) {
            ModuleLogger.info(`QuickInsert index not ready, forcing index creation`);
            window.QuickInsert.forceIndex();
            await new Promise(resolve => setTimeout(resolve, 500)); // Give index time to build
          }
          
          const searchResults = await window.QuickInsert.search(data.itemName, null, 20); // Search all documents
          const itemSearchResult = searchResults.find(r => r.item?.documentType === "Item");

          if (itemSearchResult) {
            const foundItem = await itemSearchResult.item.get(); // Asynchronously get the full document
            if (foundItem) {
              itemData = foundItem.toObject(); // Get the plain data object
            }
          }
        }
      }

      if (!itemData) throw new Error(`Item not found: ${data.itemUuid || data.itemName}`);

      // This check is only valid if we found an item via UUID or on an actor.
      if (itemEntity && itemEntity.documentName !== "Item") {
        throw new Error(`Entity must be an Item, got ${itemEntity.documentName}`);
      }

      // This check is only valid if we found the item on a specific actor.
      if (itemEntity && fromEntity && itemEntity.parent?.id !== fromEntity.id) {
        throw new Error(`Item ${data.itemUuid || data.itemName} does not belong to source actor ${data.fromUuid}`);
      }

      const amountToGive = data.quantity || 1;

      // Check if a stackable item with the same name already exists on the target actor
      const existingItem = (toEntity as any).items.find((i: any) => i.name === itemData.name);
      const isStackable = existingItem && hasProperty(existingItem.system, 'quantity');
      
      // If a source actor is defined, handle removing/updating the item from them first.
      if (itemEntity && fromEntity) {
        const sourceQuantity = getProperty(itemEntity, 'system.quantity');
        if (typeof sourceQuantity === 'number' && amountToGive < sourceQuantity) {
            await itemEntity.update({ "system.quantity": sourceQuantity - amountToGive });
        } else {
            // If giving the whole stack, or it's not a stackable item, delete it.
            await itemEntity.delete();
        }
      }

      let newItemId;
      let finalQuantity;
      // Now, add the item to the target actor.
      if (isStackable) {
        const newQuantity = existingItem.system.quantity + amountToGive;
        await existingItem.update({ 'system.quantity': newQuantity });
        newItemId = existingItem.id;
        finalQuantity = newQuantity;
      } else {
        // If the item doesn't exist on the target or isn't stackable, create a new one.
        delete itemData._id;
        if (hasProperty(itemData, 'system.quantity')) {
            itemData.system.quantity = amountToGive;
        } else if (itemData.system) { // Handle items that might not have quantity by default
            itemData.system.quantity = amountToGive;
        }
        finalQuantity = amountToGive;

        const newItems = await (toEntity as any).createEmbeddedDocuments("Item", [itemData]);
        newItemId = newItems[0].id;
      }

      socketManager?.send({
        type: "give-result",
        requestId: data.requestId,
        fromUuid: data.fromUuid,
        selected: data.selected,
        toUuid: data.toUuid,
        quantity: finalQuantity,
        itemUuid: data.itemUuid,
        newItemId: newItemId,
        success: true
      });
    } catch (error) {
      ModuleLogger.error(`Error giving item:`, error);
      socketManager?.send({
        type: "give-result",
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
  }
});

// Handle remove item request
router.addRoute({
    actionType: "remove",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received remove item request from actor: ${data.actorUuid}`);

        try {
            if (!data.actorUuid && !data.selected) {
                throw new Error("Target actor UUID or selected is required");
            }
            if (!data.itemUuid && !data.itemName) {
                throw new Error("Item UUID or Item Name is required");
            }

            if (data.selected) {
                data.actorUuid = canvas?.tokens?.controlled[0]?.actor?.uuid;
            }
            const actor = await fromUuid(data.actorUuid);
            if (!actor) throw new Error(`Target actor not found: ${data.actorUuid}`);
            if ((actor as any).documentName !== "Actor") {
                throw new Error(`Target entity must be an Actor, got ${(actor as any).documentName}`);
            }

            let itemEntity: any | null = null;
            if (data.itemUuid) {
                itemEntity = await fromUuid(data.itemUuid);
            } else if (data.itemName) {
                itemEntity = (actor as any).items.find((i: any) => i.name.toLowerCase() === data.itemName.toLowerCase());
            }

            if (!itemEntity) throw new Error(`Item not found: ${data.itemUuid || data.itemName}`);

            const amountToRemove = data.quantity || null;
            const currentQuantity = getProperty(itemEntity, 'system.quantity');
            let finalQuantity = 0;

            if (amountToRemove && typeof currentQuantity === 'number' && currentQuantity > amountToRemove) {
                finalQuantity = currentQuantity - amountToRemove;
                await itemEntity.update({ "system.quantity": finalQuantity });
            } else {
                await itemEntity.delete();
            }

            socketManager?.send({
                type: "remove-result",
                requestId: data.requestId,
                actorUuid: data.actorUuid,
                itemUuid: itemEntity.uuid,
                quantity: finalQuantity,
                success: true
            });
        } catch (error) {
            ModuleLogger.error(`Error removing item:`, error);
            socketManager?.send({
                type: "remove-result",
                requestId: data.requestId,
                success: false,
                error: (error as Error).message
            });
        }
    }
});
