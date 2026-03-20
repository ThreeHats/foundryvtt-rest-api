/**
 * Centralized permission utilities for userId-based permission filtering.
 * When a userId is provided in API requests, these utilities scope operations
 * to what that specific Foundry VTT user can see and do.
 */
import { deepSerializeEntity } from "./serialization";

/**
 * Resolve a userId string to a Foundry User object.
 * Tries ID lookup first, then falls back to name matching.
 */
export function resolveUser(userId: string): User | null {
    if (!userId) return null;

    // Try by ID first
    const byId = game.users?.get(userId);
    if (byId) return byId;

    // Fall back to name lookup (case-insensitive)
    const byName = game.users?.find(u => u.name?.toLowerCase() === userId.toLowerCase());
    return byName || null;
}

/**
 * Check if a user has at least the given permission level on a document.
 */
export function hasPermission(document: any, user: User, level: "LIMITED" | "OBSERVER" | "OWNER"): boolean {
    if (!document || !user) return false;

    // Use numeric values directly: NONE=0, LIMITED=1, OBSERVER=2, OWNER=3
    // These match both DOCUMENT_PERMISSION_LEVELS (types) and DOCUMENT_OWNERSHIP_LEVELS (runtime v12+)
    const permLevel = level === "LIMITED" ? 1
        : level === "OBSERVER" ? 2
        : 3; // OWNER

    try {
        return document.testUserPermission(user, permLevel);
    } catch {
        return false;
    }
}

/**
 * Return limited data for a document (only basic identification fields).
 * Used when a user has LIMITED permission on a document.
 */
export function toLimitedData(document: any): object {
    return {
        uuid: document.uuid,
        name: document.name,
        type: document.documentName || document.type,
        img: document.img || null
    };
}

/**
 * Serialize a document with permission awareness:
 * - OWNER/OBSERVER → full deepSerializeEntity data
 * - LIMITED → minimal data (name, uuid, type, img)
 * - NONE → null (excluded)
 */
export function serializeWithPermission(document: any, user: User): object | null {
    if (!document || !user) return null;

    if (hasPermission(document, user, "OBSERVER")) {
        return deepSerializeEntity(document);
    }

    if (hasPermission(document, user, "LIMITED")) {
        return toLimitedData(document);
    }

    return null;
}

/**
 * Filter a collection of documents, returning only those the user can see,
 * serialized according to their permission level.
 */
export function filterByPermission(documents: any[], user: User): object[] {
    const results: object[] = [];
    for (const doc of documents) {
        const serialized = serializeWithPermission(doc, user);
        if (serialized) {
            results.push(serialized);
        }
    }
    return results;
}

/**
 * Assert that a user has OWNER permission on a document.
 * Throws a descriptive error if the user lacks permission.
 */
export function assertWritePermission(document: any, user: User, operation: string): void {
    if (!hasPermission(document, user, "OWNER")) {
        const docName = document.name || document.uuid || "unknown";
        throw new Error(`User '${user.name}' does not have permission to ${operation} '${docName}'`);
    }
}

/**
 * Assert that a user is a GM. Throws if not.
 */
export function assertGM(user: User, operation: string): void {
    if (!user.isGM) {
        throw new Error(`User '${user.name}' must be a GM to ${operation}`);
    }
}

/**
 * Assert that a user has a specific Foundry permission (e.g. FILES_BROWSE).
 */
export function assertUserCan(user: User, permission: string, operation: string): void {
    if (!(user as any).can(permission)) {
        throw new Error(`User '${user.name}' does not have '${permission}' permission required to ${operation}`);
    }
}

/**
 * Helper: resolve userId from request data and return the User, or null if not provided.
 * Sends an error response via socketManager if userId is provided but invalid.
 * Returns { user, shouldReturn } where shouldReturn=true means caller should return early.
 */
export function resolveRequestUser(
    data: any,
    socketManager: any,
    responseType: string
): { user: User | null; shouldReturn: boolean } {
    if (!data.userId) {
        return { user: null, shouldReturn: false };
    }

    const user = resolveUser(data.userId);
    if (!user) {
        socketManager?.send({
            type: responseType,
            requestId: data.requestId,
            error: `User not found: ${data.userId}`,
            data: null
        });
        return { user: null, shouldReturn: true };
    }

    return { user, shouldReturn: false };
}
