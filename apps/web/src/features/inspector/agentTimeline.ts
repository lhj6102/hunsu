import { err, ok, type Result } from "@hunsu/protocol";
import type { ReactNode } from "react";
import type { AgentMessage, AgentSession } from "@/shared/api/bridgeTypes";

export type AgentTimelineStatus = "waiting" | "running" | "done" | "failed";

export type AgentTimelineProjectionError = {
  code: "empty_input" | "invalid_message";
  message: string;
};

export type AgentTimelineProjectionInput = {
  session?: AgentSession;
  messages?: readonly AgentChatMessage[];
  speaker?: string;
  emptyText?: string;
};

export type AgentTimelineRow =
  | AgentTimelineUserTurnRow
  | AgentTimelineAssistantTextRow
  | AgentTimelineReasoningRow
  | AgentTimelineToolCallRow
  | AgentTimelineCommandRunRow
  | AgentTimelineFileChangeRow
  | AgentTimelineDiffSummaryRow
  | AgentTimelineErrorRow
  | AgentTimelineStatusRow;

export type AgentTimelineRowBase = {
  id: string;
  title: string;
  text?: string;
  meta?: string;
  status: AgentTimelineStatus;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: ReactNode;
};

export type AgentTimelineUserTurnRow = AgentTimelineRowBase & {
  kind: "UserTurn";
};

export type AgentTimelineAssistantTextRow = AgentTimelineRowBase & {
  kind: "AssistantText";
};

export type AgentTimelineReasoningRow = AgentTimelineRowBase & {
  kind: "Reasoning";
};

export type AgentTimelineToolCallRow = AgentTimelineRowBase & {
  kind: "ToolCall";
  toolName?: string;
  output?: string;
};

export type AgentTimelineCommandRunRow = AgentTimelineRowBase & {
  kind: "CommandRun";
  command?: string;
  cwd?: string;
  output?: string;
};

export type AgentTimelineFileChangeRow = AgentTimelineRowBase & {
  kind: "FileChange";
  changes?: unknown;
};

export type AgentTimelineDiffSummaryRow = AgentTimelineRowBase & {
  kind: "DiffSummary";
  changedFiles: string[];
};

export type AgentTimelineErrorRow = AgentTimelineRowBase & {
  kind: "Error";
};

export type AgentTimelineStatusRow = AgentTimelineRowBase & {
  kind: "Status";
};

