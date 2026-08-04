'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeModelId } from '@/lib/pricing';

/** Mirror of the SDK's ModelInfo — kept structural so consumers stay client
 *  components without pulling the SDK (a node-only package) into the bundle. */
export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
}

/** Mirror of lib/modelCatalog's CatalogEntry (client-safe copy — that module is
 *  node-only, so we can't import its types here). */
export interface CatalogEntry {
  id: string;
  family: string;
  versionLabel: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  supportsEffort: boolean;
  createdAt: string | null;
}
export interface FamilyGroup {
  family: string;
  displayName: string;
  rank: number;
  versions: CatalogEntry[];
}

/** The SDK catalog's alias row for "whatever the provider default is". Selecting
 *  the version it resolves to maps back to `model: null` (follow the default). */
const DEFAULT_VALUE = 'default';

/** Strip the catalog's context-variant suffix ('claude-opus-4-8[1m]' -> base). */
export const stripCtx = (v: string | undefined | null): string => (v ?? '').replace(/\[[^\]]*\]/g, '');
/** Canonical id for comparison: no [1m] suffix, no dated snapshot, no prefix. */
export const norm = (v: string | undefined | null): string => (v ? normalizeModelId(stripCtx(v)) : '');

/** Parse family + version from a wire id ('claude-sonnet-4-6' -> sonnet/4.6).
 *  Used for the SDK-fallback families and for reading SDK taglines by family. */
export function familyVersionFromId(id: string): { family: string; version: string } | null {
  const s = stripCtx(id);
  // Legacy 3.x ids are VERSION-first ('claude-3-5-sonnet-20241022'). Match that shape
  // FIRST — otherwise the family-first pattern below captures the dated snapshot
  // ('20241022') as the version and the model sorts to the top of its family (F4).
  const vf = s.match(/(\d+)(?:-(\d+))?-(fable|mythos|opus|sonnet|haiku)/i);
  if (vf) return { family: vf[3].toLowerCase(), version: vf[2] ? `${vf[1]}.${vf[2]}` : vf[1] };
  const m = s.match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i);
  if (!m) return null;
  return { family: m[1].toLowerCase(), version: m[3] ? `${m[2]}.${m[3]}` : m[2] };
}

const FAMILY_ORDER = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
const familyRank = (f: string) => {
  const i = FAMILY_ORDER.indexOf(f.toLowerCase());
  return i === -1 ? FAMILY_ORDER.length : i;
};

export interface Selection {
  /** Selected wire id, e.g. 'claude-sonnet-4-6' (or '' before the catalog lands). */
  id: string;
  /** True when the selection is the provider default → apply as `model: null`. */
  isDefault: boolean;
  /** The selected catalog entry, or null. */
  version: CatalogEntry | null;
}

export interface UseModelCatalog {
  loading: boolean;
  error: string | null;
  /** False when the list came from cache/warm rather than a live query. */
  live: boolean;
  /** Effective family list — cached Models-API catalog, or SDK fallback. */
  families: FamilyGroup[];
  /** Family-level tagline copy from the SDK catalog ("Fastest for quick answers"). */
  taglineFor: (family: string) => string | null;
  /** The session's saved override (undefined = following the default). */
  current?: string;
  /** Live prompt occupancy (0 when unknown / no session). */
  contextTokens: number;
  /** Normalized id actually serving now ('' if none / no session). */
  activeNorm: string;
  /** Normalized id the provider default resolves to, or null. */
  defaultNorm: string | null;

  selectedFamily: string | null;
  pickFamily: (family: string) => void;
  versionIdFor: (fam: FamilyGroup) => string;
  pickVersion: (family: string, id: string) => void;
  selection: Selection;
  /** True when applying would be a no-op (only meaningful with a session). */
  unchanged: boolean;

  lastCheckedAt: number | null;
  refreshing: boolean;
  refreshNote: string | null;
  refresh: () => Promise<void>;
  clearRefreshNote: () => void;
}

/**
 * Shared data + selection engine for the model pickers.
 *
 * Both the mid-session picker (ModelPickerDialog) and the new-session wizard step
 * (NewSessionModelStep) render the same family/version rows; keeping the fetch,
 * fallback, default detection, and selection derivation here is what stops the two
 * views from drifting apart.
 *
 * Pass `sessionId: null` for the pre-session wizard (no active/current/context,
 * catalog fetched warm). Pass `activeModel` only when a session is running.
 */
