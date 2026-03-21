import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Difficulty, GameMode, GameState } from '../types';
import type { PowerUpDraft, PowerUpState, ActiveCard, SiegeThreat } from '../engine/powerups';
import {
  createPowerUpState,
  useCard,
  CARD_CATALOG,
  applyRecall,
  applySabotage,
  applyOverwrite,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  refreshSiegeThreats,
  advanceSiegeThreats,
  applySiegeClaim,
} from '../engine/powerups';
import {
  createGame as createEngine,
  availableMoves,
  applyMove,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import { createAI, choose, DIFFICULTY_PRESETS } from '../engine/ai';
import type { MinimaxAI } from '../engine/ai';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';
import CardTray from './CardTray';

interface Props {
  difficulty: Difficulty;
  playerSymbol: 'X' | 'O';
  aiName: string;
  mode: GameMode;
  draft: PowerUpDraft | null;
  onBack: () => void;
}

const MODE_LABELS: Record<GameMode, string> = {
  'classic': 'Classic',
  'sudden-death': 'Sudden Death',
  'misere': 'Misère',
};

type TurnPhase = 'normal' | 'dd-second' | 'haste-second' | 'redirect-pick' | 'momentum-bonus' | 'flanking-bonus';

function engineToGameState(engine: HyperXOGame, lastMove?: { player: string; boardIndex: number; cellIndex: number }): GameState {
  const moves = availableMoves(engine);
  return {
    id: 'local',
    currentPlayer: engine.currentPlayer,
    nextBoardIndex: engine.nextBoardIndex,
    winner: engine.winner,
    drawn: engine.drawn,
    boards: engine.boards.map((b, i) => ({
      index: i,
      cells: b.cells.map(c => c === '' ? '' : c),
      winner: b.winner,
      drawn: b.drawn,
      condemned: b.condemned,
    })),
    availableMoves: moves.map(([board, cell]) => ({ board, cell })),
    availableBoards: [...new Set(moves.map(([b]) => b))].sort((a, b) => a - b),
    moveLog: [],
    lastMove,
    aiPending: false,
  };
}

function isBoardLive(engine: HyperXOGame, idx: number): boolean {
  const b = engine.boards[idx];
  return !b.winner && !b.drawn && !b.condemned && b.cells.some(c => c === '');
}

export default function GameView({ difficulty, playerSymbol, aiName, mode, draft, onBack }: Props) {
  const [game, setGame] = useState<GameState | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [playerPU, setPlayerPU] = useState<PowerUpState | null>(null);
  const [activatingCard, setActivatingCard] = useState<ActiveCard | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('normal');
  const [siegeThreats, setSiegeThreats] = useState<SiegeThreat[]>([]);
  const [flashBoards, setFlashBoards] = useState<Map<number, string>>(new Map());
  const [recallSource, setRecallSource] = useState<{ boardIdx: number; cellIdx: number } | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineRef = useRef<HyperXOGame | null>(null);
  const aiRef = useRef<MinimaxAI | null>(null);
  const siegeRef = useRef<SiegeThreat[]>([]);
  const redirectPrevRef = useRef<{ prevWinners: (Player | null)[]; lastMove: { player: string; boardIndex: number; cellIndex: number } } | null>(null);
  const hasteFirstRef = useRef(false);
  const preCardWinnersRef = useRef<(Player | null)[] | null>(null);

  const aiSymbol = playerSymbol === 'X' ? 'O' : 'X';
  const doctrine = draft?.doctrine ?? null;

  const triggerFlash = useCallback((boards: number[], color: string) => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashBoards(new Map(boards.map(b => [b, color])));
    flashTimeoutRef.current = setTimeout(() => {
      setFlashBoards(new Map());
      flashTimeoutRef.current = null;
    }, 600);
  }, []);

  useEffect(() => {
    return () => { if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current); };
  }, []);

  const updateSiege = useCallback((threats: SiegeThreat[]) => {
    siegeRef.current = threats;
    setSiegeThreats(threats);
  }, []);

  const siegeCellsMap = useMemo(() => {
    if (doctrine !== 'siege' || siegeThreats.length === 0) return undefined;
    const map = new Map<number, Set<number>>();
    for (const t of siegeThreats) {
      if (!map.has(t.boardIdx)) map.set(t.boardIdx, new Set());
      map.get(t.boardIdx)!.add(t.blockingCell);
    }
    return map;
  }, [doctrine, siegeThreats]);

  const refreshGame = useCallback((lastMove?: { player: string; boardIndex: number; cellIndex: number }) => {
    if (engineRef.current) setGame(engineToGameState(engineRef.current, lastMove));
  }, []);

  const doAiResponse = useCallback(() => {
    const engine = engineRef.current;
    const ai = aiRef.current;
    if (!engine || !ai || engine.winner || engine.drawn) return;

    setAiThinking(true);
    setTimeout(() => {
      const prevWinners = engine.boards.map(b => b.winner);
      const move = choose(ai, engine);
      applyMove(engine, move[0], move[1]);
      const lastMove = { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] };

      // Siege: advance threats after opponent move
      if (doctrine === 'siege') {
        const result = advanceSiegeThreats(siegeRef.current, engine, playerSymbol as Player);
        for (const claim of result.claimed) {
          applySiegeClaim(engine, claim.boardIdx, claim.cellIdx, playerSymbol as Player);
        }
        updateSiege(result.updated);
        if (result.claimed.length > 0) {
          triggerFlash(result.claimed.map(c => c.boardIdx), 'amber');
        }
      }

      // Flanking: any board won after AI move → player bonus piece
      if (doctrine === 'flanking' && !engine.winner && !engine.drawn) {
        const newlyWon = engine.boards
          .map((b, i) => ({ winner: b.winner, i }))
          .filter(({ winner, i }) => winner && !prevWinners[i]);
        if (newlyWon.length > 0) {
          // Grant player a free placement anywhere (currentPlayer is already playerSymbol after AI's applyMove)
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          engine.nextBoardIndex = null;
          engine.zkey ^= engine.zobrist.nbiKey(null);
          setTurnPhase('flanking-bonus');
          setGame(engineToGameState(engine, lastMove));
          triggerFlash(newlyWon.map(w => w.i), 'emerald');
          setAiThinking(false);
          return;
        }
      }

      setGame(engineToGameState(engine, lastMove));
      setAiThinking(false);
    }, 50);
  }, [aiSymbol, doctrine, playerSymbol, triggerFlash, updateSiege]);

  // Check passives after player's full turn, before AI responds
  const afterPlayerTurn = useCallback((
    engine: HyperXOGame,
    lastMove: { player: string; boardIndex: number; cellIndex: number },
    prevWinners: (Player | null)[],
  ) => {
    if (engine.winner || engine.drawn) {
      setGame(engineToGameState(engine, lastMove));
      return;
    }

    const newlyWon = engine.boards
      .map((b, i) => ({ winner: b.winner, i }))
      .filter(({ winner, i }) => winner && !prevWinners[i]);
    const playerWonBoard = newlyWon.some(w => w.winner === playerSymbol);

    // Siege: refresh threats after player move
    if (doctrine === 'siege') {
      updateSiege(refreshSiegeThreats(siegeRef.current, engine, playerSymbol as Player));
    }

    // Momentum: player won a board → bonus turn
    if (doctrine === 'momentum' && playerWonBoard) {
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      setTurnPhase('momentum-bonus');
      setGame(engineToGameState(engine, lastMove));
      triggerFlash(
        newlyWon.filter(w => w.winner === playerSymbol).map(w => w.i),
        playerSymbol === 'X' ? 'cyan' : 'rose',
      );
      return;
    }

    // Flanking: any board won → bonus piece anywhere
    if (doctrine === 'flanking' && newlyWon.length > 0) {
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
      engine.nextBoardIndex = null;
      engine.zkey ^= engine.zobrist.nbiKey(null);
      setTurnPhase('flanking-bonus');
      setGame(engineToGameState(engine, lastMove));
      triggerFlash(newlyWon.map(w => w.i), 'emerald');
      return;
    }

    // Deferred haste: resume haste second turn after passives resolved
    if (hasteFirstRef.current) {
      hasteFirstRef.current = false;
      engine.currentPlayer = playerSymbol as Player;
      engine.zkey ^= engine.zobrist.stmKey();
      setTurnPhase('haste-second');
      setGame(engineToGameState(engine, lastMove));
      return;
    }

    setGame(engineToGameState(engine, lastMove));
    doAiResponse();
  }, [playerSymbol, doctrine, doAiResponse, triggerFlash, updateSiege]);

  const startNewGame = useCallback(() => {
    const engine = createEngine(mode);
    const preset = DIFFICULTY_PRESETS[difficulty];
    const ai = createAI(aiSymbol, preset.depth, preset.blunderRate);
    engineRef.current = engine;
    aiRef.current = ai;
    setPlayerPU(draft ? createPowerUpState(draft) : null);
    setActivatingCard(null);
    setRecallSource(null);
    setTurnPhase('normal');
    updateSiege([]);

    if (aiSymbol === 'X') {
      const move = choose(ai, engine);
      applyMove(engine, move[0], move[1]);
      setGame(engineToGameState(engine, { player: aiSymbol, boardIndex: move[0], cellIndex: move[1] }));
    } else {
      setGame(engineToGameState(engine));
    }
  }, [difficulty, aiSymbol, mode, draft, updateSiege]);

  useEffect(() => { startNewGame(); }, [startNewGame]);

  // --- Card activation ---

  const commitCard = useCallback((card: ActiveCard) => {
    if (!playerPU) return;
    useCard(playerPU, card);
    setPlayerPU({ ...playerPU });
    setActivatingCard(null);
  }, [playerPU]);

  const handleActivateCard = useCallback((card: ActiveCard) => {
    const engine = engineRef.current;
    if (!engine || !playerPU || engine.currentPlayer !== playerSymbol) return;

    const def = CARD_CATALOG[card];

    setActivatingCard(card);
    setRecallSource(null);
  }, [playerPU, playerSymbol, commitCard, refreshGame]);

  const cancelActivation = useCallback(() => {
    setActivatingCard(null);
    setRecallSource(null);
  }, []);

  // --- Click handler ---

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const engine = engineRef.current;
      const ai = aiRef.current;
      if (!engine || !ai) return;
      if (engine.winner || engine.drawn) return;

      // --- Pre-placement targeting ---
      if (activatingCard && turnPhase === 'normal') {
        const card = activatingCard;

        // Board-target cards (pre-placement)
        if (card === 'condemn' || card === 'swap' || card === 'shatter') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'condemn') applyCondemn(engine, boardIndex);
            else if (card === 'swap') applySwap(engine, boardIndex);
            else applyShatter(engine, boardIndex);
            commitCard(card);
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'swap' ? 'violet' : card === 'shatter' ? 'rose' : 'zinc');
          } catch { /* invalid target, ignore */ }
          return;
        }

        // Recall: two-step targeting
        if (card === 'recall') {
          if (!recallSource) {
            const b = engine.boards[boardIndex];
            if (b.condemned || b.winner || b.drawn) return;
            if (b.cells[cellIndex] !== playerSymbol) return;
            setRecallSource({ boardIdx: boardIndex, cellIdx: cellIndex });
          } else {
            try {
              preCardWinnersRef.current = engine.boards.map(b => b.winner);
              applyRecall(engine, recallSource.boardIdx, recallSource.cellIdx, boardIndex, cellIndex);
              commitCard('recall');
              if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
              setRecallSource(null);
              refreshGame();
              triggerFlash([recallSource.boardIdx, boardIndex], 'sky');
            } catch { /* invalid target */ }
          }
          return;
        }

        // Cell-target cards (pre-placement)
        if (card === 'overwrite' || card === 'sabotage') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'overwrite') applyOverwrite(engine, boardIndex, cellIndex);
            else applySabotage(engine, boardIndex, cellIndex);
            commitCard(card);
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'overwrite' ? 'rose' : 'violet');
          } catch { /* invalid target, ignore */ }
          return;
        }

        // Flow modifiers: fall through to placement (handled below)
      }

      // --- Redirect-pick phase ---
      if (turnPhase === 'redirect-pick') {
        try {
          applyRedirect(engine, boardIndex);
        } catch { /* invalid target, ignore */ return; }
        setTurnPhase('normal');
        const rp = redirectPrevRef.current;
        redirectPrevRef.current = null;
        if (rp) {
          afterPlayerTurn(engine, rp.lastMove, rp.prevWinners);
        } else {
          refreshGame();
          doAiResponse();
        }
        return;
      }

      // --- Flanking-bonus phase ---
      if (turnPhase === 'flanking-bonus') {
        if (aiThinking) return;
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        applyMove(engine, boardIndex, cellIndex);
        const lastMove = { player: playerSymbol, boardIndex, cellIndex };
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Momentum-bonus phase ---
      if (turnPhase === 'momentum-bonus') {
        if (aiThinking) return;
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        applyMove(engine, boardIndex, cellIndex);
        const lastMove = { player: playerSymbol, boardIndex, cellIndex };
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Normal / DD-second / Haste-second placement ---
      if (aiThinking) return;
      if (turnPhase === 'normal' && engine.currentPlayer !== playerSymbol) return;
      const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
      if (!legal) return;

      const savedPreCardWinners = preCardWinnersRef.current;
      preCardWinnersRef.current = null;
      const prevWinners = savedPreCardWinners ?? engine.boards.map(b => b.winner);
      applyMove(engine, boardIndex, cellIndex);
      const lastMove = { player: engine.currentPlayer === 'X' ? 'O' : 'X', boardIndex, cellIndex };

      // DD-second: done, check passives then AI responds
      if (turnPhase === 'dd-second') {
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // Haste-second: done, check passives then AI responds
      if (turnPhase === 'haste-second') {
        setTurnPhase('normal');
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Check for pending flow-modifier cards ---

      if (activatingCard === 'double-down' && !engine.winner && !engine.drawn) {
        const boardLive = isBoardLive(engine, boardIndex);
        // Undo player switch, force to same board for second piece
        engine.currentPlayer = playerSymbol as Player;
        engine.zkey ^= engine.zobrist.stmKey();
        if (boardLive) {
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          engine.nextBoardIndex = boardIndex;
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          commitCard('double-down');
          setTurnPhase('dd-second');
          setGame(engineToGameState(engine, lastMove));
          return;
        }
        // Board no longer live (first piece won it), just proceed normally
        engine.currentPlayer = engine.currentPlayer === 'X' ? 'O' : 'X';
        engine.zkey ^= engine.zobrist.stmKey();
        commitCard('double-down');
      }

      if (activatingCard === 'haste' && !engine.winner && !engine.drawn) {
        commitCard('haste');
        hasteFirstRef.current = true;
        afterPlayerTurn(engine, lastMove, prevWinners);
        return;
      }

      if (activatingCard === 'redirect' && !engine.winner && !engine.drawn) {
        commitCard('redirect');
        redirectPrevRef.current = { prevWinners, lastMove };
        setTurnPhase('redirect-pick');
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // --- Normal: check passives, then AI responds ---
      setActivatingCard(null);
      afterPlayerTurn(engine, lastMove, prevWinners);
    },
    [activatingCard, turnPhase, aiThinking, aiSymbol, playerSymbol, commitCard, refreshGame, doAiResponse, afterPlayerTurn]
  );

  // --- Compute targeting info ---

  const targeting = (() => {
    const engine = engineRef.current;
    if (!engine || !activatingCard || turnPhase !== 'normal') {
      if (turnPhase === 'redirect-pick' && engine) {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i)) validBoards.add(i);
        }
        return { mode: 'board' as const, validBoards };
      }
      return null;
    }

    const def = CARD_CATALOG[activatingCard];

    // Recall: two-step targeting
    if (activatingCard === 'recall') {
      if (!recallSource) {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === playerSymbol))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: playerSymbol };
      } else {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (i === recallSource.boardIdx) continue;
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === ''))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: '' };
      }
    }

    if (def.targetType === 'board') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        if (activatingCard === 'condemn' && (b.winner || b.drawn)) continue;
        if (activatingCard === 'swap' && (b.winner || b.drawn)) continue;
        if ((activatingCard === 'swap' || activatingCard === 'shatter') && !b.cells.some(c => c !== '')) continue;
        validBoards.add(i);
      }
      return { mode: 'board' as const, validBoards };
    }

    if (def.targetType === 'opponent-cell') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        if (activatingCard === 'overwrite' && (b.winner || b.drawn)) continue;
        if (b.cells.some(c => c === aiSymbol)) validBoards.add(i);
      }
      return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: aiSymbol };
    }

    return null;
  })();

  // --- Render ---

  if (!game) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-500 animate-pulse">Starting game...</div>
      </div>
    );
  }

  const isGameOver = !!game.winner || game.drawn;
  const isPlayerTurn = game.currentPlayer === playerSymbol && !aiThinking && !isGameOver;
  const youLabel = { turn: 'Your turn', win: 'You win' };
  const aiLabel = { turn: `${aiName}'s turn`, win: `${aiName} wins` };

  const phaseHint =
    turnPhase === 'dd-second'
      ? { label: 'Double Down', desc: 'Place your second piece on the same board' }
      : turnPhase === 'haste-second'
        ? { label: 'Haste', desc: 'Take your second consecutive turn' }
        : turnPhase === 'redirect-pick'
          ? { label: 'Redirect', desc: 'Click a board to send your opponent there' }
          : turnPhase === 'momentum-bonus'
            ? { label: 'Momentum', desc: 'You won a board — take a bonus turn!' }
            : turnPhase === 'flanking-bonus'
              ? { label: 'Flanking', desc: 'A board was won — place a bonus piece anywhere' }
              : activatingCard === 'recall' && !recallSource
                ? { label: 'Recall', desc: 'Click one of your pieces to pick it up' }
                : activatingCard === 'recall' && recallSource
                  ? { label: 'Recall', desc: 'Click an empty cell on another board to place it' }
                  : activatingCard && CARD_CATALOG[activatingCard].targetType === 'board'
                    ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click a board to target' }
                    : activatingCard && CARD_CATALOG[activatingCard].targetType === 'opponent-cell'
                      ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click an opponent piece to target' }
                      : null;

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-6 px-2">
      <div className="w-full flex items-center justify-between max-w-lg">
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Menu
        </button>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${playerSymbol === 'X' ? 'text-cyan-400' : 'text-rose-400'}`}>You ({playerSymbol})</span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className={`text-sm font-medium ${aiSymbol === 'X' ? 'text-cyan-400' : 'text-rose-400'}`}>{aiName} ({aiSymbol})</span>
          {mode !== 'classic' && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">{MODE_LABELS[mode]}</span>
          )}
          {draft && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">Gambits</span>
          )}
        </div>
      </div>

      <GameStatus
        game={{...game, aiPending: aiThinking}}
        labelX={playerSymbol === 'X' ? youLabel : aiLabel}
        labelO={playerSymbol === 'O' ? youLabel : aiLabel}
      />

      {phaseHint && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
          <span className="text-amber-400 text-sm font-semibold">{phaseHint.label}</span>
          <span className="text-amber-400/70 text-xs block">{phaseHint.desc}</span>
        </div>
      )}

      <BigBoard
        game={game}
        onCellClick={handleCellClick}
        disabled={aiThinking || (!targeting && game.currentPlayer === aiSymbol)}
        targeting={targeting}
        flashBoards={flashBoards.size > 0 ? flashBoards : undefined}
        siegeCells={siegeCellsMap}
      />

      {playerPU && (
        <div className="flex flex-col items-center gap-1">
          <CardTray
            state={playerPU}
            onActivate={handleActivateCard}
            activatingCard={activatingCard}
            disabled={!isPlayerTurn || turnPhase !== 'normal'}
          />
          {activatingCard && (
            <button
              onClick={cancelActivation}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {isGameOver && (
        <button
          onClick={startNewGame}
          className="rounded-xl bg-indigo-500 px-6 py-3 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
        >
          Play Again
        </button>
      )}
    </div>
  );
}
