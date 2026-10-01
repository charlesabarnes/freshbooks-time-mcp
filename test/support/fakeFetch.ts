export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

type Handler = (req: Recorded) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeFetch(handlers: Handler[]) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const raw = init?.body;
    const req: Recorded = { method: (init?.method ?? 'GET').toUpperCase(), url, headers, body: typeof raw === 'string' ? JSON.parse(raw) : undefined };
    calls.push(req);
    for (const handler of handlers) {
      const res = await handler(req);
      if (res) return res;
    }
    return json({ error: `unhandled ${req.method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  return { fetch: fn, calls };
}
