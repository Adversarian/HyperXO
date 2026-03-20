import { useState, useCallback, useRef } from 'react';
import type { Difficulty, Screen, GameMode } from './types';
import Menu from './components/Menu';
import GameView from './components/GameView';
import Lobby from './components/Lobby';
import FriendGame from './components/FriendGame';

const FADE_MS = 120;

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu');
  const [difficulty, setDifficulty] = useState<Difficulty>(3);
  const [playerSymbol, setPlayerSymbol] = useState<'X' | 'O'>('X');
  const [aiName, setAiName] = useState('Novax');
  const [gameMode, setGameMode] = useState<GameMode>('classic');
  const [friendWs, setFriendWs] = useState<WebSocket | null>(null);
  const [friendRole, setFriendRole] = useState<'host' | 'guest'>('host');
  const [myName, setMyName] = useState('');
  const [opponentName, setOpponentName] = useState('');
  const [friendSymbol, setFriendSymbol] = useState<'X' | 'O'>('X');
  const [fade, setFade] = useState(true);
  const transitioning = useRef(false);

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room');

  const transitionTo = useCallback(
    (next: () => void) => {
      if (transitioning.current) return;
      transitioning.current = true;
      setFade(false);
      setTimeout(() => {
        next();
        requestAnimationFrame(() => {
          setFade(true);
          transitioning.current = false;
        });
      }, FADE_MS);
    },
    []
  );

  const handleStartAI = useCallback(
    (d: Difficulty, sym: 'X' | 'O', name: string, mode: GameMode) => {
      transitionTo(() => {
        setDifficulty(d);
        setPlayerSymbol(sym);
        setAiName(name);
        setGameMode(mode);
        setScreen('game');
      });
    },
    [transitionTo]
  );

  const handleHostGame = useCallback(() => {
    transitionTo(() => setScreen('lobby-create'));
  }, [transitionTo]);

  const handleJoinGame = useCallback(() => {
    transitionTo(() => setScreen('lobby-join'));
  }, [transitionTo]);

  const handleGameStart = useCallback(
    (ws: WebSocket, role: 'host' | 'guest', playerName: string, peerName: string, mySymbol: 'X' | 'O') => {
      transitionTo(() => {
        setFriendWs(ws);
        setFriendRole(role);
        setMyName(playerName);
        setOpponentName(peerName);
        setFriendSymbol(mySymbol);
        setScreen('lobby-join');
      });
    },
    [transitionTo]
  );

  const goMenu = useCallback(() => {
    transitionTo(() => {
      friendWs?.close();
      setFriendWs(null);
      setMyName('');
      setOpponentName('');
      setScreen('menu');
      if (roomFromUrl) {
        window.history.replaceState({}, '', '/');
      }
    });
  }, [transitionTo, friendWs, roomFromUrl]);

  // Auto-join if room param in URL
  if (roomFromUrl && screen === 'menu') {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Lobby
          mode="join"
          initialRoomId={roomFromUrl.toUpperCase()}
          onBack={goMenu}
          onGameStart={handleGameStart}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center py-8 sm:py-12">
      <div
        className={`transition-all ${fade ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}`}
        style={{ transitionDuration: `${FADE_MS}ms` }}
      >
        {screen === 'menu' && (
          <Menu
            onStartAI={handleStartAI}
            onHostGame={handleHostGame}
            onJoinGame={handleJoinGame}
          />
        )}

        {screen === 'game' && (
          <GameView difficulty={difficulty} playerSymbol={playerSymbol} aiName={aiName} mode={gameMode} onBack={goMenu} />
        )}

        {screen === 'lobby-create' && !friendWs && (
          <Lobby mode="create" onBack={goMenu} onGameStart={handleGameStart} />
        )}

        {screen === 'lobby-join' && !friendWs && (
          <Lobby mode="join" onBack={goMenu} onGameStart={handleGameStart} />
        )}

        {friendWs && (
          <FriendGame
            ws={friendWs}
            role={friendRole}
            myName={myName}
            opponentName={opponentName}
            mySymbol={friendSymbol}
            onBack={goMenu}
          />
        )}
      </div>
    </div>
  );
}
