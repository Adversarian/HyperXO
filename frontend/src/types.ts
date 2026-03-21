export interface BoardState {
  index: number;
  cells: string[];
  winner: string | null;
  drawn: boolean;
  condemned?: boolean;
}

export interface MoveEntry {
  player: string;
  boardIndex: number;
  cellIndex: number;
}

export interface GameState {
  id: string;
  currentPlayer: string;
  nextBoardIndex: number | null;
  winner: string | null;
  drawn: boolean;
  boards: BoardState[];
  availableMoves: { board: number; cell: number }[];
  availableBoards: number[];
  moveLog: MoveEntry[];
  lastMove?: MoveEntry;
  aiPending: boolean;
}

export type Difficulty = 3 | 5 | 8;

export type GameMode = 'classic' | 'sudden-death' | 'misere';

export type Screen = 'menu' | 'draft' | 'game' | 'lobby-create' | 'lobby-join' | 'friend-game';
