import { CONSTANTS, SETTINGS } from "./constants";
import { SYSTEMS } from "./systems";
import { ModuleLogger } from "./utils/logger";



export async function applyDefaultSettings() {
    const settings = SETTINGS.GET_SYSTEM_DEFAULTS();
    for (const [name, data] of Object.entries(settings)) {
        await game.settings.set(CONSTANTS.MODULE_ID, name, data.default);
    }
    await game.settings.set(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_VERSION, SYSTEMS.DATA.VERSION);
}

// TODO TO PUT SOMEWHERE ???
export async function checkSystem() {
    if (!SYSTEMS.HAS_SYSTEM_SUPPORT) {
        if (game.settings.get(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_NOT_FOUND_WARNING_SHOWN)) return;

        let settingsValid = true;
        for (const [name, data] of Object.entries(SETTINGS.GET_DEFAULT())) {
            settingsValid =
                // @ts-ignore
                settingsValid && game.settings.get(CONSTANTS.MODULE_ID, name).length !== new data.type().length;
        }

        if (settingsValid) return;

        new Dialog({
            title: game.i18n.localize(`${CONSTANTS.MODULE_ID}.Dialog.systemfound.title`),
            content: ModuleLogger.warn(game.i18n.localize(`${CONSTANTS.MODULE_ID}.Dialog.systemfound.content`), true),
            buttons: {
                confirm: {
                    icon: '<i class="fas fa-check"></i>',
                    label: game.i18n.localize(`${CONSTANTS.MODULE_ID}.Dialog.systemfound.confirm`),
                    callback: () => {
                        applyDefaultSettings();
                    },
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("No"),
                },
            },
            default: "cancel",
        }).render(true);

        return game.settings.set(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_NOT_FOUND_WARNING_SHOWN, true);
    }

    if (game.settings.get(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_FOUND) || SYSTEMS.DATA.INTEGRATION) {
        const currentVersion:any = game.settings.get(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_VERSION);
        const newVersion:any = SYSTEMS.DATA.VERSION;
        ModuleLogger.debug(`Comparing system version - Current: ${currentVersion} - New: ${newVersion}`);
        if (foundry.utils.isNewerVersion(newVersion, currentVersion)) {
            // @ts-ignore
            ModuleLogger.debug(`Applying system settings for ${game.system.title}`);
            await applyDefaultSettings();
        }
        return;
    }

    await game.settings.set(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_FOUND, true);

    if (game.settings.get(CONSTANTS.MODULE_ID, SETTINGS.SYSTEM_NOT_FOUND_WARNING_SHOWN)) {
        ModuleLogger.warn(game.i18n.localize(`${CONSTANTS.MODULE_ID}.Dialog.nosystemfound.content`));
    }

    return;
} 