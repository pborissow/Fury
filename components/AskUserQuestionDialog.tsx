'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

interface AskUserQuestionDialogProps {
  open: boolean;
  questions: Question[];
  onSubmit: (formattedAnswer: string) => void;
  onSkip: () => void;
}

export default function AskUserQuestionDialog({
  open,
  questions,
  onSubmit,
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
    const parts: string[] = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = selections.get(i) || new Set();
      const isOther = useOther.get(i) || false;
      const custom = (otherText.get(i) || '').trim();

      const selectedLabels = Array.from(selected).map(idx => q.options[idx]?.label).filter(Boolean);
      let answer = '';

      if (isOther && custom) {
        if (selectedLabels.length > 0) {
          answer = `I choose: ${selectedLabels.join(', ')}. Additional input: ${custom}`;
        } else {
          answer = `My answer: ${custom}`;
        }
      } else if (selectedLabels.length > 0) {
        answer = `I choose: ${selectedLabels.join(', ')}`;
      }

      if (answer) {
        if (questions.length > 1 && q.header) {
          parts.push(`For "${q.header}": ${answer}`);
        } else {
          parts.push(answer);
        }
      }
    }

    onSubmit(parts.join('\n'));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onSkip(); }}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-xl max-h-[80vh] flex flex-col"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Claude has a question</DialogTitle>
          <DialogDescription>
            Please answer to continue the conversation
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-2">
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

        <DialogFooter>
          <Button variant="outline" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
