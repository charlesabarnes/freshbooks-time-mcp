export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return hoursToSeconds(input);
  const text = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return hoursToSeconds(Number(text));
  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (clock) return positive(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0), input);
  const unitRe = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)(?![a-z])/g;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(unitRe)) {
    const value = Number(match[1]);
    const unit = match[2]!;
    total += unit.startsWith('h') ? value * 3600 : unit.startsWith('m') ? value * 60 : value;
    consumed += match[0];
  }
  if (!consumed || text.replace(unitRe, '').replace(/\band\b|[\s,]+/g, '') !== '') {
    throw new Error(`Could not parse duration "${input}". Use hours (1.5), H:MM (1:30) or units (1h30m, 45m).`);
  }
  return positive(Math.round(total), input);
}

function hoursToSeconds(hours: number): number {
  return positive(Math.round(hours * 3600), String(hours));
}

function positive(seconds: number, input: string): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Duration must be greater than zero (got "${input}")`);
  return seconds;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function toHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}
