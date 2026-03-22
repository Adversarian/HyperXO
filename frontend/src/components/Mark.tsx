interface Props {
  mark: string;
  className?: string;
}

/** Consistent SVG marks for X and O — no font dependency. */
export default function Mark({ mark, className = '' }: Props) {
  if (mark === 'X') {
    return (
      <svg viewBox="0 0 24 24" className={`inline-block ${className}`} width="1em" height="1em">
        <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
        <line x1="20" y1="4" x2="4" y2="20" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (mark === 'O') {
    return (
      <svg viewBox="0 0 24 24" className={`inline-block ${className}`} width="1em" height="1em">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="3.5" />
      </svg>
    );
  }
  return null;
}
