'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Dialog from '@/components/Dialog';
import CopyableCodeBlock from '@/components/CopyableCodeBlock';
import { Input } from '@/components/ui/input';
import {
  buildProseAnswer,
  buildStructuredAnswers,
  type AskQuestion,
  type AskQuestionOption,
} from '@/lib/askUserQuestion';

const ExternalLink = ({ node: _node, ...props }: any) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);

const assistantMarkdownComponents = {
  pre: CopyableCodeBlock,
  a: ExternalLink,
};

type QuestionOption = AskQuestionOption;
type Question = AskQuestion;

interface AskUserQuestionDialogProps {
  open: boolean;
  questions: Question[];
  /** The last assistant message rendered in the chat panel. Shown at the top
   *  of the dialog so the user can read the context Claude's question refers
   *  to without the modal obstructing the (unscrollable) chat panel. */
  context?: string;
  /**
   * The CLI path's callback: the answer as English prose, which the caller
   * re-sends as a brand-new user turn (the CLI cannot answer the tool itself).
   */
  onSubmit: (formattedAnswer: string) => void;
  /**
   * The SDK path's callback: the answer as the tool's own structured input,
   * keyed by question text. When provided this WINS over onSubmit — the parked
   * tool call is resolved in place and no new turn is sent.
   *
   * Both props exist because both backends ship simultaneously; the caller
   * chooses by passing one or the other, not by a flag in here.
   */
  onSubmitStructured?: (result: {
    answers: Record<string, string>;
    annotations?: Record<string, { notes?: string }>;
  }) => void;
  onSkip: () => void;
}

export default function AskUserQuestionDialog({
  open,
  questions,
  context,
  onSubmit,
  onSubmitStructured,
  onSkip,
}: AskUserQuestionDialogProps) {
  // Per-question state: selected option indices
  const [selections, setSelections] = useState<Map<number, Set<number>>>(new Map());
  // Per-question: whether "Other" is active
  const [useOther, setUseOther] = useState<Map<number, boolean>>(new Map());
  // Per-question: custom "Other" text
  const [otherText, setOtherText] = useState<Map<number, string>>(new Map());

  const toggleOption = (qIndex: number, oIndex: number, multiSelect: boolean) => {
    setSelections(prev => {
      const next = new Map(prev);
      const current = new Set(next.get(qIndex) || []);

      if (multiSelect) {
        if (current.has(oIndex)) current.delete(oIndex);
        else current.add(oIndex);
      } else {
        current.clear();
        current.add(oIndex);
      }

      // Deselect "Other" when picking a regular option in single-select
      if (!multiSelect) {
        setUseOther(p => { const n = new Map(p); n.set(qIndex, false); return n; });
      }

      next.set(qIndex, current);
      return next;
    });
  };

  const toggleOther = (qIndex: number, multiSelect: boolean) => {
    setUseOther(prev => {
      const next = new Map(prev);
      const wasActive = next.get(qIndex) || false;
      next.set(qIndex, !wasActive);

      // For single-select, clear regular selections when choosing "Other"
      if (!multiSelect && !wasActive) {
        setSelections(p => { const n = new Map(p); n.set(qIndex, new Set()); return n; });
      }

      return next;
    });
  };

  const setOtherTextForQuestion = (qIndex: number, text: string) => {
    setOtherText(prev => {
      const next = new Map(prev);
      next.set(qIndex, text);
      return next;
    });
  };

  // Validate: every question must have at least one selection or "Other" text
  const isValid = questions.every((_, qIndex) => {
    const selected = selections.get(qIndex);
    const hasSelection = selected && selected.size > 0;
    const hasOther = (useOther.get(qIndex) || false) && (otherText.get(qIndex) || '').trim().length > 0;
    return hasSelection || hasOther;
  });

  const handleSubmit = () => {
    // Both serializers read the same three Maps; only the output shape differs.
    // They live in lib/askUserQuestion.ts so they're unit-testable (vitest runs
    // node, not jsdom, so nothing in this file can be tested directly).
    const state = { selections, useOther, otherText };

    // Structured wins when the caller offers it: it resolves the parked tool
    // call in place. Falling through to prose would ALSO send a new turn, and
    // the model would get the answer twice.
    if (onSubmitStructured) {
      onSubmitStructured(buildStructuredAnswers(questions, state));
      return;
    }

    onSubmit(buildProseAnswer(questions, state));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onSkip(); }}
      title="Claude has a question"
      defaultWidth={560}
      defaultHeight={560}
      minWidth={400}
      minHeight={300}
      maximizable
      buttons={[
        { label: 'Skip', onClick: onSkip, variant: 'outline' },
        { label: 'Submit', onClick: handleSubmit, disabled: !isValid },
      ]}
    >
      <div className="-mx-4 -mt-4 px-4 pt-2 pb-2 mb-4 text-sm text-muted-foreground border-b border-border">
        Please answer to continue the conversation
      </div>

      {context?.trim() && (
        <div className="mb-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Claude&apos;s message
          </div>
          <div className="max-h-52 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="prose-chat max-w-none text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={assistantMarkdownComponents}
              >
                {context}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {questions.map((q, qIndex) => (
          <div key={qIndex} className="space-y-3">
            {q.header && (
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {q.header}
              </div>
            )}
            <p className="text-sm text-foreground">{q.question}</p>

            <div className="space-y-2">
              {q.options.map((opt, oIndex) => {
                const isSelected = selections.get(qIndex)?.has(oIndex) || false;
                return (
                  <label
                    key={oIndex}
                    className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent/50'
                    }`}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`question-${qIndex}`}
                      checked={isSelected}
                      onChange={() => toggleOption(qIndex, oIndex, q.multiSelect)}
                      className="mt-0.5 accent-primary"
                    />
                    <div>
                      <div className="text-sm font-medium">{opt.label}</div>
                      {opt.description && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {opt.description}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}

              {/* "Other" option */}
              <label
                className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                  useOther.get(qIndex)
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent/50'
                }`}
              >
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`question-${qIndex}`}
                  checked={useOther.get(qIndex) || false}
                  onChange={() => toggleOther(qIndex, q.multiSelect)}
                  className="mt-0.5 accent-primary"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">Other</div>
                  {useOther.get(qIndex) && (
                    <Input
                      value={otherText.get(qIndex) || ''}
                      onChange={(e) => setOtherTextForQuestion(qIndex, e.target.value)}
                      placeholder="Type your answer..."
                      className="mt-2"
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && isValid) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                    />
                  )}
                </div>
              </label>
            </div>
          </div>
        ))}
      </div>

    </Dialog>
  );
}
