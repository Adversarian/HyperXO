import { useState, useCallback } from 'react';
import type { GameState } from '../types';
import SmallBoard from './SmallBoard';

interface Props {
  game: GameState;
  onCellClick: (boardIndex: number, cellIndex: number) => void;
  disabled: boolean;
  targeting?: {
    mode: 'board' | 'opponent-cell';
    validBoards: Set<number>;
    opponentSymbol?: string;
  } | null;
  flashBoards?: Map<number, string>;
  siegeCells?: Map<number, Set<number>>;
  conquestBonusBoards?: Set<number>;
  gravityMoves?: Map<number, number>;
  gravityBoardIdx?: number;
}

export default function BigBoard({ game, onCellClick, disabled, targeting, flashBoards, siegeCells, conquestBonusBoards, gravityMoves, gravityBoardIdx }: Props) {
  const [hoverTarget, setHoverTarget] = useState<number | null>(null);

  const availableByBoard = new Map<number, Set<number>>();
  for (const m of game.availableMoves) {
    if (!availableByBoard.has(m.board)) {
      availableByBoard.set(m.board, new Set());
    }
    availableByBoard.get(m.board)!.add(m.cell);
  }

  const activeBoards = new Set(game.availableBoards);

  const handleCellHover = useCallback((cellIdx: number | null) => {
    if (cellIdx === null) {
      setHoverTarget(null);
      return;
    }
    // The opponent will be sent to board `cellIdx` — unless that board is resolved
    const dest = game.boards[cellIdx];
    if (dest.winner || dest.drawn || dest.condemned) {
      setHoverTarget(null); // free move — no specific target
    } else {
      setHoverTarget(cellIdx);
    }
  }, [game.boards]);

  return (
    <div className="grid grid-cols-3 grid-rows-3 gap-1 sm:gap-3 p-1.5 sm:p-4 rounded-xl sm:rounded-2xl bg-zinc-900/80 border border-zinc-700/50 shadow-2xl">
      {game.boards.map((board) => {
        const isValidTarget = targeting?.validBoards.has(board.index) ?? false;
        return (
          <SmallBoard
            key={board.index}
            board={board}
            bigIndex={board.index}
            isActive={!targeting && activeBoards.has(board.index)}
            availableCells={targeting ? new Set() : (availableByBoard.get(board.index) ?? new Set())}
            lastMove={targeting ? undefined : game.lastMove}
            onCellClick={onCellClick}
            onCellHover={!targeting && !disabled ? handleCellHover : undefined}
            disabled={!!targeting || disabled}
            targetMode={isValidTarget ? targeting!.mode : null}
            opponentSymbol={targeting?.opponentSymbol}
            flashColor={flashBoards?.get(board.index)}
            siegeCells={siegeCells?.get(board.index)}
            isHoverTarget={hoverTarget === board.index}
            currentPlayer={game.currentPlayer}
            isBonusBoard={conquestBonusBoards?.has(board.index)}
            gravityMoves={gravityBoardIdx === board.index ? gravityMoves : undefined}          />
        );
      })}
    </div>
  );
}
