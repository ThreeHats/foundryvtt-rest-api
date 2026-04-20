import { moduleId } from "../constants";
import { ModuleLogger } from "./logger";
import { FoundryRestApi } from "../types";

/**
 * Module-side notification emitter.
 *
 * The Foundry module reports in-Foundry events (settings changes, execute-js,
 * macro-execute) to the relay via the existing authenticated WebSocket. The
 * relay's unified notification dispatcher receives these events and routes them
 * to the user's configured destinations (Discord webhook, email) per the
 * notification settings stored in the database.
 *
 * The module no longer holds any webhook URLs or per-channel config — that
 * lives on the relay side, where it can be configured per-account AND per
 * scoped-API-key. This module is just a thin emitter.
 */

export type ModuleEventName = "settings-change" | "execute-js" | "macro-execute";

export interface ModuleNotifyEvent {
  event: ModuleEventName;
  details?: string; // Free-form description (e.g., script preview, setting name)
  actor?: string;   // Who triggered the event (defaults to current user's name)
  world?: string;   // World title (defaults to current world's title)
}

/**
 * Send a notification event to the relay. The relay decides what to do with it
 * based on the user's notification settings.
 *
 * Fire-and-forget: failures are logged but do not bubble up. If the WebSocket
 * is not connected, the event is silently dropped (the relay can only notify
 * about events it receives).
 */
export function notifyRelay(evt: ModuleNotifyEvent): void {
  const module = game.modules.get(moduleId) as FoundryRestApi | undefined;
  const sm = module?.socketManager;
  if (!sm || !sm.isConnected()) {
    ModuleLogger.debug(`module-notify skipped (WS not connected): ${evt.event}`);
    return;
  }

  try {
    sm.send({
      type: "module-notify",
      event: evt.event,
      details: evt.details ?? "",
      actor: evt.actor ?? game.user?.name ?? "",
      world: evt.world ?? (game.world as any)?.title ?? "",
    });
  } catch (err) {
    ModuleLogger.warn(`Failed to emit module-notify event ${evt.event}:`, err);
  }
}
