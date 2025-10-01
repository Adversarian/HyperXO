# HyperXO

HyperXO is a Python implementation of hyper tic-tac-toe (also known as Ultimate Tic-Tac-Toe).
It provides a FastAPI-powered backend with a browser-based UI and a minimax AI with adjustable
search depth.

## Features

- Full HyperXO rules, including directed moves and board resolution
- FastAPI backend with JSON endpoints for game orchestration
- Responsive web UI rendered from a single-page experience
- Peer-to-peer friend matches with WebRTC signaling and QR-code invites
- Minimax AI with three difficulty levels (depths 1, 3, and 6)
- Unit tests covering the core game logic and API surface
- `uv`-managed project metadata with Docker support for local development

## Getting Started

### Prerequisites

- Python 3.11+
- [`uv`](https://github.com/astral-sh/uv) for dependency management

### Install dependencies

```bash
uv sync --all-extras
```

This installs the project in editable mode along with the optional `dev` dependencies (e.g., `pytest`).

### Running the game locally

```bash
uv run uvicorn hyperxo.ui:app --reload
```

Navigate to <http://127.0.0.1:8000> to play in the browser. Use the difficulty selector to choose
between the depth 1, 3, or 6 minimax opponents before starting a new game.

### Playing with friends

Select **Play with a friend** on the landing screen to enable peer-to-peer matchmaking. You can:

- **Create a room** to generate a six-character invite code, shareable link, and QR code.
- **Join a room** by entering an existing invite code or opening the shared link.

All gameplay traffic flows through a direct WebRTC data channel between browsers; the FastAPI
backend only coordinates the initial signaling handshake.

### Running tests

```bash
uv run pytest
```

## Docker development environment

A Docker setup is provided to run the application without installing Python locally.

```bash
docker compose up --build
```

The container exposes the FastAPI service on port 8000. Open <http://127.0.0.1:8000> in your
browser after the container is running.

## Project layout

```
.
├── pyproject.toml        # Project metadata (managed by uv)
├── src/hyperxo/          # Package source
├── tests/                # Pytest suite
├── docker-compose.yml    # Docker compose for local development
└── Dockerfile            # Image definition
```
