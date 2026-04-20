import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser } from "../../utils/permissions";

export const router = new Router("sceneImageRouter");

// Mutex for screenshot capture — only one can run at a time since it manipulates the canvas view
let screenshotLock: Promise<void> = Promise.resolve();

function withScreenshotLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const prev = screenshotLock;
    screenshotLock = new Promise(r => { resolve = r; });
    return prev.then(fn).finally(() => resolve!());
}

/**
 * Resolve a scene by ID, or fall back based on current state.
 * @param sceneId - Explicit scene ID to look up
 * @param active - If true, only return the player-facing active scene
 */
function resolveSceneForImage(sceneId?: string, active?: boolean): any {
    if (sceneId) {
        const scene = game.scenes?.get(sceneId);
        if (!scene) throw new Error(`Scene not found: ${sceneId}`);
        return scene;
    }

    if (active) {
        const scene = game.scenes?.active;
        if (!scene) throw new Error("No active scene");
        return scene;
    }

    // Default: try viewed → active → canvas scene
    const scene = (game.scenes as any)?.viewed
        ?? game.scenes?.active
        ?? (canvas as any)?.scene;
    if (!scene) throw new Error("No active scene");
    return scene;
}

// Capture a screenshot of the full rendered scene canvas
router.addRoute({
    actionType: "scene-screenshot",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received scene-screenshot request:`, data);

        await withScreenshotLock(async () => {
        try {
            const { shouldReturn } = resolveRequestUser(data, socketManager, "scene-screenshot-result");
            if (shouldReturn) return;

            const { sceneId, active, format, quality, showGrid, hideOverlays, viewport, width: reqWidth, height: reqHeight } = data;

            const scene = resolveSceneForImage(sceneId, active);

            // The canvas must be showing this scene
            if (canvas?.scene?.id !== scene.id) {
                throw new Error(`Scene '${scene.name}' is not the currently viewed scene. Switch to it first.`);
            }

            const fmt = format || "png";
            const qual = quality ?? 0.9;

            const c = canvas as any;
            const renderer = c.app?.renderer;
            if (!renderer) throw new Error("Canvas renderer not available");

            const stage = c.app?.stage;
            if (!stage) throw new Error("Canvas stage not available");

            const canvasStage = c.stage;

            // Save state for restoration
            const saved = {
                pivotX: canvasStage.pivot.x, pivotY: canvasStage.pivot.y,
                scaleX: canvasStage.scale.x, scaleY: canvasStage.scale.y,
                posX: canvasStage.position.x, posY: canvasStage.position.y,
            };

            // Temporarily hide overlays if requested
            const hiddenLayers: { obj: any; prev: boolean }[] = [];
            const hideLayer = (obj: any) => {
                if (obj && obj.visible !== undefined) {
                    hiddenLayers.push({ obj, prev: obj.visible });
                    obj.visible = false;
                }
            };

            if (hideOverlays) {
                hideLayer(c.visibility);
                hideLayer(c.fog);
                hideLayer(c.weather);
                hideLayer(c.effects);
                hideLayer(c.controls);
                hideLayer(c.hud);
                if (!showGrid) {
                    hideLayer(c.interface);
                    hideLayer(c.grid);
                }
            }

            const screenW = renderer.width;
            const screenH = renderer.height;

            let imageData: string;
            let outWidth: number;
            let outHeight: number;

            if (viewport) {
                // ── Viewport mode: capture exactly what the browser currently shows ──
                renderer.render(stage);
                if (!renderer.extract) throw new Error("PixiJS extract plugin not available");
                const viewCanvas = renderer.extract.canvas();
                outWidth = viewCanvas.width;
                outHeight = viewCanvas.height;
                imageData = fmt === "jpeg"
                    ? viewCanvas.toDataURL("image/jpeg", qual)
                    : viewCanvas.toDataURL("image/png");

            } else {
                // ── Full scene mode: tiled capture at native resolution ──
                const d = scene.dimensions;
                const sceneRect = d.sceneRect ?? d.rect ?? {
                    x: d.sceneX ?? 0,
                    y: d.sceneY ?? 0,
                    width: d.sceneWidth ?? d.width ?? 1000,
                    height: d.sceneHeight ?? d.height ?? 1000,
                };

                // Output size (default = full scene resolution)
                outWidth = reqWidth || sceneRect.width;
                outHeight = reqHeight || sceneRect.height;

                // At scale=1, each tile covers screenW x screenH scene pixels.
                // We pan across the scene capturing tiles and stitch them together.
                const tileW = screenW;
                const tileH = screenH;
                const cols = Math.ceil(sceneRect.width / tileW);
                const rows = Math.ceil(sceneRect.height / tileH);

                ModuleLogger.info(`Screenshot: renderer=${screenW}x${screenH}, scene=${sceneRect.width}x${sceneRect.height}, tiles=${cols}x${rows}=${cols * rows}`);

                if (!renderer.extract) throw new Error("PixiJS extract plugin not available");

                // Create output canvas at full scene resolution
                const stitchCanvas = document.createElement("canvas");
                stitchCanvas.width = sceneRect.width;
                stitchCanvas.height = sceneRect.height;
                const stitchCtx = stitchCanvas.getContext("2d")!;

                for (let row = 0; row < rows; row++) {
                    for (let col = 0; col < cols; col++) {
                        // Center of this tile in scene coordinates
                        const tileCenterX = sceneRect.x + col * tileW + tileW / 2;
                        const tileCenterY = sceneRect.y + row * tileH + tileH / 2;

                        c.pan({ x: tileCenterX, y: tileCenterY, scale: 1 });
                        // Let fog/visibility settle
                        await new Promise(resolve => setTimeout(resolve, 50));
                        renderer.render(stage);

                        const tileCanvas = renderer.extract.canvas();

                        // Place this tile on the output canvas
                        const destX = col * tileW;
                        const destY = row * tileH;
                        stitchCtx.drawImage(tileCanvas, 0, 0, tileW, tileH, destX, destY, tileW, tileH);
                    }
                }

                // If requested size differs from scene size, crop from center
                if (outWidth !== sceneRect.width || outHeight !== sceneRect.height) {
                    const cropX = Math.round((sceneRect.width - outWidth) / 2);
                    const cropY = Math.round((sceneRect.height - outHeight) / 2);
                    const cropCanvas = document.createElement("canvas");
                    cropCanvas.width = outWidth;
                    cropCanvas.height = outHeight;
                    const cropCtx = cropCanvas.getContext("2d")!;
                    cropCtx.drawImage(stitchCanvas, cropX, cropY, outWidth, outHeight, 0, 0, outWidth, outHeight);

                    imageData = fmt === "jpeg"
                        ? cropCanvas.toDataURL("image/jpeg", qual)
                        : cropCanvas.toDataURL("image/png");
                } else {
                    imageData = fmt === "jpeg"
                        ? stitchCanvas.toDataURL("image/jpeg", qual)
                        : stitchCanvas.toDataURL("image/png");
                }

                // Restore original view
                c.pan({ x: saved.pivotX, y: saved.pivotY, scale: saved.scaleX });
            }

            for (const { obj, prev } of hiddenLayers) {
                obj.visible = prev;
            }

            const mimeType = fmt === "jpeg" ? "image/jpeg" : "image/png";

            socketManager?.send({
                type: "scene-screenshot-result",
                requestId: data.requestId,
                imageData,
                mimeType,
                width: outWidth,
                height: outHeight,
            });
        } catch (error) {
            ModuleLogger.error(`Error in scene-screenshot:`, error);
            socketManager?.send({
                type: "scene-screenshot-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
        }); // end withScreenshotLock
    }
});

// Get the raw background image of a scene
router.addRoute({
    actionType: "scene-raw-image",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received scene-raw-image request:`, data);

        try {
            const { shouldReturn } = resolveRequestUser(data, socketManager, "scene-raw-image-result");
            if (shouldReturn) return;

            const { sceneId, active } = data;

            const scene = resolveSceneForImage(sceneId, active);

            const backgroundSrc = scene.background?.src || scene.img || null;
            if (!backgroundSrc) {
                throw new Error(`Scene '${scene.name}' has no background image`);
            }

            // Fetch the image and convert to base64
            try {
                const response = await fetch(backgroundSrc);
                const blob = await response.blob();
                const reader = new FileReader();
                const base64 = await new Promise<string>((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });

                socketManager?.send({
                    type: "scene-raw-image-result",
                    requestId: data.requestId,
                    data: {
                        sceneId: scene.id,
                        sceneName: scene.name,
                        src: backgroundSrc,
                        imageData: base64,
                        mimeType: blob.type,
                    },
                });
            } catch (fetchError) {
                // If fetch fails, just return the path
                socketManager?.send({
                    type: "scene-raw-image-result",
                    requestId: data.requestId,
                    data: {
                        sceneId: scene.id,
                        sceneName: scene.name,
                        src: backgroundSrc,
                    },
                });
            }
        } catch (error) {
            ModuleLogger.error(`Error in scene-raw-image:`, error);
            socketManager?.send({
                type: "scene-raw-image-result",
                requestId: data.requestId,
                error: (error as Error).message,
            });
        }
    }
});
