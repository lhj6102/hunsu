import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, Brain, CircleDot, Code2, FileDiff, TerminalSquare, UserRound, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import type { AgentSession } from "@/shared/api/bridgeTypes";
import {
  projectAgentTimeline,
  type AgentChatMessage,
  type AgentTimelineRow,
  type AgentTimelineStatus
} from "@/features/inspector/agentTimeline";

export type { AgentChatMessage, AgentTimelineRow };

export function AgentChat({
  messages,
  session,
  theme = "Light"
}: {
  messages?: AgentChatMessage[];
  session?: AgentSession;
  theme?: "Light" | "Dark";
}) {
  const rows = useMemo(() => {
    const result = projectAgentTimeline({ session, messages });
    return result.ok ? result.value : [];
  }, [messages, session]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasRunningMessages = rows.some(row => row.status === "running" && row.startedAt);

  useEffect(() => {
    if (!hasRunningMessages) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunningMessages]);

  return (
    <div
      data-figma-component={figmaComponentNames.agentChat}
      data-theme={theme}
      className={cn("w-full min-w-0 max-w-full space-y-2 overflow-hidden", theme === "Dark" ? "text-[#f4fbf7]" : "text-[color:var(--apple-ink)]")}
    >
      {rows.map(row => <AgentTimelineItem key={row.id} row={row} theme={theme} nowMs={nowMs} />)}
      {rows.length === 0 ? (
        <div className={cn(
          "flex items-center gap-2 py-2 text-sm",
          theme === "Dark" ? "border-white/10 text-[#9eb4aa]" : "text-muted-foreground"
        )}>
          <CircleDot className="size-4" />
          No conversation messages yet.
        </div>
      ) : null}
    </div>
  );
}

function AgentTimelineItem({ row, theme, nowMs }: { row: AgentTimelineRow; theme: "Light" | "Dark"; nowMs: number }) {
  const input = row.kind === "UserTurn";
  const Icon = iconForRow(row);
  const statusText = agentRowStatusText(row, nowMs);
  return (
    <article className={cn("flex w-full min-w-0 max-w-full overflow-hidden", input ? "justify-end" : "items-start gap-2.5")}>
      {input ? null : (
        <div className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border",
          theme === "Dark" ? "bg-white/10 text-[#dbe8df]" : "border-border bg-white/70 text-[color:var(--apple-muted)] backdrop-blur-xl",
          statusIconTone(row.status, theme)
        )} title={agentRowLabel(row)}>
          <Icon className="size-3.5" />
        </div>
      )}
      <div className={cn(
        "min-w-0 overflow-hidden",
        input
          ? theme === "Dark"
            ? "w-fit max-w-[calc(100%-2rem)] rounded-[16px] rounded-tr-[4px] bg-white/10 px-3 py-2 text-left sm:max-w-[82%]"
            : "w-fit max-w-[calc(100%-2rem)] rounded-[16px] rounded-tr-[4px] bg-[color:var(--apple-blue-soft)] px-3 py-2 text-left sm:max-w-[82%]"
          : "max-w-full flex-1 border-b pb-2.5 last:border-b-0",
        !input && (theme === "Dark" ? "border-white/10" : "border-border")
      )}>
        <div className={cn("mb-1 flex min-w-0 items-center justify-between gap-2", input && "mb-0")}>
          <p className={cn("min-w-0 truncate font-semibold", input ? "text-[12px] leading-4" : "text-[11px] leading-4 opacity-80")}>{row.title}</p>
          <span className={cn("shrink-0 text-[10px] font-medium leading-3", statusTone(row.status, theme))}>{statusText}</span>
        </div>
        <AgentTimelineBody row={row} theme={theme} />
      </div>
      {input ? (
        <div className={cn(
          "ml-2 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
          theme === "Dark" ? "bg-white/10 text-[#dbe8df]" : "bg-white/70 text-[color:var(--apple-muted)]"
        )}>
          <UserRound className="size-3.5" />
        </div>
      ) : null}
    </article>
  );
}

