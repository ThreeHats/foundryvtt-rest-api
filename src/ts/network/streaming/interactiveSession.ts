/**
 * Interactive session manager for the Foundry module side.
 * Manages interactive sessions: keeps sheets rendered, observes mutations,
 * captures frames via html-to-image, and dispatches input events.
 */
import { toJpeg } from "html-to-image";
import { ModuleLogger } from "../../utils/logger";
import { renderAndWaitForElement, closeSheet, getSheetElement } from "../../utils/sheetCompat";
import { dispatchInput } from "./inputDispatcher";
import { inlineDocumentStyles } from "../../utils/inlineStyles";

export interface ActiveInteractiveSession {
    sessionId: string;
    sheet: any; // ActorSheet
    sheetElement: HTMLElement;
    observer: MutationObserver;
    quality: number;
    scale: number;
    state: 'preparing' | 'active' | 'closing';
    frameThrottle: number;       // min ms between mutation-triggered frames
    lastFrameTime: number;
    pendingFrame: boolean;       // dirty flag from MutationObserver
    throttleTimer: ReturnType<typeof setTimeout> | null;
    capturing: boolean;          // true while a capture is in flight
    inputDebounceTimer: ReturnType<typeof setTimeout> | null;
    inputDebounceResolvers: Array<(frame: { imageData: string; width: number; height: number } | null) => void>;
    cleanupStyles: (() => void) | null;
}

const activeSessions = new Map<string, ActiveInteractiveSession>();

/**
 * Compute the full bounding box of an element including all descendants.
 * getBoundingClientRect() on the parent doesn't include absolutely
 * positioned children (like tabs at left:100%).
 */
export function getFullBoundingBox(el: HTMLElement): { width: number; height: number } {
    const parentRect = el.getBoundingClientRect();
    let minX = parentRect.left;
    let minY = parentRect.top;
    let maxX = parentRect.right;
    let maxY = parentRect.bottom;

    const all = el.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
        const child = all[i] as HTMLElement;
        if (!child.getBoundingClientRect) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > maxX) maxX = rect.right;
        if (rect.bottom > maxY) maxY = rect.bottom;
    }

    return {
        width: maxX - minX,
        height: maxY - minY,
    };
}

/**
 * Wait for any in-flight capture to finish (polls every 50ms, max 5s).
 */
