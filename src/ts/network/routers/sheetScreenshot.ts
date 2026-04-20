import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";
import { resolveRequestUser, hasPermission } from "../../utils/permissions";
import { renderAndWaitForElement, closeSheet, expandForCapture } from "../../utils/sheetCompat";
import { toPng, toJpeg } from "html-to-image";
import { getSessionForSheet, captureFrame, getFullBoundingBox } from "../streaming/interactiveSession";

export const router = new Router("sheetScreenshotRouter");

router.addRoute({
    actionType: "sheet-screenshot",
    handler: async (data, context) => {
        const socketManager = context?.socketManager;
        ModuleLogger.info(`Received sheet screenshot request for UUID: ${data.uuid}`);

        let sheet: any = null;
        let shouldCloseSheet = false;

        try {
            const { user, shouldReturn } = resolveRequestUser(data, socketManager, "sheet-screenshot-result");
            if (shouldReturn) return;

            let actor: Actor | TokenDocument | null = null;
            if (data.uuid) {
                actor = await fromUuid(data.uuid) as Actor;
            } else if (data.selected) {
                const controlledTokens = canvas?.tokens?.controlled;
                if (controlledTokens && controlledTokens.length > 0) {
                    if (data.actor) {
                        actor = controlledTokens[0].actor;
                    } else {
                        actor = controlledTokens[0].document;
                    }
                }
            }

            if (user && actor) {
                if (!hasPermission(actor, user, "OBSERVER")) {
                    socketManager?.send({
                        type: "sheet-screenshot-result",
                        requestId: data.requestId,
                        error: `User '${user.name}' does not have permission to view this sheet`,
                        success: false
                    });
                    return;
                }
            }

            if (!actor) {
                socketManager?.send({
                    type: "sheet-screenshot-result",
                    requestId: data.requestId,
                    error: "Entity not found",
                    success: false
                });
                return;
            }

            sheet = actor.sheet;
            if (!sheet) {
                socketManager?.send({
                    type: "sheet-screenshot-result",
                    requestId: data.requestId,
                    error: "Actor has no sheet",
                    success: false
                });
                return;
            }

            const scale = data.scale || 1;
            const quality = data.quality ?? 0.9;
            const useJpeg = data.format === 'jpeg';
            const mimeType = useJpeg ? 'image/jpeg' : 'image/png';

            // Check if an interactive session already has this sheet open.
            // If so, use its capture instead of rendering/moving a new sheet.
            const existingSession = getSessionForSheet(sheet);
            if (existingSession) {
                ModuleLogger.info(`Using existing interactive session for screenshot capture`);

                // Override quality/scale temporarily for this capture
                const savedQuality = existingSession.quality;
                const savedScale = existingSession.scale;
                existingSession.quality = quality;
                existingSession.scale = scale;

                const frame = await captureFrame(existingSession);

                existingSession.quality = savedQuality;
                existingSession.scale = savedScale;

                if (!frame) {
                    socketManager?.send({
                        type: "sheet-screenshot-result",
                        requestId: data.requestId,
                        error: "Failed to capture from active session",
                        success: false
                    });
                    return;
                }

                // Convert to requested format if PNG (captureFrame always returns JPEG)
                let imageData = frame.imageData;
                if (!useJpeg) {
                    // Re-capture as PNG from the session element
                    const el = existingSession.sheetElement;
                    const fullBox = getFullBoundingBox(el);
                    const captureWidth = Math.max(el.offsetWidth, el.scrollWidth, fullBox.width);
                    const captureHeight = Math.max(el.offsetHeight, el.scrollHeight, fullBox.height);
                    imageData = await toPng(el, {
                        pixelRatio: scale,
                        cacheBust: true,
                        width: captureWidth,
                        height: captureHeight,
                    });
                }

                socketManager?.send({
                    type: "sheet-screenshot-result",
                    requestId: data.requestId,
                    success: true,
                    imageData,
                    mimeType,
                    width: frame.width,
                    height: frame.height
                });
                return;
            }

            // No active session — render sheet ourselves
            const element = await renderAndWaitForElement(sheet);
            shouldCloseSheet = true;

            const restoreSize = expandForCapture(element);
            await new Promise<void>(resolve => setTimeout(resolve, 50));

            const fullBox = getFullBoundingBox(element);
            const captureWidth = Math.max(element.offsetWidth, element.scrollWidth, fullBox.width);
            const captureHeight = Math.max(element.offsetHeight, element.scrollHeight, fullBox.height);

            const captureOpts = {
                pixelRatio: scale,
                quality: useJpeg ? quality : undefined,
                cacheBust: true,
                width: captureWidth,
                height: captureHeight,
            };

            const imageData = useJpeg
                ? await toJpeg(element, captureOpts)
                : await toPng(element, captureOpts);

            restoreSize();

            const width = Math.round(captureWidth * scale);
            const height = Math.round(captureHeight * scale);

            closeSheet(sheet);
            shouldCloseSheet = false;

            socketManager?.send({
                type: "sheet-screenshot-result",
                requestId: data.requestId,
                success: true,
                imageData,
                mimeType,
                width,
                height
            });

            ModuleLogger.info(`Sent sheet screenshot: ${width}x${height}, ${mimeType}`);
        } catch (error) {
            ModuleLogger.error(`Error capturing sheet screenshot:`, error);
            if (shouldCloseSheet) closeSheet(sheet);
            socketManager?.send({
                type: "sheet-screenshot-result",
                requestId: data.requestId,
                error: "Failed to capture sheet screenshot",
                success: false
            });
        }
    }
});
