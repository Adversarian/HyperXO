import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { GameState } from '../types';
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
  applyMove as engineApply,
  type HyperXOGame,
  type Player,
} from '../engine/game';
import BigBoard from './BigBoard';
import GameStatus from './GameStatus';
import CardTray from './CardTray';
import DraftScreen from './DraftScreen';

interface Props {
  ws: WebSocket;
  myName: string;
  opponentName: string;
  mySymbol: 'X' | 'O';
  gambits: boolean;
  onBack: () => void;
}

type Phase = 'draft' | 'waiting-draft' | 'playing';
type TurnPhase = 'normal' | 'dd-second' | 'haste-second' | 'redirect-pick' | 'momentum-bonus' | 'flanking-bonus';

function engineToGameState(
  engine: HyperXOGame,
  lastMove?: { player: string; boardIndex: number; cellIndex: number },
): GameState {
  const moves = availableMoves(engine);
  return {
    id: 'p2p',
    currentPlayer: engine.currentPlayer,
    nextBoardIndex: engine.nextBoardIndex,
    winner: engine.winner,
    drawn: engine.drawn,
    boards: engine.boards.map((b, i) => ({
      index: i,
      cells: b.cells.map(c => (c === '' ? '' : c)),
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

export default function FriendGame({ ws, myName, opponentName, mySymbol, gambits, onBack }: Props) {
  // ===== Core state =====
  const [game, setGame] = useState<GameState | null>(null);
  const [peerLeft, setPeerLeft] = useState(false);
  const [phase, setPhase] = useState<Phase>(gambits ? 'draft' : 'playing');
  const engineRef = useRef<HyperXOGame | null>(null);

  // ===== Gambit state =====
  const [myPU, setMyPU] = useState<PowerUpState | null>(null);
  const [activatingCard, setActivatingCard] = useState<ActiveCard | null>(null);
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('normal');
  const [flashBoards, setFlashBoards] = useState<Map<number, string>>(new Map());
  const [opponentCardNotice, setOpponentCardNotice] = useState<string | null>(null);
  const [siegeThreats, setSiegeThreats] = useState<SiegeThreat[]>([]);
  const [opponentSiegeDisplay, setOpponentSiegeDisplay] = useState<SiegeThreat[]>([]);
  const [recallSource, setRecallSource] = useState<{ boardIdx: number; cellIdx: number } | null>(null);

  // ===== Refs (for WS handler closure stability) =====
  const myDraftRef = useRef<PowerUpDraft | null>(null);
  const opponentDraftRef = useRef<PowerUpDraft | null>(null);
  const myPURef = useRef<PowerUpState | null>(null);
  const opponentPURef = useRef<PowerUpState | null>(null);
  const mySiegeRef = useRef<SiegeThreat[]>([]);
  const opponentSiegeRef = useRef<SiegeThreat[]>([]);
  const turnPhaseRef = useRef<TurnPhase>('normal');
  const pendingRef = useRef({
    opponentCard: null as ActiveCard | null,
    ddStage: 0,
    hasteStage: 0,
  });
  const redirectPendingRef = useRef<{
    prevWinners: (Player | null)[];
    lastMove: { player: string; boardIndex: number; cellIndex: number };
  } | null>(null);
  const deferredFlankingRef = useRef<{ player: Player; boards: number[] } | null>(null);
  const deferredHasteRef = useRef<Player | null>(null);
  const preCardWinnersRef = useRef<(Player | null)[] | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const opponentSymbol: Player = mySymbol === 'X' ? 'O' : 'X';

  // Keep refs in sync
  turnPhaseRef.current = turnPhase;

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  // ===== Helpers =====

  const triggerFlash = useCallback((boards: number[], color: string) => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashBoards(new Map(boards.map(b => [b, color])));
    flashTimeoutRef.current = setTimeout(() => {
      setFlashBoards(new Map());
      flashTimeoutRef.current = null;
    }, 600);
  }, []);

  const updateMySiege = useCallback((threats: SiegeThreat[]) => {
    mySiegeRef.current = threats;
    setSiegeThreats(threats);
  }, []);

  const refreshGameView = useCallback(
    (lastMove?: { player: string; boardIndex: number; cellIndex: number }) => {
      if (engineRef.current) setGame(engineToGameState(engineRef.current, lastMove));
    },
    [],
  );

  const getDoctrineOf = useCallback(
    (player: Player) => {
      return player === mySymbol
        ? myDraftRef.current?.doctrine ?? null
        : opponentDraftRef.current?.doctrine ?? null;
    },
    [mySymbol],
  );

  // ===== Init game =====

  const initGame = useCallback(() => {
    const engine = createEngine();
    engineRef.current = engine;
    if (gambits && myDraftRef.current) {
      const pu = createPowerUpState(myDraftRef.current);
      setMyPU(pu);
      myPURef.current = pu;
    } else {
      setMyPU(null);
      myPURef.current = null;
    }
    if (gambits && opponentDraftRef.current) {
      opponentPURef.current = createPowerUpState(opponentDraftRef.current);
    } else {
      opponentPURef.current = null;
    }
    setActivatingCard(null);
    setRecallSource(null);
    setTurnPhase('normal');
    turnPhaseRef.current = 'normal';
    updateMySiege([]);
    opponentSiegeRef.current = [];
    pendingRef.current = { opponentCard: null, ddStage: 0, hasteStage: 0 };
    redirectPendingRef.current = null;
    deferredFlankingRef.current = null;
    deferredHasteRef.current = null;
    preCardWinnersRef.current = null;
    setOpponentCardNotice(null);
    setOpponentSiegeDisplay([]);
    setGame(engineToGameState(engine));
    setPhase('playing');
  }, [gambits, updateMySiege]);

  useEffect(() => {
    if (!gambits) initGame();
  }, [gambits, initGame]);

  // ===== Draft =====

  const handleDraftReady = useCallback(
    (draft: PowerUpDraft) => {
      myDraftRef.current = draft;
      ws.send(JSON.stringify({ type: 'draft-ready', draft }));
      if (opponentDraftRef.current) {
        initGame();
      } else {
        setPhase('waiting-draft');
      }
    },
    [ws, initGame],
  );

  // ===== Passive checking =====

  const checkPassives = useCallback(
    (
      engine: HyperXOGame,
      mover: Player,
      prevWinners: (Player | null)[],
      lastMove: { player: string; boardIndex: number; cellIndex: number },
    ) => {
      if (engine.winner || engine.drawn) {
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      const other: Player = mover === 'X' ? 'O' : 'X';
      const newlyWon = engine.boards
        .map((b, i) => ({ winner: b.winner, i }))
        .filter(({ winner, i }) => winner && !prevWinners[i]);
      const moverWonBoard = newlyWon.some(w => w.winner === mover);

      const moverDoc = getDoctrineOf(mover);
      const otherDoc = getDoctrineOf(other);

      // Siege: advance non-mover's threats
      if (otherDoc === 'siege') {
        const threats = other === mySymbol ? mySiegeRef.current : opponentSiegeRef.current;
        const result = advanceSiegeThreats(threats, engine, other);
        for (const claim of result.claimed) {
          applySiegeClaim(engine, claim.boardIdx, claim.cellIdx, other);
        }
        if (other === mySymbol) {
          updateMySiege(result.updated);
          if (result.claimed.length > 0) triggerFlash(result.claimed.map(c => c.boardIdx), 'amber');
        } else {
          opponentSiegeRef.current = result.updated;
          setOpponentSiegeDisplay(result.updated);
        }
      }

      // Siege: refresh mover's threats
      if (moverDoc === 'siege') {
        const threats = mover === mySymbol ? mySiegeRef.current : opponentSiegeRef.current;
        const refreshed = refreshSiegeThreats(threats, engine, mover);
        if (mover === mySymbol) {
          updateMySiege(refreshed);
        } else {
          opponentSiegeRef.current = refreshed;
          setOpponentSiegeDisplay(refreshed);
        }
      }

      if (engine.winner || engine.drawn) {
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // Momentum: mover gets bonus turn
      if (moverDoc === 'momentum' && moverWonBoard) {
        // Defer non-mover's flanking if they have it (will fire after momentum chain ends)
        if (otherDoc === 'flanking' && newlyWon.length > 0) {
          const existing = deferredFlankingRef.current;
          const boards = existing
            ? [...existing.boards, ...newlyWon.map(w => w.i)]
            : newlyWon.map(w => w.i);
          deferredFlankingRef.current = { player: other, boards };
        }
        engine.currentPlayer = mover;
        engine.zkey ^= engine.zobrist.stmKey();
        if (mover === mySymbol) {
          setTurnPhase('momentum-bonus');
          turnPhaseRef.current = 'momentum-bonus';
          triggerFlash(
            newlyWon.filter(w => w.winner === mover).map(w => w.i),
            mover === 'X' ? 'cyan' : 'rose',
          );
        }
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // Deferred flanking (from a momentum chain that just ended)
      const deferred = deferredFlankingRef.current;
      if (deferred) {
        deferredFlankingRef.current = null;
        if (engine.currentPlayer !== deferred.player) {
          engine.currentPlayer = deferred.player;
          engine.zkey ^= engine.zobrist.stmKey();
        }
        engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
        engine.nextBoardIndex = null;
        engine.zkey ^= engine.zobrist.nbiKey(null);
        if (deferred.player === mySymbol) {
          setTurnPhase('flanking-bonus');
          turnPhaseRef.current = 'flanking-bonus';
          triggerFlash(deferred.boards, 'emerald');
        }
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // Flanking: non-mover gets bonus piece
      if (otherDoc === 'flanking' && newlyWon.length > 0) {
        // Defer mover's flanking if they also have it (will fire after non-mover's bonus)
        if (moverDoc === 'flanking') {
          deferredFlankingRef.current = { player: mover, boards: newlyWon.map(w => w.i) };
        }
        // engine.currentPlayer is already `other` after applyMove — just free the board
        engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
        engine.nextBoardIndex = null;
        engine.zkey ^= engine.zobrist.nbiKey(null);
        if (other === mySymbol) {
          setTurnPhase('flanking-bonus');
          turnPhaseRef.current = 'flanking-bonus';
          triggerFlash(newlyWon.map(w => w.i), 'emerald');
        }
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // Mover's flanking (they won a board on their own turn, non-mover doesn't have flanking)
      if (moverDoc === 'flanking' && newlyWon.length > 0) {
        engine.currentPlayer = mover;
        engine.zkey ^= engine.zobrist.stmKey();
        engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
        engine.nextBoardIndex = null;
        engine.zkey ^= engine.zobrist.nbiKey(null);
        if (mover === mySymbol) {
          setTurnPhase('flanking-bonus');
          turnPhaseRef.current = 'flanking-bonus';
          triggerFlash(newlyWon.map(w => w.i), 'emerald');
        }
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // Deferred haste: resume haste second turn after passives resolved
      const hastePlayer = deferredHasteRef.current;
      if (hastePlayer) {
        deferredHasteRef.current = null;
        // Grant the haste player their second turn
        if (engine.currentPlayer !== hastePlayer) {
          engine.currentPlayer = hastePlayer;
          engine.zkey ^= engine.zobrist.stmKey();
        }
        if (hastePlayer === mySymbol) {
          setTurnPhase('haste-second');
          turnPhaseRef.current = 'haste-second';
        }
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      setGame(engineToGameState(engine, lastMove));
    },
    [mySymbol, getDoctrineOf, triggerFlash, updateMySiege],
  );

  // ===== Card activation (my turn) =====

  const commitMyCard = useCallback(
    (card: ActiveCard) => {
      if (!myPURef.current) return;
      useCard(myPURef.current, card);
      setMyPU({ ...myPURef.current });
      setActivatingCard(null);
    },
    [],
  );

  const handleActivateCard = useCallback(
    (card: ActiveCard) => {
      const engine = engineRef.current;
      if (!engine || !myPURef.current || engine.currentPlayer !== mySymbol) return;

      // All cards need targeting or are flow modifiers
      setActivatingCard(card);
      setRecallSource(null);
    },
    [mySymbol, commitMyCard, refreshGameView, ws],
  );

  const cancelActivation = useCallback(() => {
    setActivatingCard(null);
    setRecallSource(null);
  }, []);

  // ===== Cell click handler =====

  const handleCellClick = useCallback(
    (boardIndex: number, cellIndex: number) => {
      const engine = engineRef.current;
      if (!engine || engine.winner || engine.drawn) return;

      // --- Pre-placement card targeting ---
      if (activatingCard && turnPhaseRef.current === 'normal') {
        const card = activatingCard;

        // Board-target cards
        if (card === 'condemn' || card === 'swap' || card === 'shatter') {
          try {
            // Save winners before card effect so passives detect changes after placement
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'condemn') applyCondemn(engine, boardIndex);
            else if (card === 'swap') applySwap(engine, boardIndex);
            else applyShatter(engine, boardIndex);
            commitMyCard(card);
            ws.send(JSON.stringify({ type: 'card-effect', card, boardIdx: boardIndex }));
            // If the card effect ended the game (e.g., swap completes macro line), show result
            if (engine.winner || engine.drawn) { preCardWinnersRef.current = null; }
            refreshGameView();
            triggerFlash([boardIndex], card === 'swap' ? 'violet' : card === 'shatter' ? 'rose' : 'zinc');
          } catch {
            /* invalid target */
          }
          return;
        }

        // Recall: two-step targeting (pick up own piece, then place on another board)
        if (card === 'recall') {
          if (!recallSource) {
            // Step 1: pick up own piece
            const b = engine.boards[boardIndex];
            if (b.condemned || b.winner || b.drawn) return;
            if (b.cells[cellIndex] !== mySymbol) return;
            setRecallSource({ boardIdx: boardIndex, cellIdx: cellIndex });
          } else {
            // Step 2: place on different live board
            try {
              preCardWinnersRef.current = engine.boards.map(b => b.winner);
              applyRecall(engine, recallSource.boardIdx, recallSource.cellIdx, boardIndex, cellIndex);
              commitMyCard('recall');
              ws.send(JSON.stringify({
                type: 'card-effect', card: 'recall',
                fromBoard: recallSource.boardIdx, fromCell: recallSource.cellIdx,
                toBoard: boardIndex, toCell: cellIndex,
              }));
              if (engine.winner || engine.drawn) preCardWinnersRef.current = null;
              setRecallSource(null);
              refreshGameView();
              triggerFlash([recallSource.boardIdx, boardIndex], 'sky');
            } catch {
              /* invalid target */
            }
          }
          return;
        }

        // Cell-target cards
        if (card === 'overwrite' || card === 'sabotage') {
          try {
            // Save winners before card effect so passives detect changes after placement
            preCardWinnersRef.current = engine.boards.map(b => b.winner);
            if (card === 'overwrite') applyOverwrite(engine, boardIndex, cellIndex);
            else applySabotage(engine, boardIndex, cellIndex);
            commitMyCard(card);
            ws.send(
              JSON.stringify({ type: 'card-effect', card, boardIdx: boardIndex, cellIdx: cellIndex }),
            );
            if (engine.winner || engine.drawn) { preCardWinnersRef.current = null; }
            refreshGameView();
            triggerFlash([boardIndex], card === 'overwrite' ? 'rose' : 'violet');
          } catch {
            /* invalid target */
          }
          return;
        }

        // Flow modifier cards (dd, haste, redirect) — fall through to placement
      }

      // --- Redirect-pick phase ---
      if (turnPhaseRef.current === 'redirect-pick') {
        try {
          applyRedirect(engine, boardIndex);
        } catch {
          return;
        }
        ws.send(JSON.stringify({ type: 'redirect-target', boardIdx: boardIndex }));
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        // Now check passives with the saved state from when the move was made
        const rp = redirectPendingRef.current;
        redirectPendingRef.current = null;
        if (rp) {
          checkPassives(engine, mySymbol as Player, rp.prevWinners, rp.lastMove);
        } else {
          refreshGameView();
        }
        return;
      }

      // --- Flanking-bonus phase ---
      if (turnPhaseRef.current === 'flanking-bonus') {
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        engineApply(engine, boardIndex, cellIndex);
        const lastMove = { player: mySymbol, boardIndex, cellIndex };
        ws.send(JSON.stringify({ type: 'move', boardIndex, cellIndex }));
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      // --- Momentum-bonus phase ---
      if (turnPhaseRef.current === 'momentum-bonus') {
        const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
        if (!legal) return;
        const prevWinners = engine.boards.map(b => b.winner);
        engineApply(engine, boardIndex, cellIndex);
        const lastMove = { player: mySymbol, boardIndex, cellIndex };
        ws.send(JSON.stringify({ type: 'move', boardIndex, cellIndex }));
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      // --- Normal / DD-second / Haste-second placement ---
      if (engine.currentPlayer !== mySymbol) return;
      const legal = availableMoves(engine).some(([b, c]) => b === boardIndex && c === cellIndex);
      if (!legal) return;

      // Use pre-card-effect winners if a card was played this turn (so passives detect card-caused changes)
      const savedPreCardWinners = preCardWinnersRef.current;
      preCardWinnersRef.current = null;

      // Send flow card effect BEFORE the move so opponent can track it
      const pendingFlowCard =
        turnPhaseRef.current === 'normal' &&
        activatingCard &&
        ['double-down', 'haste', 'redirect'].includes(activatingCard)
          ? activatingCard
          : null;

      if (pendingFlowCard) {
        commitMyCard(pendingFlowCard);
        ws.send(JSON.stringify({ type: 'card-effect', card: pendingFlowCard }));
      }

      const prevWinners = savedPreCardWinners ?? engine.boards.map(b => b.winner);
      engineApply(engine, boardIndex, cellIndex);
      const lastMove = { player: mySymbol, boardIndex, cellIndex };
      ws.send(JSON.stringify({ type: 'move', boardIndex, cellIndex }));

      // DD-second: done
      if (turnPhaseRef.current === 'dd-second') {
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      // Haste-second: done
      if (turnPhaseRef.current === 'haste-second') {
        setTurnPhase('normal');
        turnPhaseRef.current = 'normal';
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      // --- Post-move flow card handling ---
      if (pendingFlowCard === 'double-down' && !engine.winner && !engine.drawn) {
        const boardLive = isBoardLive(engine, boardIndex);
        engine.currentPlayer = mySymbol as Player;
        engine.zkey ^= engine.zobrist.stmKey();
        if (boardLive) {
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          engine.nextBoardIndex = boardIndex;
          engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
          setTurnPhase('dd-second');
          turnPhaseRef.current = 'dd-second';
          setGame(engineToGameState(engine, lastMove));
          return;
        }
        // Board not live — dd wasted, undo switch
        engine.currentPlayer = engine.currentPlayer === 'X' ? 'O' : 'X';
        engine.zkey ^= engine.zobrist.stmKey();
      }

      if (pendingFlowCard === 'haste' && !engine.winner && !engine.drawn) {
        // Defer haste second turn — run passives first (flanking/siege may trigger)
        deferredHasteRef.current = mySymbol as Player;
        checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
        return;
      }

      if (pendingFlowCard === 'redirect' && !engine.winner && !engine.drawn) {
        redirectPendingRef.current = { prevWinners, lastMove };
        setTurnPhase('redirect-pick');
        turnPhaseRef.current = 'redirect-pick';
        setGame(engineToGameState(engine, lastMove));
        return;
      }

      // --- Normal: check passives ---
      setActivatingCard(null);
      checkPassives(engine, mySymbol as Player, prevWinners, lastMove);
    },
    [activatingCard, mySymbol, commitMyCard, refreshGameView, ws, checkPassives, triggerFlash],
  );

  // ===== WS message handler =====

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data);
      const engine = engineRef.current;

      if (msg.type === 'draft-ready') {
        opponentDraftRef.current = msg.draft;
        if (myDraftRef.current) initGame();
        return;
      }

      if (msg.type === 'peer-status') {
        if (msg.status === 'left') setPeerLeft(true);
        return;
      }

      if (msg.type === 'rematch-accept') {
        initGame();
        return;
      }

      if (!engine) return;

      // --- Opponent card effect ---
      if (msg.type === 'card-effect') {
        const card = msg.card as ActiveCard;

        // Save winners before card effect so passives detect card-caused changes
        const stateChangingCards = ['recall', 'swap', 'shatter', 'condemn', 'overwrite', 'sabotage'];
        if (stateChangingCards.includes(card)) {
          preCardWinnersRef.current = engine.boards.map(b => b.winner);
        }

        // Apply the effect locally
        if (card === 'recall') applyRecall(engine, msg.fromBoard, msg.fromCell, msg.toBoard, msg.toCell);
        else if (card === 'sabotage') applySabotage(engine, msg.boardIdx, msg.cellIdx);
        else if (card === 'overwrite') applyOverwrite(engine, msg.boardIdx, msg.cellIdx);
        else if (card === 'swap') applySwap(engine, msg.boardIdx);
        else if (card === 'shatter') applyShatter(engine, msg.boardIdx);
        else if (card === 'condemn') applyCondemn(engine, msg.boardIdx);

        // If the card effect ended the game, clear saved winners
        if (engine.winner || engine.drawn) preCardWinnersRef.current = null;

        // Flash for board/cell-target cards
        if (card === 'recall') triggerFlash([msg.fromBoard, msg.toBoard], 'sky');
        else if (card === 'swap') triggerFlash([msg.boardIdx], 'violet');
        else if (card === 'shatter') triggerFlash([msg.boardIdx], 'rose');
        else if (card === 'condemn') triggerFlash([msg.boardIdx], 'zinc');
        else if (card === 'overwrite') triggerFlash([msg.boardIdx], 'rose');
        else if (card === 'sabotage') triggerFlash([msg.boardIdx], 'violet');

        // Set pending for flow cards
        if (card === 'double-down') pendingRef.current.opponentCard = 'double-down';
        else if (card === 'haste') pendingRef.current.opponentCard = 'haste';
        else if (card === 'redirect') pendingRef.current.opponentCard = 'redirect';

        // Mark card as used in opponent's state
        if (opponentPURef.current) useCard(opponentPURef.current, card);

        // Show notice
        if (!['double-down', 'haste', 'redirect'].includes(card)) {
          if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
          setOpponentCardNotice(CARD_CATALOG[card].name);
          noticeTimeoutRef.current = setTimeout(() => {
            setOpponentCardNotice(null);
            noticeTimeoutRef.current = null;
          }, 3500);
        }

        refreshGameView();
        return;
      }

      // --- Opponent redirect target ---
      if (msg.type === 'redirect-target') {
        applyRedirect(engine, msg.boardIdx);
        const rp = redirectPendingRef.current;
        redirectPendingRef.current = null;
        if (rp) {
          checkPassives(engine, opponentSymbol, rp.prevWinners, rp.lastMove);
        } else {
          refreshGameView();
        }
        return;
      }

      // --- Move (from opponent or bonus) ---
      if (msg.type === 'move') {
        const savedPre = preCardWinnersRef.current;
        preCardWinnersRef.current = null;
        const prevWinners = savedPre ?? engine.boards.map(b => b.winner);
        const player = engine.currentPlayer;
        engineApply(engine, msg.boardIndex, msg.cellIndex);
        const lastMove = { player, boardIndex: msg.boardIndex, cellIndex: msg.cellIndex };

        const pending = pendingRef.current;

        // Handle double-down first move
        if (pending.opponentCard === 'double-down' && pending.ddStage === 0) {
          if (!engine.winner && !engine.drawn) {
            const boardLive = isBoardLive(engine, msg.boardIndex);
            engine.currentPlayer = opponentSymbol;
            engine.zkey ^= engine.zobrist.stmKey();
            if (boardLive) {
              engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
              engine.nextBoardIndex = msg.boardIndex;
              engine.zkey ^= engine.zobrist.nbiKey(engine.nextBoardIndex);
              pending.ddStage = 1;
              setGame(engineToGameState(engine, lastMove));
              return;
            }
            // Board not live, undo
            engine.currentPlayer = engine.currentPlayer === 'X' ? 'O' : 'X';
            engine.zkey ^= engine.zobrist.stmKey();
          }
          pending.opponentCard = null;
          pending.ddStage = 0;
          checkPassives(engine, opponentSymbol, prevWinners, lastMove);
          return;
        }

        // Handle double-down second move
        if (pending.opponentCard === 'double-down' && pending.ddStage === 1) {
          pending.opponentCard = null;
          pending.ddStage = 0;
          checkPassives(engine, opponentSymbol, prevWinners, lastMove);
          return;
        }

        // Handle haste first move — run passives, defer second turn
        if (pending.opponentCard === 'haste' && pending.hasteStage === 0) {
          pending.opponentCard = null;
          pending.hasteStage = 0;
          if (!engine.winner && !engine.drawn) {
            deferredHasteRef.current = opponentSymbol;
          }
          checkPassives(engine, opponentSymbol, prevWinners, lastMove);
          return;
        }

        // Handle redirect (move placed, expect redirect-target next)
        if (pending.opponentCard === 'redirect') {
          pending.opponentCard = null;
          redirectPendingRef.current = { prevWinners, lastMove };
          setGame(engineToGameState(engine, lastMove));
          return;
        }

        // Normal move — check passives for whoever just moved
        checkPassives(engine, player as Player, prevWinners, lastMove);
      }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, mySymbol, opponentSymbol, initGame, refreshGameView, checkPassives, triggerFlash]);

  // ===== Targeting computation =====

  const targeting = (() => {
    const engine = engineRef.current;
    if (!engine) return null;

    if (turnPhaseRef.current === 'redirect-pick') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        if (isBoardLive(engine, i)) validBoards.add(i);
      }
      return { mode: 'board' as const, validBoards };
    }

    if (!activatingCard || turnPhaseRef.current !== 'normal') return null;

    const def = CARD_CATALOG[activatingCard];

    // Recall: two-step targeting
    if (activatingCard === 'recall') {
      if (!recallSource) {
        // Step 1: highlight own pieces on live boards
        const validBoards = new Set<number>();
        for (let i = 0; i < 9; i++) {
          if (isBoardLive(engine, i) && engine.boards[i].cells.some(c => c === mySymbol))
            validBoards.add(i);
        }
        return { mode: 'opponent-cell' as const, validBoards, opponentSymbol: mySymbol };
      } else {
        // Step 2: highlight empty cells on other live boards
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
        // Swap: live boards only. Shatter: any non-condemned with pieces.
        if (activatingCard === 'swap' && (b.winner || b.drawn)) continue;
        if ((activatingCard === 'swap' || activatingCard === 'shatter') && !b.cells.some(c => c !== ''))
          continue;
        validBoards.add(i);
      }
      return { mode: 'board' as const, validBoards };
    }

    if (def.targetType === 'opponent-cell') {
      const validBoards = new Set<number>();
      for (let i = 0; i < 9; i++) {
        const b = engine.boards[i];
        if (b.condemned) continue;
        // Overwrite: live boards only. Sabotage: any non-condemned board.
        if (activatingCard === 'overwrite' && (b.winner || b.drawn)) continue;
        if (b.cells.some(c => c === opponentSymbol)) validBoards.add(i);
      }
      return { mode: 'opponent-cell' as const, validBoards, opponentSymbol };
    }

    return null;
  })();

  // ===== Siege cells for display =====

  const siegeCellsMap = useMemo(() => {
    const allThreats = [...siegeThreats, ...opponentSiegeDisplay];
    if (allThreats.length === 0) return undefined;
    const map = new Map<number, Set<number>>();
    for (const t of allThreats) {
      if (!map.has(t.boardIdx)) map.set(t.boardIdx, new Set());
      map.get(t.boardIdx)!.add(t.blockingCell);
    }
    return map;
  }, [siegeThreats, opponentSiegeDisplay]);

  // ==================== Render ====================

  if (phase === 'draft') {
    return <DraftScreen onReady={handleDraftReady} onBack={onBack} />;
  }

  if (phase === 'waiting-draft') {
    const myDraft = myDraftRef.current;
    return (
      <div className="flex flex-col items-center gap-6 px-4">
        <h2 className="text-zinc-200 text-lg font-semibold">
          Waiting for {opponentName} to draft...
        </h2>
        {myDraft && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-zinc-500 text-xs">Your picks</p>
            <div className="flex gap-2 flex-wrap justify-center">
              {(['strike', 'tactics', 'disruption', 'doctrine'] as const).map(cat => {
                const cardId = myDraft[cat];
                const card = CARD_CATALOG[cardId];
                return (
                  <div key={cat} className="rounded-lg bg-zinc-800/50 border border-zinc-700/50 px-3 py-1.5 text-center">
                    <div className="text-xs text-zinc-300 font-medium">{card.name}</div>
                    <div className="text-[10px] text-zinc-500">{cat}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-zinc-500 animate-pulse text-sm">Waiting...</div>
        <button
          onClick={onBack}
          className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Back
        </button>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-500 animate-pulse">Starting game...</div>
      </div>
    );
  }

  const isGameOver = !!game.winner || game.drawn;
  const isMyTurn = game.currentPlayer === mySymbol && !isGameOver;

  const xName = mySymbol === 'X' ? myName : opponentName;
  const oName = mySymbol === 'O' ? myName : opponentName;

  // Phase hint with descriptive text
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

  // Opponent waiting explanation (when it's not my turn and opponent is in a special phase)
  const opponentPhaseHint = !isMyTurn && !isGameOver && !phaseHint
    ? (game.currentPlayer === opponentSymbol ? null : `${opponentName} is taking a bonus action...`)
    : null;

  const oppDoctrine = opponentDraftRef.current?.doctrine;
  const oppDoctrineLabel = oppDoctrine ? CARD_CATALOG[oppDoctrine].name : null;

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
          <span className="text-sm font-medium text-cyan-400">{xName} (X)</span>
          <span className="text-zinc-600 text-xs">vs</span>
          <span className="text-sm font-medium text-rose-400">{oName} (O)</span>
          {gambits && (
            <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">Gambits</span>
          )}
        </div>
      </div>

      {peerLeft && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
          Opponent disconnected
        </div>
      )}

      {opponentCardNotice && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2.5 text-amber-400 text-sm font-medium">
          {opponentName} used <span className="font-bold">{opponentCardNotice}</span>
        </div>
      )}

      {oppDoctrineLabel && (
        <div className="text-xs text-zinc-500">
          {opponentName}&apos;s doctrine: <span className="text-amber-400 font-medium">{oppDoctrineLabel}</span>
        </div>
      )}

      <GameStatus
        game={game}
        labelX={{ turn: `${xName}'s turn`, win: `${xName} wins` }}
        labelO={{ turn: `${oName}'s turn`, win: `${oName} wins` }}
      />

      {phaseHint && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
          <span className="text-amber-400 text-sm font-semibold">{phaseHint.label}</span>
          <span className="text-amber-400/70 text-xs block">{phaseHint.desc}</span>
        </div>
      )}

      {opponentPhaseHint && (
        <p className="text-zinc-500 text-xs animate-pulse">{opponentPhaseHint}</p>
      )}

      <BigBoard
        game={game}
        onCellClick={handleCellClick}
        disabled={targeting ? false : !isMyTurn || peerLeft}
        targeting={targeting}
        flashBoards={flashBoards.size > 0 ? flashBoards : undefined}
        siegeCells={siegeCellsMap}
      />

      {myPU && (
        <div className="flex flex-col items-center gap-1">
          <CardTray
            state={myPU}
            onActivate={handleActivateCard}
            activatingCard={activatingCard}
            disabled={!isMyTurn || turnPhase !== 'normal'}
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
        <div className="flex gap-3">
          <button
            onClick={() => {
              ws.send(JSON.stringify({ type: 'rematch-accept' }));
              initGame();
            }}
            className="rounded-xl bg-indigo-500 px-6 py-3 text-white font-semibold hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/25 active:scale-[0.98]"
          >
            Rematch
          </button>
          <button
            onClick={() => {
              ws.send(JSON.stringify({ type: 'rematch-accept' }));
              myDraftRef.current = null;
              opponentDraftRef.current = null;
              setPhase('draft');
            }}
            className="rounded-xl border border-zinc-700 bg-zinc-800/50 px-6 py-3 text-zinc-300 font-semibold hover:bg-zinc-700/50 hover:border-zinc-600 transition-all active:scale-[0.98]"
          >
            Re-draft
          </button>
        </div>
      )}
    </div>
  );
}
