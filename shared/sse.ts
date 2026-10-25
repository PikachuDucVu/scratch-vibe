// SSE events may span network chunks and multiple data: lines. EOF is NOT success.
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", event: string[] = [], bytes = 0, ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error("Stream vượt giới hạn kích thước.");
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        if (!line) { if (event.length) { yield event.join("\n"); event = []; } }
        else if (line.startsWith("data:")) event.push(line.slice(5).replace(/^ /, ""));
      }
    }
    // The SSE spec dispatches only complete events. An unfinished event is a protocol error.
    if (buffer.trim() || event.length) throw new Error("Stream kết thúc giữa một sự kiện.");
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
