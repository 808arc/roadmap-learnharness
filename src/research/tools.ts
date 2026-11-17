/** Architect research tools, assembled from the channels the learner enabled.
 *
 * - open sources (keyless): books, book contents, papers, Wikipedia, page reading;
 * - own key: general web search with the learner's Tavily/Brave key;
 * - host web (local fork only): general web search through LearnHarness itself;
 * - Claude Code CLI: a long deep-research run with Claude's own web tools;
 * - research notes: results of research sessions and deep-research runs.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import type { ResearchSettings } from "../domain.ts";
import { NetError, fetchJson, fetchText, htmlToText } from "./net.ts";
import type { ResearchNotes } from "./notes.ts";

const PAGE_CHARS = 24_000;

const schema = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});
const ok = <T>(details: T, text: string): AgentToolResult<T> => ({ content: [{ type: "text", text }], details });
const fail = (message: string): AgentToolResult<{ error: string }> => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  details: { error: message },
  isError: true,
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 400): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const count = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.trunc(value))) : fallback;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}
export type WebSearch = (query: string, count: number, signal?: AbortSignal) => Promise<WebSearchHit[]>;
export type PageReader = (url: string, signal?: AbortSignal) => Promise<string>;

export interface ResearchToolOptions {
  readonly settings: ResearchSettings;
  readonly notes: ResearchNotes;
  /** The learner's own key, when that channel is on and a key is stored. */
  readonly ownKey?: { engine: "tavily" | "brave"; key: string } | null;
  /** Local-only host search, when available. */
  readonly hostWeb?: { search: WebSearch | null; read: PageReader } | null;
  /** The Claude Code deep-research runner, when that channel is on. */
  readonly deepResearch?: ((question: string, signal?: AbortSignal) => Promise<string>) | null;
}

/** Readable text of a public page; PDFs and binaries are reported, not parsed. */
export async function readPublicPage(url: string, signal?: AbortSignal): Promise<string> {
  const page = await fetchText(url, { signal });
  if (page.status >= 400) throw new NetError(`HTTP ${page.status} from ${new URL(page.url).hostname}.`);
  if (/pdf/i.test(page.contentType)) {
    return `Source: ${page.url}\nThis is a PDF. Its text cannot be read here; use the title and the page that links it, or ask the learner to upload it.`;
  }
  if (/html|xml/i.test(page.contentType) || /^\s*</.test(page.body)) {
    const readable = htmlToText(page.body, 200_000);
    return `# ${readable.title || page.url}\nSource: ${page.url}\n\n${readable.text}`;
  }
  return `Source: ${page.url}\n\n${page.body}`;
}

function readPageTool(reader: PageReader): PluginAgentTool {
  return {
    name: "read_page",
    description:
      "Read a public web page (course syllabus, table of contents, documentation, article) as text. " +
      "Use it to actually check a source before you cite it: its contents, chapters, level and what it covers. " +
      "Long pages come in parts: pass `part` (1, 2, …) to continue.",
    parameters: schema({ url: { type: "string" }, part: { type: "integer", minimum: 1 } }, ["url"]),
    execute: async (_id, params, signal) => {
      const value = record(params);
      const url = text(value.url, 2000);
      const part = count(value.part, 1, 50);
      try {
        const full = await reader(url, signal);
        const start = (part - 1) * PAGE_CHARS;
        if (start >= full.length) return fail(`The page has only ${Math.ceil(full.length / PAGE_CHARS)} part(s).`);
        const total = Math.ceil(full.length / PAGE_CHARS);
        const chunk = full.slice(start, start + PAGE_CHARS);
        return ok({ url, part, parts: total }, `${chunk}${total > part ? `\n\n[part ${part} of ${total}; call read_page with part ${part + 1} to continue]` : ""}`);
      } catch (error) {
        return fail(`Could not read ${url}: ${message(error)}`);
      }
    },
  };
}

interface OpenLibraryDoc {
  key?: string; title?: string; author_name?: string[]; first_publish_year?: number; edition_count?: number;
  ratings_average?: number; ratings_count?: number; want_to_read_count?: number; subject?: string[]; ia?: string[]; isbn?: string[];
}
interface GoogleVolume {
  id?: string;
  volumeInfo?: { title?: string; subtitle?: string; authors?: string[]; publishedDate?: string; description?: string; averageRating?: number; ratingsCount?: number; pageCount?: number; industryIdentifiers?: { identifier?: string }[]; infoLink?: string };
}

