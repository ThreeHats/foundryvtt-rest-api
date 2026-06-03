# Changelog

All notable changes to the FoundryVTT REST API module are documented here.

## [3.2.0] — 2026-06-03

### Added
- **Server fingerprint**: a stable random ID is generated per world on first pairing, stored as a world-scoped setting, and sent to the relay so the same server is re-identified on re-pair — even when world ID slugs collide across different servers.
- **`server-url` action** (`world:info` scope, GM only): returns `{ publicUrl: window.location.origin }` as a fallback for relays that have no stored `publicUrl` for the client.
- **Full sync** (`create` action): a `fullSync` flag threads into Foundry's document options so receiving servers can skip re-syncing (enabling bidirectional sync without loops) and triggers embedded-document reconciliation (see Fixed).
- **Folder UUID preservation** (`create-folder`): optional `folderId` creates the folder with that exact `_id` (idempotent when it already exists), so folders synced between servers share UUIDs instead of duplicating.
- **`create-user` `character` field**: optionally links a player character at creation; accepts a bare actor `_id` or `Actor.<id>` UUID.
- D&D 5e: `spells` now includes per-level `spellSlots` (incl. Warlock Pact Magic); `stats` adds `initBonus`, `deathSaves`, `encumbrance`, and `currency`; `biography` adds `trait`, `ideal`, `bond`, `flaw`, `notes`, `journal`, and `goals`; `features` includes `subclass` items.

### Changed
- All `Dialog`/`FormApplication` usage replaced with `DialogV2`/`ApplicationV2` (available since Foundry v12 — no compatibility break).
- Pairing and connection dialogs simplified: shorter titles, one-line descriptions, trimmed button labels, and a compact status summary instead of verbose per-button text.

### Security
- **Connection dialog XSS**: relay-controlled values (clientId, relay and pairing URLs) are HTML-escaped before rendering, and link/`window.open` targets are restricted to plain `http(s)` — a malicious or compromised relay could previously inject script that ran whenever the GM opened the dialog.
- `server-url` enforces a local GM check rather than relying solely on relay-side scope enforcement.
- The `create` handler's update-in-place path now requires modify/ownership rights on the target document, not just the `*_CREATE` right.

### Fixed
- **Update-in-place** (`create` with `override: true`): an existing document is now updated in place instead of attempting `create()` with `keepId` (which threw) — and the path triggers whenever the incoming `_id` exists, so overrides no longer silently create duplicates with fresh ids.
- **Embedded documents now removed during full sync**: with `fullSync`, embedded docs absent from the incoming data are deleted after the update (fixing effects/items/journal pages lingering on the target server). Embedded collections are derived per-document from Foundry's `metadata.embedded` (so Scenes resolve correctly), and the reconcile skips failed updates, arrays without resolvable ids, and system-derived docs to prevent data loss.
- DialogV2 fixes across the connection UI: button icons render correctly on v12; the Connection dialog footer fits on one row; "Edit URL" / "Enter Code" inputs are read from `dialog.element` (manual relay-URL editing and code entry were silently broken); the dialog gets its intended width and Enter activates "Pair"; saving an empty relay URL shows the validation message instead of closing silently.
- **Unpaired-browser probe**: when the relay is unreachable or returns a transient error, the module stays silent instead of falsely reporting "connected via another GM's browser" or popping the pair dialog.
- `serverFingerprint` persistence is awaited, so a racing save can no longer mint a second fingerprint.

---

## [3.1.0] — 2025

### Added
- Foundry v14 compatibility
- Region support (Foundry v13+ scene regions)
- Improved D&D 5e endpoint coverage
- Improved search index integration

---

## [3.0.3] — 2025

### Fixed
- Spammy disconnection notifications reduced
- WebSocket disconnection handling improvements
- File upload handling improvements

---

## [3.0.0] — 2025

### Added
- Scoped API key permission system
- World pairing flow (replaces direct API key sharing)
- Notification system
- Playlist endpoints
- User management endpoints
- Scene image endpoints
- Experimental interactive sessions
- Foundry-level permission filtering
- Canvas, chat, scene, and roll subscription endpoints
- Hardened security model
