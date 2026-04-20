import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, assertGM } from "../../utils/permissions";

export const router = new Router("playlistRouter");

function resolvePlaylist(data: any): any {
    const { playlistId, playlistName } = data;
    if (!playlistId && !playlistName) throw new Error("playlistId or playlistName is required");

    let playlist: any = null;
    if (playlistId) {
        playlist = game.playlists?.get(playlistId);
    } else if (playlistName) {
        playlist = game.playlists?.find((p: any) => p.name.toLowerCase() === playlistName.toLowerCase());
    }
    if (!playlist) throw new Error(`Playlist not found: ${playlistId || playlistName}`);
    return playlist;
}

function resolveSound(playlist: any, data: any): any {
    const { soundId, soundName } = data;
    if (!soundId && !soundName) return null;

    let sound: any = null;
    if (soundId) {
        sound = playlist.sounds.get(soundId);
    } else if (soundName) {
        sound = playlist.sounds.find((s: any) => s.name.toLowerCase() === soundName.toLowerCase());
    }
    if (!sound) throw new Error(`Sound not found: ${soundId || soundName}`);
    return sound;
}

function serializePlaylist(playlist: any) {
    return {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description || "",
        playing: playlist.playing,
        mode: playlist.mode,
        fade: playlist.fade,
        folder: playlist.folder?.id || null,
        sorting: playlist.sorting,
        sounds: playlist.sounds?.map((s: any) => ({
            id: s.id,
            name: s.name,
            path: s.path,
            playing: s.playing,
            volume: s.volume,
            repeat: s.repeat,
            fade: s.fade,
        })) || [],
    };
}

// Get all playlists
router.addRoute({
    actionType: "get-playlists",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received get-playlists request`);

        try {
            const { shouldReturn } = resolveRequestUser(data, socketManager, "get-playlists-result");
            if (shouldReturn) return;

            const playlists = game.playlists?.contents.map(serializePlaylist) || [];

            socketManager?.send({
                type: "get-playlists-result",
                requestId: data.requestId,
                data: { playlists },
            });
        } catch (error) {
            ModuleLogger.error(`Error in get-playlists:`, error);
            socketManager?.send({
                type: "get-playlists-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Play a playlist or specific sound
router.addRoute({
    actionType: "playlist-play",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received playlist-play request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "playlist-play-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "control playlists");

            const playlist = resolvePlaylist(data);
            const sound = resolveSound(playlist, data);

            if (sound) {
                await playlist.playSound(sound);
            } else {
                await playlist.playAll();
            }

            socketManager?.send({
                type: "playlist-play-result",
                requestId: data.requestId,
                data: { playlist: serializePlaylist(playlist) },
            });
        } catch (error) {
            ModuleLogger.error(`Error in playlist-play:`, error);
            socketManager?.send({
                type: "playlist-play-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Stop a playlist
router.addRoute({
    actionType: "playlist-stop",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received playlist-stop request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "playlist-stop-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "control playlists");

            const playlist = resolvePlaylist(data);
            await playlist.stopAll();

            socketManager?.send({
                type: "playlist-stop-result",
                requestId: data.requestId,
                data: { playlist: serializePlaylist(playlist) },
            });
        } catch (error) {
            ModuleLogger.error(`Error in playlist-stop:`, error);
            socketManager?.send({
                type: "playlist-stop-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Skip to next track
router.addRoute({
    actionType: "playlist-next",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received playlist-next request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "playlist-next-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "control playlists");

            const playlist = resolvePlaylist(data);
            await playlist.playNext(undefined, { direction: 1 });

            socketManager?.send({
                type: "playlist-next-result",
                requestId: data.requestId,
                data: { playlist: serializePlaylist(playlist) },
            });
        } catch (error) {
            ModuleLogger.error(`Error in playlist-next:`, error);
            socketManager?.send({
                type: "playlist-next-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Set volume
router.addRoute({
    actionType: "playlist-volume",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received playlist-volume request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "playlist-volume-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "control playlists");

            const playlist = resolvePlaylist(data);
            const sound = resolveSound(playlist, data);
            const volume = data.volume;

            if (typeof volume !== 'number' || volume < 0 || volume > 1) {
                throw new Error("volume must be a number between 0 and 1");
            }

            if (sound) {
                await sound.update({ volume });
            } else {
                // Update the playlist's master volume rather than each PlaylistSound individually.
                // Updating PlaylistSound documents triggers PlaylistSound#_createSound, which
                // requires the AudioContext to be unlocked — this fails in headless environments.
                await playlist.update({ volume });
            }

            socketManager?.send({
                type: "playlist-volume-result",
                requestId: data.requestId,
                data: { playlist: serializePlaylist(playlist) },
            });
        } catch (error) {
            ModuleLogger.error(`Error in playlist-volume:`, error);
            socketManager?.send({
                type: "playlist-volume-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Stop a playing sound
router.addRoute({
    actionType: "stop-sound",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received stop-sound request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "stop-sound-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "stop sounds");

            const { src } = data;
            const playing = (game as any).audio.playing;
            let stopped = 0;

            for (const sound of playing.values()) {
                if (!src || sound.src === src) {
                    sound.stop();
                    stopped++;
                }
            }

            socketManager?.send({
                type: "stop-sound-result",
                requestId: data.requestId,
                data: { stopped, src: src || null },
            });
        } catch (error) {
            ModuleLogger.error(`Error in stop-sound:`, error);
            socketManager?.send({
                type: "stop-sound-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});

// Play a one-shot sound effect
router.addRoute({
    actionType: "play-sound",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received play-sound request:`, data);

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "play-sound-result");
            if (shouldReturn) return;

            if (user) assertGM(user, "play sounds");

            const { src, volume, loop } = data;
            if (!src) throw new Error("src is required");

            // push=true broadcasts to all connected clients via Foundry's socket;
            // don't await local playback (it hangs in headless and doesn't matter there)
            (foundry as any).audio.AudioHelper.play({
                src,
                volume: volume ?? 0.5,
                loop: loop ?? false,
            }, true);

            socketManager?.send({
                type: "play-sound-result",
                requestId: data.requestId,
                data: { src, volume: volume ?? 0.5, loop: loop ?? false },
            });
        } catch (error) {
            ModuleLogger.error(`Error in play-sound:`, error);
            socketManager?.send({
                type: "play-sound-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});