function findBooksTool(): PluginAgentTool {
  return {
    name: "find_books",
    description:
      "Search book catalogs (Open Library and Google Books). Returns authors, year, editions, ratings and a short description — " +
      "edition count and ratings show how established a book is. Search both for the canonical titles and for deeper, less known " +
      "but strong books (specific subtopics, university textbooks, other languages). Then call book_contents to check what a book covers.",
    parameters: schema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 }, language: { type: "string", description: "Optional ISO 639-1 code, e.g. en or ru." } }, ["query"]),
    execute: async (_id, params, signal) => {
      const value = record(params);
      const query = text(value.query);
      const limit = count(value.limit, 10, 20);
      const language = text(value.language, 5).toLowerCase();
      if (!query) return fail("query is required.");
      const lines: string[] = [];
      const results: unknown[] = [];
      try {
        const ol = await fetchJson<{ docs?: OpenLibraryDoc[] }>(
          `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=key,title,author_name,first_publish_year,edition_count,ratings_average,ratings_count,want_to_read_count,subject,ia,isbn${language ? `&language=${encodeURIComponent(language === "ru" ? "rus" : language === "en" ? "eng" : language)}` : ""}`,
          { signal },
        );
        for (const doc of ol.docs ?? []) {
          results.push({ source: "openlibrary", ...doc, subject: doc.subject?.slice(0, 6), isbn: doc.isbn?.slice(0, 3), ia: undefined });
          lines.push(
            `- [Open Library ${doc.key}] "${doc.title}" — ${(doc.author_name ?? []).slice(0, 3).join(", ") || "unknown author"}` +
              `${doc.first_publish_year ? `, ${doc.first_publish_year}` : ""}; editions: ${doc.edition_count ?? "?"}` +
              `${doc.ratings_count ? `; rating ${doc.ratings_average?.toFixed(1)} (${doc.ratings_count})` : ""}` +
              `${doc.want_to_read_count ? `; want to read ${doc.want_to_read_count}` : ""}${doc.ia?.length ? "; scanned copy exists" : ""}` +
              `${doc.isbn?.[0] ? `; ISBN ${doc.isbn[0]}` : ""}`,
          );
        }
      } catch (error) {
        lines.push(`(Open Library unavailable: ${message(error)})`);
      }
      try {
        const gb = await fetchJson<{ items?: GoogleVolume[] }>(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${Math.min(limit, 20)}&printType=books${language ? `&langRestrict=${encodeURIComponent(language)}` : ""}`,
          { signal },
        );
        for (const item of gb.items ?? []) {
          const info = item.volumeInfo ?? {};
          results.push({ source: "googlebooks", id: item.id, title: info.title, authors: info.authors, publishedDate: info.publishedDate, rating: info.averageRating, ratings: info.ratingsCount, pages: info.pageCount });
          lines.push(
            `- [Google Books ${item.id}] "${info.title}${info.subtitle ? `: ${info.subtitle}` : ""}" — ${(info.authors ?? []).join(", ") || "unknown author"}` +
              `${info.publishedDate ? `, ${info.publishedDate}` : ""}${info.pageCount ? `, ${info.pageCount} pp.` : ""}` +
              `${info.ratingsCount ? `; rating ${info.averageRating} (${info.ratingsCount})` : ""}` +
              `${info.description ? `\n  ${info.description.replace(/\s+/g, " ").slice(0, 280)}` : ""}`,
          );
        }
      } catch (error) {
        lines.push(`(Google Books unavailable: ${message(error)})`);
      }
      return ok({ results }, lines.length ? lines.join("\n") : "No books found.");
    },
  };
}

function bookContentsTool(): PluginAgentTool {
  return {
    name: "book_contents",
    description:
      "Look inside a book before citing it: its table of contents (when catalogued), description and subjects. " +
      "Pass an Open Library work key (e.g. /works/OL45804W), an ISBN, or a Google Books id from find_books. " +
      "Use the chapters you see here for sourceAnchor; never invent chapter numbers.",
    parameters: schema({ openLibraryKey: { type: "string" }, isbn: { type: "string" }, googleBooksId: { type: "string" } }),
    execute: async (_id, params, signal) => {
      const value = record(params);
      const parts: string[] = [];
      const workKey = text(value.openLibraryKey, 64).replace(/^https?:\/\/openlibrary\.org/, "");
      const isbn = text(value.isbn, 20).replace(/[^0-9Xx]/g, "");
      const googleId = text(value.googleBooksId, 40).replace(/[^\w-]/g, "");
      try {
        if (workKey && /^\/works\/OL\d+W$/.test(workKey)) {
          const work = await fetchJson<Record<string, unknown>>(`https://openlibrary.org${workKey}.json`, { signal });
          const description = typeof work.description === "string" ? work.description : text(record(work.description).value, 4000);
          parts.push(`# ${String(work.title ?? workKey)}`);
          if (description) parts.push(description.slice(0, 4000));
          const subjects = Array.isArray(work.subjects) ? (work.subjects as unknown[]).slice(0, 12).join(", ") : "";
          if (subjects) parts.push(`Subjects: ${subjects}`);
          const editions = await fetchJson<{ entries?: Record<string, unknown>[] }>(`https://openlibrary.org${workKey}/editions.json?limit=40`, { signal });
          const withToc = (editions.entries ?? []).find((entry) => Array.isArray(entry.table_of_contents) && (entry.table_of_contents as unknown[]).length > 2);
          if (withToc) parts.push(`Table of contents (${String(withToc.publish_date ?? "")} edition):\n${tocLines(withToc.table_of_contents)}`);
        }
        if (isbn) {
          const edition = await fetchJson<Record<string, unknown>>(`https://openlibrary.org/isbn/${isbn}.json`, { signal }).catch(() => null);
          if (edition) {
            parts.push(`# ${String(edition.title ?? isbn)} (ISBN ${isbn})`);
            if (Array.isArray(edition.table_of_contents)) parts.push(`Table of contents:\n${tocLines(edition.table_of_contents)}`);
          }
        }
        if (googleId || (isbn && parts.length < 2)) {
          const url = googleId ? `https://www.googleapis.com/books/v1/volumes/${googleId}` : `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
          const data = await fetchJson<Record<string, unknown>>(url, { signal });
          const volume = (googleId ? data : (data.items as Record<string, unknown>[] | undefined)?.[0]) as GoogleVolume | undefined;
          const info = volume?.volumeInfo;
          if (info) {
            parts.push(`# ${info.title ?? ""} — ${(info.authors ?? []).join(", ")}${info.pageCount ? ` (${info.pageCount} pp.)` : ""}`);
            if (info.description) parts.push(info.description.replace(/<[^>]+>/g, " ").slice(0, 4000));
          }
        }
      } catch (error) {
        return fail(message(error));
      }
      if (parts.length === 0) return fail("Pass an Open Library work key, an ISBN or a Google Books id.");
      if (!parts.some((part) => part.startsWith("Table of contents"))) {
        parts.push("No table of contents is catalogued. Read the publisher's or author's page with read_page, or anchor by topic instead of chapter number.");
      }
      return ok({}, parts.join("\n\n"));
    },
  };
}

