import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { parseFilterString } from "../../utils/search";
import { searchIndex } from "../../utils/searchIndex";
import { resolveRequestUser, hasPermission } from "../../utils/permissions";

export const router = new Router("searchRouter");

router.addRoute({
  actionType: "search",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received search request:`, data);

    try {
      const { user, shouldReturn } = resolveRequestUser(data, socketManager, "search-result");
      if (shouldReturn) return;

      if (!searchIndex.isReady) {
        searchIndex.build();
      }

      const filters = data.filter
        ? (typeof data.filter === 'string' ? parseFilterString(data.filter) : data.filter)
        : undefined;

      const excludeCompendiums = data.excludeCompendiums === true || data.excludeCompendiums === "true";
      const minified = data.minified === true || data.minified === "true";
      const limit = Math.min(parseInt(data.limit) || 200, 500);

      const rawResults = await searchIndex.search(data.query, {
        limit,
        excludeCompendiums,
        filters
      });

      // Resolve permissions in parallel — sequential awaits on fromUuid caused
      // timeouts when results included many compendium entries (each needing
      // an IndexedDB read). Promise.all keeps the same behaviour but fast.
      const resolved = await Promise.all(
        rawResults.map(async ({ entry, formattedMatch }) => {
          let include = true;
          let limited = false;
          if (user) {
            try {
              const doc = await fromUuid(entry.uuid);
              if (doc) {
                if (hasPermission(doc, user, "OBSERVER")) {
                  // full access
                } else if (hasPermission(doc, user, "LIMITED")) {
                  limited = true;
                } else {
                  include = false;
                }
              }
            } catch {
              // If resolution fails, include the result as-is
            }
          }
          return { entry, formattedMatch, include, limited };
        })
      );

      const mappedResults: any[] = [];
      const seenUUIDs = new Set<string>();

      for (const { entry, formattedMatch, include, limited } of resolved) {
        if (!include) continue;
        if (entry.uuid && seenUUIDs.has(entry.uuid)) continue;
        if (entry.uuid) seenUUIDs.add(entry.uuid);

        if (minified || limited) {
          mappedResults.push({
            uuid: entry.uuid,
            id: entry.id,
            name: entry.name,
            img: entry.icon,
            documentType: entry.documentType
          });
        } else {
          mappedResults.push({
            documentType: entry.documentType,
            folder: entry.folder,
            id: entry.id,
            name: entry.name,
            package: entry.pack,
            packageName: entry.packageName,
            subType: entry.subType,
            uuid: entry.uuid,
            icon: entry.icon,
            journalLink: `@UUID[${entry.uuid}]{${entry.name}}`,
            tagline: entry.tagline,
            formattedMatch,
            resultType: entry.resultType
          });
        }
      }

      socketManager?.send({
        type: "search-result",
        requestId: data.requestId,
        clientId: data.clientId,
        query: data.query,
        filter: data.filter,
        results: mappedResults
      });
    } catch (error) {
      ModuleLogger.error(`Error performing search:`, error);
      socketManager?.send({
        type: "search-result",
        requestId: data.requestId,
        query: data.query,
        error: (error as Error).message,
        results: []
      });
    }
  }
});
