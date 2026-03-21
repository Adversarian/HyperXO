import { useEffect, useRef } from 'react';

export interface LogEntry {
  id: number;
  message: string;
  color: string;
}

let _nextId = 0;
// eslint-disable-next-line react-refresh/only-export-components
export function createLogEntry(message: string, color = 'text-zinc-400'): LogEntry {
  return { id: _nextId++, message, color };
}

interface Props {
  entries: LogEntry[];
}

export default function CombatLog({ entries }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="w-full max-w-lg max-h-20 overflow-y-auto rounded-lg bg-zinc-900/60 border border-zinc-800 px-3 py-1.5 space-y-0.5 scrollbar-thin"
    >
      {entries.map(entry => (
        <div key={entry.id} className={`text-xs ${entry.color} leading-snug animate-fade-in`}>
          {entry.message}
        </div>
      ))}
    </div>
  );
}
