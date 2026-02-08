// Utility functions for managing recent directories from history entries and workflows

interface HistoryEntry {
  project: string;
}

interface NodeChatSession {
  workingDirectory: string;
}

interface Workflow {
  data: {
    drawflow?: {
      Home?: {
        data?: Record<string, {
          data?: {
            chatSession?: NodeChatSession;
          };
        }>;
      };
    };
  };
}

/**
 * Extract working directories from workflow nodes
 */
export function extractWorkflowDirectories(workflows: Workflow[]): string[] {
  const directories = new Set<string>();

  for (const workflow of workflows) {
    const nodes = workflow.data?.drawflow?.Home?.data;
    if (!nodes) continue;

    for (const nodeId in nodes) {
      const node = nodes[nodeId];
      const workingDirectory = node.data?.chatSession?.workingDirectory;
      if (workingDirectory) {
        directories.add(workingDirectory);
      }
    }
  }

  return Array.from(directories);
}

/**
 * Get all recent directories from history entries and workflows
 * Returns unique directories sorted by most recently used
 */
export function getRecentDirectories(
  historyEntries: HistoryEntry[],
  workflows: Workflow[]
): string[] {
  const historyDirs = historyEntries.map(e => e.project).filter(Boolean);
  const workflowDirs = extractWorkflowDirectories(workflows);

  // Combine and deduplicate
  const allDirs = [...historyDirs, ...workflowDirs];
  const uniqueDirs = Array.from(new Set(allDirs));

  // Return up to 20 most recent directories
  return uniqueDirs.slice(0, 20);
}
