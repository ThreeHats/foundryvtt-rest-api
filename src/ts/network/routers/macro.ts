import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, hasPermission, assertWritePermission } from "../../utils/permissions";

export const router = new Router("macroRouter");

router.addRoute({
  actionType: "macros",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request for macros`);

    try {
      const { user, shouldReturn } = resolveRequestUser(data, socketManager, "macros-result");
      if (shouldReturn) return;

      let macros = game.macros?.contents.map(macro => {
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

      // Filter by permission if userId provided
      if (user) {
        macros = macros.filter(macroData => {
          const macro = game.macros?.get(macroData.id);
          return macro && hasPermission(macro, user, "LIMITED");
        });
      }

      socketManager?.send({
        type: "macros-result",
        requestId: data.requestId,
        macros
      });
    } catch (error) {
      ModuleLogger.error(`Error getting macros list:`, error);
      socketManager?.send({
        type: "macros-result",
        requestId: data.requestId,
        error: (error as Error).message,
        macros: []
      });
    }
  }
});

router.addRoute({
  actionType: "macro-execute",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received request to execute macro: ${data.uuid}`);

    try {
      const { user, shouldReturn } = resolveRequestUser(data, socketManager, "macro-execute-result");
      if (shouldReturn) return;

      if (!data.uuid) {
        throw new Error("Macro UUID is required");
      }

      const macro = await fromUuid(data.uuid) as Macro;
      if (!macro) {
        throw new Error(`Macro not found with UUID: ${data.uuid}`);
      }

      if (!(macro instanceof CONFIG.Macro.documentClass)) {
        throw new Error(`Entity with UUID ${data.uuid} is not a macro`);
      }

      if (user) {
        assertWritePermission(macro, user, "execute");
      }

      if (!macro.canExecute) {
        throw new Error(`Macro '${macro.name}' cannot be executed by the current user`);
      }

      const args = data.args || {};

      let result;
      if (typeof args === "object") {
        result = await macro.execute({ args } as any);
      } else {
        result = await macro.execute();
      }

      socketManager?.send({
        type: "macro-execute-result",
        requestId: data.requestId,
        uuid: data.uuid,
        success: true,
        result: typeof result === 'object' ? result : { value: result }
      });
    } catch (error) {
      ModuleLogger.error(`Error executing macro:`, error);
      socketManager?.send({
        type: "macro-execute-result",
        requestId: data.requestId,
        uuid: data.uuid || "",
        success: false,
        error: (error as Error).message
      });
    }
  }
});
