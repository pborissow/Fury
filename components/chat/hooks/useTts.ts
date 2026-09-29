'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TurnMeta } from '@/lib/transcriptParser';

export type TtsPlaying = 'loading' | 'playing' | 'paused' | 'idle';
export interface SpeakableBubble { content: string; turnMeta?: TurnMeta }

/** Minimum gap between chimes. Several sessions finishing within a couple of
 *  seconds (distinct SSE events, so a per-event dedupe can't see them) should
 *  ring ONCE, not machine-gun the bell. */
const CHIME_COOLDOWN_MS = 2000;

/**
 * Voice summary (TTS) of the viewed session's replies, plus the turn-complete
 * chime.
 *
 * The chime sounds whenever Claude finishes a turn in ANY session (TTS only
 * speaks the session in view). Ownership rule: when the finished session IS the
 * one in view and voice summary is on, the chime defers to TTS — speech is the
 * notification — but every TTS failure path chimes instead, so a completed turn
 * is never silent by accident.
 *
 * `enabledRef` mirrors `ttsEnabled` for long-lived SSE handlers. Every callback
 * here is stable (refs + setters only), so a handler bound once may hold them.
 */
export function useTts(ttsEnabled: boolean) {
  const enabledRef = useRef(ttsEnabled);
  useEffect(() => {
    enabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState<TtsPlaying>('idle');

  const chimeAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastChimeAtRef = useRef(0);

  const playChime = useCallback(() => {
    try {
      // Never ring over active voice playback: speech IS the notification. The
      // <audio> element is the source of truth — no state to fall out of sync —
      // and the TTS failure-path chimes still pass, since a playback that failed
      // or ended isn't playing. A single shared chime element means chimes can't
      // stack over EACH OTHER either.
      const tts = audioRef.current;
      if (tts && !tts.paused && !tts.ended) return;
      const now = Date.now();
      if (now - lastChimeAtRef.current < CHIME_COOLDOWN_MS) return;
      lastChimeAtRef.current = now;
      if (!chimeAudioRef.current) {
        chimeAudioRef.current = new Audio('/sounds/bike-bell.mp3');
        chimeAudioRef.current.volume = 0.5;
      }
      chimeAudioRef.current.currentTime = 0;
      // Rejection = browser autoplay policy (no user gesture yet) — expected on
      // a fresh tab; nothing to do about it.
      chimeAudioRef.current.play().catch(() => {});
    } catch {
      // No audio support — a chime is never worth an error.
    }
  }, []);

  /** Stop any in-flight TTS fetch and playing audio, revoke the blob URL. */
  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPlaying('idle');
  }, []);

  /**
   * Generate and play speech for a bubble, superseding anything playing.
   * `chimeOnFailure`: this speech IS a turn-complete notification (the chime
   * deferred to it), so if generation or playback fails, chime instead. A
   * supersede / session switch (AbortError) is not a failure: stay silent.
   */
  const speak = useCallback((bubble: SpeakableBubble, { chimeOnFailure }: { chimeOnFailure: boolean }) => {
    cleanup();
    const abort = new AbortController();
    abortRef.current = abort;
    setPlaying('loading');
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: bubble.content, turnMeta: bubble.turnMeta }),
      signal: abort.signal,
    })
      .then(res => {
        if (abortRef.current !== abort) return; // superseded
        if (!res.ok) throw new Error('TTS failed');
        return res.blob();
      })
      .then(blob => {
        if (!blob || abortRef.current !== abort) return; // superseded
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => setPlaying('idle');
        audio.play().catch(err => {
          console.error('[TTS] playback failed:', err);
          setPlaying('idle');
          if (chimeOnFailure) playChime();
        });
        setPlaying('playing');
      })
      .catch(err => {
        if (abortRef.current !== abort) return; // superseded
        if (err.name !== 'AbortError') console.error('[TTS]', err);
        setPlaying('idle');
        if (chimeOnFailure && err.name !== 'AbortError') playChime();
      });
  }, [cleanup, playChime]);

  /**
   * A turn in the VIEWED session finished: speak its bubble (when voice summary
   * is on). With nothing speakable, chime — the chime deferred to TTS for the
   * viewed session, so the completion must still make a sound.
   */
  const announce = useCallback((getBubble: () => SpeakableBubble | null) => {
    if (!enabledRef.current) return;
    const bubble = getBubble();
    if (bubble?.content) speak(bubble, { chimeOnFailure: true });
    else playChime();
  }, [speak, playChime]);

  /** The bubble's speaker button: pause/resume the current clip, or (no clip)
   *  re-generate from the bubble. */
  const toggle = useCallback((getBubble: () => SpeakableBubble | null) => {
    const audio = audioRef.current;
    if (audio) {
      if (audio.paused) {
        audio.currentTime = 0;
        audio.play().catch(err => {
          console.error('[TTS] playback failed:', err);
          setPlaying('idle');
        });
        setPlaying('playing');
      } else {
        audio.pause();
        setPlaying('paused');
      }
      return;
    }
    const bubble = getBubble();
    if (!bubble?.content) return;
    speak(bubble, { chimeOnFailure: false });
  }, [speak]);

  return { playing, enabledRef, cleanup, playChime, speak, announce, toggle };
}
