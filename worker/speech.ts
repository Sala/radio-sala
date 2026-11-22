export const SPEECH_MODEL = "@cf/deepgram/aura-1" as const;

export const SPEECH_DEV_NOTE =
  "DJ speech calls Workers AI model @cf/deepgram/aura-1 and stores the mp3 in the R2 binding CLIPS. No other voice provider is configured. Workers AI has no local simulator, so the AI binding is left commented out in wrangler.jsonc and `wrangler dev` can start without a Cloudflare API token. The call is wired. After wrangler login, uncomment the ai binding to turn speech on. Until that call returns audio, the break stays on screen as text and nothing is synthesized in its place.";

const AURA_SPEAKERS = [
  "angus",
  "asteria",
  "arcas",
  "orion",
  "orpheus",
  "athena",
  "luna",
  "zeus",
  "perseus",
  "helios",
  "hera",
  "stella",
] as const;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function workersAi(env: Env): Ai | null {
  const candidate = env as Env & { AI?: Ai };
  return candidate.AI ?? null;
}

export async function spokenClip(
  env: Env,
  djId: string,
  speaker: string,
  text: string,
): Promise<{ clipKey: string | null; note: string | null }> {
  const ai = workersAi(env);
  if (!ai) {
    return { clipKey: null, note: `${SPEECH_DEV_NOTE} The AI binding is unset.` };
  }
  const key = `clips/${djId}/${await sha256Hex(`${SPEECH_MODEL}\n${speaker}\n${text}`)}`;
  try {
    const cached = await env.CLIPS.get(key);
    if (cached) return { clipKey: key, note: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "R2 read failed";
    return { clipKey: null, note: `${SPEECH_DEV_NOTE} R2 binding CLIPS could not be read (${message}).` };
  }

  try {
    const speakerId = AURA_SPEAKERS.find((item) => item === speaker);
    if (!speakerId) {
      return {
        clipKey: null,
        note: `${SPEECH_DEV_NOTE} Speaker "${speaker}" is not an Aura speaker, so no audio was requested.`,
      };
    }
    const result = await ai.run(
      SPEECH_MODEL,
      { text, speaker: speakerId, encoding: "mp3" },
      { returnRawResponse: true },
    );
    if (!result.ok) {
      const detail = (await result.text()).replace(/\s+/g, " ").slice(0, 180);
      return { clipKey: null, note: `${SPEECH_DEV_NOTE} ${SPEECH_MODEL} returned ${result.status}${detail ? `: ${detail}` : ""}.` };
    }
    const contentType = result.headers.get("content-type") ?? "audio/mpeg";
    const bytes = new Uint8Array(await result.arrayBuffer());
    if (bytes.byteLength < 100) {
      return { clipKey: null, note: `${SPEECH_DEV_NOTE} ${SPEECH_MODEL} did not return audio.` };
    }
    await env.CLIPS.put(key, bytes, { httpMetadata: { contentType } });
    return { clipKey: key, note: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workers AI call failed";
    console.error(JSON.stringify({ message: "tts failed", model: SPEECH_MODEL, error: message }));
    return { clipKey: null, note: `${SPEECH_DEV_NOTE} ${message}` };
  }
}
