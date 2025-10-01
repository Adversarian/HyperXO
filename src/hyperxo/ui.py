"""FastAPI-powered web UI for playing HyperXO in the browser."""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import threading

from fastapi import (
    BackgroundTasks,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
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


ALLOWED_DEPTHS: Tuple[int, ...] = (3, 5, 8)
AI_THINK_DELAY: Tuple[float, float] = (1.0, 2.0)
ROOM_CODE_LENGTH = 6
ROOM_TTL_SECONDS = 60 * 30  # 30 minutes


@dataclass
class Room:
    """In-memory signaling room used for WebRTC peer discovery."""

    room_id: str
    created_at: float = field(default_factory=lambda: time.time())
    host: Optional[WebSocket] = field(default=None, repr=False)
    guest: Optional[WebSocket] = field(default=None, repr=False)

    def other(self, websocket: Optional[WebSocket]) -> Optional[WebSocket]:
        if websocket is self.host:
            return self.guest
        if websocket is self.guest:
            return self.host
        return self.host or self.guest


ROOMS: Dict[str, Room] = {}
ROOM_LOCK = asyncio.Lock()


def _cleanup_rooms() -> None:
    """Remove expired rooms that no longer have connected peers."""

    now = time.time()
    expired = [
        room_id
        for room_id, room in list(ROOMS.items())
        if room.host is None
        and room.guest is None
        and now - room.created_at >= ROOM_TTL_SECONDS
    ]
    for room_id in expired:
        ROOMS.pop(room_id, None)


def _generate_room_code() -> str:
    return uuid.uuid4().hex[:ROOM_CODE_LENGTH].upper()


async def _get_room(room_id: str, create: bool = False) -> Room:
    normalized = room_id.strip().upper()
    async with ROOM_LOCK:
        _cleanup_rooms()
        room = ROOMS.get(normalized)
        if room:
            return room
        if not create:
            raise HTTPException(status_code=404, detail="Room not found")
        room = Room(room_id=normalized)
        ROOMS[normalized] = room
        return room


class NewGameRequest(BaseModel):
    """Request payload for starting a new game."""

    depth: int = Field(
        default=3,
        ge=3,
        le=8,
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
                    "cells": [c if c in ("X", "O") else "" for c in board.cells],
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
            raise HTTPException(
                status_code=400, detail="Move is not allowed on this turn"
            )

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


def _resolve_join_base_url(request: Request) -> str:
    """Determine the best base URL for shareable room links."""

    origin = request.headers.get("origin")
    if origin:
        return origin.rstrip("/")

    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_host:
        scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
        return f"{scheme}://{forwarded_host}".rstrip("/")

    host = request.headers.get("host")
    if host:
        return f"{request.url.scheme}://{host}".rstrip("/")

    return str(request.base_url).rstrip("/")


@app.post("/api/room")
async def create_room(request: Request) -> Dict[str, str]:
    for _ in range(10):
        room_id = _generate_room_code()
        async with ROOM_LOCK:
            _cleanup_rooms()
            if room_id not in ROOMS:
                ROOMS[room_id] = Room(room_id=room_id)
                break
    else:
        raise HTTPException(status_code=500, detail="Unable to allocate room")

    base_url = _resolve_join_base_url(request)
    join_url = f"{base_url}/?room={room_id}"
    return {"roomId": room_id, "joinUrl": join_url}


@app.get("/api/room/{room_id}")
async def inspect_room(room_id: str) -> Dict[str, object]:
    room = await _get_room(room_id)
    available_slots = []
    if room.host is None:
        available_slots.append("host")
    if room.guest is None:
        available_slots.append("guest")
    return {
        "roomId": room.room_id,
        "available": bool(available_slots),
        "availableSlots": available_slots,
    }


@app.websocket("/ws/room/{room_id}")
async def room_signaling(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    normalized = room_id.strip().upper()
    room = await _get_room(normalized, create=True)

    async with ROOM_LOCK:
        role: Optional[str]
        if room.host is None:
            room.host = websocket
            role = "host"
        elif room.guest is None:
            room.guest = websocket
            role = "guest"
        else:
            role = None

    if role is None:
        await websocket.send_json({"type": "error", "message": "Room is full"})
        await websocket.close()
        return

    await websocket.send_json({"type": "role", "role": role})

    if role == "guest":
        other = room.other(websocket)
        if other is not None:
            try:
                await other.send_json({"type": "peer-status", "status": "joined"})
            except RuntimeError:
                pass

    try:
        while True:
            message = await websocket.receive_json()
            target: Optional[WebSocket]
            async with ROOM_LOCK:
                current_room = ROOMS.get(normalized)
                target = current_room.other(websocket) if current_room else None
            if target is not None:
                try:
                    await target.send_json(message)
                except RuntimeError:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        other: Optional[WebSocket] = None
        async with ROOM_LOCK:
            current_room = ROOMS.get(normalized)
            if current_room:
                other = current_room.other(websocket)
                if current_room.host is websocket:
                    current_room.host = None
                if current_room.guest is websocket:
                    current_room.guest = None
                if current_room.host is None and current_room.guest is None:
                    ROOMS.pop(normalized, None)
        if other is not None:
            try:
                await other.send_json({"type": "peer-status", "status": "left"})
            except RuntimeError:
                pass


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
      * {
        box-sizing: border-box;
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
        background: rgba(255, 255, 255, 0.92);
        border-radius: 18px;
        box-shadow: 0 20px 40px rgba(34, 47, 79, 0.16);
        padding: clamp(1.5rem, 4vw, 2.5rem);
        width: min(820px, 100%);
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(1.8rem, 2.4vw + 1.2rem, 2.6rem);
        text-align: center;
        letter-spacing: 0.06em;
        color: #0c1a33;
        text-shadow: 0 2px 6px rgba(9, 24, 46, 0.15);
      }
      .tagline {
        text-align: center;
        margin: 0 0 1.75rem;
        color: rgba(19, 32, 58, 0.75);
        font-weight: 500;
      }
      .panel {
        margin-bottom: 1.75rem;
      }
      .game-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        margin-bottom: 1rem;
      }
      .back-button {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.45rem 0.85rem;
        border-radius: 12px;
        background: rgba(226, 232, 255, 0.6);
        border: 1px solid rgba(58, 102, 255, 0.25);
        color: #132347;
        font-weight: 600;
      }
      .back-button:hover {
        background: rgba(206, 220, 255, 0.85);
      }
      .back-button .icon {
        font-size: 1.1rem;
        line-height: 1;
      }
      .mode-picker {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: center;
        margin-bottom: 2rem;
      }
      button,
      select,
      input[type='text'] {
        font-size: 1rem;
        padding: 0.55rem 0.95rem;
        border-radius: 999px;
        border: 1px solid rgba(60, 70, 120, 0.25);
        background: white;
        cursor: pointer;
        transition: transform 0.1s ease, box-shadow 0.1s ease;
        font-family: inherit;
      }
      button:hover,
      select:hover,
      input[type='text']:focus {
        transform: translateY(-1px);
        box-shadow: 0 8px 18px rgba(0, 64, 128, 0.12);
        outline: none;
      }
      button:disabled {
        cursor: default;
        opacity: 0.6;
        transform: none;
        box-shadow: none;
      }
      .secondary {
        background: rgba(226, 232, 255, 0.9);
      }
      label {
        font-weight: 600;
        margin-right: 0.5rem;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        justify-content: center;
        align-items: center;
      }
      .peer-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        justify-content: center;
        align-items: center;
        margin-bottom: 1rem;
      }
      .join-group {
        display: flex;
        flex-wrap: nowrap;
        gap: 0.5rem;
        align-items: center;
      }
      .join-group input[type='text'] {
        width: 8.5rem;
        text-transform: uppercase;
        text-align: center;
        letter-spacing: 0.2em;
      }
      .invite {
        display: grid;
        gap: 0.75rem;
        justify-items: center;
        padding: 1rem;
        border-radius: 16px;
        background: linear-gradient(150deg, rgba(236, 243, 255, 0.9), rgba(206, 222, 255, 0.85));
        border: 1px solid rgba(58, 102, 255, 0.25);
        margin-bottom: 1rem;
      }
      .code-badge {
        font-size: 1.65rem;
        font-weight: 700;
        letter-spacing: 0.35em;
        color: #1a2c5a;
        background: rgba(255, 255, 255, 0.85);
        padding: 0.5rem 1rem;
        border-radius: 999px;
        box-shadow: 0 12px 24px rgba(58, 102, 255, 0.25);
      }
      .link-box {
        padding: 0.45rem 0.75rem;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.9);
        font-size: 0.95rem;
        word-break: break-all;
        border: 1px dashed rgba(58, 102, 255, 0.3);
      }
      .peer-status {
        text-align: center;
        font-weight: 600;
        color: #1f2b52;
        min-height: 1.5rem;
      }
      .hidden {
        display: none !important;
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
      .cell-mark {
        font-size: clamp(1.4rem, 3vw, 2.1rem);
        font-weight: 700;
        line-height: 1;
        text-shadow: 0 2px 6px rgba(20, 32, 58, 0.18);
        display: inline-block;
      }
      .cell-mark.x {
        color: #f04a6a;
      }
      .cell-mark.o {
        color: #3a7bff;
      }
      .board-winner {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .board-winner .cell-mark {
        font-size: clamp(2.8rem, 6vw, 4.2rem);
      }
      .legend {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        margin: 1.5rem auto 0;
        max-width: 28rem;
        text-align: center;
        font-size: 0.95rem;
        color: rgba(18, 38, 74, 0.8);
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
      @media (max-width: 720px) {
        main {
          padding: 1.25rem;
        }
        .board-grid {
          gap: 0.45rem;
          max-width: 100%;
        }
        .small-board {
          gap: 0.22rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>HyperXO</h1>
      <p class=\"tagline\">Battle the AI or duel a friend in hyper tic-tac-toe.</p>
      <div id=\"mode-picker\" class=\"panel mode-picker\">
        <button id=\"choose-ai\">Play vs AI</button>
        <button id=\"choose-peer\">Play with a friend</button>
      </div>
      <section id=\"ai-setup\" class=\"panel hidden\">
        <div class=\"controls\">
          <label for=\"difficulty\">AI difficulty</label>
          <select id=\"difficulty\">
            <option value=\"3\">Beginner (depth 3)</option>
            <option value=\"5\" selected>Contender (depth 5)</option>
            <option value=\"8\">Grandmaster (depth 8)</option>
          </select>
          <button id=\"new-game\">Start new game</button>
        </div>
      </section>
      <section id=\"peer-setup\" class=\"panel hidden\">
        <div class=\"peer-actions\">
          <button id=\"create-room\">Create room</button>
          <div class=\"join-group\">
            <input id=\"join-code\" type=\"text\" inputmode=\"numeric\" autocomplete=\"off\" maxlength=\"6\" placeholder=\"ROOM\" aria-label=\"Room code\" />
            <button id=\"join-room\">Join</button>
          </div>
        </div>
        <div id=\"invite-details\" class=\"invite hidden\" aria-live=\"polite\">
          <p>Share this code with your friend:</p>
          <div id=\"invite-code\" class=\"code-badge\"></div>
          <p>Or send them this link:</p>
          <div id=\"invite-link\" class=\"link-box\"></div>
          <canvas id=\"invite-qr\" width=\"160\" height=\"160\" aria-label=\"Room QR code\"></canvas>
          <p class=\"hint\">They can scan the QR code to join instantly.</p>
        </div>
        <div id=\"peer-status\" class=\"peer-status\"></div>
      </section>
        <section id=\"game-area\" class=\"panel hidden\">
          <div class=\"game-toolbar\">
            <button id=\"go-back\" class=\"back-button\" type=\"button\">
              <span class=\"icon\" aria-hidden=\"true\">&#8592;</span>
              <span class=\"label\">Back</span>
            </button>
          </div>
          <div id=\"status\">Choose a mode to start playing.</div>
        <div id=\"message\" role=\"status\"></div>
        <div id=\"board\" class=\"board-grid\"></div>
        <div class=\"legend\">
          <span>Blue border: required board for your next move</span>
          <span>Large X or O overlay: board captured by that player</span>
          <span>Grey board: drawn and unavailable</span>
        </div>
        <div class=\"controls\">
          <button id=\"leave-room\" class=\"secondary hidden\">Leave peer match</button>
        </div>
      </section>
    </main>
    <script src=\"https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js\"></script>
    <script>
      const allowedDepths = [3, 5, 8];
      const modePicker = document.getElementById('mode-picker');
      const chooseAiButton = document.getElementById('choose-ai');
      const choosePeerButton = document.getElementById('choose-peer');
      const aiSetup = document.getElementById('ai-setup');
      const peerSetup = document.getElementById('peer-setup');
      const gameArea = document.getElementById('game-area');
      const boardContainer = document.getElementById('board');
      const statusEl = document.getElementById('status');
      const messageEl = document.getElementById('message');
      const difficultyEl = document.getElementById('difficulty');
      const newGameButton = document.getElementById('new-game');
      const createRoomButton = document.getElementById('create-room');
      const joinCodeInput = document.getElementById('join-code');
      const joinRoomButton = document.getElementById('join-room');
      const inviteDetails = document.getElementById('invite-details');
      const inviteCodeEl = document.getElementById('invite-code');
      const inviteLinkEl = document.getElementById('invite-link');
      const inviteQrCanvas = document.getElementById('invite-qr');
      const peerStatusEl = document.getElementById('peer-status');
      const leaveRoomButton = document.getElementById('leave-room');
      const goBackButton = document.getElementById('go-back');

      let gameMode = null;
      let gameId = null;
      let gameState = null;
      let isRequestPending = false;
      let aiPollHandle = null;

      let roomId = null;
      let peerConnection = null;
      let dataChannel = null;
      let signalingSocket = null;
      let isHost = false;
      let myMark = null;
      let peerReady = false;
      let localGame = null;

      class HyperXOClientGame {
        constructor(state) {
          this.boards = Array.from({ length: 9 }, (_, index) => ({
            index,
            cells: Array(9).fill(''),
            winner: null,
            drawn: false,
          }));
          this.currentPlayer = 'X';
          this.nextBoardIndex = null;
          this.winner = null;
          this.drawn = false;
          this.moveLog = [];
          if (state) {
            this.applyState(state);
          }
        }

        static winningTriples = [
          [0, 1, 2],
          [3, 4, 5],
          [6, 7, 8],
          [0, 3, 6],
          [1, 4, 7],
          [2, 5, 8],
          [0, 4, 8],
          [2, 4, 6],
        ];

        static hasWin(values, player) {
          return HyperXOClientGame.winningTriples.some((line) =>
            line.every((index) => values[index] === player)
          );
        }

        boardIsAvailable(index) {
          const board = this.boards[index];
          if (!board) return false;
          if (board.winner || board.drawn) return false;
          return board.cells.some((cell) => !cell);
        }

        computeAvailableMoves() {
          if (this.winner || this.drawn) {
            return [];
          }
          const moves = [];
          const forced =
            typeof this.nextBoardIndex === 'number' && this.boardIsAvailable(this.nextBoardIndex)
              ? [this.nextBoardIndex]
              : null;
          const boardIndexes = forced || this.boards.map((_, index) => index);
          boardIndexes.forEach((boardIndex) => {
            if (!this.boardIsAvailable(boardIndex)) {
              return;
            }
            const board = this.boards[boardIndex];
            board.cells.forEach((value, cellIndex) => {
              if (!value) {
                moves.push({ board: boardIndex, cell: cellIndex });
              }
            });
          });
          return moves;
        }

        isMoveAllowed(boardIndex, cellIndex) {
          return this.computeAvailableMoves().some(
            (move) => move.board === boardIndex && move.cell === cellIndex
          );
        }

        playMove(player, boardIndex, cellIndex) {
          if (this.winner || this.drawn) {
            throw new Error('Game already finished');
          }
          if (player !== this.currentPlayer) {
            throw new Error("Not this player's turn");
          }
          const board = this.boards[boardIndex];
          if (!board) {
            throw new Error('Invalid board');
          }
          if (board.winner || board.drawn) {
            throw new Error('Board already resolved');
          }
          if (!this.isMoveAllowed(boardIndex, cellIndex)) {
            throw new Error('Move is not allowed on this turn');
          }
          if (board.cells[cellIndex]) {
            throw new Error('Cell already occupied');
          }
          board.cells[cellIndex] = player;
          if (HyperXOClientGame.hasWin(board.cells, player)) {
            board.winner = player;
            board.drawn = false;
          } else if (board.cells.every((cell) => cell)) {
            board.drawn = true;
          }
          this.moveLog.push({ player, boardIndex, cellIndex });
          this.nextBoardIndex = cellIndex;
          if (!this.boardIsAvailable(this.nextBoardIndex)) {
            this.nextBoardIndex = null;
          }
          this.updateMacroOutcome();
          this.currentPlayer = player === 'X' ? 'O' : 'X';
        }

        updateMacroOutcome() {
          const winners = this.boards.map((board) => board.winner || null);
          if (HyperXOClientGame.hasWin(winners, 'X')) {
            this.winner = 'X';
            this.drawn = false;
            return;
          }
          if (HyperXOClientGame.hasWin(winners, 'O')) {
            this.winner = 'O';
            this.drawn = false;
            return;
          }
          this.winner = null;
          const movesRemaining = this.computeAvailableMoves();
          const boardsOpen = this.boards.some(
            (board) => !board.winner && !board.drawn && board.cells.some((cell) => !cell)
          );
          this.drawn = !this.winner && movesRemaining.length === 0 && !boardsOpen;
        }

        serialize() {
          const boards = this.boards.map((board) => ({
            index: board.index,
            cells: [...board.cells],
            winner: board.winner,
            drawn: board.drawn,
          }));
          const availableMoves = this.computeAvailableMoves();
          const availableBoards = Array.from(
            new Set(availableMoves.map((move) => move.board))
          ).sort((a, b) => a - b);
          const state = {
            id: null,
            currentPlayer: this.currentPlayer,
            nextBoardIndex: this.nextBoardIndex,
            winner: this.winner,
            drawn: this.drawn,
            boards,
            availableMoves,
            availableBoards,
            moveLog: [...this.moveLog],
          };
          if (this.moveLog.length) {
            state.lastMove = this.moveLog[this.moveLog.length - 1];
          }
          return state;
        }

        applyState(state) {
          this.currentPlayer = state.currentPlayer || 'X';
          this.nextBoardIndex =
            typeof state.nextBoardIndex === 'number' ? state.nextBoardIndex : null;
          this.winner = state.winner || null;
          this.drawn = Boolean(state.drawn);
          this.moveLog = Array.isArray(state.moveLog)
            ? state.moveLog.map((move) => ({ ...move }))
            : [];
          if (Array.isArray(state.boards)) {
            state.boards.forEach((boardState, index) => {
              const board = this.boards[index];
              if (!boardState) return;
              board.cells = Array.isArray(boardState.cells)
                ? boardState.cells.map((cell) => (cell === 'X' || cell === 'O' ? cell : ''))
                : Array(9).fill('');
              board.winner = boardState.winner === 'X' || boardState.winner === 'O'
                ? boardState.winner
                : null;
              board.drawn = Boolean(boardState.drawn);
            });
          }
        }

        static fromState(state) {
          const game = new HyperXOClientGame();
          game.applyState(state || {});
          return game;
        }
      }

      function resetUiState() {
        messageEl.textContent = '';
        statusEl.classList.remove('ai-turn');
        boardContainer.classList.remove('thinking');
      }

      function showPanel(panel) {
        [aiSetup, peerSetup].forEach((section) => {
          section.classList.add('hidden');
        });
        if (panel) {
          panel.classList.remove('hidden');
        }
      }

      function showGameArea() {
        gameArea.classList.remove('hidden');
      }

      function hideGameArea() {
        gameArea.classList.add('hidden');
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

      function updateDifficultyLock() {
        if (gameMode !== 'ai') {
          difficultyEl.disabled = false;
          return;
        }
        if (!gameState || gameState.winner || gameState.drawn) {
          difficultyEl.disabled = false;
        } else {
          difficultyEl.disabled = true;
        }
      }

      function returnToModePicker() {
        stopAiPolling();
        closePeerSession();
        gameMode = null;
        gameId = null;
        gameState = null;
        renderBoard();
        resetUiState();
        difficultyEl.disabled = false;
        newGameButton.disabled = false;
        showPanel(null);
        hideGameArea();
        modePicker.classList.remove('hidden');
        statusEl.textContent = 'Choose a mode to start playing.';
        messageEl.textContent = '';
        updateDifficultyLock();
      }

      async function startGame() {
        if (gameMode !== 'ai' || isRequestPending) {
          return;
        }
        isRequestPending = true;
        resetUiState();
        messageEl.textContent = '';
        stopAiPolling();
        gameId = null;
        gameState = null;
        renderBoard();
        statusEl.textContent = 'Setting up your game…';
        difficultyEl.disabled = true;
        newGameButton.disabled = true;
        const requestedDepth = Number.parseInt(difficultyEl.value, 10);
        const depth = allowedDepths.includes(requestedDepth) ? requestedDepth : 3;
        try {
          const response = await fetch('/api/game', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ depth }),
          });
          if (!response.ok) {
            throw new Error('Unable to start game');
          }
          const data = await response.json();
          setState(data);
        } catch (error) {
          messageEl.textContent = error.message || 'Network error. Please try again.';
          difficultyEl.disabled = false;
        } finally {
          newGameButton.disabled = false;
          isRequestPending = false;
        }
      }

      async function pollAiState() {
        aiPollHandle = null;
        if (!gameId || gameMode !== 'ai') return;
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
        if (!gameState || gameState.winner || gameState.drawn) {
          return;
        }
        if (gameMode === 'ai') {
          if (isRequestPending || !gameId) return;
          isRequestPending = true;
          resetUiState();
          statusEl.textContent = 'AI is thinking…';
          statusEl.classList.add('ai-turn');
          boardContainer.classList.add('thinking');
          try {
            const response = await fetch(`/api/game/${gameId}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ boardIndex, cellIndex }),
            });
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}));
              const detail = payload?.detail || 'Invalid move';
              messageEl.textContent = detail;
              resetUiState();
              return;
            }
            const data = await response.json();
            setState(data);
          } catch (error) {
            messageEl.textContent = 'Network error. Please try again.';
            resetUiState();
          } finally {
            isRequestPending = false;
          }
          return;
        }

        if (gameMode === 'p2p') {
          if (!peerReady || !localGame || !dataChannel || dataChannel.readyState !== 'open') {
            messageEl.textContent = 'Waiting for your opponent to connect…';
            return;
          }
          if (myMark !== localGame.currentPlayer) {
            messageEl.textContent = "It's not your turn yet.";
            return;
          }
          try {
            localGame.playMove(myMark, boardIndex, cellIndex);
            const state = localGame.serialize();
            setState(state);
            dataChannel.send(
              JSON.stringify({
                type: 'move',
                boardIndex,
                cellIndex,
                player: myMark,
              })
            );
          } catch (error) {
            messageEl.textContent = error.message;
          }
        }
      }

      function setState(data) {
        if (gameMode === 'ai' && data.id) {
          gameId = data.id;
        }
        gameState = data;
        renderBoard();
        updateStatus();
        updateDifficultyLock();
        if (gameMode === 'ai') {
          if (gameState?.aiPending && !gameState.winner && !gameState.drawn) {
            ensureAiPolling();
          } else {
            stopAiPolling();
          }
        }
      }

      function insertMark(container, player, options = {}) {
        const mark = document.createElement('span');
        mark.classList.add('cell-mark', player === 'X' ? 'x' : 'o');
        mark.textContent = player;
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
        const availableMoves = new Set(
          (gameState.availableMoves || []).map((move) => `${move.board}-${move.cell}`)
        );
        const availableBoards = new Set(gameState.availableBoards || []);
        const lastMove =
          gameState.lastMove ||
          (gameState.moveLog?.length ? gameState.moveLog[gameState.moveLog.length - 1] : null);

        gameState.boards.forEach((board) => {
          const boardEl = document.createElement('div');
          boardEl.classList.add('small-board');
          boardEl.dataset.board = String(board.index + 1);
          if (board.winner === 'X' || board.winner === 'O') {
            boardEl.classList.add('winner');
          } else if (board.drawn) {
            boardEl.classList.add('drawn');
          }
          if (gameState.nextBoardIndex !== null && typeof gameState.nextBoardIndex === 'number') {
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
              cellButton.setAttribute(
                'aria-label',
                value === 'X' ? 'X placed' : 'O placed'
              );
            } else {
              cellButton.setAttribute('aria-label', 'Empty cell');
            }
            const moveKey = `${board.index}-${cellIndex}`;
            const isAllowed =
              availableMoves.has(moveKey) && !value && !board.winner && !board.drawn;
            if (lastMove && lastMove.boardIndex === board.index && lastMove.cellIndex === cellIndex) {
              cellButton.classList.add('last-move');
            }
            const canClick =
              isAllowed &&
              !gameState.winner &&
              !gameState.drawn &&
              (gameMode === 'ai' ||
                (gameMode === 'p2p' && peerReady && myMark === gameState.currentPlayer));
            if (canClick) {
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
        boardContainer.classList.remove('thinking');
        if (!gameState) {
          statusEl.classList.remove('ai-turn');
          if (gameMode === 'ai') {
            statusEl.textContent = 'Choose a difficulty and start a new game.';
          } else if (gameMode === 'p2p') {
            statusEl.textContent = 'Create a room or join one with a code.';
          } else {
            statusEl.textContent = 'Choose a mode to start playing.';
          }
          return;
        }
        if (gameState.winner) {
          statusEl.classList.remove('ai-turn');
          boardContainer.classList.remove('thinking');
          if (gameMode === 'p2p') {
            if (gameState.winner === myMark) {
              statusEl.textContent = 'You win! 🎉';
            } else {
              statusEl.textContent = 'Your friend wins this round! ✨';
            }
          } else {
            statusEl.textContent = gameState.winner === 'X' ? 'You win! 🎉' : 'AI wins! 🤖';
          }
          return;
        }
        if (gameState.drawn) {
          statusEl.classList.remove('ai-turn');
          boardContainer.classList.remove('thinking');
          statusEl.textContent = 'Draw game. 🤝';
          return;
        }
        if (gameMode === 'ai') {
          if (gameState.currentPlayer === 'X') {
            statusEl.classList.remove('ai-turn');
            boardContainer.classList.remove('thinking');
            if (gameState.nextBoardIndex !== null && typeof gameState.nextBoardIndex === 'number') {
              statusEl.textContent = `Your move — play in board ${gameState.nextBoardIndex + 1}`;
            } else {
              statusEl.textContent = 'Your move — pick any open board';
            }
          } else {
            statusEl.textContent = 'AI is thinking…';
            statusEl.classList.add('ai-turn');
            boardContainer.classList.add('thinking');
          }
          return;
        }
        statusEl.classList.remove('ai-turn');
        if (!peerReady || !myMark) {
          statusEl.textContent = 'Waiting for your friend to connect…';
          return;
        }
        if (gameState.currentPlayer === myMark) {
          if (gameState.nextBoardIndex !== null && typeof gameState.nextBoardIndex === 'number') {
            statusEl.textContent = `Your move on board ${gameState.nextBoardIndex + 1}`;
          } else {
            statusEl.textContent = 'Your move — pick any open board';
          }
        } else {
          statusEl.textContent = "Friend's turn…";
        }
      }

      function resetPeerUi() {
        peerStatusEl.textContent = '';
        inviteDetails.classList.add('hidden');
        inviteCodeEl.textContent = '';
        inviteLinkEl.textContent = '';
        joinCodeInput.value = '';
        leaveRoomButton.classList.add('hidden');
        myMark = null;
        peerReady = false;
        roomId = null;
      }

      function closePeerSession({ keepMode = false } = {}) {
        peerReady = false;
        if (dataChannel) {
          try {
            dataChannel.close();
          } catch (error) {
            console.warn('Failed to close data channel', error);
          }
        }
        if (peerConnection) {
          try {
            peerConnection.close();
          } catch (error) {
            console.warn('Failed to close peer connection', error);
          }
        }
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.close();
        }
        dataChannel = null;
        peerConnection = null;
        signalingSocket = null;
        localGame = null;
        if (!keepMode) {
          resetPeerUi();
        }
      }

      function sendSignal(payload) {
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(JSON.stringify(payload));
        }
      }

      function buildShareUrl(code, serverUrl) {
        if (serverUrl) {
          try {
            const parsed = new URL(serverUrl, window.location.href);
            parsed.protocol = window.location.protocol;
            parsed.host = window.location.host;
            parsed.search = `?room=${code}`;
            return parsed.toString();
          } catch (error) {
            console.warn('Falling back to local share URL', error);
          }
        }
        return `${window.location.origin}/?room=${code}`;
      }

      function handlePeerLeft() {
        peerReady = false;
        statusEl.textContent = 'Your friend disconnected.';
        messageEl.textContent = '';
        leaveRoomButton.classList.remove('hidden');
        peerStatusEl.textContent = 'Peer disconnected — create a new room or wait for them to rejoin.';
        if (isHost) {
          setupPeerConnection();
        }
      }

      function bindDataChannel(channel) {
        dataChannel = channel;
        channel.addEventListener('open', () => {
          peerReady = true;
          messageEl.textContent = '';
          peerStatusEl.textContent = 'Connected! Take turns placing marks.';
          leaveRoomButton.classList.remove('hidden');
          if (!localGame) {
            localGame = new HyperXOClientGame();
          }
          if (isHost) {
            const state = localGame.serialize();
            setState(state);
            channel.send(JSON.stringify({ type: 'sync', state }));
          } else {
            channel.send(JSON.stringify({ type: 'sync-request' }));
          }
          updateStatus();
        });
        channel.addEventListener('message', (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'sync' && payload.state) {
              localGame = HyperXOClientGame.fromState(payload.state);
              setState(localGame.serialize());
            } else if (payload.type === 'move') {
              if (!localGame) {
                localGame = new HyperXOClientGame();
              }
              localGame.playMove(payload.player, payload.boardIndex, payload.cellIndex);
              setState(localGame.serialize());
            } else if (payload.type === 'sync-request' && isHost && localGame) {
              channel.send(JSON.stringify({ type: 'sync', state: localGame.serialize() }));
            }
          } catch (error) {
            console.error('Failed to handle peer message', error);
          }
        });
        channel.addEventListener('close', () => {
          peerReady = false;
          if (gameMode === 'p2p') {
            handlePeerLeft();
          }
        });
      }

      function setupPeerConnection() {
        if (dataChannel) {
          try {
            dataChannel.close();
          } catch (error) {
            console.warn('Failed to close existing data channel', error);
          }
          dataChannel = null;
          peerReady = false;
        }
        if (peerConnection) {
          try {
            peerConnection.close();
          } catch (error) {
            console.warn('Failed to close existing peer connection', error);
          }
        }
        const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        peerConnection = new RTCPeerConnection({ iceServers });
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            sendSignal({ type: 'candidate', candidate: event.candidate });
          }
        };
        peerConnection.onconnectionstatechange = () => {
          if (!peerConnection) return;
          const state = peerConnection.connectionState;
          if (state === 'failed' || state === 'disconnected') {
            peerReady = false;
            statusEl.textContent = 'Connection lost. Trying again or create a new room.';
          }
        };
        peerConnection.ondatachannel = (event) => {
          bindDataChannel(event.channel);
        };
        if (isHost) {
          const channel = peerConnection.createDataChannel('hyperxo');
          bindDataChannel(channel);
        }
      }

      async function createAndSendOffer() {
        if (!peerConnection || peerConnection.connectionState === 'closed') {
          return;
        }
        try {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal({ type: 'offer', sdp: offer });
        } catch (error) {
          console.error('Failed to create offer', error);
          peerStatusEl.textContent = 'Unable to negotiate a connection. Please try again.';
        }
      }

      async function connectToRoom(code) {
        closePeerSession({ keepMode: true });
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        signalingSocket = new WebSocket(`${protocol}://${window.location.host}/ws/room/${code}`);
        signalingSocket.addEventListener('open', () => {
          peerStatusEl.textContent = 'Connecting to your opponent…';
        });
        signalingSocket.addEventListener('close', () => {
          if (gameMode === 'p2p' && !peerReady) {
            peerStatusEl.textContent = 'Signaling connection closed. Try creating a new room.';
          }
        });
        signalingSocket.addEventListener('message', async (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'role') {
              isHost = payload.role === 'host';
              myMark = isHost ? 'X' : 'O';
              peerStatusEl.textContent = isHost
                ? 'Room ready — waiting for your friend to join.'
                : 'Joining room — finishing setup…';
              localGame = isHost ? new HyperXOClientGame() : null;
              setupPeerConnection();
              updateStatus();
              return;
            }
            if (payload.type === 'offer' && peerConnection) {
              await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
              const answer = await peerConnection.createAnswer();
              await peerConnection.setLocalDescription(answer);
              sendSignal({ type: 'answer', sdp: answer });
              return;
            }
            if (payload.type === 'answer' && peerConnection) {
              await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
              return;
            }
            if (payload.type === 'candidate' && peerConnection && payload.candidate) {
              try {
                await peerConnection.addIceCandidate(payload.candidate);
              } catch (error) {
                console.warn('Failed to add ICE candidate', error);
              }
              return;
            }
            if (payload.type === 'peer-status') {
              if (payload.status === 'joined') {
                peerStatusEl.textContent = 'Peer joined — negotiating connection…';
                if (isHost) {
                  if (!peerConnection || peerConnection.connectionState === 'closed') {
                    setupPeerConnection();
                  }
                  await createAndSendOffer();
                }
              } else if (payload.status === 'left') {
                handlePeerLeft();
              }
              return;
            }
            if (payload.type === 'error') {
              messageEl.textContent = payload.message || 'Unable to join room.';
            }
          } catch (error) {
            console.error('Failed to process signaling message', error);
          }
        });
      }

      function applyInviteDetails(code, joinUrl) {
        const shareUrl = buildShareUrl(code, joinUrl);
        inviteCodeEl.textContent = code;
        inviteLinkEl.textContent = shareUrl;
        inviteDetails.classList.remove('hidden');
        if (window.QRCode) {
          QRCode.toCanvas(
            inviteQrCanvas,
            shareUrl,
            { width: 180, margin: 1, color: { dark: '#13203a', light: '#ffffff' } },
            (error) => {
              if (error) {
                console.error('QR generation failed', error);
              }
            }
          );
        }
      }

      async function handleCreateRoom() {
        resetPeerUi();
        messageEl.textContent = '';
        createRoomButton.disabled = true;
        try {
          const response = await fetch('/api/room', { method: 'POST' });
          if (!response.ok) {
            throw new Error('Unable to create a room.');
          }
          const data = await response.json();
          roomId = data.roomId;
          applyInviteDetails(roomId, data.joinUrl);
          connectToRoom(roomId);
        } catch (error) {
          messageEl.textContent = error.message || 'Failed to create room.';
          resetPeerUi();
        } finally {
          createRoomButton.disabled = false;
        }
      }

      async function handleJoinRoom() {
        messageEl.textContent = '';
        const code = joinCodeInput.value.trim().toUpperCase();
        if (!code) {
          messageEl.textContent = 'Enter a room code to join.';
          return;
        }
        try {
          const response = await fetch(`/api/room/${code}`);
          if (!response.ok) {
            throw new Error('Room not found or no longer available.');
          }
          const data = await response.json();
          if (!data.available) {
            throw new Error('That room is already full.');
          }
          roomId = data.roomId;
          connectToRoom(roomId);
        } catch (error) {
          messageEl.textContent = error.message || 'Unable to join room.';
        }
      }

      function enterAiMode() {
        gameMode = 'ai';
        stopAiPolling();
        closePeerSession();
        gameId = null;
        gameState = null;
        renderBoard();
        resetUiState();
        modePicker.classList.add('hidden');
        showPanel(aiSetup);
        showGameArea();
        leaveRoomButton.classList.add('hidden');
        messageEl.textContent = '';
        difficultyEl.disabled = false;
        newGameButton.disabled = false;
        statusEl.textContent = 'Choose a difficulty and start a new game.';
        updateDifficultyLock();
      }

      function enterPeerMode(autoJoinCode = null) {
        gameMode = 'p2p';
        stopAiPolling();
        closePeerSession();
        gameId = null;
        gameState = null;
        renderBoard();
        resetUiState();
        messageEl.textContent = '';
        statusEl.textContent = 'Create a room or join one with a code.';
        modePicker.classList.add('hidden');
        showPanel(peerSetup);
        showGameArea();
        leaveRoomButton.classList.add('hidden');
        difficultyEl.disabled = false;
        newGameButton.disabled = false;
        updateDifficultyLock();
        if (autoJoinCode) {
          joinCodeInput.value = autoJoinCode.toUpperCase();
          handleJoinRoom();
        }
      }

      chooseAiButton.addEventListener('click', enterAiMode);
      choosePeerButton.addEventListener('click', () => enterPeerMode());
      newGameButton.addEventListener('click', startGame);
      createRoomButton.addEventListener('click', handleCreateRoom);
      joinRoomButton.addEventListener('click', handleJoinRoom);
      goBackButton.addEventListener('click', returnToModePicker);
      joinCodeInput.addEventListener('input', () => {
        joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      });
      leaveRoomButton.addEventListener('click', () => {
        closePeerSession();
        peerStatusEl.textContent = 'You left the match. Create a new room or join another.';
        statusEl.textContent = 'Waiting to start a new peer match.';
        gameState = null;
        renderBoard();
      });

      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room');
      if (roomParam) {
        enterPeerMode(roomParam);
      }
    </script>
  </body>
</html>
"""

