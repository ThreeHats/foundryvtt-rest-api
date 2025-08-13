/**
 * Shared version checking utilities for Foundry VTT
 */

/**
 * Get the current Foundry VTT core version
 * @returns The current Foundry core version
 */
export function getFoundryVersion(): string {
    return game.version;
}

export function getFoundryVersionMajor(): number {
    return parseInt(getFoundryVersion().split('.')[0], 10);
}

/**
 * Get the current game system version
 * @returns The current system version
 */
export function getSystemVersion(): string {
    return (game.system as any).version;
}

/**
 * Get the current game system ID
 * @returns The current system ID
 */
export function getSystemId(): string {
    return game.system.id;
}

/**
 * Get the current game system title
 * @returns The current system title
 */
export function getSystemTitle(): string {
    return (game.system as any).title;
}