function AgentTimelineBody({ row, theme }: { row: AgentTimelineRow; theme: "Light" | "Dark" }) {
  if (row.kind === "Reasoning" || row.kind === "ToolCall" || row.kind === "CommandRun" || row.kind === "FileChange") {
    return (
      <details className={cn("group mt-2 rounded-md border px-2.5 py-2", theme === "Dark" ? "border-white/10 bg-black/15" : "border-[#d9dfda] bg-white/60")} open={row.status === "running"}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[12px] font-medium [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 truncate">{toolSummary(row)}</span>
          <span className={cn("text-[10px]", theme === "Dark" ? "text-[#9eb4aa]" : "text-[#626b66]")}>{row.status === "running" ? "running" : "details"}</span>
        </summary>
        <div className="mt-2 space-y-2">
          {row.kind === "CommandRun" && row.command ? <CodeBlock label={row.cwd ?? "command"} text={row.command} theme={theme} /> : null}
          {row.text ? <MarkdownText text={row.text} /> : null}
          {"output" in row && row.output ? <CodeBlock label="output" text={row.output} theme={theme} /> : null}
          {row.kind === "FileChange" && row.changes ? <CodeBlock label="changes" text={formatUnknown(row.changes)} theme={theme} /> : null}
          {row.detail ? <div className="mt-3">{row.detail}</div> : null}
        </div>
      </details>
    );
  }
  return (
    <>
      {row.text ? <MarkdownText text={row.text} /> : null}
      {row.kind === "DiffSummary" ? (
        <ul className="mt-2 grid gap-1 text-[12px] leading-5">
          {row.changedFiles.map(path => <li key={path} className="truncate font-mono">{path}</li>)}
        </ul>
      ) : null}
      {row.detail ? <div className="mt-3">{row.detail}</div> : null}
    </>
  );
}

function MarkdownText({ text }: { text: string }) {
  const blocks = splitMarkdownBlocks(text);
  return (
    <div className="mt-2 space-y-2 text-[13px] leading-5">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return <pre key={index} className="max-w-full overflow-x-auto rounded-md bg-black/5 p-2 font-mono text-[12px] leading-5"><code>{block.text}</code></pre>;
        }
        if (block.type === "heading") {
          return <p key={index} className="font-semibold">{renderInlineMarkdown(block.text)}</p>;
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="grid list-disc gap-1 pl-4">
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
            </ul>
          );
        }
        return <p key={index} className="max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]">{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; text: string };

function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | undefined;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = undefined;
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.+)$/);
    if (heading?.[1]) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: heading[1] });
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item?.[1]) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) blocks.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

