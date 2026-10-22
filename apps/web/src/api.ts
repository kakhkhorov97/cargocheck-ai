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
    let message = "Request failed";
    try {
      const e = await r.json();
      message =
        typeof e.message === "string" ? e.message : JSON.stringify(e.message);
    } catch {}
    throw new Error(message);
  }
  return r.json();
}
