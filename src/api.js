export async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 180) };
    }
  }
  return { ok: response.ok, status: response.status, body };
}