function tocLines(value: unknown): string {
  return (Array.isArray(value) ? value : [])
    .slice(0, 120)
    .map((entry) => {
      const item = record(entry);
      const indent = "  ".repeat(Math.min(3, Number(item.level ?? 0) || 0));
      return `${indent}- ${[text(item.label, 20), text(item.title, 200)].filter(Boolean).join(" ")}${item.pagenum ? ` (p. ${text(item.pagenum, 10)})` : ""}`;
    })
    .join("\n");
}

function findPapersTool(): PluginAgentTool {
  return {
    name: "find_papers",
    description:
      "Search scholarly works (OpenAlex; arXiv preprints) — surveys, tutorials, classic papers and lecture notes. " +
      "Citation counts show influence. Prefer surveys and tutorials for learners; read the open-access link with read_page.",
    parameters: schema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 15 }, arxiv: { type: "boolean" } }, ["query"]),
    execute: async (_id, params, signal) => {
      const value = record(params);
      const query = text(value.query);
      const limit = count(value.limit, 8, 15);
      if (!query) return fail("query is required.");
      const lines: string[] = [];
      try {
        const data = await fetchJson<{ results?: Record<string, unknown>[] }>(
          `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&sort=relevance_score:desc&select=id,display_name,publication_year,cited_by_count,doi,type,open_access,authorships`,
          { signal },
        );
        for (const work of data.results ?? []) {
          const authors = (Array.isArray(work.authorships) ? work.authorships : [])
            .slice(0, 3)
            .map((entry) => text(record(record(entry).author).display_name, 80))
            .join(", ");
          const access = record(work.open_access);
          lines.push(
            `- "${text(work.display_name)}" — ${authors || "?"}, ${work.publication_year ?? "?"}; ${text(work.type, 30)}; cited ${work.cited_by_count ?? 0}` +
              `${work.doi ? `; ${text(work.doi, 200)}` : ""}${access.oa_url ? `; open: ${text(access.oa_url, 300)}` : ""}`,
          );
        }
      } catch (error) {
        lines.push(`(OpenAlex unavailable: ${message(error)})`);
      }
      if (value.arxiv === true) {
        try {
          const feed = await fetchText(`https://export.arxiv.org/api/query?search_query=${query.split(/\s+/).filter(Boolean).slice(0, 8).map((word) => `all:${encodeURIComponent(word)}`).join("+AND+")}&sortBy=relevance&max_results=${limit}`, { signal });
          for (const entry of feed.body.split("<entry>").slice(1)) {
            const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1]?.replace(/\s+/g, " ").trim();
            const link = /<id>([\s\S]*?)<\/id>/.exec(entry)?.[1]?.trim();
            const year = /<published>(\d{4})/.exec(entry)?.[1];
            if (title && link) lines.push(`- [arXiv] "${title}", ${year ?? "?"}; ${link}`);
          }
        } catch (error) {
          lines.push(`(arXiv unavailable: ${message(error)})`);
        }
      }
      return ok({}, lines.length ? lines.join("\n") : "No papers found.");
    },
  };
}

