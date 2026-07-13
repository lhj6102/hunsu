export function shortSha(value: string | undefined): string {
  return value ? value.slice(0, 8) : "—";
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

export function relativeTimestamp(value: string | undefined): string {
  if (!value) return "not yet";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.round((time - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function repositoryLabel(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function safeHttpHref(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
