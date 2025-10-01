"""FastAPI-powered web UI for playing HyperXO in the browser."""

from __future__ import annotations

import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import threading

from fastapi import BackgroundTasks, FastAPI, HTTPException
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
    ai_pending: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


SESSIONS: Dict[str, GameSession] = {}
app = FastAPI(title="HyperXO", description="Hyper tic-tac-toe played in the browser")


ALLOWED_DEPTHS: Tuple[int, ...] = (1, 3, 6)
AI_THINK_DELAY: Tuple[float, float] = (1.0, 2.0)


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


def _run_ai_turn(game_id: str) -> None:
    session = SESSIONS.get(game_id)
    if not session:
        return

    time.sleep(max(0.0, random.uniform(*AI_THINK_DELAY)))

    with session.lock:
        try:
            if not session.ai:
                return
            game = session.game
            if game.winner or game.drawn:
                return
            if game.current_player != session.ai.player:
                return
            board_index, cell_index = session.ai.choose(game)
            game.play_move(board_index, cell_index)
            session.move_log.append(
                {
                    "player": session.ai.player,
                    "boardIndex": board_index,
                    "cellIndex": cell_index,
                }
            )
        finally:
            session.ai_pending = False


def _serialize_session(game_id: str, session: GameSession) -> Dict[str, object]:
    with session.lock:
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
            "moveLog": list(session.move_log),
            "aiPending": session.ai_pending,
        }
        if session.move_log:
            state["lastMove"] = session.move_log[-1]
        return state


