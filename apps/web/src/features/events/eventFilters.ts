export function eventDateBound(value: string, bound: "from" | "to"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return `${value}T${bound === "from" ? "00:00:00.000" : "23:59:59.999"}Z`;
}
