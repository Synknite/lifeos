import type { ChatEvent } from '@lifeos/core';

export type { ChatEvent };

/**
 * POST a JSON body and consume the Server-Sent Events response.
 * (EventSource only supports GET, so this parses the stream by hand.)
 */
export async function streamSse(
  path: string,
  body: unknown,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    onEvent({
      type: 'error',
      code: data.error?.code ?? 'http_error',
      message: data.error?.message ?? `Request failed (${res.status})`,
    });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onEvent(JSON.parse(data) as ChatEvent);
    }
  }
}
