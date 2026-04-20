/**
 * Input dispatcher for interactive sheet sessions.
 * Maps consumer input events to synthetic DOM events on the sheet element.
 */

interface InputData {
    action: string;
    x?: number;
    y?: number;
    button?: number;
    deltaX?: number;
    deltaY?: number;
    key?: string;
    code?: string;
    modifiers?: {
        shift?: boolean;
        ctrl?: boolean;
        alt?: boolean;
        meta?: boolean;
    };
}

/**
 * Find the deepest element at given (x, y) coordinates relative to the sheet container.
 * Uses getBoundingClientRect() which works for offscreen elements.
 */
function findElementAtPoint(container: HTMLElement, x: number, y: number): HTMLElement {
    const containerRect = container.getBoundingClientRect();
    const absX = containerRect.left + x;
    const absY = containerRect.top + y;

    function walkChildren(el: HTMLElement): HTMLElement {
        const children = el.children;
        // Walk backwards so elements rendered on top are checked first
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i] as HTMLElement;
            if (!child.getBoundingClientRect) continue;

            const rect = child.getBoundingClientRect();
            if (absX >= rect.left && absX <= rect.right && absY >= rect.top && absY <= rect.bottom) {
                // Check deeper
                return walkChildren(child);
            }
        }
        return el;
    }

    return walkChildren(container);
}

function buildModifiers(modifiers?: InputData['modifiers']) {
    return {
        shiftKey: modifiers?.shift ?? false,
        ctrlKey: modifiers?.ctrl ?? false,
        altKey: modifiers?.alt ?? false,
        metaKey: modifiers?.meta ?? false,
    };
}

/**
 * Try to handle Foundry v13 ApplicationV2 data-action elements directly.
 * These don't respond to synthetic events because ApplicationV2 binds
 * action handlers internally. Returns true if handled.
 */
/**
 * Find a [data-action] element at (x, y) by checking all action elements' rects.
 * This handles absolutely-positioned elements (like vertical tabs at left:100%)
 * that findElementAtPoint misses because they're outside the parent's content box.
 */
async function tryHandleActionByCoords(sheetElement: HTMLElement, x: number, y: number, sheet?: any): Promise<boolean> {
    const containerRect = sheetElement.getBoundingClientRect();
    const absX = containerRect.left + x;
    const absY = containerRect.top + y;

    const actionEls = sheetElement.querySelectorAll('[data-action]');
    for (let i = actionEls.length - 1; i >= 0; i--) {
        const el = actionEls[i] as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (absX >= rect.left && absX <= rect.right && absY >= rect.top && absY <= rect.bottom) {
            return handleActionElement(el, sheetElement, sheet);
        }
    }
    return false;
}

/**
 * Handle a [data-action] element. Awaits async actions like changeTab.
 */
async function handleActionElement(actionEl: HTMLElement, sheetElement: HTMLElement, sheet?: any): Promise<boolean> {
    const action = actionEl.getAttribute('data-action');

    if (action === 'tab') {
        const tabName = actionEl.getAttribute('data-tab');
        const groupName = actionEl.getAttribute('data-group') || 'primary';
        if (!tabName) return false;

        if (sheet && typeof sheet.changeTab === 'function') {
            // changeTab in v13 ApplicationV2 is async (triggers re-render)
            const result = sheet.changeTab(tabName, groupName);
            if (result instanceof Promise) {
                await result;
            }
            // Extra settle time for the re-render to apply
            await new Promise<void>(r => setTimeout(r, 100));
            return true;
        }

        // Fallback: manually toggle active classes
        const nav = actionEl.closest('nav.tabs');
        if (nav) {
            nav.querySelectorAll('.item').forEach(el => el.classList.remove('active'));
            actionEl.classList.add('active');
        }
        const container = sheetElement.querySelector(`.tab[data-tab="${tabName}"][data-group="${groupName}"]`) as HTMLElement
            || sheetElement.querySelector(`.tab[data-tab="${tabName}"]`) as HTMLElement;
        if (container) {
            const parent = container.parentElement;
            if (parent) {
                parent.querySelectorAll(':scope > .tab').forEach(el => el.classList.remove('active'));
            }
            container.classList.add('active');
        }
        return true;
    }

    return false;
}

async function tryHandleAction(target: HTMLElement, sheetElement: HTMLElement, sheet?: any): Promise<boolean> {
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl || !sheetElement.contains(actionEl)) return false;
    return handleActionElement(actionEl, sheetElement, sheet);
}

/**
 * Dispatch a full click sequence on the sheet element at the given coordinates.
 * Fires the complete pointer + mouse event chain that browsers normally produce:
 * pointerdown → mousedown → pointerup → mouseup → click
 * Also handles Foundry v13 data-action elements directly.
 */
