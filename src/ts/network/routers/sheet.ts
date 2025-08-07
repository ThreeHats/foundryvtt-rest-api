import { Router } from "./baseRouter";
import { ModuleLogger } from "../../utils/logger";

export const router = new Router("sheetRouter");

router.addRoute({
  actionType: "actor-sheet",
  handler: async (data, context) => {
    const socketManager = context?.socketManager;
    ModuleLogger.info(`Received sheet HTML request for UUID: ${data.uuid}`);
    let sheet: ActorSheet | undefined;

    try {
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

      if (!actor) {
        ModuleLogger.error(`Entity not found for UUID: ${data.uuid}`);
        socketManager?.send({
          type: "actor-sheet-result",
          requestId: data.requestId,
          data: { error: "Entity not found", uuid: data.uuid }
        });
        return;
      }

      const responseUuid = actor.uuid;
      sheet = await actor.sheet?.render(true) as ActorSheet;

      // It seems that even with awaiting the render, we need to give the DOM a moment to catch up.
      await new Promise(resolve => setTimeout(resolve, 500));

      // The sheet's `id` property corresponds to the ID of the wrapper element.
      const appElement = document.getElementById(sheet.id);

      if (!appElement) {
        ModuleLogger.error(`Failed to find actor sheet element with ID ${sheet.id}`, sheet);
        throw new Error("Failed to find actor sheet element");
      }

      const sheetAppId = appElement.dataset.appid ?? '';
      let html = appElement.outerHTML;
      let css = '';

      const appStyles = document.querySelectorAll('style[data-appid]');
      appStyles.forEach(style => {
        const styleAppId = (style as HTMLElement).dataset.appid;
        if (styleAppId === sheetAppId) {
          css += style.textContent + '\n';
        }
      });

      const systemStyles = document.querySelectorAll(`style[id^="system-${(actor as any).type}"]`);
      systemStyles.forEach(style => {
        css += style.textContent + '\n';
      });

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;

      const classNames = new Set<string>();
      const ids = new Set<string>();

      function extractClassesAndIds(element: Element) {
        if (element.classList && element.classList.length) {
          element.classList.forEach(className => classNames.add(className));
        }

        if (element.id) {
          ids.add(element.id);
        }

        for (let i = 0; i < element.children.length; i++) {
          extractClassesAndIds(element.children[i]);
        }
      }

      extractClassesAndIds(tempDiv);

      const uniqueClassNames = Array.from(classNames);
      const uniqueIds = Array.from(ids);

      ModuleLogger.debug(`Extracted ${uniqueClassNames.length} unique classes and ${uniqueIds.length} unique IDs`);

      const allStyles = document.querySelectorAll('style');
      const allLinks = document.querySelectorAll('link[rel="stylesheet"]');

      allStyles.forEach(style => {
        if (style.dataset.appid && style.dataset.appid === sheetAppId) {
          return;
        }

        const styleContent = style.textContent || '';

        const isRelevant = uniqueClassNames.some(className => 
          styleContent.includes(`.${className}`)) || 
          uniqueIds.some(id => styleContent.includes(`#${id}`)) ||
          styleContent.includes('.window-app') || 
          styleContent.includes('.sheet') || 
          styleContent.includes('.actor-sheet') ||
          styleContent.includes(`.${(actor as any).type}-sheet`);

        if (isRelevant) {
          ModuleLogger.debug(`Adding relevant inline style`);
          css += styleContent + '\n';
        }
      });

      const stylesheetPromises = Array.from(allLinks).map(async (link) => {
        try {
          const href = link.getAttribute('href');
          if (!href) return '';

          if (href.includes('fonts.googleapis.com')) return '';

          ModuleLogger.debug(`Fetching external CSS from: ${href}`);
          const fullUrl = href.startsWith('http') ? href : 
                          href.startsWith('/') ? `${window.location.origin}${href}` : 
                          `${window.location.origin}/${href}`;

          const response = await fetch(fullUrl);
          if (!response.ok) {
            ModuleLogger.warn(`Failed to fetch CSS: ${fullUrl}, status: ${response.status}`);
            return '';
          }

          const styleContent = await response.text();
          return styleContent;
        } catch (e) {
          ModuleLogger.warn(`Failed to fetch external CSS: ${e}`);
          return '';
        }
      });

      const allPromises = [...stylesheetPromises];
      const externalStyles = await Promise.all(allPromises);
      externalStyles.forEach(style => {
        css += style + '\n';
      });

      if (css.length < 100) {
        ModuleLogger.warn(`CSS fetch failed or returned minimal content. Adding fallback styles.`);
        css += `
              .window-app {
                font-family: "Signika", sans-serif;
                background: #f0f0e0;
                border-radius: 5px;
                box-shadow: 0 0 20px #000;
                color: #191813;
              }
              .window-content {
                background: rgba(255, 255, 240, 0.9);
                padding: 8px;
                overflow-y: auto;
                background: url(${window.location.origin}/ui/parchment.jpg) repeat;
              }
              input, select, textarea {
                border: 1px solid #7a7971;
                background: rgba(255, 255, 255, 0.8);
              }
              button {
                background: rgba(0, 0, 0, 0.1);
                border: 1px solid #7a7971;
                border-radius: 3px;
                cursor: pointer;
              }
              .profile-img {
                border: none;
                max-width: 100%;
                max-height: 220px;
              }
            `;
      }

      ModuleLogger.debug(`Collected CSS: ${css.length} bytes`);

      html = html.replace(/src="([^"]+)"/g, (match, src) => {
        if (src.startsWith('http')) return match;
        if (src.startsWith('/')) return `src="${window.location.origin}${src}"`;
        return `src="${window.location.origin}/${src}"`;
      });

      css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
        if (url.startsWith('http') || url.startsWith('data:')) return match;
        if (url.startsWith('/')) return `url('${window.location.origin}${url}')`;
        return `url('${window.location.origin}/${url}')`;
      });

      sheet.close();

      socketManager?.send({
        type: "actor-sheet-result",
        requestId: data.requestId,
        data: { html, css, uuid: responseUuid }
      });

      ModuleLogger.debug(`Sent actor sheet HTML response with requestId: ${data.requestId}`);
      ModuleLogger.debug(`HTML length: ${html.length}, CSS length: ${css.length}`);

    } catch (error) {
      ModuleLogger.error(`Error capturing/rendering actor sheet HTML:`, error);
      socketManager?.send({
        type: "actor-sheet-result",
        requestId: data.requestId,
        data: { error: "Failed to capture or render actor sheet HTML", uuid: data.uuid }
      });
      if (sheet && typeof sheet.close === 'function') {
        sheet.close();
      }
    }
  }
});
