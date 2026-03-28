'use client';

import { useState } from 'react';
import Dialog from '@/components/Dialog';

// Isolated label edit dialog — owns its own input state to avoid re-rendering the parent on keystrokes
const LabelEditDialog = ({ initialValue, onSave, onCancel }: {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initialValue);
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title="Session Label"
      defaultWidth={450}
      defaultHeight={270}
      minHeight={160}
      buttons={[
        { label: 'Cancel', onClick: onCancel, variant: 'ghost' as const },
        { label: 'Save', onClick: () => onSave(value) },
      ]}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(value); } }}
        className="w-full h-full px-3 py-2 rounded border border-border bg-background text-foreground text-sm focus:outline-none focus:border-ring resize-none"
        autoFocus
      />
    </Dialog>
  );
};

export default LabelEditDialog;
