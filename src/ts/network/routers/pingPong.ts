import {Router, HandlerContext} from "./baseRouter"
import { ModuleLogger } from "../../utils/logger"

export const router = new Router(
    "pingRouter"
)

router.addRoute(
    {
        actionType: "ping",
        handler: (context: HandlerContext) => {
            ModuleLogger.info(`Received ping, sending pong`);
            context.socketManager.send({ type: "pong" });
        }
    }
)

router.addRoute(
    {
        actionType: "pong",
        handler: () => {
            ModuleLogger.info(`Received pong`);
        }
    }
)
