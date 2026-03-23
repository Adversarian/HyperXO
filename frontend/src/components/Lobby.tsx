import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createRoom, connectRoom } from '../api';

import type { GameMode } from '../types';

interface Props {
  mode: 'create' | 'join';
  initialRoomId?: string;
  gameMode?: GameMode;
  onBack: () => void;
  onGameStart: (ws: WebSocket, role: 'host' | 'guest', myName: string, peerName: string, mySymbol: 'X' | 'O', gambits: boolean, gameMode: GameMode, conquestBonusBoards?: number[]) => void;
}

export default function Lobby({ mode, initialRoomId, gameMode = 'classic', onBack, onGameStart }: Props) {
  const [name, setName] = useState('');
  const [nameSubmitted, setNameSubmitted] = useState(false);
  const [roomId, setRoomId] = useState(initialRoomId ?? '');
  const [joinUrl, setJoinUrl] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [gambits, setGambits] = useState(false);
  const gambitsRef = useRef(false);
  gambitsRef.current = gambits; // eslint-disable-line
  const gameModeRef = useRef(gameMode);
  gameModeRef.current = gameMode; // eslint-disable-line
  const wsRef = useRef<WebSocket | null>(null);
  const roleRef = useRef<'host' | 'guest' | null>(null);
  const nameRef = useRef('');
  const handedOff = useRef(false);

  const connectToRoom = useCallback(
    (id: string) => {
      const ws = connectRoom(id);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'role') {
          roleRef.current = msg.role;
          ws.send(JSON.stringify({ type: 'name', name: nameRef.current }));
          setStatus(
            msg.role === 'host'
              ? 'Waiting for opponent...'
              : 'Connecting...'
          );
        } else if (msg.type === 'name') {
          const peerName = msg.name;
          if (roleRef.current === 'host') {
            // Host randomly assigns symbols and tells the guest
            const hostSymbol = Math.random() < 0.5 ? 'X' : 'O';
            const guestSymbol = hostSymbol === 'X' ? 'O' : 'X';
            const gm = gameModeRef.current;
            // For conquest, host generates bonus boards so both players use the same ones
            let bonusBoards: number[] | undefined;
            if (gm === 'conquest') {
              const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8];
              for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
              }
              bonusBoards = indices.slice(0, 3).sort((a, b) => a - b);
            }
            ws.send(JSON.stringify({ type: 'assign', hostSymbol, guestSymbol, hostName: nameRef.current, gambits: gambitsRef.current, gameMode: gm, conquestBonusBoards: bonusBoards }));
            handedOff.current = true;
            ws.onmessage = null;
            onGameStart(ws, 'host', nameRef.current, peerName, hostSymbol as 'X' | 'O', gambitsRef.current, gm, bonusBoards);
          }
          // Guest waits for the 'assign' message instead
        } else if (msg.type === 'assign') {
          // Guest receives symbol assignment from host
          handedOff.current = true;
          ws.onmessage = null;
          onGameStart(ws, 'guest', nameRef.current, msg.hostName, msg.guestSymbol as 'X' | 'O', msg.gambits ?? false, msg.gameMode ?? 'classic', msg.conquestBonusBoards);
        } else if (msg.type === 'peer-status' && msg.status === 'joined') {
          ws.send(JSON.stringify({ type: 'name', name: nameRef.current }));
          setStatus('Opponent joined...');
        } else if (msg.type === 'peer-status' && msg.status === 'left') {
          setStatus('Opponent disconnected');
        } else if (msg.type === 'error') {
          setError(msg.message);
        }
      };

      ws.onerror = () => setError('Connection failed');
      ws.onclose = () => {};
    },
    [onGameStart]
  );

  const submitName = () => {
    const trimmed = name.trim() || 'Player';
    setName(trimmed);
    nameRef.current = trimmed;
    setNameSubmitted(true);

    if (mode === 'create') {
      setStatus('Creating room...');
      createRoom()
        .then((data) => {
          setRoomId(data.roomId);
          setJoinUrl(data.joinUrl);
          setStatus('Waiting for opponent...');
          connectToRoom(data.roomId);
        })
        .catch(() => setError('Failed to create room'));
    }
  };

  // Auto-connect for URL joins after name is submitted
  useEffect(() => {
    if (mode === 'join' && initialRoomId && nameSubmitted) {
      setStatus('Joining...');
      connectToRoom(initialRoomId);
    }
    return () => {
      if (!handedOff.current) {
        wsRef.current?.close();
      }
    };
  }, [mode, initialRoomId, nameSubmitted, connectToRoom]);

  const handleJoin = () => {
    if (!roomId.trim()) return;
    nameRef.current = name.trim() || 'Player';
    setName(nameRef.current);
    setError('');
    setStatus('Joining...');
    connectToRoom(roomId.trim().toUpperCase());
  };

  const copyCode = () => {
    navigator.clipboard.writeText(joinUrl || roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Step 1: Name input
  if (!nameSubmitted && mode === 'create') {
    return (
      <div className="flex flex-col items-center gap-6 px-4 w-full max-w-sm mx-auto">
        <button
          onClick={onBack}
          className="self-start text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Back
        </button>
        <h2 className="text-2xl font-bold text-zinc-200">Host Game</h2>
        <div className="w-full flex flex-col gap-3">
          <label className="text-zinc-400 text-sm">Your name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitName()}
            placeholder="Enter your name"
            maxLength={20}
            autoFocus
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={submitName}
            className="w-full rounded-lg bg-indigo-500 px-5 py-2.5 font-semibold text-white hover:bg-indigo-400 transition-colors"
          >
            Create Room
          </button>
        </div>
      </div>
    );
  }

  // Join flow: name + code on same screen
  if (mode === 'join' && !nameSubmitted && !initialRoomId) {
    return (
      <div className="flex flex-col items-center gap-6 px-4 w-full max-w-sm mx-auto">
        <button
          onClick={onBack}
          className="self-start text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Back
        </button>
        <h2 className="text-2xl font-bold text-zinc-200">Join Game</h2>
        <div className="w-full flex flex-col gap-3">
          <label className="text-zinc-400 text-sm">Your name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            maxLength={20}
            autoFocus
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
          <label className="text-zinc-400 text-sm mt-2">Room code</label>
          <div className="w-full flex gap-2">
            <input
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-center font-mono text-lg tracking-widest text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={handleJoin}
              disabled={roomId.trim().length < 6}
              className="rounded-lg bg-indigo-500 px-5 py-2.5 font-semibold text-white hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Join
            </button>
          </div>
        </div>
        {status && <p className="text-zinc-500 text-sm animate-pulse">{status}</p>}
        {error && (
          <div className="w-full rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>
    );
  }

  // URL-based join: name input first
  if (mode === 'join' && !nameSubmitted && initialRoomId) {
    return (
      <div className="flex flex-col items-center gap-6 px-4 w-full max-w-sm mx-auto">
        <button
          onClick={onBack}
          className="self-start text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          &larr; Back
        </button>
        <h2 className="text-2xl font-bold text-zinc-200">Join Game</h2>
        <p className="text-zinc-500 text-sm">Room: <span className="font-mono text-indigo-400">{initialRoomId}</span></p>
        <div className="w-full flex flex-col gap-3">
          <label className="text-zinc-400 text-sm">Your name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitName()}
            placeholder="Enter your name"
            maxLength={20}
            autoFocus
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={submitName}
            className="w-full rounded-lg bg-indigo-500 px-5 py-2.5 font-semibold text-white hover:bg-indigo-400 transition-colors"
          >
            Join Room
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Waiting room (host view with QR)
  return (
    <div className="flex flex-col items-center gap-6 px-4 w-full max-w-sm mx-auto">
      <button
        onClick={onBack}
        className="self-start text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
      >
        &larr; Back
      </button>

      <h2 className="text-2xl font-bold text-zinc-200">
        {mode === 'create' ? 'Host Game' : 'Join Game'}
      </h2>

      {error && (
        <div className="w-full rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {mode === 'create' && roomId && (
        <div className="w-full flex flex-col items-center gap-4">
          <p className="text-zinc-500 text-sm">Share this code or QR with your friend:</p>
          <div className="text-4xl font-mono font-bold tracking-widest text-indigo-400">
            {roomId}
          </div>
          {joinUrl && (
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={joinUrl} size={160} />
            </div>
          )}
          <button
            onClick={copyCode}
            className="text-sm text-zinc-400 hover:text-zinc-200 underline underline-offset-2 transition-colors"
          >
            {copied ? 'Copied!' : 'Copy invite link'}
          </button>

          <div className="flex items-center justify-center gap-3 mt-2">
            <span className="text-zinc-400 text-sm">Gambits:</span>
            <button
              onClick={() => setGambits(false)}
              className={`px-3 py-1 rounded-lg text-sm font-bold transition-all ${
                !gambits ? 'bg-zinc-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >Off</button>
            <button
              onClick={() => setGambits(true)}
              className={`px-3 py-1 rounded-lg text-sm font-bold transition-all ${
                gambits ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >On</button>
          </div>
        </div>
      )}

      {status && (
        <p className="text-zinc-500 text-sm animate-pulse">{status}</p>
      )}
    </div>
  );
}
