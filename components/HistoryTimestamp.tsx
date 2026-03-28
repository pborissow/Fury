'use client';

import { useState, useEffect } from 'react';

// Client-side only timestamp component to avoid hydration mismatch
const HistoryTimestamp = ({ timestamp }: { timestamp: number }) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <span className="text-xs text-muted-foreground">Loading...</span>;
  }

  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });

  return (
    <span className="text-xs text-muted-foreground">
      {dateStr} {timeStr}
    </span>
  );
};

export default HistoryTimestamp;
