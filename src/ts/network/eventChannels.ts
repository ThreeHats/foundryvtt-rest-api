/**
 * On-demand event channel management.
 *
 * The relay sends "event-subscription-update" messages when clients subscribe
 * or unsubscribe from event channels (SSE or WS). This module registers and
 * deregisters Foundry hooks in response, so events are only forwarded to the
 * relay when at least one external subscriber is listening.
 */

import { moduleId, recentRolls, MAX_ROLLS_STORED } from "../constants";
import { FoundryRestApi } from "../types";
import { ModuleLogger } from "../utils/logger";

// --- State ---

const activeEventChannels = new Set<string>();
const eventHookHandles = new Map<string, Array<{ name: string; id: number }>>();
let chatMsgHookHandle: number | null = null; // shared by chat-events + roll-events

// --- Helpers ---

function getConnectedSocketManager(): any {
  const mod = game.modules.get(moduleId) as FoundryRestApi;
  if (mod.socketManager?.isConnected()) return mod.socketManager;
  return null;
}

function serializeHookArg(arg: any): any {
  if (arg === null || arg === undefined) return arg;
  if (typeof arg !== "object") return arg;
  try {
    if (typeof arg.toObject === "function") return arg.toObject();
    return JSON.parse(JSON.stringify(arg));
  } catch {
    return String(arg);
  }
}

function serializeChatMessageForEvent(message: any): any {
  return {
    id: message.id,
    uuid: message.uuid,
    content: message.content,
    speaker: message.speaker,
    timestamp: message.timestamp,
    whisper: message.whisper || [],
    type: message.type,
    author: message.author
      ? { id: message.author.id, name: message.author.name }
      : null,
    flavor: message.flavor || "",
    isRoll: message.isRoll || false,
    rolls:
      message.rolls?.map((r: any) => ({
        formula: r.formula,
        total: r.total,
        isCritical: r.isCritical || false,
        isFumble: r.isFumble || false,
        dice:
          r.dice?.map((d: any) => ({
            faces: d.faces,
            results:
              d.results?.map((res: any) => ({
                result: res.result,
                active: res.active,
              })) || [],
          })) || [],
      })) || [],
    flags: message.flags || {},
  };
}

function sendActorEvent(actor: any, eventType: string, extra: any = {}): void {
  if (!actor || actor.documentName !== "Actor") return;
  const sm = getConnectedSocketManager();
  if (!sm) return;
  sm.send({ type: "actor-event", data: { actorUuid: actor.uuid, eventType, ...extra } });
}

function sendSceneEvent(scene: any, eventType: string, extra: any = {}): void {
  if (!scene) return;
  const sm = getConnectedSocketManager();
  if (!sm) return;
  const sceneId = typeof scene === "string" ? scene : scene.id || scene._id;
  sm.send({ type: "scene-event", data: { sceneId, eventType, ...extra } });
}

const FORWARDED_HOOKS = [
  "createActor", "updateActor", "deleteActor",
  "createItem", "updateItem", "deleteItem",
  "createToken", "updateToken", "deleteToken",
  "createCombat", "updateCombat", "deleteCombat",
  "createCombatant", "updateCombatant", "deleteCombatant",
  "createScene", "updateScene", "deleteScene",
  "createActiveEffect", "updateActiveEffect", "deleteActiveEffect",
  "createPlaylist", "updatePlaylist", "deletePlaylist",
  "createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound",
  "combatStart", "combatTurn", "combatRound",
  "updateWorldTime", "pauseGame",
  "canvasReady",
];

// --- Shared createChatMessage hook (used by both chat-events and roll-events) ---

function ensureChatMsgHook(): void {
  if (chatMsgHookHandle !== null) return;
  chatMsgHookHandle = Hooks.on("createChatMessage", (message: any) => {
    if (
      activeEventChannels.has("roll-events") &&
      message.isRoll &&
      message.rolls?.length > 0
    ) {
      ModuleLogger.info(
        `Detected dice roll from ${message.author?.name || "unknown"}`
      );
      const rollId = message.id;
      const rollData = {
        id: rollId,
        messageId: message.id,
        user: { id: message.author?.id, name: message.author?.name },
        speaker: message.speaker,
        flavor: message.flavor || "",
        rollTotal: message.rolls[0].total,
        formula: message.rolls[0].formula,
        isCritical: message.rolls[0].isCritical || false,
        isFumble: message.rolls[0].isFumble || false,
        dice: message.rolls[0].dice?.map((d: any) => ({
          faces: d.faces,
          results: d.results.map((r: any) => ({
            result: r.result,
            active: r.active,
          })),
        })),
        timestamp: Date.now(),
      };
      const existingIndex = recentRolls.findIndex(
        (roll) => roll.id === rollId
      );
      if (existingIndex !== -1) {
        recentRolls[existingIndex] = rollData;
      } else {
        recentRolls.unshift(rollData);
        if (recentRolls.length > MAX_ROLLS_STORED)
          recentRolls.length = MAX_ROLLS_STORED;
      }
      const sm = getConnectedSocketManager();
      if (sm) sm.send({ type: "roll-data", data: rollData });
    }

    if (activeEventChannels.has("chat-events")) {
      const sm = getConnectedSocketManager();
      if (sm)
        sm.send({
          type: "chat-event",
          data: {
            eventType: "create",
            data: serializeChatMessageForEvent(message),
          },
        });
    }
  });
}

