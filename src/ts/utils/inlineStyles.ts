/**
 * Inline external stylesheets into an element as <style> tags
 * so that html-to-image captures them correctly.
 *
 * html-to-image fails to fetch relative CSS URLs (e.g. "fonts/fontawesome/css/all.min.css")
 * because it can't resolve them without a base URL. By inlining the computed CSS
 * directly, we bypass this issue entirely.
 */
import { ModuleLogger } from "./logger";

/**
 * Collect all stylesheets from the document and inline them into the element.
 * Returns a cleanup function that removes the inlined styles.
 */
export async function inlineDocumentStyles(element: HTMLElement): Promise<() => void> {
    const inlinedElements: HTMLStyleElement[] = [];
    const origin = window.location.origin;

    // Collect CSS from all <link rel="stylesheet"> elements
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    const fetchPromises = Array.from(links).map(async (link) => {
        const href = link.getAttribute('href');
        if (!href) return '';
        // Skip Google Fonts — they're not needed for screenshots
        if (href.includes('fonts.googleapis.com')) return '';

        try {
            const fullUrl = href.startsWith('http') ? href
                : href.startsWith('/') ? `${origin}${href}`
                : `${origin}/${href}`;

            const resp = await fetch(fullUrl);
            if (!resp.ok) return '';

            let css = await resp.text();

            // Rewrite relative url() references to absolute
            css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                if (url.startsWith('http') || url.startsWith('data:') || url.startsWith('#')) return match;
                if (url.startsWith('/')) return `url('${origin}${url}')`;
                // Resolve relative to the CSS file's directory
                const cssDir = fullUrl.substring(0, fullUrl.lastIndexOf('/'));
                return `url('${cssDir}/${url}')`;
            });

            return css;
        } catch (e) {
            ModuleLogger.debug(`Failed to fetch CSS: ${href}: ${e}`);
            return '';
        }
    });

    // Also collect inline <style> elements from the document
    const inlineStyles = Array.from(document.querySelectorAll('style')).map(s => s.textContent || '');

    const externalCSS = await Promise.all(fetchPromises);
    const allCSS = [...externalCSS, ...inlineStyles].filter(s => s.length > 0).join('\n');

    if (allCSS.length > 0) {
        const styleEl = document.createElement('style');
        styleEl.textContent = allCSS;
        element.prepend(styleEl);
        inlinedElements.push(styleEl);
    }

    return () => {
        for (const el of inlinedElements) {
            el.remove();
        }
    };
}
