"""Core rules and fast hashing for HyperXO (Ultimate Tic-Tac-Toe)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple
import random

Player = str  # "X" or "O"

WINNING_LINES: Tuple[Tuple[int, int, int], ...] = (
    (0, 1, 2),
    (3, 4, 5),
    (6, 7, 8),
    (0, 3, 6),
    (1, 4, 7),
    (2, 5, 8),
    (0, 4, 8),
    (2, 4, 6),
)


# ---------- Small board ----------


@dataclass
class SmallBoard:
    # Server-internal: 'X', 'O', or ' ' (space) for empty
    cells: List[str] = field(default_factory=lambda: [" "] * 9)
    winner: Optional[Player] = None
    drawn: bool = False

    def is_full(self) -> bool:
        return all(c != " " for c in self.cells)

    def place(self, player: Player, idx: int) -> None:
        if self.winner or self.drawn:
            raise ValueError("Board already resolved")
        if self.cells[idx] != " ":
            raise ValueError("Cell already occupied")
        self.cells[idx] = player
        self._update_state()

    def _update_state(self) -> None:
        # Detect local winner
        for a, b, c in WINNING_LINES:
            v = self.cells[a]
            if v != " " and v == self.cells[b] == self.cells[c]:
                self.winner = v
                self.drawn = False
                return
        # Detect local draw
        if self.is_full():
            self.winner = None
            self.drawn = True


# ---------- Zobrist hashing ----------


class Zobrist:
    """
    64-bit Zobrist keys:
    - piece_table[big][cell][pieceIndex] for pieceIndex: 0->'X', 1->'O'
    - side_to_move toggler
    - next_board_index key for 0..8 plus 9 => free (None)
    """

    def __init__(self, seed: int = 7777):
        rng = random.Random(seed)
        self.piece_table = [
            [[rng.getrandbits(64) for _ in range(2)] for _ in range(9)]
            for _ in range(9)
        ]
        self.side_to_move = rng.getrandbits(64)
        self.next_board_key = [rng.getrandbits(64) for _ in range(10)]

    def piece_key(self, big: int, cell: int, player: Player) -> int:
        return self.piece_table[big][cell][0 if player == "X" else 1]

    def stm_key(self) -> int:
        return self.side_to_move

    def nbi_key(self, nbi: Optional[int]) -> int:
        return self.next_board_key[nbi if nbi is not None else 9]


# ---------- Game ----------


@dataclass
class HyperXOGame:
    boards: List[SmallBoard] = field(
        default_factory=lambda: [SmallBoard() for _ in range(9)]
    )
    current_player: Player = "X"
    # UI relies on this name; None means "free move" (no forced board)
    next_board_index: Optional[int] = None
    winner: Optional[Player] = None
    drawn: bool = False

    # Zobrist internals
    _zobrist: Zobrist = field(default_factory=Zobrist, init=False, repr=False)
    _zkey: int = field(default=0, init=False, repr=False)

    def __post_init__(self) -> None:
        # Build initial hash: empty position, encode side and forced board (None)
        if self.current_player == "O":
            self._zkey ^= self._zobrist.stm_key()
        self._zkey ^= self._zobrist.nbi_key(self.next_board_index)

    # ---- API used by UI & AI ----

    def big_board_state(self) -> List[str]:
        """
        Returns 9 chars summarizing each small board:
        'X' or 'O' if captured, 'G' if drawn (grey), '.' if ongoing.
        """
        out: List[str] = []
        for b in self.boards:
            if b.winner == "X":
                out.append("X")
            elif b.winner == "O":
                out.append("O")
            elif b.drawn:
                out.append("G")
            else:
                out.append(".")
        return out

    def available_moves(self) -> List[Tuple[int, int]]:
        """All legal (bigIndex, cellIndex) moves given the 'send' rule."""

        def live(i: int) -> bool:
            b = self.boards[i]
            return not b.winner and not b.drawn and not b.is_full()

        moves: List[Tuple[int, int]] = []
        # If forced board is live, must play there; otherwise free anywhere live
        if self.next_board_index is not None and live(self.next_board_index):
            i = self.next_board_index
            b = self.boards[i]
            for j, c in enumerate(b.cells):
                if c == " ":
                    moves.append((i, j))
            return moves

        for i, b in enumerate(self.boards):
            if live(i):
                for j, c in enumerate(b.cells):
                    if c == " ":
                        moves.append((i, j))
        return moves

    def play_move(self, big: int, cell: int) -> None:
        """Apply a legal move, update local/macro state, forced board, and hash."""
        if self.winner or self.drawn:
            raise ValueError("Game already finished")

        # Quick legality gate (server already checks, but keep robust)
        legal = {(i, j) for (i, j) in self.available_moves()}
        if (big, cell) not in legal:
            raise ValueError("Illegal move for the current position")

        # Remove old forced-board component
        self._zkey ^= self._zobrist.nbi_key(self.next_board_index)

        # Place on small board
        self.boards[big].place(self.current_player, cell)
        # Hash in the placed piece
        self._zkey ^= self._zobrist.piece_key(big, cell, self.current_player)

        # Update macro result
        self._update_global_state()

        # Compute next forced board from the cell just played
        target = cell
        # If target board is resolved/full, free move (None); else force there
        if target is not None:
            tb = self.boards[target]
            self.next_board_index = (
                None if (tb.winner or tb.drawn or tb.is_full()) else target
            )

        # Add new forced-board component
        self._zkey ^= self._zobrist.nbi_key(self.next_board_index)

        # Switch player and toggle side-to-move
        self.current_player = "O" if self.current_player == "X" else "X"
        self._zkey ^= self._zobrist.stm_key()

    def clone(self) -> "HyperXOGame":
        g = HyperXOGame(
            boards=[
                SmallBoard(cells=b.cells.copy(), winner=b.winner, drawn=b.drawn)
                for b in self.boards
            ],
            current_player=self.current_player,
            next_board_index=self.next_board_index,
        )
        g.winner = self.winner
        g.drawn = self.drawn
        # carry over hash state and table to make clones cheap
        g._zobrist = self._zobrist
        g._zkey = self._zkey
        return g

    def zobrist_hash(self) -> int:
        return self._zkey

    # ---- helpers ----

    def _update_global_state(self) -> None:
        bb = self.big_board_state()  # 'X','O','G','.'
        # Macro winner?
        for a, b, c in WINNING_LINES:
            if bb[a] in ("X", "O") and bb[a] == bb[b] == bb[c]:
                self.winner = bb[a]
                self.drawn = False
                return
        # Macro draw? If no legal moves and no winner
        if not self.available_moves():
            self.winner = None
            self.drawn = True