function renderInlineMarkdown(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded bg-black/5 px-1 py-0.5 font-mono text-[12px]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function CodeBlock({ label, text, theme }: { label: string; text: string; theme: "Light" | "Dark" }) {
  return (
    <div className={cn("rounded border p-2", theme === "Dark" ? "border-white/10 bg-[#050807]" : "border-[#d9dfda] bg-[#fbfdfb]")}>
      <p className={cn("mb-1 truncate text-[10px] font-semibold", theme === "Dark" ? "text-[#9eb4aa]" : "text-[#626b66]")}>{label}</p>
      <pre className="max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 [overflow-wrap:anywhere]"><code>{text}</code></pre>
    </div>
  );
}

function iconForRow(row: AgentTimelineRow) {
  if (row.kind === "Reasoning") return Brain;
  if (row.kind === "CommandRun") return TerminalSquare;
  if (row.kind === "ToolCall") return Wrench;
  if (row.kind === "FileChange" || row.kind === "DiffSummary") return FileDiff;
  if (row.kind === "Error") return CircleDot;
  if (row.kind === "Status") return CircleDot;
  return Bot;
}

function toolSummary(row: AgentTimelineRow): string {
  if (row.kind === "CommandRun") return row.command ?? row.title;
  if (row.kind === "ToolCall") return row.toolName ?? row.title;
  if (row.kind === "FileChange") return row.title;
  return row.title;
}

function formatUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function agentRowLabel(row: AgentTimelineRow): string {
  return [row.kind, row.title, row.meta, row.status].filter(Boolean).join(" / ");
}

function agentRowStatusText(row: AgentTimelineRow, nowMs: number): string {
  const duration = messageDurationLabel(row, nowMs);
  const label = row.status === "running" && row.kind === "Reasoning" ? "Reasoning" : capitalizeStatus(row.status);
  return [label, duration].filter(Boolean).join(" / ");
}

function capitalizeStatus(status: AgentTimelineStatus): string {
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  return "Waiting";
}

function messageDurationLabel(row: AgentTimelineRow, nowMs: number): string | undefined {
  const resolution = resolveDisplayDuration(row, nowMs);
  return resolution.ok ? formatDurationMs(resolution.value) : undefined;
}

type DisplayDurationSource = "completedLifecycle" | "runningLifecycle" | "messageDuration";
type DisplayDurationResolution =
  | { ok: true; value: number; source: DisplayDurationSource }
  | { ok: false; error: "missing-duration" };

function resolveDisplayDuration(row: AgentTimelineRow, nowMs: number): DisplayDurationResolution {
  const lifecycle = resolveDisplayLifecycleDuration(row, nowMs);
  if (lifecycle.ok && (lifecycle.value > 0 || !isFiniteDuration(row.durationMs) || row.durationMs <= 0)) {
    return lifecycle;
  }
  if (isFiniteDuration(row.durationMs)) {
    return { ok: true, value: row.durationMs, source: "messageDuration" };
  }
  return lifecycle.ok ? lifecycle : { ok: false, error: "missing-duration" };
}

function resolveDisplayLifecycleDuration(row: AgentTimelineRow, nowMs: number): DisplayDurationResolution {
  if (!row.startedAt) {
    return { ok: false, error: "missing-duration" };
  }
  const startedAtMs = Date.parse(row.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return { ok: false, error: "missing-duration" };
  }
  if (row.completedAt) {
    return durationFromParsedRange(startedAtMs, Date.parse(row.completedAt), "completedLifecycle");
  }
  if (row.status === "running") {
    return durationFromParsedRange(startedAtMs, nowMs, "runningLifecycle");
  }
  if (row.updatedAt) {
    return durationFromParsedRange(startedAtMs, Date.parse(row.updatedAt), "completedLifecycle");
  }
  return { ok: false, error: "missing-duration" };
}

function durationFromParsedRange(startedAtMs: number, endedAtMs: number, source: DisplayDurationSource): DisplayDurationResolution {
  if (!Number.isFinite(endedAtMs)) {
    return { ok: false, error: "missing-duration" };
  }
  return { ok: true, value: Math.max(0, endedAtMs - startedAtMs), source };
}

function isFiniteDuration(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSeconds < 60) {
    if (totalSeconds === 0) return "<1s";
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function statusTone(status: AgentTimelineStatus, theme: "Light" | "Dark"): string {
  if (status === "done") return theme === "Dark" ? "text-[#9bd6bd]" : "text-[color:var(--apple-green)]";
  if (status === "failed") return "text-[color:var(--apple-red)]";
  if (status === "running") return theme === "Dark" ? "text-[#89cfff]" : "text-[color:var(--apple-blue)]";
  return theme === "Dark" ? "text-[#9eb4aa]" : "text-muted-foreground";
}

function statusIconTone(status: AgentTimelineStatus, theme: "Light" | "Dark"): string {
  if (status === "done") return theme === "Dark" ? "border-[#9bd6bd]/70" : "border-[color:var(--apple-green)]";
  if (status === "failed") return "border-[color:var(--apple-red)] text-[color:var(--apple-red)]";
  if (status === "running") return theme === "Dark" ? "animate-pulse border-[#89cfff]/80 text-[#89cfff]" : "animate-pulse border-[color:var(--apple-blue)] text-[color:var(--apple-blue)]";
  return theme === "Dark" ? "border-white/10" : "border-border";
}
