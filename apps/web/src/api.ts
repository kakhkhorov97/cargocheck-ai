export async function api<T>(
  url: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const form = body instanceof FormData;
  const r = await fetch("/api" + url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers:
      body === undefined || form
        ? undefined
        : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  if (!r.ok) {
    let message = `Request failed (${r.status}). Please try again.`;
    try {
      const e = await r.json();
      if (typeof e?.message === "string" && e.message.trim()) {
        message = e.message;
      } else if (Array.isArray(e?.message)) {
        const details = e.message.filter(
          (item: unknown): item is string =>
            typeof item === "string" && item.trim().length > 0,
        );
        if (details.length) message = details.join(" ");
      }
    } catch {}
    throw new Error(message);
  }
  return r.json();
}
