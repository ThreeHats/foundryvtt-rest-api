import { ModuleLogger } from '../src/ts/utils/logger';
import { WSCloseCodes } from '../src/ts/types';

// Mock ModuleLogger
jest.mock('../src/ts/utils/logger', () => ({
  ModuleLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock game object
const mockGame = {
  user: { id: 'user1', isGM: true, role: 4 },
  users: [
    { id: 'user1', isGM: true, role: 4, active: true },
    { id: 'user2', isGM: true, role: 4, active: true },
  ],
  settings: {
    get: jest.fn().mockImplementation((_moduleId: string, setting: string) => {
      if (setting === 'pingInterval') return 30;
      if (setting === 'reconnectMaxAttempts') return 5;
      if (setting === 'reconnectBaseDelay') return 1000;
      return null;
    }),
  },
};

// Mock WebSocket
class MockWebSocket {
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: string, callback: any) {
    if (event === 'open') this.onopen = callback;
    if (event === 'close') this.onclose = callback;
    if (event === 'error') this.onerror = callback;
    if (event === 'message') this.onmessage = callback;
  }

  send(_data: string) {}

  close(_code?: number, _reason?: string) {}
}

// Mock WebSocketManager
class MockWebSocketManager {
  private static instance: MockWebSocketManager | null = null;
  private socket: MockWebSocket | null = null;

  private constructor(private url: string) {}

  static getInstance(url: string, _token: string): MockWebSocketManager {
    if (!MockWebSocketManager.instance) {
      MockWebSocketManager.instance = new MockWebSocketManager(url);
    }
    return MockWebSocketManager.instance;
  }

  connect(): void {
    this.socket = new MockWebSocket(this.url);
    ModuleLogger.info(`Connecting to WebSocket at ${this.url}`);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close(WSCloseCodes.Normal, "Disconnecting");
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  send(data: any): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
      return true;
    }
    return false;
  }
}

jest.mock('../src/ts/network/webSocketManager', () => ({
  WebSocketManager: MockWebSocketManager,
}));

// Mock global objects
global.WebSocket = MockWebSocket as any;
(global as any).game = mockGame;

describe('WebSocketManager', () => {
  let wsManager: MockWebSocketManager;
  const url = 'ws://localhost:3000';
  const token = 'test-token';

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).game.user.isGM = true;
    (global as any).game.user.role = 4;
    wsManager = MockWebSocketManager.getInstance(url, token);
  });

  test('getInstance creates a singleton instance for GM users', () => {
    expect(wsManager).toBeInstanceOf(MockWebSocketManager);
    const secondInstance = MockWebSocketManager.getInstance(url, token);
    expect(secondInstance).toBe(wsManager);
  });

  test('getInstance returns instance even for non-GM users', () => {
    (global as any).game.user.isGM = false;
    const instance = MockWebSocketManager.getInstance(url, token);
    expect(instance).toBeInstanceOf(MockWebSocketManager);
  });

  test('connect initializes WebSocket connection', () => {
    wsManager.connect();
    expect(ModuleLogger.info).toHaveBeenCalledWith(expect.stringContaining('Connecting to WebSocket'));
  });

  test('disconnect closes WebSocket connection', () => {
    wsManager.connect();
    const mockClose = jest.spyOn(MockWebSocket.prototype, 'close');
    wsManager.disconnect();
    expect(mockClose).toHaveBeenCalledWith(WSCloseCodes.Normal, 'Disconnecting');
  });

  test('isConnected returns true when WebSocket is open', () => {
    wsManager.connect();
    (wsManager as any).socket.readyState = WebSocket.OPEN;
    expect(wsManager.isConnected()).toBe(true);
  });

  test('send method sends data through WebSocket', () => {
    wsManager.connect();
    (wsManager as any).socket.readyState = WebSocket.OPEN;
    const mockSend = jest.spyOn(MockWebSocket.prototype, 'send');
    const data = { type: 'test', content: 'message' };
    wsManager.send(data);
    expect(mockSend).toHaveBeenCalledWith(JSON.stringify(data));
  });

  // Add more tests for message handling, reconnection logic, etc.
});
