import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { detectVcs, getStatus, run } from '@/lib/vcsServer';

// POST /api/vcs/action
// Body: { root, op: 'stage'|'unstage'|'stageAll'|'unstageAll'|'commit',
//         paths?: string[] (repo-relative, as returned by /api/vcs/status),
//         message?: string, description?: string }
// Success: { success: true, status: StatusPayload }  (fresh status inline —
// saves a round trip and avoids refetch races)
// Failure: { error, errorCode?, status? } with HTTP 400/409/500.
// errorCode: 'empty-message'|'nothing-staged'|'identity-unset'|'conflicts'|'out-of-date'

type Op = 'stage' | 'unstage' | 'stageAll' | 'unstageAll' | 'commit';
const OPS: Op[] = ['stage', 'unstage', 'stageAll', 'unstageAll', 'commit'];

const NETWORK_TIMEOUT = 60_000; // svn commit talks to a server

interface ActionError {
  error: string;
  errorCode?: string;
  httpStatus: number;
}

function validateRelPaths(root: string, paths: unknown): string[] | null {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p) return null;
    // Paths must stay inside the working copy — they are relPaths the client
    // echoed back from our own status output.
    const rel = p.replace(/\\/g, '/');
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) return null;
    out.push(rel);
  }
  return out;
}

function mapGitCommitError(stderr: string, stdout: string): ActionError {
  const text = `${stderr}\n${stdout}`;
  if (/please tell me who you are|user\.name|user\.email/i.test(text)) {
    return {
      error: 'Git identity not configured — set user.name and user.email (git config).',
      errorCode: 'identity-unset',
      httpStatus: 409,
    };
  }
  if (/unmerged files|not concluded|unresolved conflict/i.test(text)) {
    return {
      error: 'Commit blocked by unresolved merge conflicts.',
      errorCode: 'conflicts',
      httpStatus: 409,
    };
  }
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return { error: 'Nothing staged to commit.', errorCode: 'nothing-staged', httpStatus: 400 };
  }
  return { error: (stderr || stdout || 'Commit failed').trim(), httpStatus: 500 };
}

async function gitAction(
  root: string,
  op: Op,
  relPaths: string[] | null,
  summary: string,
  description: string
): Promise<ActionError | null> {
  switch (op) {
    case 'stage': {
      if (!relPaths) return { error: 'paths required', httpStatus: 400 };
      const res = await run('git', ['add', '-A', '--', ...relPaths], root);
      return res.code === 0 ? null : { error: res.stderr.trim() || 'git add failed', httpStatus: 500 };
    }
    case 'stageAll': {
      const res = await run('git', ['add', '-A'], root);
      return res.code === 0 ? null : { error: res.stderr.trim() || 'git add failed', httpStatus: 500 };
    }
    case 'unstage':
    case 'unstageAll': {
      if (op === 'unstage' && !relPaths) return { error: 'paths required', httpStatus: 400 };
      const pathArgs = op === 'unstage' && relPaths ? ['--', ...relPaths] : [];
      const res = await run('git', ['reset', '-q', 'HEAD', ...pathArgs], root);
      if (res.code === 0) return null;
      // Unborn repo (no commits yet): HEAD doesn't resolve — drop the index
      // entries instead. --cached never touches the working tree.
      if (/ambiguous argument 'HEAD'|unknown revision/i.test(res.stderr)) {
        const fallbackPaths = op === 'unstage' && relPaths ? relPaths : ['.'];
        const rm = await run('git', ['rm', '--cached', '-r', '-q', '--', ...fallbackPaths], root);
        return rm.code === 0 ? null : { error: rm.stderr.trim() || 'git rm --cached failed', httpStatus: 500 };
      }
      return { error: res.stderr.trim() || 'git reset failed', httpStatus: 500 };
    }
    case 'commit': {
      const status = await getStatus(root);
      if (!status || status.staged.length === 0) {
        return { error: 'Nothing staged to commit.', errorCode: 'nothing-staged', httpStatus: 400 };
      }
      const args = ['commit', '-m', summary];
      if (description) args.push('-m', description);
      const res = await run('git', args, root);
      return res.code === 0 ? null : mapGitCommitError(res.stderr, res.stdout);
    }
  }
}

