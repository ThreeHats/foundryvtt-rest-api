import { routers } from '../src/ts/network/routers/all';
import { WebSocketManager } from '../src/ts/network/webSocketManager';

// Interface for mocked globals
interface MockedGlobals {
  Roll: jest.Mock;
  ChatMessage: { create: jest.Mock };
  fromUuid: jest.Mock;
  game: {
    user: { id: string; isGM: boolean };
    settings: { get: jest.Mock };
  };
  CONST: {
    DICE_ROLL_MODES: {
      PUBLIC: string;
      PRIVATE: string;
    };
  };
}

// Mock dependencies

// Setup mocked globals
const mockedGlobals: MockedGlobals = {
  Roll: jest.fn().mockImplementation(() => ({
    evaluate: jest.fn().mockResolvedValue({}),
    total: 10,
    terms: [{ results: [{ result: 5 }] }],
    dice: [{ faces: 6, results: [{ result: 5, active: true }] }],
    toMessage: jest.fn().mockResolvedValue({}),
  })),
  ChatMessage: {
    create: jest.fn().mockResolvedValue({ id: 'mockMessageId' }),
  },
  fromUuid: jest.fn().mockResolvedValue(null),
  game: {
    user: { id: 'userId', isGM: true },
    settings: {
      get: jest.fn().mockReturnValue({}),
    },
  },
  CONST: {
    DICE_ROLL_MODES: {
      PUBLIC: 'publicroll',
      PRIVATE: 'gmroll',
    },
  },
};

// Assign mocked globals
Object.assign(global, mockedGlobals);

describe('WebSocket Routes', () => {
  let mockSocketManager: jest.Mocked<WebSocketManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketManager = {
      send: jest.fn(),
      onMessageType: jest.fn(),
    } as unknown as jest.Mocked<WebSocketManager>;
    
    routers.forEach(router => router.reflect(mockSocketManager));
  });

  test('all routes exist', () => {
    const expectedRoutes = [
      'ping',
      'pong',
      'perform-search',
      'get-entity',
      'get-structure',
      'get-contents',
      'create-entity',
      'update-entity',
      'delete-entity',
      'get-rolls',
      'get-last-roll',
      'perform-roll',
      'get-sheet-html',
      'get-macros',
      'execute-macro',
      'get-encounters',
      'start-encounter',
      'encounter-next-turn',
      'encounter-next-round',
      'encounter-previous-turn',
      'encounter-previous-round',
      'end-encounter',
      'add-to-encounter',
      'remove-from-encounter',
      'kill-entity',
      'decrease-attribute',
      'increase-attribute',
      'give-item',
      'execute-js',
      'select-entities',
      'get-selected-entities',
      'get-file-system',
      'upload-file',
      'download-file'
    ];
    
    console.log('Registered routes:', mockSocketManager.onMessageType.mock.calls.map(call => call[0]));
    
    expectedRoutes.forEach((route: string) => {
      const handler = mockSocketManager.onMessageType.mock.calls.find(call => call[0] === route)?.[1];
      if (!handler) {
        console.error(`Handler for ${route} not found`);
      }
      expect(handler).toBeDefined();
    });

    expect(mockSocketManager.onMessageType).toHaveBeenCalledTimes(expectedRoutes.length);
  });
});