async function waitForCapture(session: ActiveInteractiveSession, maxWaitMs = 5000): Promise<void> {
    const start = Date.now();
    while (session.capturing && Date.now() - start < maxWaitMs) {
        await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
}

/**
 * Capture a frame from the sheet element.
 * If skipIfBusy is true, returns null when a capture is in flight (for mutation frames).
 * Otherwise waits for the in-flight capture to finish first (for input frames).
 */
export async function captureFrame(session: ActiveInteractiveSession, skipIfBusy = false): Promise<{
    imageData: string;
    width: number;
    height: number;
} | null> {
    if (session.capturing) {
        if (skipIfBusy) return null;
        await waitForCapture(session);
    }
    session.capturing = true;

    try {
        // Re-acquire element — Foundry v13 re-renders may replace the DOM node
        const currentEl = getSheetElement(session.sheet);
        if (currentEl && currentEl !== session.sheetElement) {
            // Element was replaced by a re-render — update reference and re-apply styles
            session.sheetElement = currentEl;
            currentEl.style.position = 'absolute';
            currentEl.style.top = '0';
            currentEl.style.left = '0';
            currentEl.style.overflow = 'visible';
            currentEl.style.width = 'auto';
            currentEl.style.height = 'auto';
            currentEl.style.maxWidth = 'none';
            currentEl.style.maxHeight = 'none';
            currentEl.style.transform = 'none';

            // Re-attach MutationObserver to new element
            session.observer.disconnect();
            session.observer.observe(currentEl, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            // Re-inline document styles into the new element
            if (session.cleanupStyles) session.cleanupStyles();
            session.cleanupStyles = await inlineDocumentStyles(currentEl);

            // Let styles settle after re-render
            await new Promise<void>(r => setTimeout(r, 50));
        }

        const el = session.sheetElement;
        const fullBox = getFullBoundingBox(el);
        const captureWidth = Math.max(el.offsetWidth, el.scrollWidth, fullBox.width);
        const captureHeight = Math.max(el.offsetHeight, el.scrollHeight, fullBox.height);

        const imageData = await toJpeg(el, {
            quality: session.quality,
            pixelRatio: session.scale,
            cacheBust: true,
            width: captureWidth,
            height: captureHeight,
        });

        return {
            imageData,
            width: Math.round(captureWidth * session.scale),
            height: Math.round(captureHeight * session.scale),
        };
    } finally {
        session.capturing = false;
    }
}

/**
 * Start an interactive sheet session.
 */
export async function startSession(
    sessionId: string,
    actor: any,
    options: { quality?: number; scale?: number; subscribeMutations?: boolean },
    sendMessage: (msg: any) => void
): Promise<{ imageData: string; width: number; height: number } | null> {
    if (activeSessions.has(sessionId)) {
        ModuleLogger.warn(`Session ${sessionId} already exists`);
        return null;
    }

    const quality = options.quality ?? 0.7;
    const scale = options.scale ?? 1;

    const sheet = actor.sheet;
    if (!sheet) {
        throw new Error("Actor has no sheet");
    }

    const element = await renderAndWaitForElement(sheet);

    // Keep the sheet visible at a known position.
    // This avoids flashing from position toggling and ensures the DOM layout
    // always matches the captured image for coordinate mapping.
    element.style.position = 'absolute';
    element.style.top = '0';
    element.style.left = '0';
    element.style.overflow = 'visible';
    element.style.width = 'auto';
    element.style.height = 'auto';
    element.style.maxWidth = 'none';
    element.style.maxHeight = 'none';
    element.style.transform = 'none';

    // Inline document stylesheets into the element so html-to-image
    // can capture font icons and system styles (it can't fetch relative URLs)
    const cleanupStyles = await inlineDocumentStyles(element);

    const session: ActiveInteractiveSession = {
        sessionId,
        sheet,
        sheetElement: element,
        observer: null as any,
        quality,
        scale,
        state: 'preparing',
        frameThrottle: 1000, // Max ~1fps for mutation-triggered frames
        lastFrameTime: 0,
        pendingFrame: false,
        throttleTimer: null,
        capturing: false,
        inputDebounceTimer: null,
        inputDebounceResolvers: [],
        cleanupStyles,
    };

    // Only set up MutationObserver if the consumer opted in to mutation frames.
    // Without this, frames are only sent in response to explicit interactive-input messages.
    let observer: MutationObserver;
    if (options.subscribeMutations) {
        observer = new MutationObserver(() => {
            if (session.state !== 'active') return;
            if (session.inputDebounceTimer) return;

            session.pendingFrame = true;

            if (session.throttleTimer) return;

            const now = Date.now();
            const timeSinceLast = now - session.lastFrameTime;
            const delay = Math.max(0, session.frameThrottle - timeSinceLast);

            session.throttleTimer = setTimeout(async () => {
                session.throttleTimer = null;
                if (!session.pendingFrame || session.state !== 'active') return;
                if (session.inputDebounceTimer) return;
                session.pendingFrame = false;

                try {
                    const frame = await captureFrame(session, true);
                    if (!frame) return;
                    session.lastFrameTime = Date.now();
                    sendMessage({
                        type: "interactive-frame",
                        sessionId,
                        imageData: frame.imageData,
                        mimeType: 'image/jpeg',
                        width: frame.width,
                        height: frame.height,
                        trigger: 'mutation',
                    });
                } catch (err) {
                    ModuleLogger.error(`Error capturing mutation frame for session ${sessionId}:`, err);
                }
            }, delay);
        });

        observer.observe(element, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });
    } else {
        // No-op observer — nothing to observe, nothing to disconnect
        observer = new MutationObserver(() => {});
    }

    session.observer = observer;

    // Capture initial frame
    const initialFrame = await captureFrame(session);
    if (!initialFrame) {
        throw new Error("Failed to capture initial frame");
    }
    session.lastFrameTime = Date.now();
    session.state = 'active';

    activeSessions.set(sessionId, session);

    ModuleLogger.info(`Interactive session ${sessionId} started: ${initialFrame.width}x${initialFrame.height}`);
    return initialFrame;
}

/**
 * Handle input for an active session and return a new frame.
 * Debounces captures — rapid inputs share one capture taken 300ms after
 * the last input settles, giving transitions time to complete.
 */
export async function handleInput(
    sessionId: string,
    inputData: any
): Promise<{ imageData: string; width: number; height: number } | null> {
    const session = activeSessions.get(sessionId);
    if (!session || session.state !== 'active') {
        return null;
    }

    // Dispatch the input event — await async actions (e.g. changeTab re-render)
    await dispatchInput(session.sheetElement, inputData, session.sheet);

    // Debounce the capture — 100ms for responsiveness.
    // Async actions like changeTab already awaited above,
    // so the DOM should be ready.
    return new Promise(resolve => {
        session.inputDebounceResolvers.push(resolve);

        if (session.inputDebounceTimer) {
            clearTimeout(session.inputDebounceTimer);
        }

        session.inputDebounceTimer = setTimeout(async () => {
            session.inputDebounceTimer = null;
            const resolvers = session.inputDebounceResolvers.splice(0);

            const frame = await captureFrame(session);
            if (frame) {
                session.lastFrameTime = Date.now();
                session.pendingFrame = false;
            }

            for (const r of resolvers) {
                r(frame);
            }
        }, 100);
    });
}

/**
 * End an active session.
 */
export function endSession(sessionId: string): boolean {
    const session = activeSessions.get(sessionId);
    if (!session) return false;

    session.state = 'closing';

    if (session.throttleTimer) {
        clearTimeout(session.throttleTimer);
        session.throttleTimer = null;
    }
    if (session.inputDebounceTimer) {
        clearTimeout(session.inputDebounceTimer);
        session.inputDebounceTimer = null;
        for (const r of session.inputDebounceResolvers) r(null);
        session.inputDebounceResolvers = [];
    }

    session.observer.disconnect();
    if (session.cleanupStyles) session.cleanupStyles();
    closeSheet(session.sheet);

    activeSessions.delete(sessionId);
    ModuleLogger.info(`Interactive session ${sessionId} ended`);
    return true;
}

/**
 * Get an active session by ID.
 */
export function getSession(sessionId: string): ActiveInteractiveSession | undefined {
    return activeSessions.get(sessionId);
}

/**
 * Find an active session that has a given sheet open.
 * Used by the screenshot router to reuse an existing session's element
 * instead of rendering/repositioning a new sheet.
 */
export function getSessionForSheet(sheet: any): ActiveInteractiveSession | undefined {
    for (const session of activeSessions.values()) {
        if (session.sheet === sheet && session.state === 'active') {
            return session;
        }
    }
    return undefined;
}

/**
 * End all active sessions (e.g., on disconnect).
 */
export function endAllSessions(): void {
    for (const sessionId of activeSessions.keys()) {
        endSession(sessionId);
    }
}
