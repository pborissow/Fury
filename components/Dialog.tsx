'use client';

import React, { useState, useRef, useCallback } from 'react';
import { XIcon } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Resizable } from 're-resizable';
import { Button } from '@/components/ui/button';

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
  /** Remove default padding from content area (default false) */
  noPadding?: boolean;
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
  noPadding = false,
}: DialogProps) {
  const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // Reset position when dialog opens
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setPosition({ x: 0, y: 0 });
      setSize({ width: defaultWidth, height: defaultHeight });
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, defaultWidth, defaultHeight]);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
    };
  }, [position]);

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    setPosition({
      x: dragRef.current.originX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.originY + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const resizeEnable = resizable
    ? { right: true, bottom: true, bottomRight: true, top: false, topRight: false, topLeft: false, left: false, bottomLeft: false }
    : { right: false, bottom: false, bottomRight: false, top: false, topRight: false, topLeft: false, left: false, bottomLeft: false };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" onClick={(e) => e.stopPropagation()} />
        <DialogPrimitive.Content
          className="fixed z-50 focus:outline-none"
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
          <Resizable
            size={size}
            onResizeStop={(_e, _dir, _ref, delta) => {
              setSize({ width: size.width + delta.width, height: size.height + delta.height });
            }}
            minWidth={minWidth}
            minHeight={minHeight}
            maxWidth="95vw"
            maxHeight="95vh"
            className="bg-card rounded-lg border flex flex-col overflow-hidden"
            style={{ boxShadow: '0 8px 40px rgba(0, 0, 0, 0.8), 0 2px 12px rgba(0, 0, 0, 0.6)' }}
            enable={resizeEnable}
          >
            {/* Draggable header */}
            <div
              className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 cursor-grab active:cursor-grabbing select-none"
              style={{ backgroundColor: '#313131' }}
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
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
          </Resizable>
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
