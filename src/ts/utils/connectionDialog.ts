import {
  moduleId,
  SETTINGS,
} from "../constants";
import { ModuleLogger } from "./logger";

const DEFAULT_RELAY_URL = "wss://foundryrestapi.com";

/**
 * Derive the HTTP base URL for the relay from a ws/wss URL.
 *
 * Returns null if the input cannot be parsed as a valid URL — this can happen
 * if the setting was corrupted by a previous bad pairing response. Callers
 * should detect null and prompt the user to enter a fresh URL or reset.
 */
function httpBaseFromWsUrl(wsUrl: string): string | null {
  if (!wsUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return null;
  }

  // Only ws:// and wss:// are valid relay URLs
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return null;
  }

  // The host portion must look like a hostname[:port], not contain extra schemes
  // (e.g. "http//localhost:3010" embedded inside a wss URL means corruption)
  if (parsed.host.includes("/") || parsed.host.includes(":") && parsed.host.split(":").length > 2) {
    return null;
  }

  // Build the http base by swapping scheme and dropping /relay if present
  const httpScheme = parsed.protocol === "wss:" ? "https:" : "http:";
  let pathname = parsed.pathname;
  if (pathname.endsWith("/relay")) {
    pathname = pathname.slice(0, -"/relay".length);
  }
  // Strip ALL trailing slashes from the final URL so callers can safely do
  // `${base}/auth/pair` without ever producing a double slash.
  const result = `${httpScheme}//${parsed.host}${pathname}`;
  return result.replace(/\/+$/, '');
}

/**
 * Reset the relay URL setting to the production default and clear all
 * connection flags. Used to recover from a corrupted URL state.
 */
async function resetRelayUrl(): Promise<void> {
  await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, DEFAULT_RELAY_URL);
  // Clear THIS browser's client-scope token + the world-scope clientId/url
  // pointers. The world settings get cleared because the user explicitly
  // chose "reset" — this is the equivalent of "delete the entire pairing"
  // not "unpair just my browser".
  await game.settings.set(moduleId, SETTINGS.CONNECTION_TOKEN, "");
  await game.settings.set(moduleId, SETTINGS.CLIENT_ID, "");
  await game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, "");
  ui.notifications?.info(`Reset relay URL to ${DEFAULT_RELAY_URL}. Re-pair to connect.`);
}

/**
 * Prompt the user to enter a relay URL manually. Validates the input is a
 * proper ws://host or wss://host URL. Used as a recovery path when the stored
 * URL is corrupted, or when the GM is intentionally pointing at a custom relay.
 *
 * Returns the entered URL on confirm, or null on cancel.
 */
async function promptForRelayUrl(currentUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    new Dialog({
      title: "Set Relay URL",
      content: `
        <p>Enter the WebSocket URL of your relay server. Examples:</p>
        <ul>
          <li><code>ws://localhost:3010</code> (local dev)</li>
          <li><code>wss://foundryrestapi.com</code> (production)</li>
          <li><code>wss://relay.your-domain.com</code> (self-hosted)</li>
        </ul>
        <div class="form-group">
          <input type="text" id="rest-api-relay-url-input" value="${currentUrl}" style="width: 100%;" placeholder="wss://...">
        </div>
      `,
      buttons: {
        save: {
          icon: '<i class="fas fa-save"></i>',
          label: "Save",
          callback: (dialogHtml: JQuery | HTMLElement) => {
            const dh = dialogHtml instanceof HTMLElement ? $(dialogHtml) : dialogHtml;
            const url = ((dh.find('#rest-api-relay-url-input').val() as string) || "").trim();
            // Validate
            if (httpBaseFromWsUrl(url) === null) {
              ui.notifications?.error("Invalid relay URL. Must start with ws:// or wss://");
              resolve(null);
              return;
            }
            resolve(url);
          },
        },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "save",
    }).render(true);
  });
}

