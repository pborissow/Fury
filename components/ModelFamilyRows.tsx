'use client';

import React, { useState } from 'react';
import Dialog from '@/components/Dialog';
import PricingDialog from '@/components/PricingDialog';
import { norm, type UseModelCatalog } from '@/components/useModelCatalog';

/** Local calendar day (YYYY-MM-DD) for the "Index updated" label. */
function isoDay(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('en-CA') : 'never';
}

/** Human-readable "time ago" for the refresh dialog body. */
function relTime(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The shared model/version selection UI: one row per family (Fable/Opus/Sonnet/
 * Haiku), each with a radio, a version dropdown, and the family tagline. Rendered
 * by BOTH ModelPickerDialog (mid-session) and NewSessionModelStep (new-session
 * wizard) so the two views never drift.
 *
 * All state lives in the `catalog` hook; this component is presentational. The
 * `active` badge is shown only when a session is running (catalog.activeNorm set).
 */
export default function ModelFamilyRows({
  catalog,
  radioName,
  emptyHint,
}: {
  catalog: UseModelCatalog;
  /** Radio group name — distinct per dialog so two mounts never share a group. */
  radioName: string;
  /** Copy shown when the catalog is empty (differs between the two dialogs). */
  emptyHint: React.ReactNode;
}) {
  const {
    loading, error, live, families, taglineFor,
    activeNorm, defaultNorm, selectedFamily, pickFamily, versionIdFor, pickVersion,
    lastCheckedAt, refreshing, refreshNote, refresh, clearRefreshNote,
  } = catalog;

  const [refreshOpen, setRefreshOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  return (
    <>
      <div className="space-y-2">
        {loading && <div className="text-xs text-muted-foreground">Loading models...</div>}

        {error && (
          <div className="text-xs text-destructive px-3 py-2 rounded-md bg-destructive/10 border border-destructive/30">
            {error}
          </div>
        )}

        {!loading && !live && families.length > 0 && (
          <div className="space-y-3 text-sm leading-normal text-muted-foreground">
            Select a model
          </div>
        )}

        {!loading && families.length === 0 && !error && (
          <div className="text-xs text-muted-foreground">{emptyHint}</div>
        )}

        {families.map(fam => {
          const isSelected = selectedFamily === fam.family;
          const chosenId = versionIdFor(fam);
          const chosen = fam.versions.find(v => v.id === chosenId);
          const isActive = !!activeNorm && norm(chosenId) === activeNorm;
          const isDefault = !!defaultNorm && norm(chosenId) === defaultNorm;
          const tagline = taglineFor(fam.family);
          return (
            <label
              key={fam.family}
              className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'
              }`}
            >
              <input
                type="radio"
                name={radioName}
                checked={isSelected}
                onChange={() => pickFamily(fam.family)}
                className="mt-0.5 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium flex items-center gap-2">
                  {fam.displayName}
                  {isActive && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400 bg-green-950/60 border border-green-700/50 rounded px-1.5 py-0.5">
                      active
                    </span>
                  )}
                  {isDefault && (
                    <span className="text-[10px] font-normal lowercase text-muted-foreground">
                      (current default)
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {fam.versions.length > 1 ? (
                    <select
                      data-testid={`version-select-${fam.family}`}
                      value={chosenId}
                      onChange={e => pickVersion(fam.family, e.target.value)}
                      onClick={e => e.stopPropagation() /* operate the dropdown, don't toggle the row radio */}
                      className="text-[11px] leading-tight bg-background border border-border rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:border-primary"
                    >
                      {fam.versions.map(v => (
                        <option key={v.id} value={v.id}>{`${fam.displayName} ${v.versionLabel}`}</option>
                      ))}
                    </select>
                  ) : (
                    <span>{chosen ? `${fam.displayName} ${chosen.versionLabel}` : fam.displayName}</span>
                  )}
                  {tagline && <span>· {tagline}</span>}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* "Index updated" affordance pinned to the dialog's bottom-left corner —
          click to open the refresh dialog. Absolutely positioned against the
          dialog's relative outer box (escapes the content scroll area); sits in the
          footer's empty left region, clear of the right-aligned buttons. Mirrors the
          chat editor's tiny model-label. */}
      <div
        data-testid="model-catalog-updated"
        className="mt-auto pt-3 self-start text-muted-foreground hover:text-foreground"
        style={{
          fontSize: '9px', fontWeight: 100, cursor: 'pointer',
          position: 'absolute', bottom: 60, left: 5,
        }}
        title="Model list — click to refresh"
        onClick={() => { clearRefreshNote(); setRefreshOpen(true); }}
      >
        Index updated {isoDay(lastCheckedAt)}
      </div>

      {/* Refresh dialog — re-fetches GET /v1/models, updating the cache and
          resetting the weekly timer on the server. */}
      <Dialog
        open={refreshOpen}
        onOpenChange={setRefreshOpen}
        title="Refresh model list"
        defaultWidth={560}
        defaultHeight={320}
        minWidth={420}
        minHeight={240}
        buttons={[
          { label: 'Close', onClick: () => setRefreshOpen(false), variant: 'ghost' },
          { label: refreshing ? 'Refreshing...' : 'Refresh', onClick: refresh, disabled: refreshing },
        ]}
      >
        <div className="space-y-3 text-sm leading-normal text-muted-foreground">
          <div>
            The list of models and versions was last updated{' '}{relTime(lastCheckedAt)} on {' '}
            <span>
              {lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : 'never'}
            </span>
            . The list is refreshed automatically on a weekly schedule but you have the option to update it now.
          </div>
          <div>Click Refresh to update the list of models.</div>
          <div>
            <button
              type="button"
              onClick={() => setPricingOpen(true)}
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              View model pricing
            </button>
          </div>
          {refreshNote && (
            <div className="text-xs px-3 py-2 rounded-md bg-accent/40 border border-border text-foreground">
              {refreshNote}
            </div>
          )}
        </div>
      </Dialog>

      <PricingDialog open={pricingOpen} onOpenChange={setPricingOpen} />
    </>
  );
}
