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
  conquestScores?: { X: number; O: number };
  conquestBonusBoards?: number[];
}

export type Difficulty = 3 | 5 | 8;

export type GameMode = 'classic' | 'sudden-death' | 'misere' | 'conquest';

export type Screen = 'menu' | 'ban' | 'draft' | 'game' | 'lobby-create' | 'lobby-join' | 'friend-game';

export type TurnPhase = 'normal' | 'haste-second' | 'redirect-pick' | 'momentum-bonus';
