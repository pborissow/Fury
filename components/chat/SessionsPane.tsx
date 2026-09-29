'use client';

import type { ComponentProps } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SessionSidebar from '@/components/SessionSidebar';

type SessionsPaneProps = ComponentProps<typeof SessionSidebar> & {
  onCreateSession: () => void;
};

/** "Sessions" header with the New button, over the session list. */
export default function SessionsPane({ onCreateSession, ...sidebar }: SessionsPaneProps) {
  return (
    <div className="h-full bg-card border-r border-border flex flex-col">
      <div className="p-4 border-b border-border flex justify-between items-center">
        <h2 className="text-foreground text-lg font-semibold">Sessions</h2>
        <Button onClick={onCreateSession} variant="outline" size="sm">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <SessionSidebar {...sidebar} />
    </div>
  );
}
