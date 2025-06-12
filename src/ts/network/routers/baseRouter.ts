import { WebSocketManager } from "../webSocketManager";


export interface HandlerContext {
    socketManager: WebSocketManager
}


export interface RouteI {
    actionType: string
    handler: (data: any, context: HandlerContext | undefined) => void
}

interface RouterI {
    title: string,
    routes: RouteI[]
}

export class Router implements RouterI {
    title: string
    routes: RouteI[]

    constructor(title: string, routes: RouteI[] = []) {
        this.title = title,
            this.routes = routes
    }

    addRoute(route: RouteI) {
        this.routes.push(
            route
        )
    }

    reflect(socketManager: WebSocketManager) {
        this.routes.forEach(
            (route: RouteI) => socketManager.onMessageType(route.actionType, route.handler)
        )
    }
}
