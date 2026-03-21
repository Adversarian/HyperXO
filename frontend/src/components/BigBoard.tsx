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
}

export default function BigBoard({ game, onCellClick, disabled, targeting, flashBoards, siegeCells }: Props) {
  const availableByBoard = new Map<number, Set<number>>();
  for (const m of game.availableMoves) {
    if (!availableByBoard.has(m.board)) {
      availableByBoard.set(m.board, new Set());
    }
    availableByBoard.get(m.board)!.add(m.cell);
  }

  const activeBoards = new Set(game.availableBoards);

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
            disabled={!!targeting || disabled}
            targetMode={isValidTarget ? targeting!.mode : null}
            opponentSymbol={targeting?.opponentSymbol}
            flashColor={flashBoards?.get(board.index)}
            siegeCells={siegeCells?.get(board.index)}
          />
        );
      })}
    </div>
  );
}