def _apply_player_move(
    game_id: str,
    session: GameSession,
    board_index: int,
    cell_index: int,
    background_tasks: Optional[BackgroundTasks] = None,
) -> None:
    should_schedule_ai = False
    with session.lock:
        game = session.game
        if game.winner or game.drawn:
            raise HTTPException(status_code=400, detail="Game already finished")

        if session.ai_pending:
            raise HTTPException(status_code=400, detail="AI is completing its move")

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

        should_schedule_ai = (
            session.ai
            and not game.winner
            and not game.drawn
            and game.current_player == session.ai.player
        )
        if should_schedule_ai:
            session.ai_pending = True

    if should_schedule_ai and background_tasks is not None:
        background_tasks.add_task(_run_ai_turn, game_id)


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
def make_move(
    game_id: str, request: MoveRequest, background_tasks: BackgroundTasks
) -> Dict[str, object]:
    session = _get_session(game_id)
    _apply_player_move(
        game_id, session, request.board_index, request.cell_index, background_tasks
    )
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
        color-scheme: light;
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
        color: #13203a;
        transition: background 0.4s ease;
      }
      main {
        background: rgba(255, 255, 255, 0.9);
        border-radius: 18px;
        box-shadow: 0 20px 40px rgba(34, 47, 79, 0.16);
        padding: 2rem;
        width: min(780px, 100%);
      }
      h1 {
        margin-top: 0;
        font-size: clamp(1.8rem, 2.4vw + 1.2rem, 2.6rem);
        text-align: center;
        letter-spacing: 0.06em;
        color: #0c1a33;
        text-shadow: 0 2px 6px rgba(9, 24, 46, 0.15);
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
        margin: 0 auto 1rem;
        color: #14264a;
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 0.75rem;
      }
      #status.ai-turn::after {
        content: '';
        width: 1.1rem;
        height: 1.1rem;
        border-radius: 999px;
        border: 3px solid rgba(20, 38, 74, 0.2);
        border-top-color: rgba(58, 102, 255, 0.8);
        animation: spin 0.8s linear infinite;
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
        gap: 0.55rem;
        max-width: 640px;
        margin: 0 auto;
        position: relative;
        min-height: min(520px, 90vw);
      }
      .small-board {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.3rem;
        padding: 0.45rem;
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
      .small-board.winner {
        background: rgba(236, 240, 252, 0.9);
        border-color: rgba(18, 42, 90, 0.4);
      }
      .small-board.drawn {
        background: linear-gradient(140deg, rgba(226, 229, 240, 0.9), rgba(210, 214, 226, 0.9));
        border-color: rgba(120, 120, 140, 0.6);
      }
      .cell {
        aspect-ratio: 1 / 1;
        font-size: clamp(1rem, 2.5vw, 1.8rem);
        font-weight: 700;
        color: #203050;
        background: rgba(255, 255, 255, 0.95);
        border: 2px solid rgba(80, 100, 160, 0.25);
        border-radius: 10px;
        display: grid;
        place-items: center;
        position: relative;
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
      .small-board.winner .cell {
        opacity: 0.35;
        pointer-events: none;
      }
      .mark {
        width: 72%;
        height: 72%;
        display: block;
        position: relative;
      }
      .mark::before,
      .mark::after {
        content: '';
        position: absolute;
      }
      .mark-x::before,
      .mark-x::after {
        top: 0;
        left: 50%;
        width: 20%;
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(135deg, rgba(255, 164, 182, 0.98), rgba(240, 58, 103, 0.84));
        box-shadow: 0 12px 22px rgba(214, 44, 88, 0.26);
        transform-origin: center;
      }
      .mark-x::before {
        transform: translateX(-50%) rotate(45deg);
      }
      .mark-x::after {
        transform: translateX(-50%) rotate(-45deg);
      }
      .mark-o::before {
        inset: 0;
        border-radius: 50%;
        background: radial-gradient(
          circle at center,
          rgba(255, 255, 255, 0) 48%,
          rgba(212, 231, 255, 0.3) 58%,
          rgba(150, 194, 255, 0.85) 72%,
          rgba(94, 150, 255, 0.95) 86%,
          rgba(66, 124, 255, 0.98) 100%
        );
        box-shadow: 0 12px 22px rgba(66, 124, 255, 0.28);
      }
      .mark-o::after {
        inset: 18%;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.9);
        box-shadow: inset 0 0 6px rgba(220, 235, 255, 0.5);
        background: radial-gradient(circle at 50% 35%, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0) 72%);
      }
      .board-winner {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .board-winner .mark {
        width: clamp(55%, 9vw, 72%);
        height: clamp(55%, 9vw, 72%);
        filter: drop-shadow(0 18px 28px rgba(18, 36, 72, 0.28));
      }
      .legend {
        margin-top: 1.5rem;
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: center;
        font-size: 0.95rem;
        color: rgba(30, 35, 60, 0.76);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .board-grid.thinking::before {
        content: 'AI is planning the next move…';
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255, 255, 255, 0.92);
        color: #0f2042;
        padding: 0.6rem 1.1rem;
        border-radius: 999px;
        box-shadow: 0 18px 36px rgba(34, 47, 79, 0.18);
        font-weight: 600;
        animation: float 1.8s ease-in-out infinite;
        pointer-events: none;
        white-space: nowrap;
      }
      .board-grid.thinking::after {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, 0.55);
        border-radius: 16px;
        pointer-events: none;
      }
      .board-grid.thinking .cell {
        filter: blur(1px);
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes float {
        0%,
        100% {
          transform: translate(-50%, -52%);
        }
        50% {
          transform: translate(-50%, -48%);
        }
      }
      @media (max-width: 720px) {
        main {
          padding: 1.5rem;
        }
        .board-grid {
          gap: 0.45rem;
          max-width: 100%;
        }
        .small-board {
          gap: 0.22rem;
        }
        .board-grid.thinking::before {
          font-size: 0.85rem;
          padding: 0.5rem 0.9rem;
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
        <span>Large cross or circle overlay: board captured by that player</span>
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
      let aiPollHandle = null;

      async function startGame() {
        if (isRequestPending) return;
        isRequestPending = true;
        messageEl.textContent = '';
        stopAiPolling();
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

      function stopAiPolling() {
        if (aiPollHandle !== null) {
          clearTimeout(aiPollHandle);
          aiPollHandle = null;
        }
      }

      function ensureAiPolling() {
        if (aiPollHandle !== null) return;
        aiPollHandle = window.setTimeout(pollAiState, 450);
      }

      async function pollAiState() {
        aiPollHandle = null;
        if (!gameId) return;
        try {
          const response = await fetch(`/api/game/${gameId}`);
          if (!response.ok) {
            return;
          }
          const data = await response.json();
          setState(data);
        } catch (error) {
          console.error('Polling failed', error);
        } finally {
          if (gameState?.aiPending && !gameState.winner && !gameState.drawn) {
            ensureAiPolling();
          }
        }
      }

      async function sendMove(boardIndex, cellIndex) {
        if (isRequestPending || !gameId) return;
        if (gameState?.winner || gameState?.drawn) return;
        isRequestPending = true;
        messageEl.textContent = '';
        statusEl.textContent = 'AI is thinking…';
        statusEl.classList.add('ai-turn');
        boardContainer.classList.add('thinking');
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
            statusEl.classList.remove('ai-turn');
            boardContainer.classList.remove('thinking');
            return;
          }
          const data = await response.json();
          setState(data);
        } catch (error) {
          messageEl.textContent = 'Network error. Please try again.';
          statusEl.classList.remove('ai-turn');
          boardContainer.classList.remove('thinking');
        } finally {
          isRequestPending = false;
        }
      }

      function setState(data) {
        gameId = data.id;
        gameState = data;
        renderBoard();
        updateStatus();
        if (gameState?.aiPending && !gameState.winner && !gameState.drawn) {
          ensureAiPolling();
        } else {
          stopAiPolling();
        }
      }

      function insertMark(container, player, options = {}) {
        const mark = document.createElement('span');
        mark.classList.add('mark', player === 'X' ? 'mark-x' : 'mark-o');
        mark.setAttribute('aria-hidden', 'true');
        container.appendChild(mark);
        const { includeSrText = true } = options;
        if (includeSrText) {
          const srOnly = document.createElement('span');
          srOnly.classList.add('sr-only');
          srOnly.textContent = player === 'X' ? 'Player X' : 'Player O';
          container.appendChild(srOnly);
        }
      }

      function renderBoard() {
        boardContainer.innerHTML = '';
        boardContainer.classList.remove('thinking');
        if (!gameState) return;
        const availableMoves = new Set((gameState.availableMoves || []).map((m) => `${m.board}-${m.cell}`));
        const availableBoards = new Set(gameState.availableBoards || []);
        const lastMove = gameState.lastMove || (gameState.moveLog?.length ? gameState.moveLog[gameState.moveLog.length - 1] : null);

        gameState.boards.forEach((board) => {
          const boardEl = document.createElement('div');
          boardEl.classList.add('small-board');
          boardEl.dataset.board = String(board.index + 1);
          if (board.winner === 'X' || board.winner === 'O') {
            boardEl.classList.add('winner');
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
            cellButton.innerHTML = '';
            if (value === 'X' || value === 'O') {
              insertMark(cellButton, value);
              cellButton.setAttribute('aria-label', value === 'X' ? 'Cross placed' : 'Circle placed');
            } else {
              cellButton.setAttribute('aria-label', 'Empty cell');
            }
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

          if (board.winner === 'X' || board.winner === 'O') {
            const overlay = document.createElement('div');
            overlay.classList.add('board-winner');
            overlay.setAttribute('role', 'img');
            overlay.setAttribute(
              'aria-label',
              board.winner === 'X' ? 'Board won by Player X' : 'Board won by Player O'
            );
            insertMark(overlay, board.winner, { includeSrText: false });
            boardEl.appendChild(overlay);
          }

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
          statusEl.classList.remove('ai-turn');
          return;
        }
        if (gameState.drawn) {
          statusEl.textContent = 'Draw game. 🤝';
          statusEl.classList.remove('ai-turn');
          return;
        }
        if (gameState.currentPlayer === 'X') {
          statusEl.classList.remove('ai-turn');
          if (gameState.nextBoardIndex !== null) {
            statusEl.textContent = `Your move — play in board ${gameState.nextBoardIndex + 1}`;
          } else {
            statusEl.textContent = 'Your move — pick any open board';
          }
        } else {
          statusEl.textContent = 'AI is thinking…';
          statusEl.classList.add('ai-turn');
          if (!gameState.winner && !gameState.drawn) {
            boardContainer.classList.add('thinking');
          }
        }
      }

      newGameButton.addEventListener('click', startGame);
      window.addEventListener('load', startGame);
    </script>
  </body>
</html>
"""
