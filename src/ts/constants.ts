import { id } from "../module.json";
import { SYSTEMS } from "./systems";

export const CONSTANTS:any = {
    MODULE_ID: id
}


export const moduleId = id;

// Store the rolls made during this session
export const recentRolls: any[] = [];
export const MAX_ROLLS_STORED = 20; // Store up to 20 recent rolls

// User flag keys.
//
// FLAG_SKIP_SETUP_PROMPT is the only credential-adjacent value that stays as
// a per-user flag — it's just a UI preference (one GM can dismiss without
// hiding the prompt from other GMs). Per-user flags ARE broadcast to all
// connected clients in Foundry v13, so they can't hold secrets, but a
// "skip the prompt" preference being readable is harmless.
//
// The actual connection credentials moved to:
//   - SETTINGS.CLIENT_ID            world setting (non-secret pointer)
//   - SETTINGS.PAIRED_RELAY_URL     world setting (non-secret pointer)
//   - SETTINGS.CONNECTION_TOKEN     CLIENT-scope setting (browser localStorage,
//                                   per-GM, per-device — actually private)
//
// See `project_credential_architecture` memory for the full rationale: only
// `scope: "client"` Foundry settings hide data from non-GM players, verified
// against Foundry v13 source at client/helpers/client-settings.mjs:42-46.
export const FLAG_SKIP_SETUP_PROMPT = "skipSetupPrompt";

export const SETTINGS = {
    // Client settings
    ACTOR_CURRENCY_ATTRIBUTE: "actorCurrencyAttribute",
    WS_RELAY_URL: "wsRelayUrl",
    CUSTOM_NAME: "customName",
    LOG_LEVEL: "logLevel",
    PING_INTERVAL: "pingInterval",
    RECONNECT_MAX_ATTEMPTS: "reconnectMaxAttempts",
    RECONNECT_BASE_DELAY: "reconnectBaseDelay",

    // Connection state — split between world (non-secret pointers) and client
    // (browser localStorage, the only Foundry storage that doesn't broadcast).
    CLIENT_ID: "clientId",                // world scope, non-secret opaque ID
    PAIRED_RELAY_URL: "pairedRelayUrl",   // world scope, non-secret URL
    CONNECTION_TOKEN: "connectionToken",  // CLIENT scope, the actual secret

    // Security settings
    CODE_EXECUTION_PERMISSION: "codeExecutionPermission",
    ALLOW_EXECUTE_JS: "allowExecuteJs",
    ALLOW_MACRO_EXECUTE: "allowMacroExecute",
    ALLOW_MACRO_WRITE: "allowMacroWrite",
    NOTIFY_ON_EXECUTE_JS: "notifyOnExecuteJs",
    NOTIFY_ON_MACRO_EXECUTE: "notifyOnMacroExecute",

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
            config: false,  // Hidden — managed via Connection dialog
            type: String,
            default: "wss://foundryrestapi.com",
            requiresReload: true
        },

        // Connection credentials.
        // CLIENT_ID and PAIRED_RELAY_URL are world settings (shared across
        // all GMs in the world). They're non-secret pointers — players can
        // read them but learning the opaque clientId or relay URL doesn't
        // grant any access.
        [SETTINGS.CLIENT_ID]: {
            scope: "world",
            config: false,
            type: String,
            default: ""
        },

        [SETTINGS.PAIRED_RELAY_URL]: {
            scope: "world",
            config: false,
            type: String,
            default: ""
        },

        // CONNECTION_TOKEN is the ONLY actually-secret credential the module
        // holds. It must use scope: "client" — verified against Foundry v13
        // source (client/helpers/client-settings.mjs:42-46) as the only
        // storage that lives in browser localStorage and is never broadcast
        // to other connected clients.
        //
        // Per-browser, per-device. Each GM pairs each device once via the
        // Connection dialog. Players can NEVER read this value because it
        // doesn't exist in the world database at all.
        [SETTINGS.CONNECTION_TOKEN]: {
            scope: "client",
            config: false,
            type: String,
            default: ""
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
        },

        [SETTINGS.CODE_EXECUTION_PERMISSION]: {
            name: "Code Execution Permission Level",
            hint: "Minimum Foundry user role required to execute JavaScript via the API (1=Player, 2=Trusted, 3=Assistant GM, 4=GM)",
            scope: "world",
            config: true,
            type: Number,
            default: 4,
            choices: {
                1: "Player",
                2: "Trusted Player",
                3: "Assistant GM",
                4: "Game Master"
            }
        },

        // Execute-js / macro-execute gating (world-scoped)
        [SETTINGS.ALLOW_EXECUTE_JS]: {
            name: "Allow Execute JavaScript",
            hint: "Allow the REST API to execute arbitrary JavaScript via POST /execute-js. Enable only if you trust all API key holders.",
            scope: "world",
            config: true,
            type: Boolean,
            default: false
        },

        [SETTINGS.ALLOW_MACRO_EXECUTE]: {
            name: "Allow Macro Execution",
            hint: "Allow the REST API to run macros via POST /macro. Enable only if you trust all API key holders.",
            scope: "world",
            config: true,
            type: Boolean,
            default: false
        },

        [SETTINGS.ALLOW_MACRO_WRITE]: {
            name: "Allow Macro Creation/Editing",
            hint: "Allow the REST API to create, update, or delete macros. Disabled by default — malicious code could be planted for later execution. Enable only if you trust all API key holders.",
            scope: "world",
            config: true,
            type: Boolean,
            default: false
        },

        [SETTINGS.NOTIFY_ON_EXECUTE_JS]: {
            name: "Notify on Execute JS",
            hint: "Show an in-Foundry GM whisper each time the API runs execute-js. Disable if a trusted integration calls this frequently and the notifications are noise. Discord/email notifications are controlled separately on the relay.",
            scope: "world",
            config: true,
            type: Boolean,
            default: true
        },

        [SETTINGS.NOTIFY_ON_MACRO_EXECUTE]: {
            name: "Notify on Macro Execute",
            hint: "Show an in-Foundry GM whisper each time the API runs a macro. Disable if a trusted integration calls this frequently. Discord/email notifications are controlled separately on the relay.",
            scope: "world",
            config: true,
            type: Boolean,
            default: true
        },

    })
};