function wikipediaTool(): PluginAgentTool {
  return {
    name: "search_wikipedia",
    description:
      "Search Wikipedia for an overview of a field or topic: its subfields, key concepts and standard references. " +
      "Good for mapping the territory and finding the classic literature in the references section (read the article with read_page).",
    parameters: schema({ query: { type: "string" }, language: { type: "string", description: "Wikipedia language code, default en." } }, ["query"]),
    execute: async (_id, params, signal) => {
      const value = record(params);
      const query = text(value.query);
      const language = /^[a-z]{2,3}$/.test(text(value.language, 3)) ? text(value.language, 3) : "en";
      if (!query) return fail("query is required.");
      try {
        const data = await fetchJson<{ pages?: { key?: string; title?: string; excerpt?: string; description?: string }[] }>(
          `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=8`,
          { signal },
        );
        const lines = (data.pages ?? []).map(
          (page) => `- ${page.title} — ${page.description ?? ""} ${String(page.excerpt ?? "").replace(/<[^>]+>/g, "")}\n  https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.key ?? "")}`,
        );
        return ok({}, lines.length ? lines.join("\n") : "No articles found.");
      } catch (error) {
        return fail(message(error));
      }
    },
  };
}

/** The learner's own key; the request goes straight to the provider. */
export function keySearch(engine: "tavily" | "brave", key: string): WebSearch {
  return async (query, limit, signal) => {
    const timeout = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    if (engine === "tavily") {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: timeout,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: "advanced" }),
      });
      if (!response.ok) throw new Error(`Tavily answered HTTP ${response.status}${response.status === 401 ? " (check the key)" : ""}.`);
      const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      return (data.results ?? []).map((hit) => ({ title: hit.title ?? "", url: hit.url ?? "", snippet: (hit.content ?? "").slice(0, 500) }));
    }
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      signal: timeout,
      headers: { accept: "application/json", "x-subscription-token": key },
    });
    if (!response.ok) throw new Error(`Brave Search answered HTTP ${response.status}${response.status === 401 || response.status === 422 ? " (check the key)" : ""}.`);
    const data = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? []).map((hit) => ({ title: hit.title ?? "", url: hit.url ?? "", snippet: (hit.description ?? "").replace(/<[^>]+>/g, "").slice(0, 500) }));
  };
}

