# HyperXO Agent Guide

This repository implements HyperXO: a native desktop app (Tauri) with a React/TypeScript frontend,
a client-side minimax AI, and peer-to-peer multiplayer via an embedded WebSocket signaling server.

## Architecture overview

- `frontend/src/engine/game.ts` contains the authoritative game rules, board state, Zobrist hashing,
  and make/unmake move support. All game logic runs client-side in the browser/webview.
- `frontend/src/engine/ai.ts` houses the minimax AI with alpha-beta pruning, iterative deepening,
  transposition table, move ordering, and card-aware evaluation. Depths 3, 5, and 8 are the
  supported difficulty levels.
- `frontend/src/engine/powerups.ts` defines all gambit cards, draft system, and card effect functions.
- `frontend/src/engine/ai-gambits.ts` contains the AI's card decision system: ban selection,
  draft generation, simulation-based card evaluation, urgency multiplier, and deep verify.
- `frontend/src/components/` contains the React UI: menu, game board, lobby, multiplayer views.
- `frontend/src/api.ts` handles room creation and WebSocket connections, with automatic detection
  of Tauri vs browser mode. In Tauri, it uses Tauri commands and the WebSocket plugin; in the
  browser, it uses standard fetch/WebSocket.
- `frontend/src-tauri/` is the Tauri desktop app:
  - `src/signaling.rs` — embedded warp WebSocket signaling server that also serves the built
    frontend to phone browsers joining via QR code.
  - `src/lib.rs` — Tauri commands for room creation and signaling info.

## Implementation guidelines

- All game state mutations happen through `game.ts`. UI components should never modify board
  state directly.
- The AI uses `applyMove`/`undoMove` (make/unmake pattern) for zero-allocation search. Never
  clone game state in the search tree.
- The Tauri webview loads from `http://127.0.0.1:29170` (the embedded signaling server) to avoid
  CSP and mixed-content issues with WebSocket connections.
- WebSocket connections in Tauri use `tauri-plugin-websocket` (Rust-side) to bypass webview
  restrictions. Browser clients use native WebSocket.
- Player colors: X = cyan, O = rose. Won boards use opaque overlays.

## Game modes

- **Classic** — standard Ultimate Tic-Tac-Toe rules (complete a row, column, or diagonal of won boards on the macro grid).
- **Sudden Death** — first player to win any single board wins the game.
- **Misère** — completing a row, column, or diagonal of won boards means that player *loses*.
- **Gambits** — ban phase + draft-based tactical cards with active abilities and passive doctrines.
  Full AI support with card-aware evaluation, urgency-based timing, and mode-specific adjustments.
  See `GAMBITS.md` for the full design document.

## Tooling & testing

- Frontend dependencies: `cd frontend && npm install`
- Tests: `cd frontend && npx vitest run` (game engine + AI tests)
- Desktop build: `cd frontend && npx tauri build` (requires Rust toolchain)
- Dev server: `cd frontend && npx vite --host`

## CI/CD

- GitHub Actions workflow at `.github/workflows/release.yml` builds for Linux, macOS (ARM + Intel),
  and Windows on every published release using `tauri-action`.

## Desktop app details

- Tauri config: `frontend/src-tauri/tauri.conf.json`
- Signaling server port: 29170 (hardcoded in `lib.rs`)
- The signaling server embeds the built frontend via `include_dir` at compile time
- Room creation uses `ureq` from Rust to call the local signaling API
- Local IP detection uses `local-ip-address` crate for QR invite URLs
