import { Badge } from "@/shared/ui/badge";
import type { GoalStatus, ReviewStatus, RunStatus } from "@/shared/api/types";

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return <Badge variant={status === "completed" ? "success" : status === "active" ? "default" : "outline"}>{humanize(status)}</Badge>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={status === "completed" ? "success" : status === "failed" ? "destructive" : isActiveRun(status) ? "default" : "outline"}>{humanize(status)}</Badge>;
}

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge variant={status === "ready" ? "success" : status === "changes_recommended" ? "warning" : "outline"}>{humanize(status)}</Badge>;
}

export function humanize(value: string): string {
  return value.split("_").map(part => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function isActiveRun(status: RunStatus): boolean {
  return status === "running";
}
