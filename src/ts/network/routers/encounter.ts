import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("encounterRouter");

router.addRoute({
  actionType: "get-encounters",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for encounters`);

    try {
      const encounters = (game as Game).combats?.contents.map(combat => {
        return {
          id: combat.id,
          name: combat.name,
          round: combat.round,
          turn: combat.turn,
          current: combat.id === (game as Game).combat?.id,
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

      socketManager?.send({
        type: "encounters-list",
        requestId: data.requestId,
        encounters
      });
    } catch (error) {
      ModuleLogger.error(`Error getting encounters list:`, error);
      socketManager?.send({
        type: "encounters-list",
        requestId: data.requestId,
        error: (error as Error).message,
        encounters: []
      });
    }
  }
});

router.addRoute({
  actionType: "start-encounter",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request to start encounter with options:`, data);

    try {
      const combat = await Combat.create({ name: data.name || "New Encounter" });

      if (combat) {
        await combat.startCombat();

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

        if (data.startWithPlayers) {
          const currentScene = (game as Game).scenes?.viewed;

          if (currentScene) {
            const playerTokens = currentScene.tokens?.filter(token => !!token.actor && token.actor.hasPlayerOwner) ?? [];

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

        if (data.startWithSelected) {
          const selectedTokens = canvas?.tokens?.controlled
            .filter(token => !addedTokenIds.has(token.id))
            .map(token => ({
              tokenId: token.id,
              sceneId: token.scene.id
            })) ?? [];

          if (selectedTokens.length > 0) {
            await combat.createEmbeddedDocuments("Combatant", selectedTokens);
          }
        }

        if (data.rollNPC) {
          await combat.rollNPC();
        }

        if (data.rollAll) {
          await combat.rollAll();
        }

        await combat.activate();

        socketManager?.send({
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
      socketManager?.send({
        type: "encounter-started",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "encounter-next-turn",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for next turn in encounter: ${data.encounterId || 'active'}`);

    try {
      const combat = data.encounterId ? (game as Game).combats?.get(data.encounterId) : (game as Game).combat;

      if (!combat) {
        throw new Error(data.encounterId ? `Encounter with ID ${data.encounterId} not found` : "No active encounter");
      }

      await combat.nextTurn();

      socketManager?.send({
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
      socketManager?.send({
        type: "encounter-navigation",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "encounter-next-round",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for next round in encounter: ${data.encounterId || 'active'}`);

    try {
      const combat = data.encounterId ? (game as Game).combats?.get(data.encounterId) : (game as Game).combat;

      if (!combat) {
        throw new Error(data.encounterId ? `Encounter with ID ${data.encounterId} not found` : "No active encounter");
      }

      await combat.nextRound();

      socketManager?.send({
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
      socketManager?.send({
        type: "encounter-navigation",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "encounter-previous-turn",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for previous turn in encounter: ${data.encounterId || 'active'}`);

    try {
      const combat = data.encounterId ? (game as Game).combats?.get(data.encounterId) : (game as Game).combat;

      if (!combat) {
        throw new Error(data.encounterId ? `Encounter with ID ${data.encounterId} not found` : "No active encounter");
      }

      await combat.previousTurn();

      socketManager?.send({
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
      socketManager?.send({
        type: "encounter-navigation",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "encounter-previous-round",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for previous round in encounter: ${data.encounterId || 'active'}`);

    try {
      const combat = data.encounterId ? (game as Game).combats?.get(data.encounterId) : (game as Game).combat;

      if (!combat) {
        throw new Error(data.encounterId ? `Encounter with ID ${data.encounterId} not found` : "No active encounter");
      }

      await combat.previousRound();

      socketManager?.send({
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
      socketManager?.send({
        type: "encounter-navigation",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "end-encounter",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request to end encounter: ${data.encounterId}`);

    try {
      let encounterId = data.encounterId;
      if (!encounterId) {
        encounterId = (game as Game).combat?.id;
      }

      const combat = (game as Game).combats?.get(encounterId);

      if (!combat) {
        throw new Error(`No encounter not found`);
      }

      await combat.delete();

      socketManager?.send({
        type: "encounter-ended",
        requestId: data.requestId,
        encounterId: encounterId,
        message: "Encounter successfully ended"
      });
    } catch (error) {
      ModuleLogger.error(`Error ending encounter:`, error);
      socketManager?.send({
        type: "encounter-ended",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "add-to-encounter",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received add-to-encounter request for encounter: ${data.encounterId}`);

    try {
      const combat = data.encounterId ? (game as Game).combats?.get(data.encounterId) : (game as Game).combat;

      if (!combat) {
        throw new Error(data.encounterId ? `Encounter with ID ${data.encounterId} not found` : "No active encounter");
      }

      const addedEntities: string[] = [];
      const failedEntities = [];

      if (data.uuids && Array.isArray(data.uuids)) {
        for (const uuid of data.uuids) {
          try {
            const entity = await fromUuid(uuid);

            if (!entity) {
              failedEntities.push({ uuid, reason: "Entity not found" });
              continue;
            }

            if (entity.documentName === "Token") {
              const token = entity;
              const combatantData = {
                tokenId: token.id,
                sceneId: token.parent?.id
              };

              await combat.createEmbeddedDocuments("Combatant", [combatantData]);
              addedEntities.push(uuid);
            } else if (entity.documentName === "Actor") {
              const scene = (game as Game).scenes?.viewed;
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

      if (data.rollInitiative === true && addedEntities.length > 0) {
        combat.rollAll();
      }

      socketManager?.send({
        type: "add-to-encounter-result",
        requestId: data.requestId,
        encounterId: combat.id,
        added: addedEntities,
        failed: failedEntities
      });
    } catch (error) {
      ModuleLogger.error(`Error adding to encounter:`, error);
      socketManager?.send({
        type: "add-to-encounter-result",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "remove-from-encounter",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received remove-from-encounter request for encounter: ${data.encounterId}`);

    try {
      const combat = data.encounterId ? (game as Game).combats?.get(data.encounterId) : (game as Game).combat;

      if (!combat) {
        throw new Error(data.encounterId ? `Encounter with ID ${data.encounterId} not found` : "No active encounter");
      }

      const removedEntities = [];
      const failedEntities = [];
      const combatantIdsToRemove = [];

      if (data.uuids && Array.isArray(data.uuids)) {
        for (const uuid of data.uuids) {
          try {
            const entity = await fromUuid(uuid);

            if (!entity) {
              failedEntities.push({ uuid, reason: "Entity not found" });
              continue;
            }

            let foundCombatant = false;

            if (entity.documentName === "Token") {
              const combatant = combat.combatants.find(c =>
                c.token?.id === entity.id && c.combat?.scene?.id === entity.parent?.id
              );

              if (combatant) {
                combatantIdsToRemove.push(combatant.id);
                foundCombatant = true;
              }
            } else if (entity.documentName === "Actor") {
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

      if (combatantIdsToRemove.length > 0) {
        const validIds = combatantIdsToRemove.filter((id): id is string => id !== null);
        if (validIds.length > 0) {
          await combat.deleteEmbeddedDocuments("Combatant", validIds);
        }
      }

      socketManager?.send({
        type: "remove-from-encounter-result",
        requestId: data.requestId,
        encounterId: combat.id,
        removed: removedEntities,
        failed: failedEntities
      });
    } catch (error) {
      ModuleLogger.error(`Error removing from encounter:`, error);
      socketManager?.send({
        type: "remove-from-encounter-result",
        requestId: data.requestId,
        error: (error as Error).message
      });
    }
  }
});
