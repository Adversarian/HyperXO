"""Depth-limited Minimax AI with move ordering + transposition table for HyperXO."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple, List
import math

from .game import HyperXOGame, Player, WINNING_LINES


# TT entry flags
EXACT, LOWER, UPPER = 0, 1, 2


@dataclass
class TTEntry:
    depth: int
    score: float
    flag: int
    best_move: Optional[Tuple[int, int]]


@dataclass
class MinimaxAI:
    """AI player that uses alpha–beta with move ordering + a transposition table.

    Public surface stays the same so ui.py doesn't need changes:
      - MinimaxAI(player="O", depth=3)
      - choose(game) -> (board_index, cell_index)
    """

    player: Player
    depth: int = 3
    _tt: Dict[int, TTEntry] = field(default_factory=dict, repr=False)

    # ---- public API ----

    def choose(self, game: HyperXOGame) -> Tuple[int, int]:
        if game.current_player != self.player:
            raise ValueError("It is not this AI player's turn")

        # Iterative deepening for stable move ordering (up to self.depth)
        alpha, beta = -math.inf, math.inf
        best_move: Optional[Tuple[int, int]] = None

        for d in range(1, max(1, self.depth) + 1):
            score, move = self._minimax(game, d, alpha, beta, True)
            if move is not None:
                best_move = move
            # Small aspiration window around last score (optional micro-boost)
            alpha = score - 50.0
            beta = score + 50.0

        if best_move is None:
            # Fallback to first legal move
            moves = game.available_moves()
            if not moves:
                raise RuntimeError("No valid moves available")
            best_move = moves[0]
        return best_move

    # ---- core search ----

    def _minimax(
        self,
        game: HyperXOGame,
        depth: int,
        alpha: float,
        beta: float,
        maximizing: bool,
    ) -> Tuple[float, Optional[Tuple[int, int]]]:
        # Terminal/leaf
        if depth == 0 or game.winner or game.drawn:
            return self._evaluate(game), None

        key = self._hash(game)

        # TT probe
        tt_hit = self._tt.get(key)
        if tt_hit and tt_hit.depth >= depth:
            if tt_hit.flag == EXACT:
                return tt_hit.score, tt_hit.best_move
            if tt_hit.flag == LOWER:
                alpha = max(alpha, tt_hit.score)
            elif tt_hit.flag == UPPER:
                beta = min(beta, tt_hit.score)
            if alpha >= beta:
                return tt_hit.score, tt_hit.best_move

        # Move ordering: sort by heuristic, seed with TT best if present
        moves = list(game.available_moves())
        if tt_hit and tt_hit.best_move in moves:
            # Try PV move first by bumping its key
            pv = tt_hit.best_move
            moves.remove(pv)  # type: ignore[arg-type]
            moves.insert(0, pv)  # type: ignore[arg-type]

        moves.sort(key=lambda m: self._move_heuristic(game, m), reverse=True)

        best_move: Optional[Tuple[int, int]] = None

        if maximizing:
            value = -math.inf
            for move in moves:
                child = game.clone()
                child.play_move(*move)
                score, _ = self._minimax(child, depth - 1, alpha, beta, False)
                if score > value:
                    value, best_move = score, move
                alpha = max(alpha, value)
                if alpha >= beta:
                    break
            flag = EXACT if best_move is not None else LOWER
        else:
            value = math.inf
            for move in moves:
                child = game.clone()
                child.play_move(*move)
                score, _ = self._minimax(child, depth - 1, alpha, beta, True)
                if score < value:
                    value, best_move = score, move
                beta = min(beta, value)
                if alpha >= beta:
                    break
            flag = EXACT if best_move is not None else UPPER

        # Store in TT
        self._tt[key] = TTEntry(
            depth=depth, score=value, flag=flag, best_move=best_move
        )
        return value, best_move

    # ---- heuristics & eval ----

    def _hash(self, game: HyperXOGame) -> int:
        # Fast 64-bit key from game
        return game.zobrist_hash()

    def _is_winning_move_local(
        self, board_cells: List[str], player: Player, cell: int
    ) -> bool:
        # Board cell must be currently empty
        if board_cells[cell] != " ":
            return False
        for a, b, c in WINNING_LINES:
            if cell not in (a, b, c):
                continue
            trio = [board_cells[a], board_cells[b], board_cells[c]]
            if trio.count(player) == 2 and trio.count(" ") == 1:
                return True
        return False

    def _two_in_a_row_threats(self, board_cells: List[str], player: Player) -> int:
        cnt = 0
        for a, b, c in WINNING_LINES:
            trio = [board_cells[a], board_cells[b], board_cells[c]]
            if trio.count(player) == 2 and trio.count(" ") == 1:
                cnt += 1
        return cnt

    def _move_heuristic(self, game: HyperXOGame, move: Tuple[int, int]) -> float:
        """Lightweight ordering score: win/block locally; send-quality; geometry."""
        i, j = move
        me: Player = self.player
        opp: Player = "O" if me == "X" else "X"
        board = game.boards[i]

        # 1) Local tactical: winning/blocking moves first
        if self._is_winning_move_local(board.cells, me, j):
            return 1_000.0
        if self._is_winning_move_local(board.cells, opp, j):
            return 900.0

        score = 0.0

        # 2) Send heuristic: where does this punt the opponent?
        target_idx = j
        tgt = game.boards[target_idx]
        if tgt.winner == me:
            score += 6.0  # forcing them into your captured board tends to be good
        elif tgt.winner == opp:
            score -= 6.0  # gifting them a free move
        elif tgt.drawn or all(c != " " for c in tgt.cells):
            score -= 3.0  # free move for them (usually neutral-to-bad)
        else:
            my_threats = self._two_in_a_row_threats(tgt.cells, me)
            their_threats = self._two_in_a_row_threats(tgt.cells, opp)
            score += 1.5 * my_threats - 1.0 * their_threats

        # 3) Local geometry: center > corner > edge
        score += 0.4 if j == 4 else (0.2 if j in (0, 2, 6, 8) else 0.1)
        return score

    def _evaluate(self, game: HyperXOGame) -> float:
        me: Player = self.player
        opp: Player = "O" if me == "X" else "X"

        # Terminal clarity
        if game.winner == me:
            return 10_000.0
        if game.winner == opp:
            return -10_000.0
        if game.drawn:
            return 0.0

        score = 0.0

        # Macro summary; 'G' (drawn) blocks lines entirely
        bb = game.big_board_state()  # 'X','O','G','.'
        for a, b, c in WINNING_LINES:
            marks = [bb[a], bb[b], bb[c]]
            if "G" in marks:  # grayed board kills the line
                continue
            m = marks.count(me)
            o = marks.count(opp)
            if m and o:
                continue
            if m:
                score += 4**m
            if o:
                score -= 4**o

        # Macro geometry nudges
        if bb[4] == me:
            score += 0.6
        elif bb[4] == opp:
            score -= 0.6
        for k in (0, 2, 6, 8):
            if bb[k] == me:
                score += 0.3
            elif bb[k] == opp:
                score -= 0.3

        # Micro-board detail on unresolved boards
        for b in game.boards:
            if b.winner == me:
                score += 2.0
                continue
            if b.winner == opp:
                score -= 2.0
                continue
            if b.drawn:
                continue

            # Line-based potential
            for a, c, d in WINNING_LINES:
                trio = [b.cells[a], b.cells[c], b.cells[d]]
                if opp not in trio:
                    cnt = trio.count(me)
                    if cnt == 1:
                        score += 1.0
                    elif cnt == 2:
                        score += 5.0
                if me not in trio:
                    cnto = trio.count(opp)
                    if cnto == 1:
                        score -= 1.0
                    elif cnto == 2:
                        score -= 5.0

            # Center emphasis on live micro-boards
            if b.cells[4] == me:
                score += 0.3
            elif b.cells[4] == opp:
                score -= 0.3

        return score

