import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { recentRolls } from "../../constants";

export const router = new Router("rollRouter");

router.addRoute({
  actionType: "get-rolls",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for roll data`);

    socketManager?.send({
      type: "rolls-data",
      requestId: data.requestId,
      data: recentRolls.slice(0, data.limit || 20)
    });
  }
});

router.addRoute({
  actionType: "get-last-roll",
  handler: (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for last roll data`);

    socketManager?.send({
      type: "last-roll-data",
      requestId: data.requestId,
      data: recentRolls.length > 0 ? recentRolls[0] : null
    });
  }
});

router.addRoute({
  actionType: "perform-roll",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    try {
      const { formula, itemUuid, flavor, createChatMessage, speaker, target, whisper, requestId } = data;

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
              const activeScene = (game as Game).scenes?.active;
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

      if (itemUuid) {
        try {
          const document = await fromUuid(itemUuid);
          if (!document) {
            throw new Error(`Item with UUID ${itemUuid} not found`);
          }

          const item = document as any;

          ModuleLogger.info(`Creating chat message for item: ${(item as any).name}`);

          let messageId;
          let targetAcquired = false;
          let targetToken = null;

          if (target) {
            try {
              const targetDocument = await fromUuid(target);

              if (targetDocument) {
                if (targetDocument instanceof TokenDocument) {
                  targetToken = targetDocument;
                  targetAcquired = true;
                  ModuleLogger.info(`Target token acquired: ${targetDocument.name}`);
                } else if (targetDocument instanceof Actor) {
                  const activeScene = (game as Game).scenes?.active;
                  if (activeScene) {
                    const tokens = activeScene.tokens?.filter(t => t.actor?.id === targetDocument.id);
                    if (tokens && tokens.length > 0) {
                      targetToken = tokens[0];
                      targetAcquired = true;
                      ModuleLogger.info(`Target token acquired from actor: ${tokens[0].name}`);
                    }
                  }
                }

                if (targetAcquired && targetToken) {
                  if (canvas && canvas.ready) {
                    if (canvas.tokens) {
                      (game as Game).user?.targets.forEach(t => t.setTarget(false, { user: (game as Game).user, releaseOthers: false, groupSelection: false }));
                      (game as Game).user?.targets.clear();

                      if (targetToken.id) {
                        const targetObject = canvas.tokens.get(targetToken.id);
                        if (targetObject) {
                          targetObject.setTarget(true, { user: (game as Game).user, releaseOthers: true, groupSelection: false });
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

          if ((item as any).system?.actionType) {
            ModuleLogger.info(`Using D&D 5e item with action type: ${(item as any).system.actionType}`);

            if (((item as Record<string, any>).system as Record<string, any>)?.actionType) {
              const useOptions: any = {
                configureDialog: false,
                createMessage: true,
                skipDialog: true,
                fastForward: true,
                consume: false,
                speaker: speakerData,
                target: targetToken
              };

              if (targetAcquired && targetToken) {
                useOptions.target = targetToken;
              }

              const originalRenderDialog = Dialog.prototype.render;

              Dialog.prototype.render = function(...args) {
                const result = originalRenderDialog.apply(this, args);

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
                ModuleLogger.info(`Using item with dialog auto-click enabled: ${(item as any).name}`);
                const useResult = await (((item as Record<string, any>).use) as Function)(useOptions);
                messageId = useResult?.id || useResult;

                ModuleLogger.info(`Item used with use() method, should trigger Midi-QOL: ${(item as any).name}`);
              } finally {
                Dialog.prototype.render = originalRenderDialog;

                ModuleLogger.info(`Restored original dialog methods after item use`);
              }
            } else if ((item as any).displayCard && typeof (item as any).displayCard === 'function') {
              const cardResult = await (item as any).displayCard({
                createMessage: true,
                speaker: speakerData,
                ...(targetAcquired ? { target: targetToken } : {})
              });
              messageId = cardResult?.id;
            }
          } else if (typeof (item as any).toChat === 'function') {
            const chatOptions = targetAcquired ? { target: targetToken } : {};
            const chatResult = await (item as any).toChat(chatOptions);
            messageId = chatResult?.id;
          } else if (typeof (item as any).displayCard === 'function') {
            const displayCard = (item as any).displayCard as (options: any) => Promise<any>;
            const cardResult = await displayCard({
              createMessage: true,
              speaker: speakerData,
              ...(targetAcquired ? { target: targetToken } : {})
            });
            messageId = cardResult?.id;
          } else {
            const chatData = {
              user: (game as Game).user?.id,
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
          socketManager?.send({
            type: "roll-result",
            requestId: requestId,
            success: false,
            error: `Failed to display item in chat: ${(err as Error).message}`
          });
          return;
        }
      } else {
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
