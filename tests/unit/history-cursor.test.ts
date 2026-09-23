/**
 * Cursor pagination for the session list (app/api/history/route.ts).
 *
 * The sidebar pages through a list that MUTATES while the user scrolls: a new
 * session is prepended on submit, an archive removes one. Offset paging skips
 * or repeats entries across that seam — the bug this replaces. These tests pin
 * the property that matters: walking the list page by page yields every session
 * exactly once, even when the list changes between pages.
 *
 * The slice/cursor logic is reimplemented here against the same comparator the
 * route uses; the route itself reads ~/.claude/history.jsonl and the archive DB,
 * which a unit test can't supply.
 */
import { describe, it, expect } from 'vitest';

interface Row { timestamp: number; cursorId: string }

/** Mirrors `byRecencyThenId` in app/api/history/route.ts. */
function byRecencyThenId(a: Row, b: Row): number {
  if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
  return a.cursorId < b.cursorId ? -1 : a.cursorId > b.cursorId ? 1 : 0;
}

/** Mirrors the route's page resolution. */
function page(all: Row[], limit: number, cursor: string | null) {
  const sorted = [...all].sort(byRecencyThenId);
  let start = 0;
  if (cursor) {
    const sep = cursor.indexOf(':');
    const cTs = Number(cursor.slice(0, sep));
    const cId = cursor.slice(sep + 1);
    if (sep > 0 && Number.isFinite(cTs)) {
      const idx = sorted.findIndex(
        e => e.timestamp < cTs || (e.timestamp === cTs && String(e.cursorId) > cId),
      );
      start = idx < 0 ? sorted.length : idx;
    }
  }
  const entries = sorted.slice(start, start + limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor: last ? `${last.timestamp}:${last.cursorId}` : null,
    hasMore: start + entries.length < sorted.length,
  };
}

function rows(n: number, startTs = 1_000_000): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: startTs - i * 10,
    cursorId: `s${String(i).padStart(4, '0')}`,
  }));
}

/** Walk every page, returning the ids seen in order. */
function walkAll(getAll: () => Row[], limit: number, mutate?: (pageNo: number) => void): string[] {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < 500; p++) {
    const res = page(getAll(), limit, cursor);
    seen.push(...res.entries.map(e => e.cursorId));
    if (!res.hasMore || !res.nextCursor) break;
    cursor = res.nextCursor;
    mutate?.(p);
  }
  return seen;
}

describe('history cursor pagination', () => {
  it('a static list is walked exactly once, in order, with no gaps', () => {
    const all = rows(103);
    const seen = walkAll(() => all, 25);
    expect(seen).toEqual(all.map(r => r.cursorId));
    expect(new Set(seen).size).toBe(103);
  });

  it('prepending sessions mid-scroll never skips an older one', () => {
    const all = rows(100);
    let added = 0;
    // A new session arrives (newest timestamp) after every page — exactly what
    // submitting a prompt does while the user is scrolling back.
    const seen = walkAll(() => all, 25, () => {
      added++;
      all.push({ timestamp: 2_000_000 + added, cursorId: `new${added}` });
    });
    // Every ORIGINAL session is still seen exactly once. (The newly prepended
    // ones sort above the cursor and are correctly not revisited.)
    for (const r of rows(100)) {
      expect(seen.filter(id => id === r.cursorId)).toHaveLength(1);
    }
  });

  it('removing the cursor\'s own entry mid-scroll still resumes correctly', () => {
    const all = rows(60);
    const seen = walkAll(() => all, 10, () => {
      // Archive the entry the cursor points at — the server must resume at the
      // next one in sort order rather than losing its place.
      const lastSeenIdx = all.findIndex(r => r.cursorId === `s${String(9).padStart(4, '0')}`);
      if (lastSeenIdx >= 0) all.splice(lastSeenIdx, 1);
    });
    // No duplicates, and nothing after the removed entry is lost.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain('s0010');
    expect(seen).toContain('s0059');
  });

  it('identical timestamps are ordered totally, so ties are not skipped', () => {
    // 30 sessions sharing one timestamp — a tie that offset paging handles by
    // luck and cursor paging must handle by construction.
    const all: Row[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: 5_000,
      cursorId: `tie${String(i).padStart(3, '0')}`,
    }));
    const seen = walkAll(() => all, 7);
    expect(seen.length).toBe(30);
    expect(new Set(seen).size).toBe(30);
  });

  /** The paging this replaced: positional slice, offset advanced by page size. */
  function walkAllByOffset(getAll: () => Row[], limit: number, mutate?: () => void): string[] {
    const seen: string[] = [];
    let offset = 0;
    for (let p = 0; p < 500; p++) {
      const sorted = [...getAll()].sort(byRecencyThenId);
      const entries = sorted.slice(offset, offset + limit);
      seen.push(...entries.map(e => e.cursorId));
      if (offset + entries.length >= sorted.length) break;
      offset += entries.length;
      mutate?.();
    }
    return seen;
  }

  it('CONTROL: offset paging REPEATS entries when a session is prepended', () => {
    const all = rows(100);
    let added = 0;
    const seen = walkAllByOffset(() => all, 25, () => {
      added++;
      all.push({ timestamp: 2_000_000 + added, cursorId: `new${added}` });
    });
    // A prepend shifts everything down one, so the row at the page seam is
    // served twice. Cursor paging sees each exactly once (test above).
    const duplicated = [...new Set(seen)].filter(id => seen.filter(x => x === id).length > 1);
    expect(duplicated.length).toBeGreaterThan(0);
  });

  it('CONTROL: offset paging SKIPS entries when a session is removed', () => {
    const all = rows(100);
    const seen = walkAllByOffset(() => all, 25, () => {
      // An archive/delete removes an already-passed row, shifting the rest up
      // past the offset — those rows are never served. This is the data-loss
      // case: a session the user is scrolling to find simply never appears.
      all.shift();
    });
    const originals = rows(100).map(r => r.cursorId);
    const missed = originals.filter(id => !seen.includes(id));
    expect(missed.length).toBeGreaterThan(0);
  });

  it('cursor paging survives removals above the cursor with no skips', () => {
    const all = rows(100);
    const seen = walkAll(() => all, 25, () => {
      all.shift(); // same mutation that makes offset paging lose rows
    });
    // Every session still present at the end was served, and none twice.
    expect(new Set(seen).size).toBe(seen.length);
    for (const r of all) {
      expect(seen).toContain(r.cursorId);
    }
  });

  it('hasMore is false exactly at the end', () => {
    const all = rows(50);
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const res: ReturnType<typeof page> = page(all, 25, cursor);
      pages++;
      if (!res.hasMore) break;
      cursor = res.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(2);
  });
});
