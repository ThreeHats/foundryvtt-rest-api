/**
 * Version-compatible sheet element helpers.
 * v12: sheet.element is jQuery, DOM at sheet.element[0]
 * v13+: sheet.element is native HTMLElement (ApplicationV2)
 */

/**
 * Get the DOM element from a sheet, handling v12 jQuery vs v13+ native element.
 */
export function getSheetElement(sheet: any): HTMLElement | null {
    if (!sheet?.element) return null;

    // v13+: element is already an HTMLElement
    if (sheet.element instanceof HTMLElement) {
        return sheet.element;
    }

    // v12: element is jQuery, get the underlying DOM element
    if (sheet.element[0] instanceof HTMLElement) {
        return sheet.element[0];
    }

    return null;
}

/**
 * Wait for layout to settle.
 * Uses setTimeout instead of requestAnimationFrame because browsers
 * suspend rAF in background tabs — and Foundry often runs in one.
 */
function waitForLayout(): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, 50));
}

/**
 * Wait for all images within an element to finish loading.
 */
function waitForImages(el: HTMLElement, timeoutMs = 2000): Promise<void> {
    const imgs = el.querySelectorAll('img');
    if (imgs.length === 0) return Promise.resolve();

    const promises = Array.from(imgs).map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise<void>(resolve => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
        });
    });

    return Promise.race([
        Promise.all(promises).then(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
}

/**
 * Render a sheet and wait until its DOM element is fully laid out.
 * v12: render(true) is sync, element is available after a short delay.
 * v13+: render(true) returns a Promise (ApplicationV2), await it then poll.
 *
 * @returns The fully rendered DOM element
 */
export async function renderAndWaitForElement(sheet: any, maxWaitMs = 3000): Promise<HTMLElement> {
    // Call render — in v13 this is a Promise, in v12 it returns the app synchronously
    const result = sheet.render(true);
    if (result instanceof Promise) {
        await result;
    }

    // Poll for the element to become available
    const start = Date.now();
    const interval = 100;
    let el: HTMLElement | null = null;
    while (Date.now() - start < maxWaitMs) {
        el = getSheetElement(sheet);
        if (el) break;
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    if (!el) {
        throw new Error("Sheet element did not become available after render");
    }

    // Wait for layout/paint to settle and images to load
    await waitForLayout();
    await waitForImages(el);
    // One more paint after images are done
    await waitForLayout();

    return el;
}

/**
 * Temporarily force an element to its full content size for accurate capture.
 * Returns a restore function that reverts the changes.
 *
 * v13 ApplicationV2 sets inline width/height/overflow on the sheet element,
 * which causes html-to-image to clip the capture. This removes those
 * constraints so the full content is visible for the screenshot.
 */
export function expandForCapture(el: HTMLElement): () => void {
    const saved = {
        overflow: el.style.overflow,
        width: el.style.width,
        height: el.style.height,
        maxWidth: el.style.maxWidth,
        maxHeight: el.style.maxHeight,
        position: el.style.position,
        left: el.style.left,
        top: el.style.top,
        transform: el.style.transform,
    };

    // Remove dimension constraints — let the element size to its content
    el.style.overflow = 'visible';
    el.style.width = 'auto';
    el.style.height = 'auto';
    el.style.maxWidth = 'none';
    el.style.maxHeight = 'none';

    // Reset positioning so the content renders at (0,0) in the capture.
    // Foundry's window manager sets left/top/transform on the element,
    // which causes html-to-image to render content offset within the canvas.
    el.style.position = 'static';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transform = 'none';

    return () => {
        el.style.overflow = saved.overflow;
        el.style.width = saved.width;
        el.style.height = saved.height;
        el.style.maxWidth = saved.maxWidth;
        el.style.maxHeight = saved.maxHeight;
        el.style.position = saved.position;
        el.style.left = saved.left;
        el.style.top = saved.top;
        el.style.transform = saved.transform;
    };
}

/**
 * Close a sheet in a version-safe manner.
 */
export function closeSheet(sheet: any): void {
    if (!sheet) return;

    try {
        if (typeof sheet.close === 'function') {
            sheet.close();
        }
    } catch (e) {
        // Ignore close errors
    }
}
