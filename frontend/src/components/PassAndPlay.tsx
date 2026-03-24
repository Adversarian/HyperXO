import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { GameMode, GameState, TurnPhase, MoveEntry } from '../types';
import type { PowerUpDraft, PowerUpState, ActiveCard, SiegeThreat } from '../engine/powerups';
import {
  createPowerUpState,
  useCard as markCardUsed,
  CARD_CATALOG,
  applyRecall,
  applySabotage,
  applyOverwrite,
  applySwap,
  applyShatter,
  applyCondemn,
  applyRedirect,
  applyGravity,
  computeGravity,
  refreshSiegeThreats,
  advanceSiegeThreats,
  applySiegeClaim,
  rechargeRandomCard,
} from '../engine/powerups';
import {
  createGame as createEngine,
  availableMoves,
  applyMove,
  validateWinner,
  bigBoardState,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import { engineToGameState, isBoardLive, getNewlyWonBoards } from '../engine/utils';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';
import CardTray from './CardTray';
import CombatLog, { type LogEntry, createLogEntry } from './CombatLog';
import Mark from './Mark';

interface Props {
  mode: GameMode;
  nameX: string;
  nameO: string;
  draftX: PowerUpDraft | null;
  draftO: PowerUpDraft | null;
  onBack: () => void;
}

const MODE_LABELS: Record<GameMode, string> = {
  'classic': 'Classic',
  'sudden-death': 'Sudden Death',
  'misere': 'Misère',
  'conquest': 'Conquest',
};

const toGameState = (engine: HyperXOGame, lastMove?: MoveEntry) => {
  const gs = engineToGameState(engine, 'local', lastMove);
  if (gs.winner || gs.drawn) {
    const err = validateWinner(engine);
    if (err) {
      console.error('[HyperXO] WINNER VALIDATION FAILED:', err);
      console.error('[HyperXO] Board state:', JSON.stringify({
        bigBoard: bigBoardState(engine),
        boardWinners: engine.boards.map(b => b.winner),
        currentPlayer: engine.currentPlayer,
        mode: engine.mode,
        winner: engine.winner,
        drawn: engine.drawn,
      }));
    }
  }
  return gs;
};

export default function PassAndPlay({ mode, nameX, nameO, draftX, draftO, onBack }: Props) {
  const [game, setGame] = useState<GameState | null>(null);
  const [puXDisplay, setPuXDisplay] = useState<PowerUpState | null>(null);
  const [puODisplay, setPuODisplay] = useState<PowerUpState | null>(null);
  const [activatingCard, setActivatingCard] = useState<ActiveCard | null>(null);
  const [cardUsedThisTurn, setCardUsedThisTurn] = useState<ActiveCard | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('normal');
  const [siegeVersion, setSiegeVersion] = useState(0);
  const [flashBoards, setFlashBoards] = useState<Map<number, string>>(new Map());
  const [recallSource, setRecallSource] = useState<{ boardIdx: number; cellIdx: number } | null>(null);
  const [combatLog, setCombatLog] = useState<LogEntry[]>([]);
  const [gravityAnimation, setGravityAnimation] = useState<{ boardIdx: number; moves: Map<number, number> } | null>(null);

  const engineRef = useRef<HyperXOGame | null>(null);
  const puXRef = useRef<PowerUpState | null>(null);
  const puORef = useRef<PowerUpState | null>(null);
  const siegeXRef = useRef<SiegeThreat[]>([]);
  const siegeORef = useRef<SiegeThreat[]>([]);
  const hasteFirstRef = useRef(false);
  const preCardWinnersRef = useRef<(Player | null)[] | null>(null);
  const redirectPrevRef = useRef<{ prevWinners: (Player | null)[]; lastMove: { player: string; boardIndex: number; cellIndex: number } } | null>(null);
  const cardUsedThisTurnRef = useRef<ActiveCard | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getName = useCallback((p: Player) => p === 'X' ? nameX : nameO, [nameX, nameO]);
  const getDoctrine = (p: Player) => (p === 'X' ? draftX : draftO)?.doctrine ?? null;

  const triggerFlash = useCallback((boards: number[], color: string) => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashBoards(new Map(boards.map(b => [b, color])));
    flashTimeoutRef.current = setTimeout(() => {
      setFlashBoards(new Map());
      flashTimeoutRef.current = null;
    }, 600);
  }, []);

  const logEvent = useCallback((message: string, color = 'text-zinc-400') => {
    setCombatLog(prev => [...prev.slice(-19), createLogEntry(message, color)]);
  }, []);

  useEffect(() => {
    return () => { if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current); };
  }, []);

  useEffect(() => {
    if (!gravityAnimation) return;
    const t = setTimeout(() => setGravityAnimation(null), 500);
    return () => clearTimeout(t);
  }, [gravityAnimation]);

  const refreshGame = useCallback((lastMove?: { player: string; boardIndex: number; cellIndex: number }) => {
    if (engineRef.current) setGame(toGameState(engineRef.current, lastMove));
  }, []);

  // Siege display: combine both players' threats (both visible on shared screen)
  const siegeCellsMap = useMemo(() => {
    const threats = [...siegeXRef.current, ...siegeORef.current];
    if (threats.length === 0) return undefined;
    const map = new Map<number, Set<number>>();
    for (const t of threats) {
      if (!map.has(t.boardIdx)) map.set(t.boardIdx, new Set());
      map.get(t.boardIdx)!.add(t.blockingCell);
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siegeVersion, game]);

  // ---- Passive handling after any move ----

  const afterTurn = useCallback((
    engine: HyperXOGame,
    lastMove: { player: string; boardIndex: number; cellIndex: number },
    prevWinners: (Player | null)[],
  ) => {
    if (engine.winner || engine.drawn) {
      setGame(toGameState(engine, lastMove));
      return;
    }

    const mover = lastMove.player as Player;
    const opponent = mover === 'X' ? 'O' : 'X';
    const moverDoctrine = getDoctrine(mover);
    const opponentDoctrine = getDoctrine(opponent);
    const moverName = getName(mover);

    const newlyWon = getNewlyWonBoards(engine, prevWinners);
    const moverWonBoard = newlyWon.some(w => w.winner === mover);

    // Mover's siege refresh
    if (moverDoctrine === 'siege') {
      const ref = mover === 'X' ? siegeXRef : siegeORef;
      ref.current = refreshSiegeThreats(ref.current, engine, mover);
    }

    // Opponent's siege advance
    if (opponentDoctrine === 'siege') {
      const ref = opponent === 'X' ? siegeXRef : siegeORef;
      const result = advanceSiegeThreats(ref.current, engine, opponent);
      for (const claim of result.claimed) {
        applySiegeClaim(engine, claim.boardIdx, claim.cellIdx, opponent);
      }
      ref.current = result.updated;
      if (result.claimed.length > 0) {
        triggerFlash(result.claimed.map(c => c.boardIdx), 'amber');
        logEvent(`${getName(opponent)}: Siege claim!`, 'text-amber-400');
      }
      if (engine.winner || engine.drawn) {
        setGame(toGameState(engine, lastMove));
        return;
      }
    }

    // Mover's momentum
    if (moverDoctrine === 'momentum' && moverWonBoard && !engine.winner && !engine.drawn) {
      engine.currentPlayer = mover;
      engine.zkey ^= engine.zobrist.stmKey();
      setTurnPhase('momentum-bonus');
      logEvent(`${moverName}: Momentum!`, 'text-amber-400');
      triggerFlash(
        newlyWon.filter(w => w.winner === mover).map(w => w.i),
        mover === 'X' ? 'cyan' : 'rose',
      );
      setSiegeVersion(v => v + 1);
      setGame(toGameState(engine, lastMove));
      return;
    }

    // Recompute after siege claims
    const allNewlyWon = getNewlyWonBoards(engine, prevWinners);

    // Mover's arsenal
    if (moverDoctrine === 'arsenal' && allNewlyWon.some(w => w.winner === mover) && !engine.winner && !engine.drawn) {
      const pu = mover === 'X' ? puXRef.current : puORef.current;
      if (pu) {
        const recharged = rechargeRandomCard(pu, cardUsedThisTurnRef.current ?? undefined);
        if (recharged) {
          logEvent(`${moverName}: Arsenal — ${CARD_CATALOG[recharged].name} recharged!`, 'text-emerald-400');
          if (mover === 'X') setPuXDisplay({ ...pu });
          else setPuODisplay({ ...pu });
        }
      }
    }

    // Deferred haste
    if (hasteFirstRef.current) {
      hasteFirstRef.current = false;
      engine.currentPlayer = mover;
      engine.zkey ^= engine.zobrist.stmKey();
      setTurnPhase('haste-second');
      setSiegeVersion(v => v + 1);
      setGame(toGameState(engine, lastMove));
      return;
    }

    // Normal: next player's turn
    setCardUsedThisTurn(null);
    cardUsedThisTurnRef.current = null;
    setSiegeVersion(v => v + 1);
    setGame(toGameState(engine, lastMove));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftX, draftO, nameX, nameO, triggerFlash, logEvent]);

  // ---- Start / restart game ----

  const startNewGame = useCallback(() => {
    const engine = createEngine(mode);
    engineRef.current = engine;

    if (draftX) {
      const pu = createPowerUpState(draftX);
      puXRef.current = pu;
      setPuXDisplay({ ...pu });
    } else {
      puXRef.current = null;
      setPuXDisplay(null);
    }

    if (draftO) {
      const pu = createPowerUpState(draftO);
      puORef.current = pu;
      setPuODisplay({ ...pu });
    } else {
      puORef.current = null;
      setPuODisplay(null);
    }

    siegeXRef.current = [];
    siegeORef.current = [];
    hasteFirstRef.current = false;
    preCardWinnersRef.current = null;
    redirectPrevRef.current = null;
    setActivatingCard(null);
    setCardUsedThisTurn(null);
    cardUsedThisTurnRef.current = null;
    setRecallSource(null);
    setTurnPhase('normal');
    setGravityAnimation(null);
    setSiegeVersion(0);
    setCombatLog([]);
    setGame(toGameState(engine));
  }, [mode, draftX, draftO]);

  useEffect(() => { startNewGame(); }, [startNewGame]);

  // ---- Card activation ----

  const commitCard = useCallback((card: ActiveCard) => {
    const engine = engineRef.current;
    if (!engine) return;
    const player = engine.currentPlayer;
    const pu = player === 'X' ? puXRef.current : puORef.current;
    if (!pu) return;
    markCardUsed(pu, card);
    if (player === 'X') setPuXDisplay({ ...pu });
    else setPuODisplay({ ...pu });
    setActivatingCard(null);
    setCardUsedThisTurn(card);
    cardUsedThisTurnRef.current = card;
  }, []);

  const handleActivateCard = useCallback((card: ActiveCard) => {
    const engine = engineRef.current;
    if (!engine) return;
    setActivatingCard(card);
    setRecallSource(null);
  }, []);

  const cancelActivation = useCallback(() => {
    setActivatingCard(null);
    setRecallSource(null);
  }, []);

  // ---- Click handler ----

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      if (engine.winner || engine.drawn) return;

      const currentPlayer = engine.currentPlayer;

      // --- Pre-placement targeting ---
      if (activatingCard && turnPhase === 'normal') {
        const card = activatingCard;
        const playerColor = currentPlayer === 'X' ? 'text-cyan-400' : 'text-rose-400';

        // Board-target cards
        if (card === 'condemn' || card === 'swap' || card === 'shatter' || card === 'gravity') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'condemn') applyCondemn(engine, boardIndex);
            else if (card === 'swap') applySwap(engine, boardIndex);
            else if (card === 'gravity') {
              const gravityMoves = applyGravity(engine, boardIndex);
              setGravityAnimation({ boardIdx: boardIndex, moves: gravityMoves });
            }
            else applyShatter(engine, boardIndex);
            commitCard(card);
            logEvent(`${getName(currentPlayer)} used ${CARD_CATALOG[card].name}!`, playerColor);
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'swap' ? 'violet' : card === 'shatter' ? 'rose' : card === 'gravity' ? 'amber' : 'zinc');
          } catch { /* invalid target, ignore */ }
          return;
        }

        // Recall: two-step targeting
        if (card === 'recall') {
          if (!recallSource) {
            const b = engine.boards[boardIndex];
            if (b.condemned || b.winner || b.drawn) return;
            if (b.cells[cellIndex] !== currentPlayer) return;
            setRecallSource({ boardIdx: boardIndex, cellIdx: cellIndex });
          } else {
            try {
              preCardWinnersRef.current = engine.boards.map(b => b.winner);
              applyRecall(engine, recallSource.boardIdx, recallSource.cellIdx, boardIndex, cellIndex);
              commitCard('recall');
              logEvent(`${getName(currentPlayer)} used Recall!`, playerColor);
              if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
              setRecallSource(null);
              refreshGame();
              triggerFlash([recallSource.boardIdx, boardIndex], 'sky');
            } catch { /* invalid target */ }
          }
          return;
        }

        // Cell-target cards
        if (card === 'overwrite' || card === 'sabotage') {
          try {
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'overwrite') applyOverwrite(engine, boardIndex, cellIndex);
            else applySabotage(engine, boardIndex, cellIndex);
            commitCard(card);
            logEvent(`${getName(currentPlayer)} used ${CARD_CATALOG[card].name}!`, playerColor);
            if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
            refreshGame();
            triggerFlash([boardIndex], card === 'overwrite' ? 'rose' : 'violet');
          } catch { /* invalid target, ignore */ }
          return;
        }

        // Flow modifiers: fall through to placement
      }

      // --- Redirect-pick phase ---
      if (turnPhase === 'redirect-pick') {
        try {
          applyRedirect(engine, boardIndex);
        } catch { /* invalid target */ return; }
        setTurnPhase('normal');
        const rp = redirectPrevRef.current;
        redirectPrevRef.current = null;
        if (rp) {
          afterTurn(engine, rp.lastMove, rp.prevWinners);
        } else {
          refreshGame();
        }
        return;
      }

      // --- Momentum-bonus phase ---
      if (turnPhase === 'momentum-bonus') {
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        applyMove(engine, boardIndex, cellIndex);
        const lastMove = { player: currentPlayer, boardIndex, cellIndex };
        setTurnPhase('normal');
        afterTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Normal / Haste-second placement ---
      const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
      if (!legal) return;

      const savedPreCardWinners = preCardWinnersRef.current;
      preCardWinnersRef.current = null;
      const prevWinners = savedPreCardWinners ?? engine.boards.map(b => b.winner);
      applyMove(engine, boardIndex, cellIndex);
      const lastMove = { player: currentPlayer, boardIndex, cellIndex };

      // Haste-second
      if (turnPhase === 'haste-second') {
        setTurnPhase('normal');
        afterTurn(engine, lastMove, prevWinners);
        return;
      }

      // --- Flow modifiers ---
      const playerColor = currentPlayer === 'X' ? 'text-cyan-400' : 'text-rose-400';

      if (activatingCard === 'haste' && !engine.winner && !engine.drawn) {
        commitCard('haste');
        logEvent(`${getName(currentPlayer)} used Haste!`, playerColor);
        hasteFirstRef.current = true;
        afterTurn(engine, lastMove, prevWinners);
        return;
      }

      if (activatingCard === 'redirect' && !engine.winner && !engine.drawn) {
        commitCard('redirect');
        logEvent(`${getName(currentPlayer)} used Redirect!`, playerColor);
        redirectPrevRef.current = { prevWinners, lastMove };
        setTurnPhase('redirect-pick');
        setGame(toGameState(engine, lastMove));
        return;
      }

      // Normal move
      setActivatingCard(null);
      afterTurn(engine, lastMove, prevWinners);
    },
    [activatingCard, turnPhase, getName, commitCard, refreshGame, afterTurn, triggerFlash, logEvent, recallSource]
  );

  // --- Targeting info ---

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

    const currentPlayer = engine.currentPlayer;
    const opponent = currentPlayer === 'X' ? 'O' : 'X';
    const def = CARD_CATALOG[activatingCard];

    // Recall
    if (activatingCard === 'recall') {
      if (!recallSource) {
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === currentPlayer))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: currentPlayer };
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
        if (activatingCard === 'gravity' && (b.winner || b.drawn)) continue;
        if ((activatingCard === 'swap' || activatingCard === 'shatter') && !b.cells.some(c => c !== '')) continue;
        if (activatingCard === 'gravity' && computeGravity(b.cells as ('' | 'X' | 'O')[]).size === 0) continue;
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
        if (b.cells.some(c => c === opponent)) validBoards.add(i);
      }
      return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: opponent };
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
  const isXTurn = game.currentPlayer === 'X' && !isGameOver;
  const isOTurn = game.currentPlayer === 'O' && !isGameOver;
  const xLabel = { turn: `${nameX}'s turn`, win: `${nameX} wins` };
  const oLabel = { turn: `${nameO}'s turn`, win: `${nameO} wins` };

  const phaseHint =
    turnPhase === 'haste-second'
      ? { label: 'Haste', desc: 'Take your second consecutive turn' }
      : turnPhase === 'redirect-pick'
          ? { label: 'Redirect', desc: 'Click a board to send your opponent there' }
          : turnPhase === 'momentum-bonus'
            ? { label: 'Momentum', desc: 'You won a board — take a bonus turn!' }
            : activatingCard === 'recall' && !recallSource
                ? { label: 'Recall', desc: 'Click one of your pieces to pick it up' }
                : activatingCard === 'recall' && recallSource
                  ? { label: 'Recall', desc: 'Click an empty cell on another board to place it' }
                  : activatingCard && CARD_CATALOG[activatingCard].targetType === 'board'
                    ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click a board to target' }
                    : activatingCard && CARD_CATALOG[activatingCard].targetType === 'opponent-cell'
                      ? { label: CARD_CATALOG[activatingCard].name, desc: 'Click an opponent piece to target' }
                      : null;

  const hasGambits = !!(puXDisplay || puODisplay);

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-5 px-2">
      <div className="w-full flex items-center justify-between max-w-lg">
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Menu
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium inline-flex items-center gap-1 text-cyan-400">{nameX} <Mark mark="X" /></span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className="text-sm font-medium inline-flex items-center gap-1 text-rose-400">{nameO} <Mark mark="O" /></span>
          {mode !== 'classic' && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">{MODE_LABELS[mode]}</span>
          )}
          {hasGambits && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">Gambits</span>
          )}
        </div>
      </div>

      <GameStatus
        game={{...game, aiPending: false}}
        labelX={xLabel}
        labelO={oLabel}
      />

      {mode === 'conquest' && game.conquestScores && (
        <div className="flex items-center gap-3 px-4 py-1.5 rounded-full bg-zinc-800/80 border border-zinc-700/50">
          <span className="text-cyan-400 font-bold text-sm">{game.conquestScores.X}</span>
          <span className="text-zinc-600 text-xs">pts</span>
          <div className="w-px h-4 bg-zinc-700" />
          <span className="text-rose-400 font-bold text-sm">{game.conquestScores.O}</span>
          <span className="text-zinc-600 text-xs">pts</span>
        </div>
      )}

      {phaseHint && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
          <span className="text-amber-400 text-sm font-semibold">{phaseHint.label}</span>
          <span className="text-amber-400/70 text-xs block">{phaseHint.desc}</span>
        </div>
      )}

      {/* Main area: side cards on wide screens, stacked on mobile */}
      <div className={hasGambits
        ? 'flex flex-col lg:flex-row lg:items-start lg:gap-4 w-full max-w-4xl'
        : 'flex flex-col items-center'
      }>
        {/* Left panel: Player X cards */}
        {puXDisplay && (
          <div className="lg:w-36 shrink-0 flex flex-col items-center gap-1 mb-3 lg:mb-0 lg:pt-8">
            <span className={`text-xs ${isXTurn ? 'text-cyan-400' : 'text-zinc-600'}`}>{nameX}</span>
            <div className="hidden lg:block w-full">
              <CardTray state={puXDisplay} onActivate={handleActivateCard} activatingCard={isXTurn ? activatingCard : null} disabled={!isXTurn || turnPhase !== 'normal' || !!cardUsedThisTurn} vertical />
            </div>
            <div className="lg:hidden">
              <CardTray state={puXDisplay} onActivate={handleActivateCard} activatingCard={isXTurn ? activatingCard : null} disabled={!isXTurn || turnPhase !== 'normal' || !!cardUsedThisTurn} />
            </div>
            {isXTurn && activatingCard && (
              <button onClick={cancelActivation} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Cancel</button>
            )}
          </div>
        )}

        {/* Center: board + log */}
        <div className="flex flex-col items-center gap-3 flex-1 min-w-0">
          <BigBoard
            game={game}
            onCellClick={handleCellClick}
            disabled={false}
            targeting={targeting}
            flashBoards={flashBoards.size > 0 ? flashBoards : undefined}
            siegeCells={siegeCellsMap}
            conquestBonusBoards={game.conquestBonusBoards ? new Set(game.conquestBonusBoards) : undefined}
            gravityMoves={gravityAnimation?.moves}
            gravityBoardIdx={gravityAnimation?.boardIdx}
          />
          {hasGambits && <CombatLog entries={combatLog} />}
        </div>

        {/* Right panel: Player O cards */}
        {puODisplay && (
          <div className="lg:w-36 shrink-0 flex flex-col items-center gap-1 mt-3 lg:mt-0 lg:pt-8">
            <span className={`text-xs ${isOTurn ? 'text-rose-400' : 'text-zinc-600'}`}>{nameO}</span>
            <div className="hidden lg:block w-full">
              <CardTray state={puODisplay} onActivate={handleActivateCard} activatingCard={isOTurn ? activatingCard : null} disabled={!isOTurn || turnPhase !== 'normal' || !!cardUsedThisTurn} vertical />
            </div>
            <div className="lg:hidden">
              <CardTray state={puODisplay} onActivate={handleActivateCard} activatingCard={isOTurn ? activatingCard : null} disabled={!isOTurn || turnPhase !== 'normal' || !!cardUsedThisTurn} />
            </div>
            {isOTurn && activatingCard && (
              <button onClick={cancelActivation} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Cancel</button>
            )}
          </div>
        )}
      </div>

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