/**
 * Open-in-browser upgrade flow. Creates an upgradeOnly pair request on the
 * relay, opens the approval URL, and polls until the user grants cross-world
 * permissions. No new connection token is created — the world stays paired
 * and the relay simply updates its cross-world settings.
 */
async function startBrowserUpgradeFlow(relayUrl: string): Promise<void> {
  const httpUrl = httpBaseFromWsUrl(relayUrl);
  if (httpUrl === null) {
    ui.notifications?.error(`Invalid relay URL: ${relayUrl}`);
    return;
  }

  let pairData: { code: string; pairUrl: string; expiresAt: string };
  try {
    const res = await fetch(`${httpUrl}/auth/pair-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worldId: game.world.id,
        worldTitle: (game.world as any).title ?? game.world.id,
        systemId: game.system?.id ?? '',
        systemTitle: (game.system as any)?.title ?? '',
        systemVersion: (game.system as any)?.version ?? '',
        foundryVersion: game.version ?? '',
        upgradeOnly: true,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to create upgrade request' }));
      ui.notifications?.error(`Upgrade failed: ${err.error || res.statusText}`);
      return;
    }
    pairData = await res.json();
  } catch (err) {
    ModuleLogger.error('Failed to create upgrade request:', err);
    ui.notifications?.error(`Upgrade failed: ${err}`);
    return;
  }

  window.open(pairData.pairUrl, '_blank');

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let resolved = false;

  const dialog = new Dialog({
    title: 'Upgrade World Permissions',
    content: `
      <p>A browser tab has been opened to your relay dashboard.</p>
      <p>Log in if needed, configure cross-world permissions, then click <strong>Upgrade Permissions</strong>.</p>
      <p class="notes">
        If the tab didn't open, <a href="${pairData.pairUrl}" target="_blank">click here</a>.
      </p>
      <p id="rest-api-upgrade-status" class="notes">Status: <em>Waiting…</em></p>
    `,
    buttons: {
      cancel: {
        label: 'Cancel',
        callback: () => {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
        },
      },
    },
    default: 'cancel',
    close: () => {
      resolved = true;
      if (pollInterval) clearInterval(pollInterval);
    },
  });
  dialog.render(true);

  pollInterval = setInterval(async () => {
    if (resolved) {
      clearInterval(pollInterval!);
      return;
    }

    let statusData: { status: string; upgraded?: boolean };
    try {
      const res = await fetch(`${httpUrl}/auth/pair-request/${pairData.code}/status`);
      if (!res.ok) {
        resolved = true;
        clearInterval(pollInterval!);
        dialog.close();
        ui.notifications?.error('Upgrade request not found or expired.');
        return;
      }
      statusData = await res.json();
    } catch {
      return;
    }

    const statusEl = document.getElementById('rest-api-upgrade-status');
    if (statusEl) {
      statusEl.textContent = "Status: ";
      const em = document.createElement("em");
      em.textContent = statusData.status;
      statusEl.appendChild(em);
    }

    if (statusData.status === 'approved' && statusData.upgraded) {
      resolved = true;
      clearInterval(pollInterval!);
      dialog.close();
      ui.notifications?.info('Cross-world permissions updated successfully!');
    } else if (statusData.status === 'denied') {
      resolved = true;
      clearInterval(pollInterval!);
      dialog.close();
      ui.notifications?.warn('Upgrade request was denied.');
    } else if (statusData.status === 'expired' || statusData.status === 'exchanged') {
      resolved = true;
      clearInterval(pollInterval!);
      dialog.close();
      ui.notifications?.warn('Upgrade request expired. Please try again.');
    }
  }, 3000);
}

/**
 * Open-in-browser pairing flow. Creates a pair request on the relay, opens
 * the approval URL in a new browser tab, then polls until the user approves
 * (or denies / the request expires).
 *
 * On approval the relay returns a 6-char pairing code which is exchanged
 * via the existing /auth/pair endpoint — identical to the manual flow.
 */
async function startBrowserPairingFlow(relayUrl: string): Promise<void> {
  const httpUrl = httpBaseFromWsUrl(relayUrl);
  if (httpUrl === null) {
    ui.notifications?.error(`Invalid relay URL: ${relayUrl}`);
    return;
  }

  // Create the pair request on the relay (no auth needed).
  let pairData: { code: string; pairUrl: string; expiresAt: string };
  try {
    const res = await fetch(`${httpUrl}/auth/pair-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worldId: game.world.id,
        worldTitle: (game.world as any).title ?? game.world.id,
        systemId: game.system?.id ?? '',
        systemTitle: (game.system as any)?.title ?? '',
        systemVersion: (game.system as any)?.version ?? '',
        foundryVersion: game.version ?? '',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to create pair request' }));
      ui.notifications?.error(`Pairing failed: ${err.error || res.statusText}`);
      return;
    }
    pairData = await res.json();
  } catch (err) {
    ModuleLogger.error('Failed to create pair request:', err);
    ui.notifications?.error(`Pairing failed: ${err}`);
    return;
  }

  // Open the approval URL — show a link in case popup is blocked.
  window.open(pairData.pairUrl, '_blank');

  // Show a waiting dialog that auto-completes when the user approves.
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let resolved = false;

  const dialog = new Dialog({
    title: 'Waiting for Approval',
    content: `
      <p>A browser tab has been opened to your relay dashboard.</p>
      <p>Log in if needed, then click <strong>Approve Pairing</strong>.</p>
      <p class="notes">
        If the tab didn't open, <a href="${pairData.pairUrl}" target="_blank">click here</a>.
      </p>
      <p id="rest-api-pair-status" class="notes">Status: <em>Waiting…</em></p>
    `,
    buttons: {
      cancel: {
        label: 'Cancel',
        callback: () => {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
        },
      },
    },
    default: 'cancel',
    close: () => {
      resolved = true;
      if (pollInterval) clearInterval(pollInterval);
    },
  });
  dialog.render(true);

  // Poll the status endpoint every 3 seconds.
  pollInterval = setInterval(async () => {
    if (resolved) {
      clearInterval(pollInterval!);
      return;
    }

    let statusData: { status: string; pairingCode?: string };
    try {
      const res = await fetch(`${httpUrl}/auth/pair-request/${pairData.code}/status`);
      if (!res.ok) {
        // 404 means expired or unknown — stop polling.
        resolved = true;
        clearInterval(pollInterval!);
        dialog.close();
        ui.notifications?.error('Pair request not found or expired.');
        return;
      }
      statusData = await res.json();
    } catch {
      return; // Network hiccup — keep polling.
    }

    const statusEl = document.getElementById('rest-api-pair-status');
    if (statusEl) {
      statusEl.textContent = "Status: ";
      const em = document.createElement("em");
      em.textContent = statusData.status;
      statusEl.appendChild(em);
    }

    if (statusData.status === 'approved' && statusData.pairingCode) {
      resolved = true;
      clearInterval(pollInterval!);
      dialog.close();

      // Exchange the pairing code exactly as the manual flow does.
      try {
        const pairRes = await fetch(`${httpUrl}/auth/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: statusData.pairingCode,
            worldId: game.world.id,
            worldTitle: (game.world as any).title ?? game.world.id,
          }),
        });
        if (!pairRes.ok) {
          const err = await pairRes.json().catch(() => ({ error: 'Pairing failed' }));
          ui.notifications?.error(`Pairing failed: ${err.error || pairRes.statusText}`);
          return;
        }
        const data = await pairRes.json();
        if (data.relayUrl) {
          await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, data.relayUrl);
        }
        await game.settings.set(moduleId, SETTINGS.CONNECTION_TOKEN, data.token);
        await game.settings.set(moduleId, SETTINGS.CLIENT_ID, data.clientId);
        await game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, data.relayUrl || relayUrl);
        ui.notifications?.info(`Successfully paired! Client ID: ${data.clientId}`);
        new Dialog({
          title: 'Reload Required',
          content: '<p>Pairing complete! Reload now to connect?</p>',
          buttons: {
            yes: { label: 'Reload', callback: () => window.location.reload() },
            no: { label: 'Later' },
          },
          default: 'yes',
        }).render(true);
      } catch (err) {
        ModuleLogger.error('Pairing exchange error:', err);
        ui.notifications?.error(`Pairing failed: ${err}`);
      }
    } else if (statusData.status === 'denied') {
      resolved = true;
      clearInterval(pollInterval!);
      dialog.close();
      ui.notifications?.warn('Pairing request was denied.');
    } else if (statusData.status === 'expired' || statusData.status === 'exchanged') {
      resolved = true;
      clearInterval(pollInterval!);
      dialog.close();
      ui.notifications?.warn('Pair request expired. Please try again.');
    }
  }, 3000);
}

/**
 * Start the pairing flow with a given relay URL. Prompts for the 6-char code,
 * calls /auth/pair, and stores the returned token and clientId on the current
 * user's flags. Also pins the paired relay URL.
 *
 * If the supplied URL is corrupted (cannot be parsed), prompts the user to
 * enter a fresh URL before continuing.
 */
async function startPairingFlow(relayUrl: string): Promise<void> {
  // Validate the URL upfront — if it's corrupted, prompt for a fresh one
  if (httpBaseFromWsUrl(relayUrl) === null) {
    ui.notifications?.warn(`Stored relay URL is invalid: ${relayUrl}. Please enter a new one.`);
    const newUrl = await promptForRelayUrl(DEFAULT_RELAY_URL);
    if (!newUrl) return;
    await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, newUrl);
    relayUrl = newUrl;
  }

  new Dialog({
    title: "Pair with Relay",
    content: `
      <p>Enter the 6-character pairing code from your relay dashboard:</p>
      <p class="notes">Relay: <code>${relayUrl}</code></p>
      <div class="form-group">
        <input type="text" id="rest-api-pairing-code-input" maxlength="6"
               style="text-transform: uppercase; font-size: 1.5em; text-align: center; letter-spacing: 0.3em; width: 200px;"
               placeholder="ABC123">
      </div>
      <p class="notes">Generate a code at your relay dashboard under Connection Tokens.</p>
    `,
    buttons: {
      pair: {
        icon: '<i class="fas fa-link"></i>',
        label: "Pair",
        callback: async (dialogHtml: JQuery | HTMLElement) => {
          const dh = dialogHtml instanceof HTMLElement ? $(dialogHtml) : dialogHtml;
          const code = ((dh.find('#rest-api-pairing-code-input').val() as string) || '').toUpperCase().trim();
          if (!code || code.length !== 6) {
            ui.notifications?.error("Please enter a valid 6-character pairing code.");
            return;
          }

          try {
            const httpUrl = httpBaseFromWsUrl(relayUrl);
            if (httpUrl === null) {
              // Should be unreachable because startPairingFlow validates first,
              // but be defensive in case the URL was modified between validation
              // and submission.
              ui.notifications?.error(`Invalid relay URL: ${relayUrl}`);
              return;
            }
            const response = await fetch(`${httpUrl}/auth/pair`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code,
                worldId: game.world.id,
                worldTitle: (game.world as any).title ?? game.world.id,
              }),
            });

            if (!response.ok) {
              const err = await response.json().catch(() => ({ error: 'Pairing failed' }));
              ui.notifications?.error(`Pairing failed: ${err.error || response.statusText}`);
              return;
            }

            const data = await response.json();
            const finalRelayUrl = data.relayUrl || relayUrl;

            // Save relay URL (world setting) if returned
            if (data.relayUrl) {
              await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, data.relayUrl);
            }

            // Save the token to client-scope (browser localStorage, per-device,
            // never broadcast) and the clientId/pairedRelayUrl to world settings
            // (shared across all GMs). This is the storage split that lets a
            // second GM "add this browser" without sharing the secret with players.
            await game.settings.set(moduleId, SETTINGS.CONNECTION_TOKEN, data.token);
            await game.settings.set(moduleId, SETTINGS.CLIENT_ID, data.clientId);
            await game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, finalRelayUrl);

            ui.notifications?.info(`Successfully paired! Client ID: ${data.clientId}`);

            new Dialog({
              title: "Reload Required",
              content: "<p>Pairing complete! A reload is required to connect with the new token. Reload now?</p>",
              buttons: {
                yes: { label: "Reload", callback: () => window.location.reload() },
                no: { label: "Later" }
              },
              default: "yes"
            }).render(true);
          } catch (error) {
            ModuleLogger.error(`Pairing error:`, error);
            ui.notifications?.error(`Pairing failed: ${error}`);
          }
        }
      },
      cancel: { label: "Cancel" }
    },
    default: "pair"
  }).render(true);
}

/**
 * Unpair: notify the relay to remove this browser's connection token and
 * (if no other tokens remain for this world) the world's KnownClients entry,
 * then clear local settings.
 */
async function unpair(): Promise<void> {
  const confirmed = await Dialog.confirm({
    title: "Unpair Relay",
    content: "<p>Are you sure you want to unpair this browser from the relay? This removes your connection token from the relay's records.</p>",
  });
  if (!confirmed) return;

  const currentToken = (game.settings.get(moduleId, SETTINGS.CONNECTION_TOKEN) as string) || "";
  const relayUrl = game.settings.get(moduleId, SETTINGS.WS_RELAY_URL) as string;

  // Tell the relay to remove this browser's connection token and clean up
  // KnownClients if no other tokens remain for this world.
  if (currentToken && relayUrl) {
    const httpBase = httpBaseFromWsUrl(relayUrl);
    if (httpBase) {
      try {
        await fetch(`${httpBase}/api/self-unpair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: currentToken }),
        });
      } catch (err) {
        // Non-fatal — continue with local cleanup even if the relay is unreachable.
        ModuleLogger.warn("Self-unpair request failed (relay may be offline):", err);
      }
    }
  }

  // Clear this browser's local connection token. The world settings (clientId,
  // pairedRelayUrl) stay intact because other GMs may still need them to
  // identify the world — they just won't have a valid token to connect with.
  await game.settings.set(moduleId, SETTINGS.CONNECTION_TOKEN, "");

  ui.notifications?.info("Unpaired from relay. Reload to fully disconnect.");

  new Dialog({
    title: "Reload Required",
    content: "<p>Unpaired. Reload now to fully disconnect?</p>",
    buttons: {
      yes: { label: "Reload", callback: () => window.location.reload() },
      no: { label: "Later" }
    },
    default: "yes"
  }).render(true);
}

