/** Safe outbound HTTP for research tools (backend only).
 *
 * The model chooses URLs, so every request is checked: http(s) only, no
 * loopback/private/link-local hosts (also after DNS resolution and on every
 * redirect), a timeout, and a size cap. This keeps a model from reaching the
 * learner's router, LearnHarness itself or other local services.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Roadmap-LearnHarness/0.3 (learning research; +https://github.com/Doshhhh/roadmap-learnharness)";

export class NetError extends Error {}

function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return privateAddress(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetError("Only http(s) addresses can be read.");
  if (url.username || url.password) throw new NetError("Addresses with credentials are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new NetError("Local addresses are not allowed.");
  }
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(privateAddress)) throw new NetError("Private and local network addresses are not allowed.");
  return url;
}

export interface FetchedText {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** GET a public URL, following redirects manually so each hop is checked. */
export async function fetchText(raw: string, options: { signal?: AbortSignal; headers?: Record<string, string>; accept?: string } = {}): Promise<FetchedText> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT, accept: options.accept ?? "text/html,application/json,text/plain;q=0.9,*/*;q=0.5", ...options.headers },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await assertPublicUrl(new URL(response.headers.get("location")!, url).toString());
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new NetError("The page is too large to read.");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { url: url.toString(), status: response.status, contentType, body };
  }
  throw new NetError("Too many redirects.");
}

export async function fetchJson<T>(raw: string, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetchText(raw, { ...options, accept: "application/json" });
  if (response.status >= 400) throw new NetError(`HTTP ${response.status} from ${new URL(response.url).hostname}.`);
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new NetError(`${new URL(response.url).hostname} did not return JSON.`);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", middot: "·", times: "×" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Readable text of an HTML page: headings kept as Markdown, chrome removed. */
export function htmlToText(html: string, maxChars = 30_000): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const main = /<(main|article)[\s>][\s\S]*<\/\1>/i.exec(html)?.[0] ?? html;
  const text = decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/section)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated]` : text };
}
