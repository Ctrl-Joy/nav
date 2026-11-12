import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { LogLine } from '@nav/shared';
import { Button, useToast } from '@/components/ui';
import { stripAnsi } from '@/lib/ansi';
import { copyText } from '@/lib/misc';

/**
 * Plain text for a set of log lines: one line per entry with time, stream and level, and the message without colour
 * codes. Used by both "Copy logs" and "Download", so what you paste matches what you would save.
 */
export function logsToText(lines: LogLine[], withInstance = false): string {
  return lines
    .map((l) => `${l.ts} [${l.stream}] [${l.level}]${withInstance && l.instanceId ? ` [${l.instanceId}]` : ''} ${stripAnsi(l.message)}`)
    .join('\n');
}

/** Copies the log lines currently shown to the clipboard. */
export function CopyLogsButton({ lines, withInstance = false }: { lines: LogLine[]; withInstance?: boolean }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(logsToText(lines, withInstance));
    if (!ok) {
      toast.error('Copy failed', 'Your browser blocked clipboard access. Use Download instead.');
      return;
    }
    setDone(true);
    toast.success(`Copied ${lines.length} log ${lines.length === 1 ? 'line' : 'lines'}`);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1800);
  };

  return (
    <Button size="sm" variant="ghost" icon={done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} onClick={onClick} disabled={!lines.length}>
      {done ? 'Copied' : 'Copy logs'}
    </Button>
  );
}
