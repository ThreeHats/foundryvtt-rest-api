import { Router } from "./baseRouter";
import { handleRemoteResponse } from "../remoteRequest";

// remoteResponse router resolves pending module.api.remoteRequest() Promises
// when the relay forwards a response back from a target Foundry world.
//
// Wire format (relay → source module):
//   { type: "remote-response", requestId: "rr_...", success: bool, data?: {...}, error?: "..." }
export const router = new Router("remoteResponseRouter");

router.addRoute({
  actionType: "remote-response",
  handler: (data, _context) => {
    handleRemoteResponse(data);
  },
});
