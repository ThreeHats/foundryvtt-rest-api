import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { recentRolls } from "../../constants";

export const router = new Router("rollRouter");

router.addRoute({
  actionType: "rolls",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for roll data`);

    socketManager?.send({
      type: "rolls-result",
      requestId: data.requestId,
      data: recentRolls.slice(0, data.limit || 20)
    });
  }
});

router.addRoute({
  actionType: "last-roll",
  handler: (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for last roll data`);

    socketManager?.send({
      type: "last-roll-result",
      requestId: data.requestId,
      data: recentRolls.length > 0 ? recentRolls[0] : null
    });
  }
});

router.addRoute({
  actionType: "roll",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    try {
      const { formula, flavor, createChatMessage, speaker, whisper, requestId } = data;

      let rollResult;
      let speakerData = {};
      let rollMode = whisper && whisper.length > 0 ? CONST.DICE_ROLL_MODES.PRIVATE : CONST.DICE_ROLL_MODES.PUBLIC;

      // Process speaker if provided
      if (speaker) {
        try {
          const speakerEntity = await fromUuid(speaker);

          if (speakerEntity) {
            if (speakerEntity instanceof TokenDocument) {
              speakerData = {
                token: speakerEntity?.id,
                actor: speakerEntity?.actor?.id,
                scene: speakerEntity?.parent?.id,
                alias: speakerEntity?.name || speakerEntity?.actor?.name
              };
            } else if (speakerEntity instanceof Actor) {
              const activeScene = game.scenes?.active;
              if (activeScene) {
                const tokens = activeScene.tokens?.filter(t => t.actor?.id === speakerEntity.id);
                if (tokens && tokens.length > 0) {
                  const token = tokens[0];
                  speakerData = {
                    token: token.id,
                    actor: speakerEntity.id,
                    scene: activeScene.id,
                    alias: token.name || speakerEntity.name
                  };
                } else {
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

      try {
        const roll = new Roll(formula);

        await roll.evaluate();

        if (createChatMessage) {
          await roll.toMessage({
            speaker: speakerData,
            flavor: flavor || "",
            rollMode,
            whisper: whisper || []
          });
        }

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
        socketManager?.send({
          type: "roll-result",
          requestId: requestId,
          success: false,
          error: `Failed to roll formula: ${(err as Error).message}`
        });
        return;
      }

      socketManager?.send({
        type: "roll-result",
        requestId: requestId,
        success: true,
        data: rollResult
      });
    } catch (error) {
      ModuleLogger.error(`Error in roll handler: ${error}`);
      socketManager?.send({
        type: "roll-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message || "Unknown error occurred during roll"
      });
    }
  }
});
