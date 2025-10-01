"""Entry point for running HyperXO via ``python -m hyperxo``."""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    """Start the FastAPI-powered HyperXO web server."""

    host = os.environ.get("HYPERXO_HOST", "0.0.0.0")
    port = int(os.environ.get("HYPERXO_PORT", "8000"))
    uvicorn.run("hyperxo.ui:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
