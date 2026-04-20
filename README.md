# Foundry REST API Module

**The Foundry VTT companion module** for the [Foundry REST API](https://github.com/ThreeHats/foundryvtt-rest-api-relay) — connects your Foundry world to a relay server, enabling external tools and automations to interact with your game.

[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/U634xNGRAC)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What Is This?

This module bridges your Foundry VTT world to a relay server via WebSocket, allowing external applications to read and modify your world data through a REST API.

```
┌─────────────────┐      WebSocket       ┌─────────────────┐      REST API      ┌─────────────────┐
│   Foundry VTT   │ ◄──────────────────► │  Relay Server   │ ◄────────────────► │  Your App/Tool  │
│   + This Module │                      │                 │                    │                 │
└─────────────────┘                      └─────────────────┘                    └─────────────────┘
```

**Use cases:** Custom dashboards, MIDI controller integration, Discord bots, Stream Deck triggers, automated testing, and more.

---

## Quick Start

### 1. Install the Module

Add this manifest URL in Foundry VTT (Settings → Add-on Modules → Install Module):

```
https://github.com/ThreeHats/foundryvtt-rest-api/releases/latest/download/module.json
```

### 2. Get an API Key

**Option A: Public Relay (Easiest)**  
Go to **[https://foundryrestapi.com](https://foundryrestapi.com)**, create an account, and copy your API key.

**Option B: Self-Host**  
See the [relay server documentation](https://github.com/ThreeHats/foundryvtt-rest-api-relay) to run your own instance.

### 3. Configure the Module

Enable the module in your world, then go to **Module Settings** and enter:
- Your **API Key**
- The **WebSocket Relay URL** (default: `wss://foundryrestapi.com/`)

### 4. Start Making API Calls

```bash
# List connected worlds
curl -X GET "https://foundryrestapi.com/clients" \
  -H "x-api-key: YOUR_API_KEY"
```

---

## Module Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **WebSocket Relay URL** | `wss://foundryrestapi.com/` | Relay server WebSocket endpoint |
| **API Key** | — | Your API key from the relay server |
| **Log Level** | `info` | Controls module log verbosity (`debug`, `info`, `warn`, `error`) |
| **Ping Interval** | `30` seconds | Keep-alive ping frequency |
| **Max Reconnect Attempts** | `20` | Reconnection attempts on disconnect |
| **Reconnect Base Delay** | `1000` ms | Initial delay before reconnecting (exponential backoff) |
---

## Project Ecosystem

| Component | Description |
|-----------|-------------|
| [**This Module**](https://github.com/ThreeHats/foundryvtt-rest-api) | Foundry VTT module (you are here) |
| [**Relay Server**](https://github.com/ThreeHats/foundryvtt-rest-api-relay) | Node.js server with REST API and WebSocket relay |

---

## Tech Stack

- **TypeScript** module for Foundry VTT
- **WebSocket** communication with automatic reconnection

---

## Links

- 📖 [API Documentation](https://foundryrestapi.com/docs)
- 💬 [Discord Community](https://discord.gg/U634xNGRAC)
- 🖥️ [Relay Server Repository](https://github.com/ThreeHats/foundryvtt-rest-api-relay)

---

## License

MIT © [ThreeHats](https://github.com/ThreeHats)
