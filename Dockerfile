FROM ghcr.io/astral-sh/uv:python3.11-bookworm

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY src ./src
COPY tests ./tests

RUN uv sync --frozen --all-extras

CMD ["uv", "run", "uvicorn", "hyperxo.ui:app", "--host", "0.0.0.0", "--port", "8000"]