/**
 * Open the unified Connection dialog. Shows status and provides buttons for
 * pairing, unpairing, editing the relay URL, and resetting to default.
 */
export function openConnectionDialog(): void {
  const currentToken = (game.settings.get(moduleId, SETTINGS.CONNECTION_TOKEN) as string) || "";
  const currentClientId = (game.settings.get(moduleId, SETTINGS.CLIENT_ID) as string) || "";
  const pairedUrl = (game.settings.get(moduleId, SETTINGS.PAIRED_RELAY_URL) as string) || "";
  const relayUrl = game.settings.get(moduleId, SETTINGS.WS_RELAY_URL) as string;

  const urlIsValid = httpBaseFromWsUrl(relayUrl) !== null;

  const statusHtml = currentToken
    ? `<span style="color: green;">Paired</span> (Client: <code>${currentClientId || 'legacy'}</code>)`
    : `<span style="color: orange;">Not paired</span>`;

  const corruptedHtml = !urlIsValid
    ? `<p style="color: var(--color-text-hyperlink, #b33);"><b>⚠ Relay URL is invalid or corrupted.</b> Click <b>Edit URL</b> to fix it, or <b>Reset URL</b> to restore the production default.</p>`
    : "";

  const mismatchHtml = (urlIsValid && currentToken && pairedUrl && pairedUrl !== relayUrl)
    ? `<p style="color: var(--color-text-hyperlink, #b33);"><b>⚠ URL mismatch:</b> Paired URL (<code>${pairedUrl}</code>) differs from current relay URL (<code>${relayUrl}</code>). Re-pair to reconnect.</p>`
    : "";

  const content = `
    <div style="max-height: 70vh; overflow-y: auto;">
      <h3>Connection Status</h3>
      <p><b>Status:</b> ${statusHtml}</p>
      <p><b>Current Relay:</b> <code>${relayUrl || '(none)'}</code></p>
      ${pairedUrl ? `<p><b>Paired Relay:</b> <code>${pairedUrl}</code></p>` : ""}
      ${corruptedHtml}
      ${mismatchHtml}
      <hr>
      <p class="notes"><b>Pair via Browser</b> — opens a link to your relay dashboard for one-click pairing (recommended).</p>
      <p class="notes"><b>Enter Code</b> — generate a code on the relay dashboard and enter it here manually.</p>
      ${currentToken ? `<p class="notes"><b>Upgrade Permissions</b> — already paired but want to enable cross-world communication? Opens the relay to update permissions without creating a new token.</p>` : ""}
    </div>
  `;

  const buttons: Record<string, Dialog.Button> = {
    browserPair: {
      icon: '<i class="fas fa-globe"></i>',
      label: "Pair via Browser",
      callback: () => { void startBrowserPairingFlow(relayUrl); }
    },
    pair: {
      icon: '<i class="fas fa-keyboard"></i>',
      label: "Enter Code",
      callback: () => startPairingFlow(relayUrl)
    },
  };

  if (currentToken) {
    buttons.upgrade = {
      icon: '<i class="fas fa-arrow-up"></i>',
      label: "Upgrade Permissions",
      callback: () => { void startBrowserUpgradeFlow(relayUrl); }
    };
  }

  const dialog = new Dialog({
    title: "REST API Connection",
    content,
    buttons: {
      ...buttons,
      unpair: {
        icon: '<i class="fas fa-unlink"></i>',
        label: "Unpair",
        callback: () => { void unpair(); }
      },
      editUrl: {
        icon: '<i class="fas fa-edit"></i>',
        label: "Edit URL",
        callback: async () => {
          const newUrl = await promptForRelayUrl(urlIsValid ? relayUrl : DEFAULT_RELAY_URL);
          if (!newUrl) return;
          await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, newUrl);
          ui.notifications?.info(`Relay URL set to ${newUrl}`);
          // Reopen the dialog so the GM sees the updated state
          openConnectionDialog();
        }
      },
      reset: {
        icon: '<i class="fas fa-undo"></i>',
        label: "Reset URL",
        callback: async () => {
          const confirmed = await Dialog.confirm({
            title: "Reset Relay URL",
            content: `<p>Reset the relay URL to <code>${DEFAULT_RELAY_URL}</code> and clear all connection flags? You will need to re-pair after this.</p>`,
          });
          if (!confirmed) return;
          await resetRelayUrl();
          openConnectionDialog();
        }
      },
      close: { label: "Close" }
    },
    default: "browserPair"
  }, { width: 560 } as any);

  dialog.render(true);
}

/**
 * Minimal FormApplication stub so that `game.settings.registerMenu` can open
 * the connection dialog from the Foundry settings UI.
 */
export class ConnectionSettingsApp extends (FormApplication as any) {
  static get defaultOptions() {
    return foundry.utils.mergeObject((FormApplication as any).defaultOptions, {
      id: "rest-api-connection-settings",
      title: "REST API Connection",
      template: "templates/generic/form.html",
      width: 400,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() { return {}; }

  render(_force?: boolean, _options?: any): any {
    openConnectionDialog();
    return this;
  }

  async _updateObject(_event: Event, _formData: any) { /* no-op */ }
}