// --- Public API ---

/**
 * Enable hooks for the given event channel. Called when the relay reports
 * that subscriber count rose from 0 to 1.
 */
export function enableEventChannel(channel: string): void {
  if (activeEventChannels.has(channel)) return;
  activeEventChannels.add(channel);

  const pairs: Array<{ name: string; id: number }> = [];
  const reg = (hookName: string, fn: (...args: any[]) => void) => {
    pairs.push({ name: hookName, id: Hooks.on(hookName, fn) });
  };

  switch (channel) {
    case "chat-events":
      ensureChatMsgHook();
      reg("deleteChatMessage", (message: any) => {
        const sm = getConnectedSocketManager();
        if (sm)
          sm.send({
            type: "chat-event",
            data: { eventType: "delete", data: { id: message.id } },
          });
      });
      reg("updateChatMessage", (message: any) => {
        const sm = getConnectedSocketManager();
        if (sm)
          sm.send({
            type: "chat-event",
            data: {
              eventType: "update",
              data: serializeChatMessageForEvent(message),
            },
          });
      });
      break;

    case "roll-events":
      ensureChatMsgHook();
      // Roll data is handled inside the shared createChatMessage hook above.
      break;

    case "hooks":
      for (const hookName of FORWARDED_HOOKS) {
        reg(hookName, (...args: any[]) => {
          const sm = getConnectedSocketManager();
          if (sm)
            sm.send({
              type: "hook-event",
              data: { hook: hookName, args: args.map(serializeHookArg) },
            });
        });
      }
      break;

    case "combat-events":
      reg("combatStart", (combat: any) => {
        const sm = getConnectedSocketManager();
        if (!sm) return;
        sm.send({
          type: "combat-event",
          data: {
            eventType: "start",
            encounterId: combat.id,
            round: combat.round,
            turn: combat.turn,
            combatants: combat.combatants?.map((c: any) => ({
              id: c.id,
              initiative: c.initiative,
              defeated: c.defeated,
              uuid: c.uuid,
            })) || [],
          },
        });
      });
      reg("combatTurn", (combat: any) => {
        const sm = getConnectedSocketManager();
        if (!sm) return;
        sm.send({
          type: "combat-event",
          data: {
            eventType: "turn",
            encounterId: combat.id,
            round: combat.round,
            turn: combat.turn,
            combatants: combat.combatants?.map((c: any) => ({
              id: c.id,
              initiative: c.initiative,
              defeated: c.defeated,
              uuid: c.uuid,
            })) || [],
          },
        });
      });
      reg("combatRound", (combat: any) => {
        const sm = getConnectedSocketManager();
        if (!sm) return;
        sm.send({
          type: "combat-event",
          data: {
            eventType: "round",
            encounterId: combat.id,
            round: combat.round,
            turn: combat.turn,
            combatants: combat.combatants?.map((c: any) => ({
              id: c.id,
              initiative: c.initiative,
              defeated: c.defeated,
              uuid: c.uuid,
            })) || [],
          },
        });
      });
      reg("createCombatant", (combatant: any) => {
        const sm = getConnectedSocketManager();
        if (!sm || !combatant.combat) return;
        sm.send({
          type: "combat-event",
          data: {
            eventType: "combatant-add",
            encounterId: combatant.combat.id,
            combatant: { id: combatant.id, initiative: combatant.initiative, defeated: combatant.defeated, uuid: combatant.uuid },
          },
        });
      });
      reg("deleteCombatant", (combatant: any) => {
        const sm = getConnectedSocketManager();
        if (!sm || !combatant.combat) return;
        sm.send({
          type: "combat-event",
          data: {
            eventType: "combatant-remove",
            encounterId: combatant.combat.id,
            combatant: { id: combatant.id, initiative: combatant.initiative, defeated: combatant.defeated, uuid: combatant.uuid },
          },
        });
      });
      reg("deleteCombat", (combat: any) => {
        const sm = getConnectedSocketManager();
        if (!sm) return;
        sm.send({
          type: "combat-event",
          data: { eventType: "end", encounterId: combat.id },
        });
      });
      break;

    case "actor-events":
      reg("updateActor", (actor: any, changes: any) => {
        sendActorEvent(actor, "update", { changes: serializeHookArg(changes) });
      });
      reg("createActiveEffect", (effect: any) => {
        if (effect.parent?.documentName === "Actor")
          sendActorEvent(effect.parent, "effect-add", {
            effect: effect.toObject(),
          });
      });
      reg("deleteActiveEffect", (effect: any) => {
        if (effect.parent?.documentName === "Actor")
          sendActorEvent(effect.parent, "effect-remove", {
            effectId: effect.id,
            effectName: effect.name,
          });
      });
      reg("createItem", (item: any) => {
        if (item.parent?.documentName === "Actor")
          sendActorEvent(item.parent, "item-add", { item: item.toObject() });
      });
      reg("deleteItem", (item: any) => {
        if (item.parent?.documentName === "Actor")
          sendActorEvent(item.parent, "item-remove", {
            itemId: item.id,
            itemName: item.name,
          });
      });
      reg("updateItem", (item: any, changes: any) => {
        if (item.parent?.documentName === "Actor")
          sendActorEvent(item.parent, "item-update", {
            itemId: item.id,
            itemName: item.name,
            changes: serializeHookArg(changes),
          });
      });
      break;

    case "scene-events":
      reg("createToken", (token: any) =>
        sendSceneEvent(token.parent, "token-create", {
          token: token.toObject(),
        })
      );
      reg("updateToken", (token: any, changes: any) =>
        sendSceneEvent(token.parent, "token-update", {
          tokenId: token.id,
          changes: serializeHookArg(changes),
        })
      );
      reg("deleteToken", (token: any) =>
        sendSceneEvent(token.parent, "token-delete", {
          tokenId: token.id,
          tokenName: token.name,
        })
      );
      reg("createAmbientLight", (light: any) =>
        sendSceneEvent(light.parent, "light-create", {
          light: light.toObject(),
        })
      );
      reg("updateAmbientLight", (light: any, changes: any) =>
        sendSceneEvent(light.parent, "light-update", {
          lightId: light.id,
          changes: serializeHookArg(changes),
        })
      );
      reg("deleteAmbientLight", (light: any) =>
        sendSceneEvent(light.parent, "light-delete", { lightId: light.id })
      );
      reg("createWall", (wall: any) =>
        sendSceneEvent(wall.parent, "wall-create", { wall: wall.toObject() })
      );
      reg("updateWall", (wall: any, changes: any) =>
        sendSceneEvent(wall.parent, "wall-update", {
          wallId: wall.id,
          changes: serializeHookArg(changes),
        })
      );
      reg("deleteWall", (wall: any) =>
        sendSceneEvent(wall.parent, "wall-delete", { wallId: wall.id })
      );
      break;

    default:
      ModuleLogger.warn(`enableEventChannel: unknown channel "${channel}"`);
      activeEventChannels.delete(channel);
      return;
  }

  if (pairs.length) eventHookHandles.set(channel, pairs);
  ModuleLogger.info(`Event channel enabled: ${channel}`);
}

/**
 * Disable hooks for the given event channel. Called when the relay reports
 * that subscriber count dropped to 0.
 */
export function disableEventChannel(channel: string): void {
  if (!activeEventChannels.has(channel)) return;
  activeEventChannels.delete(channel);

  // The shared createChatMessage hook is torn down only when BOTH
  // chat-events and roll-events are inactive.
  if (channel === "chat-events" || channel === "roll-events") {
    if (
      !activeEventChannels.has("chat-events") &&
      !activeEventChannels.has("roll-events")
    ) {
      if (chatMsgHookHandle !== null) {
        Hooks.off("createChatMessage", chatMsgHookHandle);
        chatMsgHookHandle = null;
      }
    }
  }

  const pairs = eventHookHandles.get(channel);
  if (pairs) {
    pairs.forEach(({ name, id }) => Hooks.off(name, id));
    eventHookHandles.delete(channel);
  }

  ModuleLogger.info(`Event channel disabled: ${channel}`);
}
