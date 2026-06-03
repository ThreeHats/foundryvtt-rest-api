import {
  moduleId,
  SETTINGS,
} from "../constants";
import { ModuleLogger } from "./logger";

const DEFAULT_RELAY_URL = "wss://foundryrestapi.com";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DV2 = () => (foundry as any).applications.api.DialogV2;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Escapes a relay-controlled URL for an href, or returns "#" if it isn't plain
// http(s) — escHtml alone wouldn't block a javascript:/data: scheme.
function safeHttpUrl(u: unknown): string {
  return (typeof u === "string" && /^https?:\/\//i.test(u)) ? escHtml(u) : "#";
}

/**
 * Get or create a stable random fingerprint for this Foundry server+world.
 * Stored as a world-scoped setting so it persists across browser reloads and
 * GM sessions. Used at pair-time to let the relay re-identify the same server
 * even if the worldId slug collides with a different Foundry instance.
 */
async function getOrCreateServerFingerprint(): Promise<string> {
  let fp = (game.settings.get(moduleId, SETTINGS.SERVER_FINGERPRINT) as string) || "";
  if (!fp) {
    fp = foundry.utils.randomID(32);
    await game.settings.set(moduleId, SETTINGS.SERVER_FINGERPRINT, fp);
  }
  return fp;
}

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
 * proper ws://host or wss://host URL.
 *
 * Returns the entered URL on confirm, or null on cancel.
 */
async function promptForRelayUrl(currentUrl: string): Promise<string | null> {
  const result = await DV2().wait({
    window: { title: "Relay URL" },
    content: `
      <div class="form-group">
        <input type="text" id="rest-api-relay-url-input" value="${escHtml(currentUrl)}" style="width:100%;" placeholder="wss://foundryrestapi.com" autofocus>
        <p class="hint">e.g. <code>wss://foundryrestapi.com</code> or <code>ws://localhost:3010</code></p>
      </div>
    `,
    buttons: [
      {
        action: "save",
        label: "Save",
        default: true,
        // 3rd arg is the DialogV2 instance; its DOM is at `.element`.
        callback: (_e: Event, _b: HTMLButtonElement, dialog: any) => {
          const input = dialog?.element?.querySelector('#rest-api-relay-url-input') as HTMLInputElement;
          return (input?.value || "").trim();
        },
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  }).catch(() => null);

  if (result === null || result === "cancel") return null;

  if (httpBaseFromWsUrl(result) === null) {
    ui.notifications?.error("Invalid relay URL. Must start with ws:// or wss://");
    return null;
  }
  return result;
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
        // Send the stored clientId so the relay identifies THIS world exactly
        // rather than guessing by worldId — which lets the approval UI reliably
        // exclude this world from its own cross-world target list.
        clientId: (game.settings.get(moduleId, SETTINGS.CLIENT_ID) as string) || '',
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

  // pairUrl is relay-controlled — only open a plain http(s) URL.
  if (/^https?:\/\//i.test(pairData.pairUrl)) window.open(pairData.pairUrl, '_blank');

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let resolved = false;

  const dialog = new (DV2())({
    window: { title: 'Upgrading Permissions' },
    content: `
      <p>Approve in the tab that opened. <a href="${safeHttpUrl(pairData.pairUrl)}" target="_blank">Click here</a> if it didn't open.</p>
      <p id="rest-api-upgrade-status" class="notes">Status: <em>Waiting…</em></p>
    `,
    buttons: [
      {
        action: 'cancel',
        label: 'Cancel',
        callback: () => {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
        },
      },
    ],
  });
  dialog.render(true);

  pollInterval = setInterval(async () => {
    if (resolved || !dialog.rendered) {
      clearInterval(pollInterval!);
      resolved = true;
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
        serverFingerprint: await getOrCreateServerFingerprint(),
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
  // pairUrl is relay-controlled — only open a plain http(s) URL.
  if (/^https?:\/\//i.test(pairData.pairUrl)) window.open(pairData.pairUrl, '_blank');

  // Show a waiting dialog that auto-completes when the user approves.
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let resolved = false;

  const dialog = new (DV2())({
    window: { title: 'Waiting for Approval' },
    content: `
      <p>Approve in the tab that opened. <a href="${safeHttpUrl(pairData.pairUrl)}" target="_blank">Click here</a> if it didn't open.</p>
      <p id="rest-api-pair-status" class="notes">Status: <em>Waiting…</em></p>
    `,
    buttons: [
      {
        action: 'cancel',
        label: 'Cancel',
        callback: () => {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
        },
      },
    ],
  });
  dialog.render(true);

  // Poll the status endpoint every 3 seconds.
  pollInterval = setInterval(async () => {
    if (resolved || !dialog.rendered) {
      clearInterval(pollInterval!);
      resolved = true;
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
            serverFingerprint: await getOrCreateServerFingerprint(),
            // Send the existing clientId (if any) so the relay can reuse it on
            // re-pair without relying on the fingerprint surviving in world settings.
            existingClientId: (game.settings.get(moduleId, SETTINGS.CLIENT_ID) as string) || "",
            // Send server origin to distinguish instances sharing a worldId on different ports
            // (e.g. localhost:30000 vs localhost:30001).
            serverOrigin: window.location.origin,
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
        ui.notifications?.info(`Paired! Client ID: ${data.clientId}`);
        new (DV2())({
          window: { title: 'Paired!' },
          content: '<p>Pairing complete. Reload now to connect?</p>',
          buttons: [
            { action: 'reload', label: 'Reload', default: true, callback: () => window.location.reload() },
            { action: 'later', label: 'Later' },
          ],
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

  await DV2().wait({
    window: { title: "Enter Pairing Code" },
    content: `
      <p>Enter the 6-character code from your relay dashboard.</p>
      <div class="form-group">
        <input type="text" id="rest-api-pairing-code-input" maxlength="6"
               style="text-transform:uppercase;font-size:1.5em;text-align:center;letter-spacing:0.3em;width:200px;"
               placeholder="ABC123" autofocus>
      </div>
    `,
    buttons: [
      {
        action: 'connect',
        label: 'Connect',
        default: true,
        callback: async (_e: Event, _b: HTMLButtonElement, dialog: any) => {
          const input = dialog?.element?.querySelector('#rest-api-pairing-code-input') as HTMLInputElement;
          const code = (input?.value || '').toUpperCase().trim();
          if (!code || code.length !== 6) {
            ui.notifications?.error("Please enter a valid 6-character pairing code.");
            return;
          }

          try {
            const httpUrl = httpBaseFromWsUrl(relayUrl);
            if (httpUrl === null) {
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
                serverFingerprint: await getOrCreateServerFingerprint(),
                existingClientId: (game.settings.get(moduleId, SETTINGS.CLIENT_ID) as string) || "",
                serverOrigin: window.location.origin,
              }),
            });

            if (!response.ok) {
              const err = await response.json().catch(() => ({ error: 'Pairing failed' }));
              ui.notifications?.error(`Pairing failed: ${err.error || response.statusText}`);
              return;
            }

            const data = await response.json();
            const finalRelayUrl = data.relayUrl || relayUrl;

            if (data.relayUrl) {
              await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, data.relayUrl);
            }
            await game.settings.set(moduleId, SETTINGS.CONNECTION_TOKEN, data.token);
            await game.settings.set(moduleId, SETTINGS.CLIENT_ID, data.clientId);
            await game.settings.set(moduleId, SETTINGS.PAIRED_RELAY_URL, finalRelayUrl);

            ui.notifications?.info(`Paired! Client ID: ${data.clientId}`);

            new (DV2())({
              window: { title: 'Paired!' },
              content: '<p>Pairing complete. Reload now to connect?</p>',
              buttons: [
                { action: 'reload', label: 'Reload', default: true, callback: () => window.location.reload() },
                { action: 'later', label: 'Later' },
              ],
            }).render(true);
          } catch (error) {
            ModuleLogger.error(`Pairing error:`, error);
            ui.notifications?.error(`Pairing failed: ${error}`);
          }
        },
      },
      { action: 'cancel', label: 'Cancel' },
    ],
    rejectClose: false,
  }).catch(() => {});
}

/**
 * Unpair: notify the relay to remove this browser's connection token and
 * (if no other tokens remain for this world) the world's KnownClients entry,
 * then clear local settings.
 */
async function unpair(): Promise<void> {
  const confirmed = await DV2().confirm({
    window: { title: "Unpair" },
    content: "<p>Remove this browser's connection to the relay?</p>",
    yes: { label: "Unpair" },
    no: { label: "Cancel" },
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

  new (DV2())({
    window: { title: 'Unpaired' },
    content: '<p>Unpaired successfully. Reload now to disconnect?</p>',
    buttons: [
      { action: 'reload', label: 'Reload', default: true, callback: () => window.location.reload() },
      { action: 'later', label: 'Later' },
    ],
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
    ? `<span style="color:green;">Paired</span> (Client: <code>${escHtml(currentClientId || 'legacy')}</code>)`
    : `<span style="color:orange;">Not paired</span>`;

  const corruptedHtml = !urlIsValid
    ? `<p style="color:var(--color-text-hyperlink,#b33);"><b>⚠ Relay URL is invalid.</b> Use <b>Edit URL</b> to fix it or <b>Reset URL</b> to restore the default.</p>`
    : "";

  const mismatchHtml = (urlIsValid && currentToken && pairedUrl && pairedUrl !== relayUrl)
    ? `<p style="color:var(--color-text-hyperlink,#b33);"><b>⚠ URL mismatch:</b> paired to <code>${escHtml(pairedUrl)}</code> but current relay is <code>${escHtml(relayUrl)}</code>. Re-pair to reconnect.</p>`
    : "";

  const content = `
    <div>
      <p><b>Status:</b> ${statusHtml}</p>
      <p><b>Relay:</b> <code>${escHtml(relayUrl) || '(none)'}</code></p>
      ${(pairedUrl && pairedUrl !== relayUrl) ? `<p><b>Paired to:</b> <code>${escHtml(pairedUrl)}</code></p>` : ""}
      ${corruptedHtml}
      ${mismatchHtml}
    </div>
  `;

  const buttons: any[] = [
    {
      action: 'browserPair',
      label: 'Pair',
      default: true,
      callback: () => { void startBrowserPairingFlow(relayUrl); },
    },
    {
      action: 'pair',
      label: 'Enter Code',
      callback: () => { void startPairingFlow(relayUrl); },
    },
  ];

  if (currentToken) {
    buttons.push({
      action: 'upgrade',
      label: 'Upgrade',
      callback: () => { void startBrowserUpgradeFlow(relayUrl); },
    });
  }

  buttons.push(
    {
      action: 'unpair',
      label: 'Unpair',
      callback: () => { void unpair(); },
    },
    {
      action: 'editUrl',
      label: 'Edit URL',
      callback: async () => {
        const newUrl = await promptForRelayUrl(urlIsValid ? relayUrl : DEFAULT_RELAY_URL);
        if (!newUrl) return;
        await game.settings.set(moduleId, SETTINGS.WS_RELAY_URL, newUrl);
        ui.notifications?.info(`Relay URL set to ${newUrl}`);
        openConnectionDialog();
      },
    },
    {
      action: 'reset',
      label: 'Reset URL',
      callback: async () => {
        const confirmed = await DV2().confirm({
          window: { title: "Reset URL" },
          content: `<p>Reset to <code>${DEFAULT_RELAY_URL}</code> and clear all pairing data?</p>`,
        });
        if (!confirmed) return;
        await resetRelayUrl();
        openConnectionDialog();
      },
    },
    {
      action: 'close',
      label: 'Close',
    },
  );

  new (DV2())({
    window: { title: "REST API Connection" },
    position: { width: 560 },
    // V12 forces dialog footers to a single non-wrapping row — this class lets
    // our many buttons wrap (see style.scss). V13+ wraps natively.
    classes: ["rest-api-connection-dialog"],
    content,
    buttons,
  }).render(true);
}

/**
 * Minimal ApplicationV2 stub so that `game.settings.registerMenu` can open
 * the connection dialog from the Foundry settings UI.
 */
export class ConnectionSettingsApp extends ((foundry as any).applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rest-api-connection-settings",
    window: { title: "REST API Connection" },
  };

  protected async _renderHTML(): Promise<string> { return ""; }

  render(_force?: boolean, _options?: any): any {
    openConnectionDialog();
    return this;
  }
}
