export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionError';
  }
}

export type Ref = string | number;

export interface Named {
  id: number;
  name: string;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function isIdRef(ref: Ref): boolean {
  return typeof ref === 'number' || /^\d+$/.test(ref.trim());
}

function describe(items: Named[], limit = 10): string {
  const shown = items.slice(0, limit).map((i) => `"${i.name}" (id ${i.id})`);
  return items.length > limit ? `${shown.join(', ')} and ${items.length - limit} more` : shown.join(', ');
}

export function resolveNamed<T extends Named>(kind: string, ref: Ref, items: T[]): T | Named {
  if (isIdRef(ref)) {
    const id = Number(ref);
    return items.find((i) => i.id === id) ?? { id, name: `${kind} ${id}` };
  }
  const wanted = normalize(String(ref));
  if (!wanted) throw new ResolutionError(`Empty ${kind} name`);
  const exact = items.filter((i) => normalize(i.name) === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new ResolutionError(`${kind} name "${ref}" is ambiguous: ${describe(exact)}. Pass the id instead.`);
  }
  const partial = items.filter((i) => normalize(i.name).includes(wanted));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new ResolutionError(`${kind} "${ref}" matches several: ${describe(partial)}. Use a more specific name or the id.`);
  }
  const hint = items.length ? ` Known: ${describe(items, 8)}.` : '';
  throw new ResolutionError(`No ${kind.toLowerCase()} matches "${ref}".${hint}`);
}
