// ↓ IMPORT SYSTEMS HERE ↓
// import {dnd4e} from "./systems/dnd4e";
import {dnd5e} from "./systems/dnd5e";
// import {pf1} from "./systems/pf1";
// import {pf2e} from "./systems/pf2e";
// import {ds4} from "./systems/ds4";
// import {d35e} from "./systems/d35e";
// import {sfrpg} from "./systems/sfrpg";
// import {swade} from "./systems/swade";
// import {tormenta20} from "./systems/tormenta20";
// import {wfrp4e} from "./systems/wfrp4e";
// import {splittermond} from "./systems/splittermond";
// import {forbiddenLands} from "./systems/forbidden-lands";
// import {icrpg} from "./systems/icrpg";
// import {swse} from "./systems/swse";
// import {sw5e} from "./systems/sw5e";
// import {sw5e203} from "./systems/sw5e-2.0.3.2.3.8";
// import {fallout} from "./systems/fallout";
// import {cyberpunkRedCore} from "./systems/cyberpunk-red-core";
// import {knave} from "./systems/knave";
// import {t2k4e} from "./systems/t2k4e";
// import {yzecoriolis} from "./systems/yzecoriolis";
// import {kamigakari} from "./systems/kamigakari";
// import {symbaroum} from "./systems/symbaroum";
// import {wwn} from "./systems/wwn";
// import {cyphersystem} from "./systems/cyphersystem";
// import {ptu} from "./systems/ptu";
// import {dcc} from "./systems/dcc";
import {a5e} from "./systems/a5e";
// import {darkHeresy2e} from "./systems/dark-heresy";
// import {naheulbeuk} from "./systems/naheulbeuk";
// import {icrpgme} from "./systems/icrpgme";
// import {bladeRunner} from "./systems/blade-runner";
// import {alienrpg} from "./systems/alienrpg";
// import {pirateborg} from "./systems/pirateborg";
// import {starwarsffg} from "./systems/starwarsffg";
// ↑ IMPORT SYSTEMS HERE ↑

/**
 * NOTE: YOUR PULL REQUEST WILL NOT BE ACCEPTED IF YOU DO NOT
 * FOLLOW THE CONVENTION IN THE D&D 5E SYSTEM FILE
 */
export const SYSTEMS = {
    SUPPORTED_SYSTEMS:<any>{
        // ↓ ADD SYSTEMS HERE ↓
        // "alienrpg": {
        //   "latest": alienrpg
        // },
        // "dnd4e": {
        //   "latest": dnd4e
        // },
        dnd5e: {
            latest: dnd5e,
        },
        // "pf1": {
        //   "latest": pf1
        // },
        // "pf2e": {
        //   "latest": pf2e
        // },
        // "ds4": {
        //   "latest": ds4
        // },
        // "d35e": {
        //   "latest": d35e
        // },
        // "blade-runner": {
        //   "latest": bladeRunner
        // },
        // "sfrpg": {
        //   "latest": sfrpg
        // },
        // "swade": {
        //   "latest": swade
        // },
        // "tormenta20": {
        //   "latest": tormenta20
        // },
        // "wfrp4e": {
        //   "latest": wfrp4e
        // },
        // "splittermond": {
        //   "latest": splittermond
        // },
        // "forbidden-lands": {
        //   "latest": forbiddenLands
        // },
        // "icrpg": {
        //   "latest": icrpg
        // },
        // "icrpgme": {
        //   "latest": icrpgme
        // },
        // "swse": {
        //   "latest": swse
        // },
        // "sw5e": {
        //   "latest": sw5e,
        //   "2.0.3.2.3.8": sw5e203
        // },
        // "fallout": {
        //   "latest": fallout
        // },
        // "cyberpunk-red-core": {
        //   "latest": cyberpunkRedCore
        // },
        // "knave": {
        //   "latest": knave
        // },
        // "t2k4e": {
        //   "latest": t2k4e
        // },
        // "yzecoriolis": {
        //   "latest": yzecoriolis
        // },
        // "kamigakari": {
        //   "latest": kamigakari
        // },
        // "wwn": {
        //   "latest": wwn
        // },
        // "symbaroum": {
        //   "latest": symbaroum
        // },
        // "cyphersystem": {
        //   "latest": cyphersystem
        // },
        // "ptu": {
        //   "latest": ptu
        // },
        // "dcc": {
        //   "latest": dcc
        // },
        a5e: {
            latest: a5e,
        },
        // "dark-heresy": {
        //   "latest": darkHeresy2e
        // },
        // "naheulbeuk": {
        //   "latest": naheulbeuk
        // },
        // "pirateborg": {
        //   "latest": pirateborg
        // },
        // "starwarsffg": {
        //   "latest": starwarsffg
        // }
        // ↑ ADD SYSTEMS HERE ↑
    },

    DEFAULT_SETTINGS:<any>{
        ACTOR_CURRENCY_ATTRIBUTE: "",
    },

    get HAS_SYSTEM_SUPPORT() {
        return !!this.SUPPORTED_SYSTEMS?.[game.system.id.toLowerCase()];
    },

    _currentSystem:<any> false,

    get DATA() {
        if (this._currentSystem) return this._currentSystem;

        const system = this.SUPPORTED_SYSTEMS?.[game.system.id.toLowerCase()];
        if (!system) return this.DEFAULT_SETTINGS;

        // @ts-ignore
        if (system[game.system.version]) {
            // @ts-ignore
            this._currentSystem = foundry.utils.mergeObject(this.DEFAULT_SETTINGS, system[game.system.version]);
            return this._currentSystem;
        }

        const versions = Object.keys(system);
        if (versions.length === 1) {
            this._currentSystem = foundry.utils.mergeObject(this.DEFAULT_SETTINGS, system[versions[0]]);
            return this._currentSystem;
        }

        versions.sort((a, b) => {
            return a === "latest" || b === "latest" ? -Infinity : isNewerVersion(b, a) ? -1 : 1;
        });
        const version:any = versions.find((version) => {
            // @ts-ignore
            return version === "latest" || !isNewerVersion(game.system.version, version);
        });

        this._currentSystem = foundry.utils.mergeObject(this.DEFAULT_SETTINGS, system[version]);

        return this._currentSystem;
    },

    addSystem(data:any) {
        this.SUPPORTED_SYSTEMS[game.system.id.toLowerCase()] = { latest: data };
    },
}; 