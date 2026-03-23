import type { BoardState } from '../types';
import Mark from './Mark';

interface Props {
  board: BoardState;
  bigIndex: number;
  isActive: boolean;
  availableCells: Set<number>;
  lastMove?: { boardIndex: number; cellIndex: number };
  onCellClick: (boardIndex: number, cellIndex: number) => void;
  onCellHover?: (cellIndex: number | null) => void;
  disabled: boolean;
  targetMode?: 'board' | 'opponent-cell' | null;
  opponentSymbol?: string;
  flashColor?: string | null;
  siegeCells?: Set<number>;
  isHoverTarget?: boolean;
  currentPlayer?: string;
  isBonusBoard?: boolean;
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

const WIN_LINES: [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/** Find the first winning line's start and end cell indices. */
function getWinLine(cells: string[], winner: string): [number, number] | null {
  for (const [a, b, c] of WIN_LINES) {
    if (cells[a] === winner && cells[b] === winner && cells[c] === winner) {
      return [a, c];
    }
  }
  return null;
}

export default function SmallBoard({
  board,
  bigIndex,
  isActive,
  availableCells,
  lastMove,
  onCellClick,
  onCellHover,
  disabled,
  targetMode,
  opponentSymbol,
  flashColor,
  siegeCells,
  isHoverTarget,
  currentPlayer,
  isBonusBoard,
}: Props) {
  const resolved = board.winner || board.drawn || board.condemned;
  const winLine = board.winner ? getWinLine(board.cells, board.winner) : null;

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
        ? isHoverTarget
          ? 'bg-indigo-500/10 outline outline-2 outline-dashed outline-indigo-400 shadow-lg shadow-indigo-500/20'
          : 'bg-indigo-500/10 ring-2 ring-indigo-400 shadow-lg shadow-indigo-500/20'
        : isHoverTarget
          ? 'bg-zinc-600/40 outline outline-2 outline-dashed outline-zinc-400/50'
          : 'bg-zinc-600/40';

  return (
    <div className={`relative grid grid-cols-3 grid-rows-3 gap-0.5 sm:gap-1 rounded-lg sm:rounded-xl p-1 sm:p-1.5 transition-all duration-200 ${bgColor}`}>
      {/* Bonus board amber tint — sits behind everything */}
      {isBonusBoard && (
        <>
          <div className="absolute inset-0 rounded-lg sm:rounded-xl bg-amber-400/[0.07] pointer-events-none" />
          {!resolved && (
            <span className="absolute top-0.5 right-1 z-[5] text-amber-400/40 text-[7px] sm:text-[9px] font-bold pointer-events-none select-none">x2</span>
          )}
        </>
      )}
      {/* Win line SVG — inset by padding, viewBox maps to cell grid */}
      {board.winner && winLine && !targetMode && (() => {
        const cx = (i: number) => (i % 3) * 2 + 1;
        const cy = (i: number) => Math.floor(i / 3) * 2 + 1;
        return (
          <svg className="absolute inset-[4px] sm:inset-[6px] z-10 pointer-events-none" viewBox="0 0 6 6">
            <line
              x1={cx(winLine[0])} y1={cy(winLine[0])}
              x2={cx(winLine[1])} y2={cy(winLine[1])}
              stroke="#fbbf24"
              strokeWidth="0.18"
              strokeLinecap="round"
              opacity="0.6"
              className="animate-win-line"
            />
          </svg>
        );
      })()}

      {/* Won/drawn/condemned overlay — delayed stamp for wins, hover to peek */}
      {resolved && !targetMode && (
        <div className={`absolute inset-0 z-10 group ${
          board.winner ? 'animate-board-stamp' : 'animate-fade-in'
        }`}>
          <div className={`w-full h-full flex items-center justify-center rounded-xl transition-opacity duration-200 group-hover:opacity-40 ${
            board.winner === 'X'
              ? 'bg-cyan-950'
              : board.winner === 'O'
                ? 'bg-rose-950'
                : board.condemned
                  ? 'bg-red-950/90'
                  : 'bg-zinc-900'
          }`}>
            {board.winner ? (
              <Mark mark={board.winner} className={`!w-8 !h-8 sm:!w-14 sm:!h-14 drop-shadow-lg ${
                board.winner === 'X' ? 'text-cyan-400' : 'text-rose-400'
              }`} />
            ) : (
              <span className={`text-xl sm:text-4xl font-black drop-shadow-lg ${
                board.condemned ? 'text-red-500/40' : 'text-zinc-600'
              }`}>
                {board.condemned ? '\u2298' : 'Draw'}
              </span>
            )}
          </div>
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
            onMouseEnter={playable && onCellHover ? () => onCellHover(cellIdx) : undefined}
            onMouseLeave={onCellHover ? () => onCellHover(null) : undefined}
            className={`
              group/cell relative flex w-full min-w-7 sm:min-w-12 aspect-square items-center justify-center rounded text-sm font-bold transition-all duration-150
              sm:text-xl sm:rounded-md
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
            {cell ? (
              <span className={isLastMove && !targetMode ? 'animate-piece-pop inline-block' : ''}>
                <Mark mark={cell} />
              </span>
            ) : playable && currentPlayer ? (
              <span className={`opacity-0 group-hover/cell:opacity-30 transition-opacity duration-150 pointer-events-none ${
                currentPlayer === 'X' ? 'text-cyan-400' : 'text-rose-400'
              }`}>
                <Mark mark={currentPlayer} />
              </span>
            ) : null}
            {isSiegeThreat && (
              <div className="absolute inset-0 rounded bg-amber-500/20 animate-siege-pulse pointer-events-none" />
            )}
          </button>
        );
      })}
    </div>
  );
}
