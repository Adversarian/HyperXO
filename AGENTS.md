# HyperXO Agent Guide

This repository contains the HyperXO Python project. Follow these guidelines when working inside
this repo:

## Code style
- Target Python 3.11+ and prefer standard library solutions.
- Keep the FastAPI application, HTTP routes, and web UI assets inside `src/hyperxo/ui.py`.
- WebRTC signaling rooms for peer-to-peer play also live in `src/hyperxo/ui.py`; keep the
  signaling lifecycle (room creation, WebSocket relays, and client HTML/JS) cohesive there.
- Maintain the turn-based rules inside `src/hyperxo/game.py` and AI logic in `src/hyperxo/ai.py`.
- Update this guide if you significantly expand the UI architecture (e.g., move templates or static
  assets out of `ui.py`).
- Tests belong in the `tests/` directory and should use `pytest`.

## Tooling
- Dependency management is handled by [`uv`](https://github.com/astral-sh/uv). Use `uv sync` to
  install dependencies and `uv run` to execute commands.
- Update the `uv.lock` file whenever dependencies change.

## Docker
- The provided `Dockerfile` and `docker-compose.yml` enable local development. Keep them in sync
  with the runtime entry point (`uvicorn hyperxo.ui:app`).

## PR Guidance
- Summaries should mention UI, game logic, tests, and tooling changes when relevant.
- Reference specific modules or files that were touched in the change.
