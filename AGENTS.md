# HyperXO Agent Guide

This repository implements HyperXO: a FastAPI backend with a browser-based UI, a minimax AI, and
peer-to-peer friend play powered by WebRTC data channels. Keep the following guidelines in mind
when making changes.

## Architecture overview
- `src/hyperxo/game.py` contains the authoritative HyperXO rules, board resolution, and cloning
  utilities used by both the API and the AI. Preserve the pure, side-effect-free design of this
  module.
- `src/hyperxo/ai.py` houses the minimax implementation with depths 1, 3, and 6. When adjusting
  heuristics or branching limits, ensure the public interface (`MinimaxAI.choose`) remains
  deterministic and synchronous.
- `src/hyperxo/ui.py` bundles the FastAPI app, REST endpoints, WebRTC signaling helpers, and the
  single-page HTML/JS UI. Keep signaling (room creation, websocket relay, QR invites) and UI assets
  colocated here unless the architecture is intentionally refactored into dedicated modules.
- Package exports live in `src/hyperxo/__init__.py`, and the CLI entry point (`python -m hyperxo`)
  should continue to boot the web server defined in `ui.py`.

## Implementation guidelines
- Maintain strict separation between game state mutations (confined to `HyperXOGame`) and transport
  layers. Client or network code should never bypass the model APIs.
- Preserve accessibility affordances in the web UI (ARIA labels, focus management) when updating
  markup or replacing assets.
- Peer-to-peer sessions rely on ephemeral in-memory room state; do not introduce long-lived storage
  without updating this guide.
- Favor modern, declarative CSS within the embedded UI template. Keep gradients and icon styling
  consistent with the existing design language (light red crosses, light blue rings).

## Tooling & testing
- Dependencies are managed with [`uv`](https://github.com/astral-sh/uv). Run `uv sync --all-extras`
  before development and `uv run --extra dev pytest` (or `uv run pytest`) to execute the suite.
- Update `uv.lock` alongside `pyproject.toml` whenever dependencies change.
- Tests belong under `tests/` and should use `pytest`. Cover new game mechanics, API routes, and UI
  contract changes with unit or integration tests as appropriate.

## Docker & local development
- The Docker image is based on `ghcr.io/astral-sh/uv:python3.11-bookworm`. Ensure Dockerfile
  adjustments keep parity with the uvicorn entry point (`hyperxo.ui:app`).
- `docker-compose.yml` exposes the FastAPI service on port 8000 for local play; update compose
  overrides if ports or environment variables change.

## PR expectations
- Summaries should mention UI, AI, signaling, or tooling modifications that affect gameplay.
- Reference notable files or modules touched by the change and call out any migrations impacting
  local development.