export function useModelCatalog({
  open,
  sessionId,
  activeModel = null,
}: {
  open: boolean;
  sessionId: string | null;
  activeModel?: string | null;
}): UseModelCatalog {
  const [families, setFamilies] = useState<FamilyGroup[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [sdkModels, setSdkModels] = useState<ModelInfo[]>([]);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [contextTokens, setContextTokens] = useState(0);
  const [live, setLive] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pickedFamily, setPickedFamily] = useState<string | null>(null);
  const [versionByFamily, setVersionByFamily] = useState<Record<string, string>>({});

  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const res = await fetch('/api/model-catalog');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setFamilies(data.families ?? []);
    setLastCheckedAt(data.lastCheckedAt ?? null);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPickedFamily(null);
    setVersionByFamily({});
    setRefreshNote(null);

    const sdkUrl = sessionId
      ? `/api/claude-sdk/model?sessionId=${encodeURIComponent(sessionId)}`
      : '/api/claude-sdk/model';

    Promise.all([
      loadCatalog().catch(() => { /* fall back to SDK catalog below */ }),
      fetch(sdkUrl)
        .then(res => res.json())
        .then(data => {
          if (data.error) throw new Error(data.error);
          setSdkModels(data.models ?? []);
          setLive(data.live ?? false);
          setCurrent(data.current);
          setContextTokens(data.contextTokens ?? 0);
        }),
    ])
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load models'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, sessionId, loadCatalog]);

  /** Family taglines from the SDK catalog: the copy after ' · ' in each row's
   *  description ("Haiku 4.5 · Fastest for quick answers" -> "Fastest for quick
   *  answers"). Version-independent, so it applies to every version of a family. */
  const taglines = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of sdkModels) {
      if (m.value === DEFAULT_VALUE) continue;
      const fv = familyVersionFromId(m.resolvedModel || m.value);
      if (!fv || map[fv.family]) continue;
      const desc = m.description || '';
      const idx = desc.indexOf(' · ');
      map[fv.family] = idx >= 0 ? desc.slice(idx + 3) : desc;
    }
    return map;
  }, [sdkModels]);
  const taglineFor = useCallback((family: string) => taglines[family] ?? null, [taglines]);

  /** Effective families: prefer the cached catalog; else synthesize single-version
   *  families from the SDK catalog so the picker still works before the cache lands. */
  const families_ = useMemo<FamilyGroup[]>(() => {
    if (families.length) return families;
    const byFamily = new Map<string, CatalogEntry[]>();
    for (const m of sdkModels) {
      if (m.value === DEFAULT_VALUE) continue;
      const id = stripCtx(m.resolvedModel || m.value);
      const fv = familyVersionFromId(id);
      if (!fv) continue;
      const entry: CatalogEntry = {
        id, family: fv.family, versionLabel: fv.version,
        displayName: m.displayName || id, maxInputTokens: null, maxOutputTokens: null,
        supportsEffort: m.supportsEffort ?? false, createdAt: null,
      };
      (byFamily.get(fv.family) ?? byFamily.set(fv.family, []).get(fv.family)!).push(entry);
    }
    return [...byFamily.entries()]
      .map(([family, versions]) => ({
        family, displayName: family[0].toUpperCase() + family.slice(1),
        rank: familyRank(family), versions,
      }))
      .sort((a, b) => a.rank - b.rank);
  }, [families, sdkModels]);

  const defaultNorm = useMemo(() => {
    const def = sdkModels.find(m => m.value === DEFAULT_VALUE);
    return def?.resolvedModel ? norm(def.resolvedModel) : null;
  }, [sdkModels]);

  const currentNorm = current ? norm(current) : null;
  const activeNorm = norm(activeModel);

  const preferredVersion = useCallback(
    (fam: FamilyGroup): CatalogEntry => {
      const by = (n: string | null) => (n ? fam.versions.find(v => norm(v.id) === n) : undefined);
      return by(currentNorm) ?? by(activeNorm) ?? by(defaultNorm) ?? fam.versions[0];
    },
    [currentNorm, activeNorm, defaultNorm],
  );

  const familyOf = useCallback(
    (n: string | null): FamilyGroup | undefined =>
      n ? families_.find(f => f.versions.some(v => norm(v.id) === n)) : undefined,
    [families_],
  );

  const selectedFamily = useMemo(() => {
    if (pickedFamily) return pickedFamily;
    return (familyOf(currentNorm) ?? familyOf(defaultNorm) ?? families_[0])?.family ?? null;
  }, [pickedFamily, familyOf, currentNorm, defaultNorm, families_]);

  const versionIdFor = useCallback(
    (fam: FamilyGroup): string => versionByFamily[fam.family] ?? preferredVersion(fam)?.id ?? '',
    [versionByFamily, preferredVersion],
  );

  const selectedGroup = families_.find(f => f.family === selectedFamily);
  const selectedId = selectedGroup ? versionIdFor(selectedGroup) : '';
  const selectedVersion = selectedGroup?.versions.find(v => v.id === selectedId) ?? null;
  const isDefault = !!defaultNorm && norm(selectedId) === defaultNorm;

  const unchanged =
    !!selectedId &&
    (currentNorm ? norm(selectedId) === currentNorm : isDefault) &&
    (!activeNorm || norm(selectedId) === activeNorm);

  const pickFamily = useCallback((family: string) => setPickedFamily(family), []);
  const pickVersion = useCallback((family: string, id: string) => {
    setVersionByFamily(prev => ({ ...prev, [family]: id }));
    setPickedFamily(family);
  }, []);

  const clearRefreshNote = useCallback(() => setRefreshNote(null), []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch('/api/model-catalog', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Refresh failed');
      setFamilies(data.families ?? []);
      setLastCheckedAt(data.lastCheckedAt ?? null);
      setRefreshNote(data.status === 'ok' ? `Updated — ${data.models} models.` : `Refresh failed: ${data.note}`);
    } catch (err) {
      setRefreshNote(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, []);

  return {
    loading, error, live,
    families: families_, taglineFor,
    current, contextTokens, activeNorm, defaultNorm,
    selectedFamily, pickFamily, versionIdFor, pickVersion,
    selection: { id: selectedId, isDefault, version: selectedVersion },
    unchanged,
    lastCheckedAt, refreshing, refreshNote, refresh, clearRefreshNote,
  };
}
