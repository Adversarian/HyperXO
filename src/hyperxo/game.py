"""Core game logic for the HyperXO variant of tic-tac-toe."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

Player = str


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


@dataclass
class SmallBoard:
    """Represents a single 3x3 tic-tac-toe board."""

    cells: List[Optional[Player]] = field(default_factory=lambda: [None] * 9)
    winner: Optional[Player] = None
    drawn: bool = False

    def play(self, index: int, player: Player) -> None:
        if self.winner or self.drawn:
            raise ValueError("Cannot play on a finished board")
        if not 0 <= index < 9:
            raise ValueError("Cell index out of range")
        if self.cells[index] is not None:
            raise ValueError("Cell already taken")
        self.cells[index] = player
        self._update_state()

    def available_moves(self) -> List[int]:
        if self.winner or self.drawn:
            return []
        return [i for i, cell in enumerate(self.cells) if cell is None]

    def _update_state(self) -> None:
        for a, b, c in WINNING_LINES:
            if self.cells[a] and self.cells[a] == self.cells[b] == self.cells[c]:
                self.winner = self.cells[a]
                return
        if all(cell is not None for cell in self.cells):
            self.drawn = True

    def clone(self) -> "SmallBoard":
        clone = SmallBoard()
        clone.cells = self.cells.copy()
        clone.winner = self.winner
        clone.drawn = self.drawn
        return clone


@dataclass
class HyperXOGame:
    """Game state manager for HyperXO."""

    boards: List[SmallBoard] = field(default_factory=lambda: [SmallBoard() for _ in range(9)])
    current_player: Player = "X"
    next_board_index: Optional[int] = None
    winner: Optional[Player] = None
    drawn: bool = False

    def clone(self) -> "HyperXOGame":
        return HyperXOGame(
            boards=[board.clone() for board in self.boards],
            current_player=self.current_player,
            next_board_index=self.next_board_index,
            winner=self.winner,
            drawn=self.drawn,
        )

    def play_move(self, board_index: int, cell_index: int) -> None:
        if self.winner or self.drawn:
            raise ValueError("Game already finished")
        if not 0 <= board_index < 9:
            raise ValueError("Board index out of range")
        target_board = self.boards[board_index]
        if self.next_board_index is not None and board_index != self.next_board_index:
            if not self.is_board_available(self.next_board_index):
                self.next_board_index = None
            elif board_index != self.next_board_index:
                raise ValueError("Must play on the directed board")
        if self.next_board_index is None and not self.is_board_available(board_index):
            raise ValueError("Board not available")

        target_board.play(cell_index, self.current_player)
        self._update_overall_state()
        self.next_board_index = cell_index
        if self.next_board_index is not None and not self.is_board_available(self.next_board_index):
            self.next_board_index = None
        self._swap_player()

    def _swap_player(self) -> None:
        self.current_player = "O" if self.current_player == "X" else "X"

    def is_board_available(self, board_index: int) -> bool:
        board = self.boards[board_index]
        return not (board.winner or board.drawn)

    def available_moves(self) -> List[Tuple[int, int]]:
        if self.winner or self.drawn:
            return []
        if self.next_board_index is not None and self.is_board_available(self.next_board_index):
            boards = [self.next_board_index]
        else:
            boards = [i for i in range(9) if self.is_board_available(i)]
        moves: List[Tuple[int, int]] = []
        for board_index in boards:
            board = self.boards[board_index]
            for cell in board.available_moves():
                moves.append((board_index, cell))
        return moves

    def _update_overall_state(self) -> None:
        board_winners = [board.winner for board in self.boards]
        for a, b, c in WINNING_LINES:
            if board_winners[a] and board_winners[a] == board_winners[b] == board_winners[c]:
                self.winner = board_winners[a]
                return
        if all(board.winner or board.drawn for board in self.boards):
            self.drawn = True

    def big_board_state(self) -> List[Optional[Player]]:
        return [board.winner for board in self.boards]

    def reset(self) -> None:
        self.boards = [SmallBoard() for _ in range(9)]
        self.current_player = "X"
        self.next_board_index = None
        self.winner = None
        self.drawn = False


def format_board(game: HyperXOGame) -> str:
    """Return a human-readable string of the current state."""

    def cell_repr(board: SmallBoard, idx: int) -> str:
        val = board.cells[idx]
        return val if val else " "

    rows = []
    for big_row in range(3):
        for small_row in range(3):
            row_cells = []
            for big_col in range(3):
                board_index = big_row * 3 + big_col
                board = game.boards[board_index]
                start = small_row * 3
                row_cells.append("|".join(cell_repr(board, start + i) for i in range(3)))
            rows.append(" || ".join(row_cells))
        rows.append("====+=====+====")
    return "\n".join(rows[:-1])
