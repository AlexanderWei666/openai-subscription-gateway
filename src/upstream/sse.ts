/**
 * SSE 解析/序列化。只懂 SSE 帧格式,不懂 Responses 事件语义。
 * 契约见 docs/UPSTREAM.md §8:data: 行,空行分隔,注释行以 ":" 开头。
 */

export interface SseEvent {
  /** event: 字段(Responses API 一般不用,type 在 data JSON 内) */
  event: string | null;
  /** 多条 data: 行按 \n 连接 */
  data: string;
}

/** 把 ReadableStream 增量解析为 SSE 事件;容忍跨 chunk 的半行。
 *  传入 signal 时:abort → 取消上游读取(reader.cancel),用于下游断连传播。 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventField: string | null = null;

  const onAbort = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventField = null;
      return null;
    }
    const ev: SseEvent = { event: eventField, data: dataLines.join("\n") };
    dataLines = [];
    eventField = null;
    return ev;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 逐行处理;最后一行可能不完整,留在 buffer
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue; // 注释/心跳
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          eventField = line.slice(6).replace(/^ /, "");
        }
        // 其他字段(id:/retry:)忽略
      }
    }
    // 流结束时若还有未分发数据,尽力交付
    if (buffer.trim() !== "") {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const ev = flush();
    if (ev) yield ev;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** 序列化一个 SSE 帧 */
export function formatSse(ev: SseEvent): string {
  const head = ev.event ? `event: ${ev.event}\n` : "";
  return `${head}data: ${ev.data}\n\n`;
}
