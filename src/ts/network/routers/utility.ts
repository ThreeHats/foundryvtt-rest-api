import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("utilityRouter");

router.addRoute({
  actionType: "execute-js",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received execute-js request:`, data);

    try {
      const { script, requestId } = data;

      if (!script || typeof script !== "string") {
        throw new Error("Invalid script provided");
      }

      let result;
      try {
        result = await (async () => {
          return eval(`(async () => { ${script} })()`);
        })();
      } catch (executionError) {
        const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);
        throw new Error(`Error executing script: ${errorMessage}`);
      }

      socketManager?.send({
        type: "execute-js-result",
        requestId,
        success: true,
        result
      });
    } catch (error) {
      ModuleLogger.error(`Error in execute-js handler:`, error);
      socketManager?.send({
        type: "execute-js-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "select",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received select entities request:`, data);

    try {
      const scene = game.scenes?.active;
      if (!scene) {
        throw new Error("No active scene found");
      }

      if (data.overwrite) {
        canvas?.tokens?.releaseAll();
      }

      // Use a Set to track unique tokens by UUID to avoid duplicates
      const targetSet = new Set<TokenDocument>();
      
      if (data.all) {
        const allTokens = scene.tokens?.contents || [];
        allTokens.forEach(token => targetSet.add(token));
      }
      if (data.uuids && Array.isArray(data.uuids)) {
        const matchingTokens = scene.tokens?.filter(token => 
          data.uuids.includes(token.uuid)
        ) || [];
        matchingTokens.forEach(token => targetSet.add(token));
      }
      if (data.name) {
        const matchingTokens = scene.tokens?.filter(token => 
          token.name?.toLowerCase() === data.name?.toLowerCase()
        ) || [];
        matchingTokens.forEach(token => targetSet.add(token));
      }
      if (data.data) {
        const matchingTokens = scene.tokens?.filter(token => 
          Object.entries(data.data).every(([key, value]) => {
            if (key.startsWith("actor.") && token.actor) {
              const actorKey = key.replace("actor.", "");
              return getProperty(token.actor, actorKey) === value;
            }
            const tokenData = token.toObject();
            return getProperty(tokenData, key) === value;
          })
        ) || [];
        matchingTokens.forEach(token => targetSet.add(token));
      }

      // Convert Set back to array
      const targets = Array.from(targetSet);

      if (targets.length === 0) {
        throw new Error("No matching entities found");
      }

      for (const token of targets) {
        const t = token.id ? canvas?.tokens?.get(token.id) : null;
        if (t) {
          t.control({ releaseOthers: false });
        }
      }

      const selectedUuids = targets.map(token => token.uuid);

      socketManager?.send({
        type: "select-result",
        requestId: data.requestId,
        success: true,
        count: targets.length,
        message: `${targets.length} entities selected`,
        selected: selectedUuids
      });
    } catch (error) {
      ModuleLogger.error(`Error selecting entities:`, error);
      socketManager?.send({
        type: "select-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});

router.addRoute({
  actionType: "selected",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
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

      socketManager?.send({
        type: "selected-result",
        requestId: data.requestId,
        success: true,
        selected: selectedUuids
      });
    } catch (error) {
      ModuleLogger.error(`Error getting selected entities:`, error);
      socketManager?.send({
        type: "selected-result",
        requestId: data.requestId,
        success: false,
        error: (error as Error).message
      });
    }
  }
});
