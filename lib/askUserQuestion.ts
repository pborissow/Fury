/**
 * Serializers for AskUserQuestion dialog state.
 *
 * There are TWO answer shapes because there are two backends, and they are not
 * interchangeable:
 *
 *   - PROSE (buildProseAnswer) — the CLI/`--print` path. It cannot answer the
 *     tool at all: the CLI auto-errors it, sessionManager kills the process, and
 *     the answer is re-injected as a brand-new user turn. So the answer has to
 *     be English the model reads as a message. Structure is unavoidably lost.
 *
 *   - STRUCTURED (buildStructuredAnswers) — the SDK path. The tool call is still
 *     parked in canUseTool, so the answer goes back as the tool's own
 *     `updatedInput.answers`, keyed by question text, in the same turn.
 *
 * These live outside AskUserQuestionDialog.tsx deliberately: the vitest suite
 * runs `tests/unit/**\/*.test.ts` in a node environment with no jsdom, so a
 * serializer defined inside a component could not be unit-tested at all.
 */

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskQuestionOption[];
}

/**
 * The dialog's three parallel Maps, all keyed by question index. `selections`
 * holds OPTION indices.
 */
export interface AskDialogState {
  selections: Map<number, Set<number>>;
  useOther: Map<number, boolean>;
  otherText: Map<number, string>;
}

/** Resolve one question's selected option indices to their labels. */
function selectedLabels(q: AskQuestion, state: AskDialogState, i: number): string[] {
  const selected = state.selections.get(i) || new Set<number>();
  return Array.from(selected)
    .map((idx) => q.options[idx]?.label)
    .filter((l): l is string => Boolean(l));
}

function customText(state: AskDialogState, i: number): string {
  return (state.useOther.get(i) || false) ? (state.otherText.get(i) || '').trim() : '';
}

/**
 * The CLI path's English rendering. Behavior preserved verbatim from the
 * dialog's original handleSubmit — do not "improve" it without checking the
 * model-facing wording, it is what the CLI backend has always sent.
 */
export function buildProseAnswer(questions: AskQuestion[], state: AskDialogState): string {
  const parts: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const labels = selectedLabels(q, state, i);
    const custom = customText(state, i);
    let answer = '';

    if (custom) {
      answer = labels.length > 0
        ? `I choose: ${labels.join(', ')}. Additional input: ${custom}`
        : `My answer: ${custom}`;
    } else if (labels.length > 0) {
      answer = `I choose: ${labels.join(', ')}`;
    }

    if (answer) {
      parts.push(questions.length > 1 && q.header ? `For "${q.header}": ${answer}` : answer);
    }
  }

  return parts.join('\n');
}

/**
 * The SDK path's structured rendering, per AskUserQuestionOutput's contract:
 * keyed by QUESTION TEXT (not index, not header), multi-select comma-joined.
 *
 *   { "Which library should we use?": "date-fns" }
 *   { "Which features do you want?": "Auth, Billing" }
 *
 * "Other" with no selections becomes the answer string itself. "Other" ALONGSIDE
 * selections keeps the selected labels as the answer and puts the free text in
 * annotations[questionText].notes — the answer field must stay a clean value the
 * model can match against the options it offered.
 *
 * Questions the user left blank are omitted rather than sent as "": the dialog
 * requires every question be answered before Submit enables, so a blank one here
 * means a shape we don't understand, and a silent "" would read as a real answer.
 */
export function buildStructuredAnswers(
  questions: AskQuestion[],
  state: AskDialogState,
): { answers: Record<string, string>; annotations?: Record<string, { notes?: string }> } {
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes?: string }> = {};

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const labels = selectedLabels(q, state, i);
    const custom = customText(state, i);

    if (labels.length > 0) {
      answers[q.question] = labels.join(', ');
      if (custom) annotations[q.question] = { notes: custom };
    } else if (custom) {
      answers[q.question] = custom;
    }
  }

  return Object.keys(annotations).length > 0 ? { answers, annotations } : { answers };
}
