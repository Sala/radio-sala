export async function fetchJson(
  url: string,
  extraHeaders?: HeadersInit,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const host = new URL(url).host;
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "RadioSala/0.1 (personal radio station)",
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    const clipped = text.replace(/key=[^&\s"]+/gi, "key=redacted").slice(0, 180);
    if (!response.ok) {
      return { ok: false, error: `${host} returned ${response.status}${clipped ? `: ${clipped}` : ""}` };
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: `${host} did not return JSON` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return { ok: false, error: `${host} did not answer (${message})` };
  }
}