async function svnCommit(
  root: string,
  relPaths: string[],
  summary: string,
  description: string
): Promise<ActionError | null> {
  // SVN has no staging area — the client sends the selected files. Untracked
  // selections need `svn add`, missing ones `svn delete`, before commit.
  const status = await getStatus(root);
  if (!status) return { error: 'Not an svn working copy', httpStatus: 400 };
  const byRel = new Map(status.unstaged.map((e) => [e.relPath, e.status]));

  for (const rel of relPaths) {
    const st = byRel.get(rel);
    if (st === '?') {
      const res = await run('svn', ['add', '--parents', '--', rel], root);
      if (res.code !== 0) return { error: res.stderr.trim() || `svn add failed for ${rel}`, httpStatus: 500 };
    } else if (st === '!') {
      const res = await run('svn', ['delete', '--', rel], root);
      if (res.code !== 0) return { error: res.stderr.trim() || `svn delete failed for ${rel}`, httpStatus: 500 };
    }
  }

  const message = description ? `${summary}\n\n${description}` : summary;
  const res = await run('svn', ['commit', '-m', message, '--', ...relPaths], root, {
    timeout: NETWORK_TIMEOUT,
  });
  if (res.code === 0) return null;
  if (/out of date/i.test(res.stderr)) {
    return {
      error: 'Working copy is out of date — run svn update first.',
      errorCode: 'out-of-date',
      httpStatus: 409,
    };
  }
  return { error: res.stderr.trim() || 'svn commit failed', httpStatus: 500 };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { root, op } = body as { root?: string; op?: Op };

    if (!root || typeof root !== 'string') {
      return NextResponse.json({ error: 'root is required' }, { status: 400 });
    }
    if (!op || !OPS.includes(op)) {
      return NextResponse.json({ error: 'Invalid op' }, { status: 400 });
    }
    try {
      const stats = await fs.stat(root);
      if (!stats.isDirectory()) {
        return NextResponse.json({ error: 'root is not a directory' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'root does not exist' }, { status: 404 });
    }

    const vcs = await detectVcs(root);
    if (!vcs) {
      return NextResponse.json({ error: 'Not a VCS working copy' }, { status: 400 });
    }

    const relPaths = body.paths !== undefined ? validateRelPaths(root, body.paths) : null;
    if (body.paths !== undefined && relPaths === null) {
      return NextResponse.json({ error: 'Invalid paths' }, { status: 400 });
    }

    const summary = typeof body.message === 'string' ? body.message.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';

    if (op === 'commit' && !summary) {
      return NextResponse.json(
        { error: 'Commit message is required.', errorCode: 'empty-message' },
        { status: 400 }
      );
    }

    let failure: ActionError | null;
    if (vcs === 'git') {
      failure = await gitAction(root, op, relPaths, summary, description);
    } else {
      // svn: staging is entirely client-side; only commit reaches the server
      if (op !== 'commit') {
        return NextResponse.json({ error: `op '${op}' is not applicable to svn` }, { status: 400 });
      }
      if (!relPaths) {
        return NextResponse.json({ error: 'paths required for svn commit' }, { status: 400 });
      }
      failure = await svnCommit(root, relPaths, summary, description);
    }

    const status = await getStatus(root);
    if (failure) {
      return NextResponse.json(
        { error: failure.error, errorCode: failure.errorCode, status },
        { status: failure.httpStatus }
      );
    }
    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error('Error in /api/vcs/action:', error);
    return NextResponse.json({ error: 'VCS action failed' }, { status: 500 });
  }
}
