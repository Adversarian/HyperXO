"""FastAPI-powered web UI for playing HyperXO in the browser."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .ai import MinimaxAI
from .game import HyperXOGame


@dataclass
class GameSession:
    """Container for an active HyperXO game and its AI opponent."""

    game: HyperXOGame
    ai: Optional[MinimaxAI]
    move_log: List[Dict[str, int | str]] = field(default_factory=list)


SESSIONS: Dict[str, GameSession] = {}
app = FastAPI(title="HyperXO", description="Hyper tic-tac-toe played in the browser")


ALLOWED_DEPTHS: Tuple[int, ...] = (1, 3, 6)


class NewGameRequest(BaseModel):
    """Request payload for starting a new game."""

    depth: int = Field(
        default=3,
        ge=1,
        le=6,
        description="Minimax depth controlling AI strength",
    )

    @field_validator("depth")
    @classmethod
    def ensure_supported_depth(cls, value: int) -> int:
        if value not in ALLOWED_DEPTHS:
            raise ValueError(
                f"Unsupported difficulty depth {value}. "
                f"Choose one of {', '.join(map(str, ALLOWED_DEPTHS))}."
            )
        return value


class MoveRequest(BaseModel):
    """Request payload for submitting a move on an existing game."""

    model_config = ConfigDict(populate_by_name=True)

    board_index: int = Field(alias="boardIndex", ge=0, le=8)
    cell_index: int = Field(alias="cellIndex", ge=0, le=8)


def _create_session(depth: int) -> Tuple[str, GameSession]:
    """Create a new game session and register it for later access."""

    game = HyperXOGame()
    ai = MinimaxAI(player="O", depth=depth)
    session = GameSession(game=game, ai=ai)
    session_id = uuid.uuid4().hex
    SESSIONS[session_id] = session
    return session_id, session


def _get_session(game_id: str) -> GameSession:
    try:
        return SESSIONS[game_id]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Game not found") from exc


def _serialize_session(game_id: str, session: GameSession) -> Dict[str, object]:
    game = session.game
    boards: List[Dict[str, object]] = []
    for index, board in enumerate(game.boards):
        boards.append(
            {
                "index": index,
                "cells": board.cells,
                "winner": board.winner,
                "drawn": board.drawn,
            }
        )

    available_moves = [
        {"board": board_index, "cell": cell_index}
        for board_index, cell_index in game.available_moves()
    ]
    available_boards = sorted({move["board"] for move in available_moves})

    state: Dict[str, object] = {
        "id": game_id,
        "currentPlayer": game.current_player,
        "nextBoardIndex": game.next_board_index,
        "winner": game.winner,
        "drawn": game.drawn,
        "boards": boards,
        "availableMoves": available_moves,
        "availableBoards": available_boards,
        "moveLog": session.move_log,
    }
    if session.move_log:
        state["lastMove"] = session.move_log[-1]
    return state


def _apply_player_move(session: GameSession, board_index: int, cell_index: int) -> None:
    game = session.game
    if game.winner or game.drawn:
        raise HTTPException(status_code=400, detail="Game already finished")

    allowed_moves = {(b, c) for b, c in game.available_moves()}
    if (board_index, cell_index) not in allowed_moves:
        raise HTTPException(status_code=400, detail="Move is not allowed on this turn")

    player = game.current_player
    try:
        game.play_move(board_index, cell_index)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    session.move_log.append(
        {"player": player, "boardIndex": board_index, "cellIndex": cell_index}
    )

    if (
        session.ai
        and not game.winner
        and not game.drawn
        and game.current_player == session.ai.player
    ):
        ai_player = game.current_player
        ai_board, ai_cell = session.ai.choose(game)
        game.play_move(ai_board, ai_cell)
        session.move_log.append(
            {"player": ai_player, "boardIndex": ai_board, "cellIndex": ai_cell}
        )


@app.post("/api/game")
def create_game(request: NewGameRequest) -> Dict[str, object]:
    depth = int(request.depth)
    game_id, session = _create_session(depth)
    return _serialize_session(game_id, session)


@app.get("/api/game/{game_id}")
def get_game(game_id: str) -> Dict[str, object]:
    session = _get_session(game_id)
    return _serialize_session(game_id, session)


@app.post("/api/game/{game_id}/move")
def make_move(game_id: str, request: MoveRequest) -> Dict[str, object]:
    session = _get_session(game_id)
    _apply_player_move(session, request.board_index, request.cell_index)
    return _serialize_session(game_id, session)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return HTML_PAGE


HTML_PAGE = """<!DOCTYPE html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>HyperXO</title>
    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />
    <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />
    <link
      href=\"https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap\"
      rel=\"stylesheet\"
    />
    <style>
      :root {
        color-scheme: light dark;
        font-family: 'Poppins', system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;
        font-weight: 400;
      }
      body {
        margin: 0;
        background: radial-gradient(circle at top, #f2f5ff, #dbe0ff 40%, #cfd8ff 70%);
        min-height: 100vh;
        display: flex;
        justify-content: center;
        padding: 2rem 1rem 3rem;
      }
      main {
        background: rgba(255, 255, 255, 0.86);
        border-radius: 18px;
        box-shadow: 0 24px 48px rgba(34, 47, 79, 0.18);
        padding: 2rem;
        width: min(960px, 100%);
      }
      h1 {
        margin-top: 0;
        font-size: clamp(1.8rem, 2.4vw + 1.2rem, 2.6rem);
        text-align: center;
        letter-spacing: 0.06em;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        justify-content: center;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      label {
        font-weight: 600;
      }
      select, button {
        font-size: 1rem;
        padding: 0.45rem 0.75rem;
        border-radius: 999px;
        border: 1px solid rgba(60, 70, 120, 0.25);
        background: white;
        cursor: pointer;
        transition: transform 0.1s ease, box-shadow 0.1s ease;
      }
      button:hover, select:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 18px rgba(0, 64, 128, 0.12);
      }
      button:disabled {
        cursor: default;
        opacity: 0.6;
        transform: none;
        box-shadow: none;
      }
      #status {
        text-align: center;
        font-size: 1.1rem;
        font-weight: 600;
        margin-bottom: 1rem;
      }
      #message {
        text-align: center;
        min-height: 1.25rem;
        color: #b00020;
        font-weight: 600;
        margin-bottom: 1rem;
      }
      .board-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
      }
      .small-board {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.35rem;
        padding: 0.5rem;
        border-radius: 12px;
        background: linear-gradient(160deg, rgba(240, 244, 255, 0.9), rgba(213, 222, 255, 0.9));
        border: 2px solid transparent;
        position: relative;
        transition: transform 0.2s ease, box-shadow 0.2s ease, border 0.2s ease;
      }
      .small-board.required {
        border-color: #3a66ff;
        box-shadow: 0 12px 24px rgba(58, 102, 255, 0.25);
      }
      .small-board.inactive {
        opacity: 0.6;
      }
      .small-board.winner-x {
        background: linear-gradient(140deg, rgba(216, 244, 219, 0.95), rgba(163, 230, 180, 0.9));
        border-color: #0f8f3a;
      }
      .small-board.winner-o {
        background: linear-gradient(140deg, rgba(255, 221, 221, 0.95), rgba(252, 181, 181, 0.9));
        border-color: #d64545;
      }
      .small-board.drawn {
        background: linear-gradient(140deg, rgba(226, 229, 240, 0.9), rgba(210, 214, 226, 0.9));
        border-color: rgba(120, 120, 140, 0.6);
      }
      .cell {
        aspect-ratio: 1 / 1;
        font-size: clamp(1.2rem, 3vw, 2.2rem);
        font-weight: 700;
        color: #203050;
        background: rgba(255, 255, 255, 0.95);
        border: 2px solid rgba(80, 100, 160, 0.25);
        border-radius: 10px;
        display: grid;
        place-items: center;
        transition: transform 0.1s ease, box-shadow 0.1s ease;
      }
      .cell:hover:not(:disabled) {
        transform: translateY(-2px) scale(1.02);
        box-shadow: 0 6px 16px rgba(50, 80, 160, 0.25);
      }
      .cell:disabled {
        background: rgba(240, 240, 240, 0.8);
        color: rgba(30, 30, 30, 0.7);
      }
      .cell.last-move {
        box-shadow: 0 0 0 3px rgba(58, 102, 255, 0.55);
      }
      .legend {
        margin-top: 1.5rem;
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: center;
        font-size: 0.95rem;
        color: rgba(30, 35, 60, 0.8);
      }
      @media (max-width: 720px) {
        main {
          padding: 1.5rem;
        }
        .board-grid {
          gap: 0.5rem;
        }
        .small-board {
          gap: 0.25rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>HyperXO</h1>
      <div class=\"controls\">
        <label for=\"difficulty\">AI difficulty</label>
        <select id=\"difficulty\">
          <option value=\"1\">Beginner (depth 1)</option>
          <option value=\"3\" selected>Contender (depth 3)</option>
          <option value=\"6\">Grandmaster (depth 6)</option>
        </select>
        <button id=\"new-game\">Start new game</button>
      </div>
      <div id=\"status\">Loading game…</div>
      <div id=\"message\" role=\"status\"></div>
      <div id=\"board\" class=\"board-grid\"></div>
      <div class=\"legend\">
        <span>Blue border: required board for your next move</span>
        <span>Green / Red board: won by X or O</span>
        <span>Grey board: drawn and unavailable</span>
      </div>
    </main>
    <script>
      const boardContainer = document.getElementById('board');
      const statusEl = document.getElementById('status');
      const messageEl = document.getElementById('message');
      const difficultyEl = document.getElementById('difficulty');
      const newGameButton = document.getElementById('new-game');
      let gameId = null;
      let gameState = null;
      let isRequestPending = false;

      async function startGame() {
        if (isRequestPending) return;
        isRequestPending = true;
        messageEl.textContent = '';
        const allowedDepths = [1, 3, 6];
        const requestedDepth = Number.parseInt(difficultyEl.value, 10);
        const depth = allowedDepths.includes(requestedDepth) ? requestedDepth : 3;
        try {
          const response = await fetch('/api/game', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ depth })
          });
          if (!response.ok) {
            throw new Error('Unable to start game');
          }
          const data = await response.json();
          setState(data);
        } catch (error) {
          messageEl.textContent = error.message;
        } finally {
          isRequestPending = false;
        }
      }

      async function sendMove(boardIndex, cellIndex) {
        if (isRequestPending || !gameId) return;
        if (gameState?.winner || gameState?.drawn) return;
        isRequestPending = true;
        messageEl.textContent = '';
        try {
          const response = await fetch(`/api/game/${gameId}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ boardIndex, cellIndex })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const detail = payload?.detail || 'Invalid move';
            messageEl.textContent = detail;
            return;
          }
          const data = await response.json();
          setState(data);
        } catch (error) {
          messageEl.textContent = 'Network error. Please try again.';
        } finally {
          isRequestPending = false;
        }
      }

      function setState(data) {
        gameId = data.id;
        gameState = data;
        renderBoard();
        updateStatus();
      }

      function renderBoard() {
        boardContainer.innerHTML = '';
        if (!gameState) return;
        const availableMoves = new Set((gameState.availableMoves || []).map((m) => `${m.board}-${m.cell}`));
        const availableBoards = new Set(gameState.availableBoards || []);
        const lastMove = gameState.lastMove || (gameState.moveLog?.length ? gameState.moveLog[gameState.moveLog.length - 1] : null);

        gameState.boards.forEach((board) => {
          const boardEl = document.createElement('div');
          boardEl.classList.add('small-board');
          boardEl.dataset.board = String(board.index + 1);
          if (board.winner === 'X') {
            boardEl.classList.add('winner-x');
          } else if (board.winner === 'O') {
            boardEl.classList.add('winner-o');
          } else if (board.drawn) {
            boardEl.classList.add('drawn');
          }
          if (gameState.nextBoardIndex !== null) {
            if (gameState.nextBoardIndex === board.index) {
              boardEl.classList.add('required');
            } else if (!availableBoards.has(board.index)) {
              boardEl.classList.add('inactive');
            }
          }

          board.cells.forEach((value, cellIndex) => {
            const cellButton = document.createElement('button');
            cellButton.classList.add('cell');
            cellButton.type = 'button';
            cellButton.textContent = value ?? '';
            const moveKey = `${board.index}-${cellIndex}`;
            const isAllowed = availableMoves.has(moveKey) && !value && !board.winner && !board.drawn;
            if (lastMove && lastMove.boardIndex === board.index && lastMove.cellIndex === cellIndex) {
              cellButton.classList.add('last-move');
            }
            if (isAllowed && !gameState.winner && !gameState.drawn) {
              cellButton.disabled = false;
              cellButton.addEventListener('click', () => sendMove(board.index, cellIndex));
            } else {
              cellButton.disabled = true;
            }
            boardEl.appendChild(cellButton);
          });

          boardContainer.appendChild(boardEl);
        });
      }

      function updateStatus() {
        if (!gameState) {
          statusEl.textContent = 'Loading game…';
          return;
        }
        if (gameState.winner) {
          statusEl.textContent = gameState.winner === 'X' ? 'You win! 🎉' : 'AI wins! 🤖';
          return;
        }
        if (gameState.drawn) {
          statusEl.textContent = 'Draw game. 🤝';
          return;
        }
        if (gameState.currentPlayer === 'X') {
          if (gameState.nextBoardIndex !== null) {
            statusEl.textContent = `Your move — play in board ${gameState.nextBoardIndex + 1}`;
          } else {
            statusEl.textContent = 'Your move — pick any open board';
          }
        } else {
          statusEl.textContent = 'AI is thinking…';
        }
      }

      newGameButton.addEventListener('click', startGame);
      window.addEventListener('load', startGame);
    </script>
  </body>
</html>
"""
