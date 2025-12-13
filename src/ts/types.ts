import { WebSocketManager } from "./network/webSocketManager";

// WebSocket close codes
export enum WSCloseCodes {
  Normal = 1000,
  PolicyViolation = 1008,  // Used for invalid API key, unauthorized access
  NoClientId = 4001,
  NoAuth = 4002,
  NoConnectedGuild = 4003,
  InternalError = 4000,
  DuplicateConnection = 4004,
  ServerShutdown = 4005,
}

// Module-specific interfaces
export interface FoundryRestApi extends Game.ModuleData<any> {
  socketManager: WebSocketManager | null;
  api: FoundryRestApiAPI;
}

export interface FoundryRestApiAPI {
  getWebSocketManager: () => WebSocketManager | null;
  search: (query: string, filter?: string) => Promise<any[]>;
  getByUuid: (uuid: string) => Promise<any>;
}

export interface WebSocketMessage {
  type: string;
  data: any;
  sender?: string;
  timestamp?: number;
}

export interface ChatMessage {
  content: string;
  sender: string;
  timestamp: number;
}

export interface BackupFolder {
  path: string;
  name: string;
}

// Server route types
export declare namespace ServerRoutes {
  export interface BackupResponse {
    backups: string[];
  }
  
  export interface APIDocsResponse {
    message: string;
    endpoints: {
      path: string;
      description: string;
    }[];
  }
}

// Make sure TypeScript sees this file as a module
export {};