export type AgentChatMessage = {
  id: string;
  speaker: string;
  title: string;
  text: string;
  status: "Waiting" | "Running" | "Done" | "Failed";
  meta?: string;
  role?: "user" | "assistant" | "tool" | "reasoning" | "system";
  detail?: ReactNode;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export function projectAgentTimeline(input: AgentTimelineProjectionInput): Result<AgentTimelineRow[], AgentTimelineProjectionError> {
  if (input.session) {
    return ok(projectAgentSessionRows(input.session, input));
  }
  if (input.messages) {
    return ok(input.messages.map(projectLegacyMessage));
  }
  return err({ code: "empty_input", message: "Agent timeline projection requires a session or message list." });
}

function projectAgentSessionRows(session: AgentSession, input: AgentTimelineProjectionInput): AgentTimelineRow[] {
  const visibleMessages = session.messages
    .filter(message => !isInternalHunsuMessage(message))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const rows = visibleMessages.map(projectAgentMessage);
  if (rows.length > 0) {
    if (session.error) {
      rows.push({
        kind: "Error",
        id: `${session.sessionId}:error`,
        title: "Session failed",
        text: session.error,
        status: "failed",
        updatedAt: session.updatedAt
      });
    }
    return rows;
  }
  return [{
    kind: "Status",
    id: `${session.sessionId}:status`,
    title: sessionStatusTitle(session),
    text: session.finalResponse ?? session.error ?? input.emptyText ?? "No conversation messages yet.",
    status: sessionStatus(session),
    startedAt: session.createdAt,
    updatedAt: session.updatedAt
  }];
}

function projectAgentMessage(message: AgentMessage): AgentTimelineRow {
  const base = {
    id: message.messageId,
    title: message.title,
    text: textFromAgentMessage(message),
    meta: [message.type, message.command ? "command" : undefined].filter(Boolean).join(" / "),
    status: messageStatus(message.status),
    startedAt: message.createdAt,
    updatedAt: message.updatedAt,
    completedAt: message.completedAt,
    durationMs: message.durationMs
  };
  if (message.role === "user") {
    return { ...base, kind: "UserTurn" };
  }
  if (message.role === "reasoning") {
    return { ...base, kind: "Reasoning" };
  }
  if (message.command) {
    return { ...base, kind: "CommandRun", command: message.command, cwd: message.cwd, output: message.output };
  }
  if (message.changes) {
    return { ...base, kind: "FileChange", changes: message.changes };
  }
  if (message.role === "tool") {
    return { ...base, kind: "ToolCall", toolName: message.title, output: message.output };
  }
  return { ...base, kind: "AssistantText" };
}

function projectLegacyMessage(message: AgentChatMessage): AgentTimelineRow {
  const base = {
    id: message.id,
    title: message.title,
    text: message.text,
    meta: message.meta,
    status: legacyStatus(message.status),
    startedAt: message.startedAt,
    updatedAt: message.updatedAt,
    completedAt: message.completedAt,
    durationMs: message.durationMs,
    detail: message.detail
  };
  const title = message.title.toLowerCase();
  const meta = message.meta?.toLowerCase() ?? "";
  if (message.role === "user" || title === "prompt" || title.includes("input") || meta.includes("usermessage") || message.speaker.toLowerCase() === "director") {
    return { ...base, kind: "UserTurn" };
  }
  if (message.role === "reasoning" || title.includes("reasoning") || title.includes("thinking") || meta.includes("reasoning")) {
    return { ...base, kind: "Reasoning" };
  }
  if (title.includes("command") || meta.includes("command")) {
    return { ...base, kind: "CommandRun" };
  }
  if (message.role === "tool") {
    return { ...base, kind: "ToolCall" };
  }
  if (message.status === "Failed") {
    return { ...base, kind: "Error" };
  }
  return { ...base, kind: "AssistantText" };
}

function isInternalHunsuMessage(message: AgentMessage): boolean {
  const haystack = [message.title, message.text, message.command, message.cwd, message.output, ...(message.summary ?? []), ...(message.content ?? [])]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return (message.role === "system" || message.role === "tool") && /(^|\s)\.hunsu(\/|\s|$)/.test(haystack);
}

function textFromAgentMessage(message: AgentMessage): string {
  return [
    message.text,
    ...(message.summary ?? []),
    ...(message.content ?? []),
    message.output
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "").join("\n\n");
}

function messageStatus(status: AgentMessage["status"]): AgentTimelineStatus {
  if (status === "completed") return "done";
  if (status === "streaming") return "running";
  return "waiting";
}

function legacyStatus(status: AgentChatMessage["status"]): AgentTimelineStatus {
  if (status === "Done") return "done";
  if (status === "Failed") return "failed";
  if (status === "Running") return "running";
  return "waiting";
}

function sessionStatus(session: AgentSession): AgentTimelineStatus {
  if (session.state.type === "completed") return "done";
  if (session.state.type === "failed") return "failed";
  if (session.state.type === "executing" || session.state.type === "starting" || session.state.type === "interactWait") return "running";
  return "waiting";
}

function sessionStatusTitle(session: AgentSession): string {
  if (session.state.type === "completed") return "Complete";
  if (session.state.type === "failed") return "Failed";
  if (session.state.type === "executing" || session.state.type === "starting" || session.state.type === "interactWait") return "Running";
  return "Waiting";
}
