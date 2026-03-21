import type { BoardState } from '../types';

interface Props {
  board: BoardState;
  bigIndex: number;
  isActive: boolean;
  availableCells: Set<number>;
  lastMove?: { boardIndex: number; cellIndex: number };
  onCellClick: (boardIndex: number, cellIndex: number) => void;
  disabled: boolean;
  targetMode?: 'board' | 'opponent-cell' | null;
  opponentSymbol?: string;
  flashColor?: string | null;
  siegeCells?: Set<number>;
}

const FLASH_CLASSES: Record<string, string> = {
  rose: 'bg-rose-500/40',
  violet: 'bg-violet-500/40',
  amber: 'bg-amber-500/40',
  cyan: 'bg-cyan-500/40',
  emerald: 'bg-emerald-500/40',
  sky: 'bg-sky-500/40',
  zinc: 'bg-zinc-700/60',
  indigo: 'bg-indigo-500/40',
};

export default function SmallBoard({
  board,
  bigIndex,
  isActive,
  availableCells,
  lastMove,
  onCellClick,
  disabled,
  targetMode,
  opponentSymbol,
  flashColor,
  siegeCells,
}: Props) {
  const resolved = board.winner || board.drawn || board.condemned;

  const bgColor = resolved
    ? board.winner === 'X'
      ? 'bg-cyan-500/20 ring-2 ring-cyan-400/50'
      : board.winner === 'O'
        ? 'bg-rose-500/20 ring-2 ring-rose-400/50'
        : board.condemned
          ? 'bg-red-500/10 ring-2 ring-red-500/30'
          : 'bg-zinc-700/30'
    : targetMode === 'board'
      ? 'bg-amber-500/10 ring-2 ring-amber-400/70 shadow-lg shadow-amber-500/20'
      : isActive && !disabled
        ? 'bg-indigo-500/10 ring-2 ring-indigo-400 shadow-lg shadow-indigo-500/20'
        : 'bg-zinc-600/40';

  return (
    <div className={`relative grid grid-cols-3 grid-rows-3 gap-0.5 sm:gap-1 rounded-lg sm:rounded-xl p-1 sm:p-1.5 transition-all duration-200 ${bgColor}`}>
      {/* Won/drawn overlay */}
      {resolved && !targetMode && (
        <div className={`absolute inset-0 z-10 flex items-center justify-center rounded-xl ${
          board.winner === 'X'
            ? 'bg-cyan-950'
            : board.winner === 'O'
              ? 'bg-rose-950'
              : board.condemned
                ? 'bg-red-950/90'
                : 'bg-zinc-900'
        }`}>
          <span className={`text-3xl sm:text-6xl font-black drop-shadow-lg ${
            board.winner === 'X'
              ? 'text-cyan-400'
              : board.winner === 'O'
                ? 'text-rose-400'
                : board.condemned
                  ? 'text-red-500/40 !text-xl sm:!text-4xl'
                  : 'text-zinc-600 !text-xl sm:!text-4xl'
          }`}>
            {board.winner ?? (board.condemned ? '\u2298' : 'Draw')}
          </span>
        </div>
      )}

      {/* Board-level targeting overlay */}
      {targetMode === 'board' && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center rounded-xl cursor-pointer hover:bg-amber-500/20 transition-all"
          onClick={() => onCellClick(bigIndex, 0)}
        >
          <span className="text-amber-400 text-xs sm:text-sm font-semibold opacity-80">Target</span>
        </div>
      )}

      {/* Gambit flash effect */}
      {flashColor && FLASH_CLASSES[flashColor] && (
        <div className={`absolute inset-0 z-30 rounded-xl ${FLASH_CLASSES[flashColor]} animate-gambit-flash pointer-events-none`} />
      )}

      {board.cells.map((cell, cellIdx) => {
        const isTargetCell = targetMode === 'opponent-cell' && cell === opponentSymbol;
        const playable = !targetMode && isActive && availableCells.has(cellIdx) && !disabled;
        const isLastMove =
          lastMove?.boardIndex === bigIndex && lastMove?.cellIndex === cellIdx;
        const isSiegeThreat = siegeCells?.has(cellIdx) && cell === '';

        return (
          <button
            key={cellIdx}
            disabled={!playable && !isTargetCell}
            onClick={() => {
              if (isTargetCell) onCellClick(bigIndex, cellIdx);
              else if (playable) onCellClick(bigIndex, cellIdx);
            }}
            className={`
              relative flex h-8 w-8 items-center justify-center rounded text-sm font-bold transition-all duration-150
              sm:h-14 sm:w-14 sm:text-xl sm:rounded-md
              ${cell === 'X' ? 'text-cyan-400' : cell === 'O' ? 'text-rose-400' : ''}
              ${isLastMove && !targetMode ? 'ring-2 ring-yellow-400/70 bg-yellow-400/10' : ''}
              ${isTargetCell
                ? 'cursor-pointer ring-2 ring-amber-400/70 bg-amber-500/20 hover:bg-amber-500/30 hover:scale-105 active:scale-95'
                : playable
                  ? 'cursor-pointer bg-zinc-700/40 hover:bg-indigo-500/30 hover:scale-105 active:scale-95'
                  : cell
                    ? 'bg-zinc-800/30'
                    : 'bg-zinc-800/20'
              }
            `}
          >
            {cell || null}
            {isSiegeThreat && (
              <div className="absolute inset-0 rounded bg-amber-500/20 animate-siege-pulse pointer-events-none" />
            )}
          </button>
        );
      })}
    </div>
  );
}
