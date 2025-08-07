// src/ts/utils/logger.ts
import { moduleId } from "../constants";

/**
 * Utility for module logging with debug mode support
 */
export class ModuleLogger {
  /**
   * Check if debug mode is enabled
   */
  static debugLevel(): number {
    return (game as Game).settings.get(moduleId, "logLevel") as number;
  }

  /**
   * Log a debug message (only when debug mode is enabled)
   */
  static debug(message: string, ...args: any[]): string {
    if (this.debugLevel() < 1) {
      console.log(`${moduleId} | ${message}`, ...args);
    }
    return message;
  }

  /**
   * Log info message (always shown)
   */
  static info(message: string, ...args: any[]): string {
    if (this.debugLevel() < 2) {
        console.log(`${moduleId} | ${message}`, ...args);
    }
    return message;
  }

  /**
   * Log warning message (always shown)
   */
  static warn(message: string, ...args: any[]): string {
    if (this.debugLevel() < 3) {
      console.warn(`${moduleId} | ${message}`, ...args);
    }
    return message;
  }

  /**
   * Log error message (always shown)
   */
  static error(message: string, ...args: any[]): string {
    if (this.debugLevel() < 4) {
        console.error(`${moduleId} | ${message}`, ...args);
    }
    return message;
  }
}