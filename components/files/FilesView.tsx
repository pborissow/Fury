'use client';

import { useCallback, useState } from 'react';
import FileTree from '@/components/FileTree';
import CodeViewerDialog from '@/components/CodeViewerDialog';
import SourceControlDialog from '@/components/SourceControlDialog';
import { isCodeFile } from '@/components/DiffView';

interface FilesViewProps {
  projectPath: string | null;
}

/**
 * Project file tree plus the dialogs it opens: double-click a code file to view
 * it, or open Source Control. Keep this mounted while hidden (not unmounted) to
 * preserve the tree's expansion state. The dialogs portal to <body>, so they
 * appear the same even though they're declared inside this view.
 */
export default function FilesView({ projectPath }: FilesViewProps) {
  const [codeViewerPath, setCodeViewerPath] = useState<string | null>(null);
  const [sourceControlOpen, setSourceControlOpen] = useState(false);

  const handleFileDoubleClick = useCallback((filePath: string) => {
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || '';
    if (isCodeFile(fileName)) setCodeViewerPath(filePath);
  }, []);

  return (
    <>
      <FileTree projectPath={projectPath} onFileDoubleClick={handleFileDoubleClick} onOpenSourceControl={() => setSourceControlOpen(true)} />
      <CodeViewerDialog filePath={codeViewerPath} onClose={() => setCodeViewerPath(null)} />
      <SourceControlDialog open={sourceControlOpen} projectPath={projectPath} onClose={() => setSourceControlOpen(false)} />
    </>
  );
}