function webSearchTool(search: WebSearch, via: string): PluginAgentTool {
  return {
    name: "web_search",
    description:
      `Search the whole web (${via}). One query per call; vary the angle: "best books for X", "X university course syllabus", ` +
      `"X roadmap", "X lecture notes pdf", "X for beginners reddit", in the learner's language and in English. Read promising results with read_page.`,
    parameters: schema({ query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
    execute: async (_id, params, signal) => {
      const value = record(params);
      const query = text(value.query);
      if (!query) return fail("query is required.");
      try {
        const hits = await search(query, count(value.count, 6, 10), signal);
        return ok({ hits }, hits.length ? hits.map((hit) => `- ${hit.title}\n  ${hit.url}\n  ${hit.snippet}`).join("\n") : "No results.");
      } catch (error) {
        return fail(`web_search failed: ${message(error)}`);
      }
    },
  };
}

function deepResearchTool(run: (question: string, signal?: AbortSignal) => Promise<string>, notes: ResearchNotes): PluginAgentTool {
  return {
    name: "deep_research",
    description:
      "Start a deep web research run by Claude Code (it searches and reads many pages itself). Slow (10–30 minutes) and expensive: " +
      "use it once per path, for the whole field, only when the learner turned deep research on for this message. " +
      "Pass the learner's goal, level and what to find. The report is also saved as a research note.",
    parameters: schema({ question: { type: "string", description: "The full research brief." } }, ["question"]),
    execute: async (_id, params, signal) => {
      const question = text(record(params).question, 8000);
      if (!question) return fail("question is required.");
      try {
        const report = await run(question, signal);
        const note = notes.add({ title: question.split("\n")[0]!.slice(0, 120), origin: "claude-cli", body: report });
        return ok({ noteId: note.id }, `Research note ${note.id} saved.\n\n${report}`);
      } catch (error) {
        return fail(`deep_research failed: ${message(error)}`);
      }
    },
  };
}

function notesTools(notes: ResearchNotes): PluginAgentTool[] {
  return [
    {
      name: "list_research_notes",
      description: "List research notes: reports from LearnHarness research sessions and deep-research runs. Read them before planning.",
      parameters: schema({}),
      execute: async () => {
        const list = notes.list();
        return ok({ notes: list }, list.length ? list.map((note) => `- ${note.id}: ${note.title} (${note.origin}, ${note.createdAt}, ${note.size} chars)`).join("\n") : "No research notes yet.");
      },
    },
    {
      name: "read_research_note",
      description: "Read one research note in full (long notes come in parts).",
      parameters: schema({ noteId: { type: "string" }, part: { type: "integer", minimum: 1 } }, ["noteId"]),
      execute: async (_id, params) => {
        const value = record(params);
        const note = notes.read(text(value.noteId, 80));
        if (!note) return fail("Unknown note id; call list_research_notes.");
        const part = count(value.part, 1, 50);
        const total = Math.max(1, Math.ceil(note.body.length / PAGE_CHARS));
        return ok({ part, parts: total }, `# ${note.title}\n\n${note.body.slice((part - 1) * PAGE_CHARS, part * PAGE_CHARS)}${total > part ? `\n\n[part ${part} of ${total}]` : ""}`);
      },
    },
  ];
}

/** Every research tool the Architect gets under these settings. */
export function buildResearchTools(_ctx: PluginBackendContext, options: ResearchToolOptions): PluginAgentTool[] {
  const { settings } = options;
  const tools: PluginAgentTool[] = [...notesTools(options.notes)];
  const reader = settings.hostWeb && options.hostWeb ? options.hostWeb.read : readPublicPage;
  const anyWeb = settings.openSources || (settings.ownKey && options.ownKey) || (settings.hostWeb && options.hostWeb);
  if (anyWeb) tools.push(readPageTool(reader));
  if (settings.openSources) tools.push(findBooksTool(), bookContentsTool(), findPapersTool(), wikipediaTool());
  if (settings.hostWeb && options.hostWeb?.search) tools.push(webSearchTool(options.hostWeb.search, "through LearnHarness search"));
  else if (settings.ownKey && options.ownKey) tools.push(webSearchTool(keySearch(options.ownKey.engine, options.ownKey.key), options.ownKey.engine));
  if (settings.claudeCli && options.deepResearch) tools.push(deepResearchTool(options.deepResearch, options.notes));
  return tools;
}

/** What the Architect may use, for its system prompt. */
export function researchCapabilities(tools: readonly PluginAgentTool[]): string[] {
  return tools.map((tool) => tool.name);
}
