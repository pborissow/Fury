'use client';

import { useEffect, useState } from 'react';
import { getRecentDirectories } from '@/lib/recent-directories';
import type { HistoryEntry } from '@/lib/types';
import type { ChatDialogsProps } from '../ChatDialogs';

interface NewSessionWizardOptions {
  /** Source for the recent-directories list. */
  history: HistoryEntry[];
  /** Model selection only means anything on the SDK backend. */
  sdkSessionsEnabled: boolean;
  /** Create the session. `model` null = provider default (no override);
   *  `resolvedModel` = the picked row's wire id, for the status label. */
  onCreate: (path: string, model: string | null, resolvedModel?: string | null) => void;
}

/**
 * The two-step New Session wizard: (a) choose a directory, (b) choose the model,
 * then create. Owns the steps' UI state; creating the session is the caller's
 * (it resets the viewed session, which this hook doesn't own).
 */
export function useNewSessionWizard({ history, sdkSessionsEnabled, onCreate }: NewSessionWizardOptions) {
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [modelStepOpen, setModelStepOpen] = useState(false);
  // The directory chosen in step (a), held until the user commits or backs out.
  const [wizardPath, setWizardPath] = useState<string | null>(null);
  const [recentDirectories, setRecentDirectories] = useState<string[]>([]);

  // Recent directories: computed from history + workflows.
  useEffect(() => {
    const loadWorkflowsAndDirectories = async () => {
      try {
        const res = await fetch('/api/workflows');
        if (res.ok) {
          const data = await res.json();
          const loadedWorkflows = data.workflows || [];
          setRecentDirectories(getRecentDirectories(history, loadedWorkflows));
        }
      } catch (error) {
        console.error('Failed to load workflows:', error);
      }
    };

    loadWorkflowsAndDirectories();
  }, [history]);

  /** Start the wizard. */
  const open = () => setDirectoryPickerOpen(true);

  // (a) → (b): stash the directory and advance. Nothing is created yet.
  const onDirectoryNext = (path: string) => {
    setDirectoryPickerOpen(false);
    // With the SDK backend off, skip (b) and create on the default model rather
    // than show a step that can't take effect.
    if (!sdkSessionsEnabled) {
      onCreate(path, null);
      return;
    }
    setWizardPath(path);
    setModelStepOpen(true);
  };

  // (b) → (a): back to the directory picker.
  const onModelStepBack = () => {
    setModelStepOpen(false);
    setDirectoryPickerOpen(true);
  };

  // (b) commit: create on the chosen directory + model.
  const onModelStepCreate = (model: string | null, resolvedModel: string | null) => {
    setModelStepOpen(false);
    const path = wizardPath;
    setWizardPath(null);
    if (path) onCreate(path, model, resolvedModel);
  };

  const dialogs: ChatDialogsProps['wizard'] = {
    directoryPickerOpen,
    onDirectoryPickerOpenChange: setDirectoryPickerOpen,
    onDirectoryNext,
    recentDirectories,
    modelStepOpen,
    onModelStepClose: () => { setModelStepOpen(false); setWizardPath(null); },
    onModelStepBack,
    onModelStepCreate,
    directory: wizardPath,
  };

  return { open, dialogs };
}
