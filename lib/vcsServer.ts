// Server-side VCS helpers shared by the /api/vcs/* routes.
// All commands run through execFile with argument arrays (never a shell),
// matching the convention in app/api/tree/route.ts.

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export type VcsType = 'git' | 'svn';

// M=modified, A=added, D=deleted, R=renamed, ?=untracked, C=conflict, !=missing
export type VcsFileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'C' | '!';

export interface VcsFileEntry {
  /** Absolute path (path.join(root, rel)) — matches FileTree status-map keys */
  path: string;
  /** Forward-slash repo-relative path — for display and as git/svn CLI args */
  relPath: string;
  status: VcsFileStatus;
  /** Renames: the old path (needed to diff a staged rename against HEAD) */
  origRelPath?: string;
}

export interface StatusPayload {
  vcs: VcsType;
  branch: string | null; // git only; '(detached)' when detached
  detached: boolean;
  unborn: boolean;       // git repo with no commits yet
  staged: VcsFileEntry[];   // always [] for svn (no staging area)
  unstaged: VcsFileEntry[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number; // 0 on success
}

const MAX_BUFFER = 1024 * 1024;
const DEFAULT_TIMEOUT = 15_000;

/** Promisified execFile. Never rejects — callers inspect `code`/`stderr`. */
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { timeout?: number }
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: MAX_BUFFER, timeout: opts?.timeout ?? DEFAULT_TIMEOUT },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : 1;
          resolve({ stdout: stdout ?? '', stderr: (stderr || err.message) ?? '', code });
        } else {
          resolve({ stdout, stderr, code: 0 });
        }
      }
    );
  });
}

export async function detectVcs(dirPath: string): Promise<VcsType | null> {
  // Check for .git first (more common), then .svn
  try {
    await fs.stat(path.join(dirPath, '.git'));
    return 'git';
  } catch {
    // Not git
  }
  try {
    await fs.stat(path.join(dirPath, '.svn'));
    return 'svn';
  } catch {
    // Not svn
  }
  return null;
}

// Unmerged XY combinations from `git status` — all collapse to 'C' (conflict)
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function mapGitCode(c: string): VcsFileStatus | null {
  switch (c) {
    case 'M':
    case 'T': // typechange — treat as modified
      return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case 'C': return 'A'; // copied in index — closest UI meaning is "added"
    default: return null;
  }
}

interface GitBranchInfo {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
}

function parseBranchHeader(header: string): GitBranchInfo {
  // "## main...origin/main [ahead 1]" | "## main" | "## HEAD (no branch)" | "## No commits yet on main"
  const s = header.slice(3);
  if (s.startsWith('No commits yet on ')) {
    return { branch: s.slice('No commits yet on '.length), detached: false, unborn: true };
  }
  if (s.startsWith('HEAD (no branch)')) {
    return { branch: '(detached)', detached: true, unborn: false };
  }
  return { branch: s.split('...')[0].split(' ')[0] || null, detached: false, unborn: false };
}

async function getGitStatus(root: string): Promise<StatusPayload> {
  // -z: NUL-separated records — avoids porcelain's C-style quoting/octal
  // escaping of special-char filenames entirely. A staged rename/copy is TWO
  // records: "XY new-path" followed by "old-path".
  const res = await run('git', ['status', '--porcelain=v1', '-b', '-z', '-uall'], root);
  const payload: StatusPayload = {
    vcs: 'git', branch: null, detached: false, unborn: false, staged: [], unstaged: [],
  };
  if (res.code !== 0) return payload;

  const records = res.stdout.split('\0').filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.startsWith('## ')) {
      Object.assign(payload, parseBranchHeader(rec));
      continue;
    }
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const xy = x + y;
    const rel = rec.slice(3);
    const abs = path.join(root, rel);

    // Renames/copies carry the original path as the NEXT record
    let origRelPath: string | undefined;
    if (x === 'R' || x === 'C') {
      origRelPath = records[++i];
    }

    if (xy === '??') {
      payload.unstaged.push({ path: abs, relPath: rel, status: '?' });
      continue;
    }
    if (CONFLICT_CODES.has(xy)) {
      payload.unstaged.push({ path: abs, relPath: rel, status: 'C' });
      continue;
    }

    const stagedStatus = mapGitCode(x);
    if (stagedStatus) {
      payload.staged.push({ path: abs, relPath: rel, status: stagedStatus, origRelPath });
    }
    const unstagedStatus = mapGitCode(y);
    if (unstagedStatus) {
      payload.unstaged.push({ path: abs, relPath: rel, status: unstagedStatus });
    }
  }
  return payload;
}

function mapSvnCode(c: string): VcsFileStatus | null {
  switch (c) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case '?': return '?';
    case '!': return '!';
    case 'C': return 'C';
    default: return null;
  }
}

async function getSvnStatus(root: string): Promise<StatusPayload> {
  const payload: StatusPayload = {
    vcs: 'svn', branch: null, detached: false, unborn: false, staged: [], unstaged: [],
  };
  const res = await run('svn', ['status'], root);
  if (res.code !== 0) return payload;

  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const status = mapSvnCode(line[0]);
    if (!status) continue;
    const raw = line.slice(8).trim();
    if (!raw) continue;
    const relPath = raw.replace(/\\/g, '/');
    payload.unstaged.push({ path: path.join(root, relPath), relPath, status });
  }
  return payload;
}

/** Full status for a working-copy root, or null if the dir is not under VCS. */
export async function getStatus(root: string): Promise<StatusPayload | null> {
  const vcs = await detectVcs(root);
  if (!vcs) return null;
  return vcs === 'git' ? getGitStatus(root) : getSvnStatus(root);
}

/** Cheap branch lookup (no file status) — for lightweight UI labels.
 *  git: branch name, '(detached)', works on unborn branches too.
 *  svn: tail of the repo-relative URL (e.g. 'trunk'), or null. */
export async function getBranch(root: string, vcs: VcsType): Promise<string | null> {
  if (vcs === 'git') {
    // symbolic-ref resolves the branch HEAD points at (incl. unborn branches);
    // it exits non-zero on a detached HEAD.
    const res = await run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], root);
    if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
    return '(detached)';
  }
  const res = await run('svn', ['info', '--show-item', 'relative-url'], root);
  if (res.code !== 0) return null;
  const rel = res.stdout.trim().replace(/^\^\//, '');
  if (!rel) return null;
  return rel.split('/').pop() || rel;
}
