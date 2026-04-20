import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("transferRouter");

// Handle transfer result from relay
router.addRoute({
  actionType: "transfer-result",
  handler: (data, _context) => {
    ModuleLogger.info(`Received transfer result:`, data);

    // The relay sends back the result of a transfer request.
    // This is already handled by the pending request system
    // but we log and notify for the module's benefit.
    if (data.success) {
      ui.notifications?.info(`Transfer completed: ${data.data?.entityType} transferred to ${data.data?.targetClientId}`);
    } else {
      ui.notifications?.error(`Transfer failed: ${data.error}`);
    }
  }
});
