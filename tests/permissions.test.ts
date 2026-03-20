import {
  resolveUser,
  hasPermission,
  toLimitedData,
  serializeWithPermission,
  filterByPermission,
  assertWritePermission,
  assertGM,
  assertUserCan,
  resolveRequestUser
} from '../src/ts/utils/permissions';

// Mock deepSerializeEntity
jest.mock('../src/ts/utils/serialization', () => ({
  deepSerializeEntity: jest.fn((entity: any) => ({
    ...entity,
    _serialized: true
  }))
}));

// Setup mock Foundry globals
const mockUsers = [
  { id: 'gm-id-123', name: 'GameMaster', isGM: true, can: jest.fn().mockReturnValue(true) },
  { id: 'player-id-456', name: 'PlayerOne', isGM: false, can: jest.fn().mockImplementation((perm: string) => perm === 'FILES_BROWSE') },
  { id: 'player-id-789', name: 'PlayerTwo', isGM: false, can: jest.fn().mockReturnValue(false) }
];

(global as any).game = {
  users: {
    get: jest.fn((id: string) => mockUsers.find(u => u.id === id) || undefined),
    find: jest.fn((fn: (u: any) => boolean) => mockUsers.find(fn) || undefined)
  }
};

describe('permissions utilities', () => {
  describe('resolveUser', () => {
    test('resolves by ID', () => {
      const user = resolveUser('gm-id-123');
      expect(user).toBeTruthy();
      expect(user!.name).toBe('GameMaster');
    });

    test('falls back to name lookup (case-insensitive)', () => {
      const user = resolveUser('playerone');
      expect(user).toBeTruthy();
      expect(user!.id).toBe('player-id-456');
    });

    test('returns null for unknown user', () => {
      const user = resolveUser('nonexistent');
      expect(user).toBeNull();
    });

    test('returns null for empty string', () => {
      const user = resolveUser('');
      expect(user).toBeNull();
    });
  });

  describe('hasPermission', () => {
    const mockDoc = {
      testUserPermission: jest.fn()
    };

    beforeEach(() => {
      mockDoc.testUserPermission.mockReset();
    });

    test('returns true when user has permission', () => {
      mockDoc.testUserPermission.mockReturnValue(true);
      expect(hasPermission(mockDoc, mockUsers[0] as any, 'OBSERVER')).toBe(true);
      expect(mockDoc.testUserPermission).toHaveBeenCalledWith(mockUsers[0], 2);
    });

    test('returns false when user lacks permission', () => {
      mockDoc.testUserPermission.mockReturnValue(false);
      expect(hasPermission(mockDoc, mockUsers[1] as any, 'OWNER')).toBe(false);
      expect(mockDoc.testUserPermission).toHaveBeenCalledWith(mockUsers[1], 3);
    });

    test('checks LIMITED with level 1', () => {
      mockDoc.testUserPermission.mockReturnValue(true);
      hasPermission(mockDoc, mockUsers[0] as any, 'LIMITED');
      expect(mockDoc.testUserPermission).toHaveBeenCalledWith(mockUsers[0], 1);
    });

    test('returns false for null document', () => {
      expect(hasPermission(null, mockUsers[0] as any, 'OBSERVER')).toBe(false);
    });

    test('returns false for null user', () => {
      expect(hasPermission(mockDoc, null as any, 'OBSERVER')).toBe(false);
    });

    test('returns false when testUserPermission throws', () => {
      mockDoc.testUserPermission.mockImplementation(() => { throw new Error('fail'); });
      expect(hasPermission(mockDoc, mockUsers[0] as any, 'OBSERVER')).toBe(false);
    });
  });

  describe('toLimitedData', () => {
    test('returns only basic fields', () => {
      const doc = { uuid: 'Actor.abc', name: 'Test', documentName: 'Actor', img: 'test.png', system: { hp: 10 } };
      const result = toLimitedData(doc);
      expect(result).toEqual({
        uuid: 'Actor.abc',
        name: 'Test',
        type: 'Actor',
        img: 'test.png'
      });
    });

    test('falls back to type field if documentName missing', () => {
      const doc = { uuid: 'Item.abc', name: 'Sword', type: 'weapon', img: null };
      const result = toLimitedData(doc);
      expect(result).toEqual({
        uuid: 'Item.abc',
        name: 'Sword',
        type: 'weapon',
        img: null
      });
    });
  });

  describe('serializeWithPermission', () => {
    const makeDoc = (observerPerm: boolean, limitedPerm: boolean) => ({
      uuid: 'Actor.test',
      name: 'TestDoc',
      documentName: 'Actor',
      img: 'test.png',
      testUserPermission: jest.fn((_user: any, level: number) => {
        if (level <= 1) return limitedPerm;
        if (level <= 2) return observerPerm;
        return false;
      })
    });

    test('returns full serialization for OBSERVER+ permission', () => {
      const doc = makeDoc(true, true);
      const result = serializeWithPermission(doc, mockUsers[0] as any);
      expect(result).toHaveProperty('_serialized', true);
    });

    test('returns limited data for LIMITED permission', () => {
      const doc = makeDoc(false, true);
      const result = serializeWithPermission(doc, mockUsers[1] as any);
      expect(result).toEqual({
        uuid: 'Actor.test',
        name: 'TestDoc',
        type: 'Actor',
        img: 'test.png'
      });
    });

    test('returns null for NONE permission', () => {
      const doc = makeDoc(false, false);
      const result = serializeWithPermission(doc, mockUsers[2] as any);
      expect(result).toBeNull();
    });
  });

  describe('filterByPermission', () => {
    test('filters out documents with no permission', () => {
      const docs = [
        { uuid: 'a', name: 'A', documentName: 'Actor', img: null, testUserPermission: jest.fn().mockReturnValue(true) },
        { uuid: 'b', name: 'B', documentName: 'Actor', img: null, testUserPermission: jest.fn().mockReturnValue(false) },
        { uuid: 'c', name: 'C', documentName: 'Actor', img: null, testUserPermission: jest.fn().mockReturnValue(true) }
      ];

      const result = filterByPermission(docs, mockUsers[0] as any);
      expect(result.length).toBe(2);
    });
  });

  describe('assertWritePermission', () => {
    test('does not throw when user has OWNER permission', () => {
      const doc = { name: 'Test', testUserPermission: jest.fn().mockReturnValue(true) };
      expect(() => assertWritePermission(doc, mockUsers[0] as any, 'update')).not.toThrow();
    });

    test('throws when user lacks OWNER permission', () => {
      const doc = { name: 'Test', testUserPermission: jest.fn().mockReturnValue(false) };
      expect(() => assertWritePermission(doc, mockUsers[1] as any, 'update'))
        .toThrow("User 'PlayerOne' does not have permission to update 'Test'");
    });
  });

  describe('assertGM', () => {
    test('does not throw for GM user', () => {
      expect(() => assertGM(mockUsers[0] as any, 'execute JS')).not.toThrow();
    });

    test('throws for non-GM user', () => {
      expect(() => assertGM(mockUsers[1] as any, 'execute JS'))
        .toThrow("User 'PlayerOne' must be a GM to execute JS");
    });
  });

  describe('assertUserCan', () => {
    test('does not throw when user has the permission', () => {
      expect(() => assertUserCan(mockUsers[1] as any, 'FILES_BROWSE', 'browse files')).not.toThrow();
    });

    test('throws when user lacks the permission', () => {
      expect(() => assertUserCan(mockUsers[2] as any, 'FILES_BROWSE', 'browse files'))
        .toThrow("User 'PlayerTwo' does not have 'FILES_BROWSE' permission required to browse files");
    });
  });

  describe('resolveRequestUser', () => {
    test('returns null user when no userId in data', () => {
      const result = resolveRequestUser({}, null, 'test-result');
      expect(result.user).toBeNull();
      expect(result.shouldReturn).toBe(false);
    });

    test('returns user when valid userId provided', () => {
      const result = resolveRequestUser({ userId: 'gm-id-123' }, null, 'test-result');
      expect(result.user).toBeTruthy();
      expect(result.user!.name).toBe('GameMaster');
      expect(result.shouldReturn).toBe(false);
    });

    test('sends error and returns shouldReturn=true for invalid userId', () => {
      const mockSend = jest.fn();
      const socketManager = { send: mockSend };
      const result = resolveRequestUser(
        { userId: 'nonexistent', requestId: 'req-1' },
        socketManager,
        'test-result'
      );
      expect(result.user).toBeNull();
      expect(result.shouldReturn).toBe(true);
      expect(mockSend).toHaveBeenCalledWith({
        type: 'test-result',
        requestId: 'req-1',
        error: 'User not found: nonexistent',
        data: null
      });
    });
  });
});
