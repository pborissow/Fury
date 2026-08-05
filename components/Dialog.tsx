'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { XIcon } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost';

export interface DialogButton {
  label: string;
  onClick: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Optional extra elements rendered in the header bar (between title and close button) */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  /** Footer buttons rendered right-aligned. When provided, the component renders the footer bar automatically. */
  buttons?: DialogButton[];
  /** Initial width in px (default 480) */
  defaultWidth?: number;
  /** Initial height in px (default 400) */
  defaultHeight?: number;
  /** Minimum width in px (default 320) */
  minWidth?: number;
  /** Minimum height in px (default 200) */
  minHeight?: number;
  /** Enable resize handles (default true) */
  resizable?: boolean;
  /** Allow maximizing/restoring the dialog by double-clicking the header (default false). */
  maximizable?: boolean;
  /** Remove default padding from content area (default false) */
  noPadding?: boolean;
  /** Reset position & size to defaults each time the dialog opens (default true).
   *  Set to false for dialogs that persist user-resized geometry. */
  resetOnOpen?: boolean;
  /** Fires after the user finishes resizing — use to persist the new size. */
  onResizeEnd?: (size: { width: number; height: number }) => void;
  /** Fires after the user finishes dragging — use to persist the new position. */
  onMoveEnd?: (position: { x: number; y: number }) => void;
  /** When provided, the dialog is portaled INTO this element and positioned
   *  relative to it (absolute, centered) instead of the viewport (fixed). The
   *  dim overlay then covers only that container. The element must be
   *  positioned (e.g. `relative`). Used to anchor a modal to a single panel
   *  rather than the whole app. */
  portalContainer?: HTMLElement | null;
}

