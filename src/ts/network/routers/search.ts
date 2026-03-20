import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { parseFilterString, matchesAllFilters } from "../../utils/search";
import { resolveRequestUser, hasPermission, toLimitedData } from "../../utils/permissions";

export const router = new Router("searchRouter");

router.addRoute({
  actionType: "search",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received search request:`, data);

    try {
      const { user, shouldReturn } = resolveRequestUser(data, socketManager, "search-result");
      if (shouldReturn) return;

      if (!window.QuickInsert) {
        ModuleLogger.error(`QuickInsert not available`);
        socketManager?.send({
          type: "search-result",
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
          socketManager?.send({
            type: "search-result",
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

      let mappedResults: any[] = filteredResults.map(result => {
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
      });

      // Filter by user permission if userId provided
      if (user) {
        const permissionFilteredResults = [];
        for (const result of mappedResults) {
          try {
            const doc = await fromUuid(result.uuid);
            if (doc) {
              if (hasPermission(doc, user, "OBSERVER")) {
                permissionFilteredResults.push(result);
              } else if (hasPermission(doc, user, "LIMITED")) {
                // Include with limited data
                const limited = toLimitedData(doc);
                permissionFilteredResults.push({
                  ...limited,
                  formattedMatch: result.formattedMatch,
                  resultType: result.resultType
                });
              }
              // NONE permission: exclude
            }
          } catch {
            // If we can't resolve the document, include the search result as-is
            permissionFilteredResults.push(result);
          }
        }
        mappedResults = permissionFilteredResults;
      }

      socketManager?.send({
        type: "search-result",
        requestId: data.requestId,
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
