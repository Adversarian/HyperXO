# HyperXO

HyperXO is an implementation of Ultimate Tic-Tac-Toe with a minimax AI,
peer-to-peer multiplayer, and a native desktop app.

## Features

- Full Ultimate Tic-Tac-Toe rules, including directed moves and board resolution
- React + TypeScript frontend with Tailwind CSS
- Minimax AI with alpha-beta pruning, iterative deepening, and transposition tables
- Three difficulty levels: Novax (Easy), Stratix (Medium), Terminus (Hard)
- Choose your symbol (X or O) when playing against AI
- Peer-to-peer friend matches with room codes and QR invites
- Native desktop app via Tauri with embedded signaling server
- Phone players can join by scanning a QR code from the desktop host
- Cross-platform builds (Linux, macOS, Windows) via GitHub Actions

## Getting Started

### Prerequisites

- Node.js 20+
- Rust toolchain (for desktop builds)

### Install dependencies

```bash
cd frontend
npm install
```

### Running in the browser (dev mode)

```bash
cd frontend
npx vite --host
```

Navigate to the URL shown in the terminal. AI games work fully in the browser.
For multiplayer, you'll need the Tauri desktop app running (it includes the signaling server).

### Running the desktop app

```bash
cd frontend
npx tauri dev
```

Or build a release:

```bash
cd frontend
npx tauri build
```

The built executable is in `frontend/src-tauri/target/release/bundle/`.

### Running tests

```bash
cd frontend
npx vitest run
```

## Releasing

To create a new release with cross-platform desktop builds:

```bash
git tag v0.2.0
git push --tags
```

This triggers the CI workflow which builds for Linux, macOS (ARM + Intel), and Windows,
then creates a GitHub release with the executables attached.

## Architecture

```
frontend/
  src/
    engine/          # Client-side game engine + AI (TypeScript)
      game.ts        # Board state, moves, Zobrist hashing, make/unmake
      ai.ts          # Minimax with alpha-beta, TT, move ordering, evaluation
    components/      # React UI components
    api.ts           # Room signaling API (Tauri plugin or fetch)
  src-tauri/         # Tauri desktop app (Rust)
    src/
      lib.rs         # App entry, Tauri commands
      signaling.rs   # Embedded WebSocket signaling server (warp)
```

### How it works

- **AI games** run entirely client-side — no server needed
- **Multiplayer** uses WebSocket signaling to connect two players:
  - Desktop app: embedded Rust signaling server on port 29170
  - Browser dev: proxied through Vite to a backend server
- The desktop app's signaling server also serves the frontend, so a phone
  can scan the QR code and load the game directly from the host

