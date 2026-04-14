'use client';

import { useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlock from '@tiptap/extension-code-block';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import TurndownService from 'turndown';
import { Button } from '@/components/ui/button';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});
import { Bold, Code, List, ListOrdered, Type, Send, Mic, MicOff, Square } from 'lucide-react';

interface RichTextEditorProps {
  onSubmit: (content: string) => void;
  placeholder?: string;
  disabled?: boolean;
  submitLabel?: string;
  isProcessing?: boolean;
  onStop?: () => void;
  initialContent?: string;
  onChange?: (content: string) => void;
  persistContent?: boolean; // If true, don't clear after submit
  showButtonBar?: boolean; // If true, show mic and send buttons
  debounceMs?: number; // Debounce delay for onChange callback (default: 300ms)
  statusBar?: React.ReactNode; // Optional status bar rendered below the editor
}

export interface RichTextEditorHandle {
  setContent: (content: string) => void;
  getContent: () => string;
  getPlainText: () => string;
  stopRecording: () => void;
}

const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(function RichTextEditor({
  onSubmit,
  placeholder = '',
  disabled = false,
  submitLabel = 'Send',
  isProcessing = false,
  onStop,
  initialContent = '',
  onChange,
  persistContent = false,
  showButtonBar = true,
  debounceMs = 300,
  statusBar,
}, ref) {
  const [isRecording, setIsRecording] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSubmitRef = useRef<() => void>(() => {});
  const isRecordingRef = useRef(false);
  // Force re-render on editor transactions so toolbar active states stay current
  const [, setTick] = useState(0);
  const recognitionRef = useRef<any>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingContentRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Debounced onChange handler using useCallback for stable reference
  const debouncedOnChange = useCallback((content: string) => {
    if (!onChange) return;

    pendingContentRef.current = content;

    // Clear existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Set new timeout
    debounceTimeoutRef.current = setTimeout(() => {
      pendingContentRef.current = null;
      onChange(content);
    }, debounceMs);
  }, [onChange, debounceMs]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false, // Disable default code block to use custom one
        link: false, // Disable auto-linking of URLs, file paths, and emails
      }),
      CodeBlock.configure({
        HTMLAttributes: {
          class: 'bg-muted p-3 rounded my-2 font-mono text-sm border border-border',
        },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: initialContent,
    immediatelyRender: false, // Fix SSR hydration issues
    editorProps: {
      attributes: {
        class: 'max-w-none focus:outline-none min-h-[80px] p-3 text-foreground',
      },
      // Strip <a> tags from pasted HTML so file paths, URLs, and emails
      // aren't auto-wrapped in hyperlinks by the source application.
      transformPastedHTML(html) {
        return html.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
      },
      handleKeyDown: (view, event) => {
        if (showButtonBar && event.key === 'Enter') {
          const state = view.state;
          const { $from } = state.selection;
          const inList = $from.node(-1)?.type.name === 'listItem';

          if (event.shiftKey) {
            // Shift+Enter = new line (always).
            event.preventDefault();

            if (inList) {
              // Inside a list: check if the current item is empty.
              // If empty, exit the list (like pressing backspace on an empty bullet).
              // If non-empty, create a new list item.
              const itemContent = $from.parent.textContent;
              if (!itemContent) {
                // Empty list item — exit the list into a paragraph
                const listDepth = $from.depth - 2;
                const listNode = $from.node(listDepth);
                if (listNode && (listNode.type.name === 'bulletList' || listNode.type.name === 'orderedList')) {
                  const listEnd = $from.end(listDepth);
                  const paragraphType = state.schema.nodes.paragraph;
                  const tr = state.tr.insert(listEnd + 1, paragraphType.create());
                  tr.setSelection((state.selection.constructor as any).near(tr.doc.resolve(listEnd + 2)));
                  // Delete the empty list item we're leaving behind
                  const itemStart = $from.before(-1);
                  const itemEnd = $from.after(-1);
                  tr.delete(tr.mapping.map(itemStart), tr.mapping.map(itemEnd));
                  view.dispatch(tr.scrollIntoView());
                }
              } else {
                // Non-empty list item — split into a new list item
                editor?.chain().splitListItem('listItem').run();
              }
            } else {
              // Outside a list: create a new paragraph block
              const { tr } = state;
              const split = tr.split($from.pos);
              view.dispatch(split);
            }
            return true;
          }

          // Enter = submit (always)
          event.preventDefault();
          handleSubmit();
          return true;
        }
        return false;
      },
    },
    editable: !disabled,
    onUpdate: ({ editor }) => {
      // Call debounced onChange callback if provided
      // Use getHTML() to preserve formatting (line breaks, bold, etc.)
      if (onChange) {
        const content = editor.getHTML();
        debouncedOnChange(content);
      }
    },
    onTransaction: () => {
      // Trigger re-render so toolbar isActive() checks reflect current state
      setTick(t => t + 1);
    },
  });

  useImperativeHandle(ref, () => ({
    setContent: (content: string) => {
      if (editor) {
        editor.commands.setContent(content);
        editor.commands.focus('end');
      }
    },
    getContent: () => {
      return editor?.getHTML() || '';
    },
    getPlainText: () => {
      return editor?.getText() || '';
    },
    stopRecording: () => {
      if (recognitionRef.current && isRecording) {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        if (sendTimerRef.current) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
        recognitionRef.current.stop();
        setIsRecording(false);
      }
    },
  }), [editor, isRecording]);

  // Initialize speech recognition
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) { setIsSupported(false); return; }

      // Hide mic button if no microphone hardware is available
      if (navigator.mediaDevices?.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices().then(devices => {
          if (!devices.some(d => d.kind === 'audioinput')) setIsSupported(false);
        }).catch(() => setIsSupported(false));
      }

      {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: any) => {
          let finalTranscript = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript + ' ';
            }
          }

          if (finalTranscript && editor) {
            editor.commands.insertContent(finalTranscript);
          }

          // Reset silence timer on any speech activity
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            recognition.stop();
          }, 30_000);
        };

        recognition.onerror = (event: any) => {
          console.error('Speech recognition error:', event.error);
          setIsRecording(false);
        };

        recognition.onend = () => {
          setIsRecording(false);
        };

        recognitionRef.current = recognition;
      }
    }

    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [editor]);

  const handleSubmit = () => {
    if (!editor) return;

    // Check if there's any meaningful content
    const plainText = editor.getText().trim();
    if (!plainText) return;

    // Convert HTML to markdown so formatting (bold, lists, code blocks)
    // is preserved in prompts sent to Claude.
    // Convert <table> elements to markdown pipe tables via DOM traversal.
    // Tables are replaced with unique markers before Turndown runs, then
    // swapped back after — this avoids Turndown collapsing newlines or
    // escaping pipe characters.
    const rawHtml = editor.getHTML();
    const div = document.createElement('div');
    div.innerHTML = rawHtml;
    const tableMdMap = new Map<string, string>();
    div.querySelectorAll('table').forEach((table, idx) => {
      const rows = table.querySelectorAll('tr');
      const mdRows: string[] = [];

      rows.forEach((row, i) => {
        const cells = row.querySelectorAll('th, td');
        const values = Array.from(cells).map(cell => (cell.textContent || '').trim());
        mdRows.push('| ' + values.join(' | ') + ' |');
        if (i === 0) {
          mdRows.push('| ' + values.map(() => '---').join(' | ') + ' |');
        }
      });

      const marker = `FURYTABLE${idx}FURYTABLE`;
      tableMdMap.set(marker, mdRows.join('\n'));
      const placeholder = document.createElement('p');
      placeholder.textContent = marker;
      table.replaceWith(placeholder);
    });

    let markdown = turndown.turndown(div.innerHTML).trim();

    // Swap markers back with the raw table markdown
    for (const [marker, md] of tableMdMap) {
      markdown = markdown.replace(marker, md);
    }

    // Stop mic recording on send
    if (isRecording && recognitionRef.current) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current.stop();
      setIsRecording(false);
    }

    onSubmit(markdown);

    // Clear the editor after submission (unless persistContent is true)
    if (!persistContent) {
      editor.commands.clearContent();
    }
  };

  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Spoken punctuation patterns — only active during dictation
  const PUNCTUATION_MAP: [RegExp, string][] = [
    [/\bperiod\b/gi, '.'],
    [/\bfull stop\b/gi, '.'],
    [/\bquestion mark\b/gi, '?'],
    [/\bexclamation point\b/gi, '!'],
    [/\bexclamation mark\b/gi, '!'],
    [/\bcomma\b/gi, ','],
    [/\bcolon\b/gi, ':'],
    [/\bsemicolon\b/gi, ';'],
    [/\bsemi colon\b/gi, ';'],
    [/\bnew paragraph\b/gi, '\n\n'],
    [/\bnew line\b/gi, '\n'],
    [/\bnewline\b/gi, '\n'],
  ];

  useEffect(() => {
    if (!editor) return;
    let replacing = false;
    const handler = () => {
      // Cancel pending voice-send on any new input (even outside recording)
      if (sendTimerRef.current) {
        clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
      }
      if (!isRecordingRef.current || replacing) return;
      const text = editor.getText();
      let replaced = text;
      for (const [pattern, symbol] of PUNCTUATION_MAP) {
        replaced = replaced.replace(pattern, symbol);
      }
      // Clean up space before punctuation
      replaced = replaced.replace(/\s+([.,;:?!])/g, '$1');

      // Voice "send" command — strip keyword and submit after 5s of silence
      const sendMatch = replaced.match(/\bsend\s*$/i);
      if (sendMatch) {
        replaced = replaced.slice(0, sendMatch.index).trimEnd();
        replacing = true;
        if (replaced) {
          editor.commands.setContent(`<p>${replaced.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`);
        } else {
          editor.commands.clearContent();
        }
        editor.commands.focus('end');
        replacing = false;
        sendTimerRef.current = setTimeout(() => {
          sendTimerRef.current = null;
          handleSubmitRef.current();
        }, 5_000);
        return;
      }

      if (replaced !== text) {
        replacing = true;
        editor.commands.setContent(`<p>${replaced.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`);
        editor.commands.focus('end');
        replacing = false;
      }
    };
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor]);

  const toggleRecording = () => {
    if (!recognitionRef.current) return;

    if (isRecording) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (sendTimerRef.current) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      try {
        recognitionRef.current.start();
        setIsRecording(true);
        // Start silence timer — stops recording if no speech within 30s
        silenceTimerRef.current = setTimeout(() => {
          recognitionRef.current?.stop();
        }, 30_000);
      } catch (error) {
        console.error('Error starting speech recognition:', error);
      }
    }
  };

  // Update editable state when disabled prop changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Flush any pending debounced save on unmount (e.g. when switching sessions)
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (pendingContentRef.current !== null && onChangeRef.current) {
        onChangeRef.current(pendingContentRef.current);
      }
    };
  }, []);

  if (!editor) {
    return null;
  }

  const ToolbarButton = ({
    onClick,
    active,
    children,
    title,
  }: {
    onClick: () => void;
    active?: boolean;
    children: React.ReactNode;
    title: string;
  }) => (
    <Button
      type="button"
      variant={active ? 'default' : 'ghost'}
      size="sm"
      // Prevent mousedown from stealing focus away from the editor.
      // Without this, the editor loses focus before the command runs,
      // causing toggleBulletList / toggleOrderedList etc. to silently fail.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-8 w-8 p-0"
    >
      {children}
    </Button>
  );

  return (
    <div className="h-full w-full flex flex-col border border-border rounded bg-card focus-within:border-ring transition-colors">
      {/* Toolbar */}
      <div className="border-b border-border p-2 flex gap-1">
        <ToolbarButton
          onClick={() => editor.chain().focus().setParagraph().run()}
          active={editor.isActive('paragraph') && !editor.isActive('bulletList') && !editor.isActive('orderedList')}
          title="Plain Text"
        >
          <Type className="h-4 w-4" />
        </ToolbarButton>

        <div className="w-px bg-border mx-1" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
          title="Bold (Ctrl+B)"
        >
          <Bold className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          active={editor.isActive('codeBlock')}
          title="Code Block"
        >
          <Code className="h-4 w-4" />
        </ToolbarButton>

        <div className="w-px bg-border mx-1" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')}
          title="Bullet List"
        >
          <List className="h-4 w-4" />
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')}
          title="Numbered List"
        >
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>
      </div>

      {/* Editor Content - grows to fill available space */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="text-foreground text-sm h-full" />
      </div>

      {/* Optional status bar (e.g. provider indicator) */}
      {statusBar}

      {/* Footer with Microphone and Send Buttons - only shown if showButtonBar is true */}
      {showButtonBar && (
        <div className="border-t border-border p-2 flex justify-between items-center">
          {/* Microphone Button */}
          <Button
            onClick={toggleRecording}
            disabled={disabled || !isSupported}
            className={`h-10 w-10 rounded-full p-0 ${
              isRecording
                ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                : isSupported
                  ? 'bg-gray-700 hover:bg-gray-600 text-white'
                  : 'bg-gray-700 text-white opacity-40 cursor-not-allowed'
            }`}
            title={!isSupported ? 'No microphone detected' : isRecording ? 'Stop recording' : 'Start voice input'}
          >
            {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>

          {/* Send/Stop Button */}
          <Button
            onClick={isProcessing ? onStop : handleSubmit}
            disabled={!isProcessing && (disabled || editor.isEmpty)}
            className={`h-10 w-10 rounded-full text-white p-0 ${
              isProcessing
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-green-800 hover:bg-green-700'
            }`}
            title={isProcessing ? 'Stop processing' : 'Send message'}
          >
            {isProcessing ? (
              <Square className="h-5 w-5 fill-white" />
            ) : (
              <Send className="h-5 w-5" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
});

export default RichTextEditor;
