import { id } from "../module.json";
import { SYSTEMS } from "./systems";

export const CONSTANTS:any = {
    MODULE_ID: id
}


export const moduleId = id;

// Store the rolls made during this session
export const recentRolls: any[] = [];
export const MAX_ROLLS_STORED = 20; // Store up to 20 recent rolls

export const SETTINGS = {
    // Client settings
    ACTOR_CURRENCY_ATTRIBUTE: "actorCurrencyAttribute",
    WS_RELAY_URL: "wsRelayUrl",
    API_KEY: "apiKey",
    CUSTOM_NAME: "customName",
    LOG_LEVEL: "logLevel",
    PING_INTERVAL: "pingInterval",
    RECONNECT_MAX_ATTEMPTS: "reconnectMaxAttempts",
    RECONNECT_BASE_DELAY: "reconnectBaseDelay",

    // Hidden settings
    SYSTEM_FOUND: "systemFound",
    SYSTEM_NOT_FOUND_WARNING_SHOWN: "systemNotFoundWarningShown",
    SYSTEM_VERSION: "systemVersion",

    GET_DEFAULT() {
        return foundry.utils.deepClone(SETTINGS.DEFAULTS());
    },

    GET_SYSTEM_DEFAULTS() {
        return Object.fromEntries(
            Object.entries(SETTINGS.GET_DEFAULT()).filter((entry) => {
                return entry[1].system;
            }),
        );
    },

    DEFAULTS: () => ({

        // SYSTEM SETTINGS CLIENT

        [SETTINGS.ACTOR_CURRENCY_ATTRIBUTE]: {
            name: `Actor Currency attribute`,
            hint: `Reference path to the actor currency attribute`,
            scope: "world",
            config: false,
            system: true,
            default: SYSTEMS.DATA.ACTOR_CURRENCY_ATTRIBUTE,
            type: String,
        },

        // SYSTEM SETTINGS HIDDEN

        [SETTINGS.SYSTEM_VERSION]: {
            scope: "world",
            config: false,
            default: "0.0.0",
            type: String,
        },

        [SETTINGS.SYSTEM_FOUND]: {
            scope: "world",
            config: false,
            default: false,
            type: Boolean,
        },

        [SETTINGS.SYSTEM_NOT_FOUND_WARNING_SHOWN]: {
            scope: "world",
            config: false,
            default: false,
            type: Boolean,
        },

        // WORLD SETTINGS

        [SETTINGS.WS_RELAY_URL]: {
            name: "WebSocket Relay URL",
            hint: "URL for the WebSocket relay server",
            scope: "world",
            config: true,
            type: String,
            default: "wss://foundryvtt-rest-api-relay.fly.dev",
            requiresReload: true
        },

        [SETTINGS.API_KEY]: {
            name: "API Key",
            hint: "API Key for authentication with the relay server",
            scope: "world",
            config: true,
            type: String,
            default: game.world.id,
            requiresReload: true
        },

        [SETTINGS.CUSTOM_NAME]: {
            name: "Custom Client Name",
            hint: "A custom name to identify this client (optional)",
            scope: "world",
            config: true,
            type: String,
            default: "",
            requiresReload: true
        },

        [SETTINGS.LOG_LEVEL]: {
            name: "Log Level",
            hint: "Set the level of detail for module logging",
            scope: "world",
            config: true,
            type: Number,
            choices: {
                0: "debug",
                1: "info",
                2: "warn",
                3: "error"
            },
            default: 2
        },

        [SETTINGS.PING_INTERVAL]: {
            name: "Ping Interval (seconds)",
            hint: "How often (in seconds) the module sends a ping to the relay server to keep the connection alive.",
            scope: "world",
            config: true,
            type: Number,
            default: 30,
            range: {
              min: 5,
              max: 600,
              step: 1
            },
            requiresReload: true
        },

        [SETTINGS.RECONNECT_MAX_ATTEMPTS]: {
            name: "Max Reconnect Attempts",
            hint: "Maximum number of times the module will try to reconnect after losing connection.",
            scope: "world",
            config: true,
            type: Number,
            default: 20,
            requiresReload: true
        },

        [SETTINGS.RECONNECT_BASE_DELAY]: {
            name: "Reconnect Base Delay (ms)",
            hint: "Initial delay (in milliseconds) before the first reconnect attempt. Subsequent attempts use exponential backoff.",
            scope: "world",
            config: true,
            type: Number,
            default: 1000,
            requiresReload: true
        }
    })
};