export default function Dialog({
  open,
  onOpenChange,
  title,
  headerActions,
  children,
  buttons,
  defaultWidth = 480,
  defaultHeight = 400,
  minWidth = 320,
  minHeight = 200,
  resizable = true,
  maximizable = false,
  noPadding = false,
  resetOnOpen = true,
  onResizeEnd,
  onMoveEnd,
  portalContainer,
}: DialogProps) {
  // When anchored to a container, position relative to it (absolute) and dim
  // only it, rather than the whole viewport (fixed).
  const contained = !!portalContainer;
  const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // Maximize/restore state. When maximized we stash the pre-maximize geometry
  // so a second double-click can put the window back exactly where it was.
  const [maximized, setMaximized] = useState(false);
  const restoreRef = useRef<{ size: { width: number; height: number }; position: { x: number; y: number } } | null>(null);

  // Reset position when dialog opens, unless the consumer manages persistence.
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setMaximized(false);
      if (resetOnOpen) {
        setPosition({ x: 0, y: 0 });
        setSize({ width: defaultWidth, height: defaultHeight });
      }
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, defaultWidth, defaultHeight, resetOnOpen]);

  // Reset geometry when a parent-CONTROLLED dialog transitions closed → open.
  // handleOpenChange above only fires for Radix-initiated open changes, so a
  // dialog opened by flipping the `open` prop (as all consumers here do) never
  // re-applied its defaults — making resetOnOpen a no-op for controlled dialogs
  // and letting a stale size (incl. one preserved across Fast Refresh) persist.
  // Fires only on the false → true edge, so an in-session resize is preserved.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen && resetOnOpen) {
      setMaximized(false);
      setPosition({ x: 0, y: 0 });
      setSize({ width: defaultWidth, height: defaultHeight });
    }
  }, [open, resetOnOpen, defaultWidth, defaultHeight]);

  // Double-click the header to toggle maximize. Maximizing grows the window to
  // the same 95vw/95vh cap the panel is clamped to and re-centers it; restoring
  // returns to the exact geometry captured before maximizing. This is a
  // transient view — we deliberately don't fire onResizeEnd/onMoveEnd, so any
  // persisted size the consumer tracks stays at the user's real size.
  const handleHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!maximizable) return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (maximized) {
      const prev = restoreRef.current;
      if (prev) {
        setSize(prev.size);
        setPosition(prev.position);
      }
      setMaximized(false);
    } else {
      restoreRef.current = { size, position };
      const maxW = typeof window !== 'undefined' ? window.innerWidth : size.width;
      const maxH = typeof window !== 'undefined' ? window.innerHeight : size.height;
      setSize({ width: maxW, height: maxH });
      setPosition({ x: 0, y: 0 });
      setMaximized(true);
    }
  }, [maximizable, maximized, size, position]);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    // A maximized window fills the viewport and isn't draggable.
    if (maximized) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
    };
  }, [position, maximized]);

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    setPosition({
      x: dragRef.current.originX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.originY + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
      if (onMoveEnd) {
        setPosition(pos => { onMoveEnd(pos); return pos; });
      }
    }
  }, [onMoveEnd]);

  // --- Resize ---
  const resizeRef = useRef<{
    dir: ResizeDir;
    startX: number; startY: number;
    startW: number; startH: number;
    startPX: number; startPY: number;
  } | null>(null);

  const handleResizeStart = useCallback((dir: ResizeDir, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Resizing by hand exits the maximized state so the next double-click
    // maximizes again rather than snapping back to stale restore geometry.
    setMaximized(false);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = {
      dir, startX: e.clientX, startY: e.clientY,
      startW: size.width, startH: size.height,
      startPX: position.x, startPY: position.y,
    };
  }, [size, position]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    e.preventDefault();
    const { dir, startX, startY, startW, startH, startPX, startPY } = resizeRef.current;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    let newW = startW, newH = startH;
    if (dir.includes('e')) newW = startW + dx;
    else if (dir.includes('w')) newW = startW - dx;
    if (dir.includes('s')) newH = startH + dy;
    else if (dir.includes('n')) newH = startH - dy;

    // Clamp both ends. The maximum mirrors the CSS max-w/h on the panel
    // (95vw/95vh) so the underlying size state can't drift past what's
    // actually rendered — otherwise dragging beyond the viewport
    // accumulates "phantom" size that pops on the next resize.
    const maxW = typeof window !== 'undefined' ? window.innerWidth * 0.95 : Infinity;
    const maxH = typeof window !== 'undefined' ? window.innerHeight * 0.95 : Infinity;
    newW = Math.min(maxW, Math.max(minWidth, newW));
    newH = Math.min(maxH, Math.max(minHeight, newH));

    // Compensate for center-based positioning so the opposite edge stays fixed
    const dw = newW - startW;
    const dh = newH - startH;
    let newX = startPX, newY = startPY;
    if (dir.includes('e')) newX = startPX + dw / 2;
    else if (dir.includes('w')) newX = startPX - dw / 2;
    if (dir.includes('s')) newY = startPY + dh / 2;
    else if (dir.includes('n')) newY = startPY - dh / 2;

    setSize({ width: newW, height: newH });
    setPosition({ x: newX, y: newY });
  }, [minWidth, minHeight]);

  const handleResizeEnd = useCallback(() => {
    if (resizeRef.current) {
      resizeRef.current = null;
      if (onResizeEnd || onMoveEnd) {
        setSize(s => { onResizeEnd?.(s); return s; });
        setPosition(p => { onMoveEnd?.(p); return p; });
      }
    }
  }, [onResizeEnd, onMoveEnd]);

  const HANDLE = 6;
  const resizeHandles: { dir: ResizeDir; cursor: string; style: React.CSSProperties }[] = resizable ? [
    { dir: 'n',  cursor: 'ns-resize',   style: { top: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE } },
    { dir: 's',  cursor: 'ns-resize',   style: { bottom: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE } },
    { dir: 'e',  cursor: 'ew-resize',   style: { right: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE } },
    { dir: 'w',  cursor: 'ew-resize',   style: { left: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE } },
    { dir: 'nw', cursor: 'nwse-resize', style: { top: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 } },
    { dir: 'ne', cursor: 'nesw-resize', style: { top: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 } },
    { dir: 'sw', cursor: 'nesw-resize', style: { bottom: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 } },
    { dir: 'se', cursor: 'nwse-resize', style: { bottom: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 } },
  ] : [];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal container={portalContainer ?? undefined}>
        <DialogPrimitive.Overlay className={`${contained ? 'absolute' : 'fixed'} inset-0 z-50 bg-black/50`} onClick={(e) => e.stopPropagation()} />
        <DialogPrimitive.Content
          className={`${contained ? 'absolute' : 'fixed'} z-50 focus:outline-none`}
          style={{
            top: '50%',
            left: '50%',
            transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div
            className={`bg-card border flex flex-col overflow-hidden relative${maximized ? '' : ' rounded-lg'}`}
            style={{
              width: size.width, height: size.height,
              maxWidth: contained ? '100%' : (maximized ? '100vw' : '95vw'),
              maxHeight: contained ? '100%' : (maximized ? '100vh' : '95vh'),
              boxShadow: '0 8px 40px rgba(0, 0, 0, 0.8), 0 2px 12px rgba(0, 0, 0, 0.6)',
            }}
          >
            {/* Draggable header (fixed while maximized) */}
            <div
              data-dialog-header
              className={`flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 select-none${maximized ? '' : ' cursor-grab active:cursor-grabbing'}`}
              style={{ backgroundColor: '#313131' }}
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onDoubleClick={handleHeaderDoubleClick}
            >
              <DialogPrimitive.Title className="text-sm font-semibold truncate flex-1">
                {title}
              </DialogPrimitive.Title>
              {headerActions}
              <DialogPrimitive.Close className="ring-offset-background focus:ring-ring rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
                <XIcon />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            </div>

            {/* Content */}
            <div className={`flex-1 overflow-auto min-h-0 flex flex-col${noPadding ? '' : ' p-4'}`}>
              {children}
            </div>

            {/* Footer buttons */}
            {buttons && buttons.length > 0 && (
              <div className="px-4 py-3 flex justify-end gap-2 shrink-0 border-t border-border">
                {buttons.map((btn, i) => (
                  <Button
                    key={i}
                    size="sm"
                    variant={btn.variant || 'default'}
                    onClick={btn.onClick}
                    disabled={btn.disabled}
                  >
                    {btn.label}
                  </Button>
                ))}
              </div>
            )}

            {/* Resize handles */}
            {resizeHandles.map(({ dir, cursor, style }) => (
              <div
                key={dir}
                style={{ position: 'absolute', zIndex: 10, cursor, ...style }}
                onPointerDown={(e) => handleResizeStart(dir, e)}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeEnd}
              />
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// --- Convenience wrappers ---

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  confirmVariant?: ButtonVariant;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmVariant = 'default',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const handleCancel = onCancel || (() => onOpenChange(false));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      defaultWidth={420}
      defaultHeight={220}
      minWidth={320}
      minHeight={180}
      resizable={false}
      buttons={[
        { label: cancelLabel, onClick: handleCancel, variant: 'ghost' },
        { label: confirmLabel, onClick: onConfirm, variant: confirmVariant },
      ]}
    >
      <div className="text-sm text-muted-foreground">{message}</div>
    </Dialog>
  );
}

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: React.ReactNode;
  buttonLabel?: string;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  message,
  buttonLabel = 'OK',
}: AlertDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      defaultWidth={420}
      defaultHeight={200}
      minWidth={320}
      minHeight={160}
      resizable={false}
      buttons={[
        { label: buttonLabel, onClick: () => onOpenChange(false) },
      ]}
    >
      <div className="text-sm text-muted-foreground">{message}</div>
    </Dialog>
  );
}
