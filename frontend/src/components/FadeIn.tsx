import { useState, useEffect, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  duration?: number;
  className?: string;
}

export default function FadeIn({ children, duration = 150, className = '' }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div
      className={`transition-all ${className} ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
      style={{ transitionDuration: `${duration}ms` }}
    >
      {children}
    </div>
  );
}
