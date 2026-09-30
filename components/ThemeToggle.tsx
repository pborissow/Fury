'use client';

import { Moon, Sun } from 'lucide-react';

interface ThemeToggleProps {
  theme: 'light' | 'dark';
  onToggle: () => void;
}

/**
 * A small sun ↔ moon switch for the header / tab bar. Self-contained colours
 * (no theme tokens) so it reads the same inside the always-dark header and on
 * the light tab bar an installed PWA shows instead.
 */
export default function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
      title={`Switch to ${dark ? 'light' : 'dark'} mode`}
      onClick={onToggle}
      className="group inline-flex items-center gap-1.5 h-8 px-1 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Sun className={`h-3.5 w-3.5 transition-colors ${dark ? 'text-neutral-500' : 'text-amber-500'}`} />
      <span
        className={`relative inline-block h-4 w-7 rounded-full transition-colors ${
          dark ? 'bg-neutral-600 group-hover:bg-neutral-500' : 'bg-neutral-400 group-hover:bg-neutral-500'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
            dark ? 'translate-x-3' : 'translate-x-0'
          }`}
        />
      </span>
      <Moon className={`h-3.5 w-3.5 transition-colors ${dark ? 'text-sky-300' : 'text-neutral-400'}`} />
    </button>
  );
}