async function dispatchClickSequence(sheetElement: HTMLElement, data: InputData, isDblClick = false, sheet?: any): Promise<void> {
    const x = data.x ?? 0;
    const y = data.y ?? 0;
    const target = findElementAtPoint(sheetElement, x, y);

    // Try to handle Foundry v13 action elements by direct rect-checking
    // (findElementAtPoint misses absolutely-positioned elements like tabs)
    if (await tryHandleActionByCoords(sheetElement, x, y, sheet)) {
        return;
    }

    // Try via the element found by tree walk
    if (await tryHandleAction(target, sheetElement, sheet)) {
        return;
    }

    const containerRect = sheetElement.getBoundingClientRect();
    const clientX = containerRect.left + x;
    const clientY = containerRect.top + y;

    const mods = buildModifiers(data.modifiers);
    const button = data.button ?? 0;

    const commonInit = {
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button,
        bubbles: true,
        cancelable: true,
        ...mods,
    };

    // Pointer events
    target.dispatchEvent(new PointerEvent('pointerdown', { ...commonInit, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...commonInit, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...commonInit, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...commonInit, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...commonInit, buttons: 0 }));

    if (isDblClick) {
        target.dispatchEvent(new MouseEvent('dblclick', { ...commonInit, buttons: 0 }));
    }

    // Also try to focus the target if it's focusable
    if (typeof target.focus === 'function' && (
        target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' ||
        target.tagName === 'A' || target.getAttribute('tabindex') !== null
    )) {
        target.focus();
    }
}

/**
 * Dispatch a single mouse event (for mousedown/mouseup/contextmenu sent individually).
 */
function dispatchSingleMouseEvent(sheetElement: HTMLElement, data: InputData): void {
    const x = data.x ?? 0;
    const y = data.y ?? 0;
    const target = findElementAtPoint(sheetElement, x, y);

    const containerRect = sheetElement.getBoundingClientRect();
    const clientX = containerRect.left + x;
    const clientY = containerRect.top + y;

    const eventInit: MouseEventInit = {
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: data.button ?? 0,
        buttons: data.action === 'mousedown' ? 1 : 0,
        bubbles: true,
        cancelable: true,
        ...buildModifiers(data.modifiers),
    };

    // Also dispatch matching pointer event
    const pointerInit = {
        ...eventInit,
        pointerId: 1,
        pointerType: 'mouse' as const,
    };

    if (data.action === 'mousedown') {
        target.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    } else if (data.action === 'mouseup') {
        target.dispatchEvent(new PointerEvent('pointerup', pointerInit));
    }

    target.dispatchEvent(new MouseEvent(data.action, eventInit));
}

/**
 * Handle scroll by programmatically scrolling the container.
 * Synthetic WheelEvent dispatches don't cause actual scrolling (browser security).
 */
function dispatchScrollEvent(sheetElement: HTMLElement, data: InputData): void {
    const deltaX = data.deltaX ?? 0;
    const deltaY = data.deltaY ?? 0;

    // Find scrollable containers within the sheet
    // Try common Foundry sheet scroll containers
    const scrollTargets = [
        sheetElement.querySelector('.window-content'),
        sheetElement.querySelector('.sheet-body'),
        sheetElement.querySelector('[data-group].active'),
        sheetElement.querySelector('.tab.active'),
        sheetElement,
    ];

    for (const target of scrollTargets) {
        if (!target) continue;
        const el = target as HTMLElement;
        // Check if this element is actually scrollable
        if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
            el.scrollBy({ left: deltaX, top: deltaY });
            return;
        }
    }
}

/**
 * Dispatch a keyboard event on the focused element within the sheet.
 */
function dispatchKeyEvent(sheetElement: HTMLElement, data: InputData): void {
    // Use the active element if it's within the sheet, otherwise use the sheet itself
    let target: HTMLElement = sheetElement;
    if (document.activeElement && sheetElement.contains(document.activeElement)) {
        target = document.activeElement as HTMLElement;
    }

    const eventInit: KeyboardEventInit = {
        key: data.key ?? '',
        code: data.code ?? '',
        bubbles: true,
        cancelable: true,
        ...buildModifiers(data.modifiers),
    };

    const event = new KeyboardEvent(data.action, eventInit);
    target.dispatchEvent(event);
}

/**
 * Dispatch an input event based on the action type.
 * @param sheetElement The sheet's DOM element
 * @param data The input data from the consumer
 * @param sheet Optional reference to the Foundry sheet/app instance for direct API calls
 */
export async function dispatchInput(sheetElement: HTMLElement, data: InputData, sheet?: any): Promise<void> {
    switch (data.action) {
        case 'click':
            await dispatchClickSequence(sheetElement, data, false, sheet);
            break;
        case 'dblclick':
            await dispatchClickSequence(sheetElement, data, true, sheet);
            break;
        case 'mousedown':
        case 'mouseup':
        case 'contextmenu':
            dispatchSingleMouseEvent(sheetElement, data);
            break;
        case 'scroll':
            dispatchScrollEvent(sheetElement, data);
            break;
        case 'keydown':
        case 'keyup':
            dispatchKeyEvent(sheetElement, data);
            break;
        default:
            throw new Error(`Unknown input action: ${data.action}`);
    }
}
