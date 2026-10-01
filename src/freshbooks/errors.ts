export class FreshBooksApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'FreshBooksApiError';
  }
}

export class FreshBooksNotConnectedError extends Error {
  constructor(message = 'FreshBooks is not connected. Reconnect this MCP server to sign in to FreshBooks again.') {
    super(message);
    this.name = 'FreshBooksNotConnectedError';
  }
}

function collect(value: unknown, out: string[]): void {
  if (!value) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      out.push(typeof obj.field === 'string' ? `${obj.field}: ${obj.message}` : obj.message);
      return;
    }
    for (const [key, inner] of Object.entries(obj)) {
      if (typeof inner === 'string') out.push(`${key}: ${inner}`);
      else collect(inner, out);
    }
  }
}

export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body ? body.slice(0, 300) : undefined;
  const obj = body as Record<string, any>;
  const messages: string[] = [];
  collect(obj.response?.errors, messages);
  collect(obj.errors, messages);
  if (!messages.length && typeof obj.error_description === 'string') messages.push(obj.error_description);
  if (!messages.length) collect(obj.error, messages);
  if (!messages.length && typeof obj.message === 'string') messages.push(obj.message);
  return messages.length ? [...new Set(messages)].join('; ') : undefined;
}
