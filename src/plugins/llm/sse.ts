/**
 * Shared SSE line parsing for fetch-based adapters.
 */

export interface SseEvent {
  data: string;
}

/** Iterate SSE `data:` frames from a fetch response body. */
export async function* sseFrames(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const body = response.body;
  if (!body) throw new Error("response body is empty");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length > 0) yield dataLines.join("\n");
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read a non-streaming error body into a message. */
export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return parsed.error?.message ?? parsed.message ?? text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}
