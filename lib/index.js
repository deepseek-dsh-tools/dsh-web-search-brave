/**
 * Brave Search provider for the DSH web seam.
 *
 * Rebuilt 2026-10-25 from forensics (`工具\Temp\recovery\small-plugins-forensics.md`
 * §3) after the 0.2.1-rc.3 installer accident wiped the original source. The
 * contract and constants below are taken verbatim from that report and from the
 * official sibling provider `@deepseek-ai/dsh-web-search-deepseek`.
 *
 * Why this plugin exists: DeepSeek's native search runs a model turn through the
 * Messages API (token cost) and started charging a separate search fee on
 * 2026-11-01. Brave bills per request with a $20/month free tier and its own
 * index.
 *
 * @module dsh-web-search-brave
 */
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

/** Stable id this provider registers under (matches `web.config.searchProvider`). */
const BRAVE_PROVIDER_ID = "brave";
/** Brave's web-search endpoint. */
const BRAVE_DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** Default number of results requested. */
const BRAVE_DEFAULT_COUNT = 10;
/** Brave rejects `count` above 20 with HTTP 422. */
const BRAVE_MAX_COUNT = 20;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "dsh-web-search-brave/0.1.0";

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-brave";
/** The web seam this provider registers into. */
const inject = ["web"];

/**
 * Config fields carry `.volatile()` so cordis hands `apply` accessors and each
 * operation can snapshot the NEXT search's options. The original plugin hit the
 * documented trap where a field without `.volatile()` arrives as a plain value
 * and `.get()` throws `config.endpoint.get is not a function`; we declare every
 * field volatile AND read through `read()`, which tolerates both shapes.
 */
const Config = z.object({
	apiKey: z.string().role("secret").volatile().default(""),
	count: z.number().step(1).min(1).default(BRAVE_DEFAULT_COUNT).volatile(),
	endpoint: z.string().default(BRAVE_DEFAULT_ENDPOINT).volatile(),
	extraSnippets: z.boolean().default(true).volatile(),
	safesearch: z.string().volatile().default("moderate"),
	country: z.string().volatile().default(""),
	searchLang: z.string().volatile().default(""),
	freshness: z.string().volatile().default("")
});

/**
 * Read one config field tolerating both cordis shapes: an accessor (field is
 * `.volatile()` and thus wrapped) or a plain value.
 * @param field - the field as handed to `apply`.
 * @param fallback - value used when the field is undefined or null.
 * @returns the current value or the fallback.
 */
function read(field, fallback) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") return field.get() ?? fallback;
	return field ?? fallback;
}

/** Clamp a requested count into Brave's accepted range. */
function clampCount(value) {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : BRAVE_DEFAULT_COUNT;
	return Math.min(Math.max(n, 1), BRAVE_MAX_COUNT);
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Brave search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/**
 * Map a Brave web-search response body to the seam's normalized result.
 *
 * Brave returns `web.results[]` with `title` / `url` / `description` / `age`
 * (`"5 days ago"`) / `page_age` (ISO timestamp) and, when requested,
 * `extra_snippets[]`. The web service owns the final `maxResults` truncation, so
 * `truncated` is always `false` here.
 *
 * @param body - the parsed JSON response.
 * @param options - the operation snapshot (only `extraSnippets` is read).
 * @returns the normalized `{ sources, truncated }` result.
 */
function mapBraveResponse(body, options) {
	const results = Array.isArray(body?.web?.results) ? body.web.results : [];
	const sources = [];
	const seen = new Set();
	for (const item of results) {
		if (item === null || typeof item !== "object") continue;
		const url = typeof item.url === "string" ? item.url : "";
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		let snippet;
		if (typeof item.description === "string" && item.description.length > 0) snippet = item.description;
		if (options.extraSnippets === true) {
			const extra = Array.isArray(item.extra_snippets) ? item.extra_snippets.filter((s) => typeof s === "string" && s.length > 0) : [];
			if (extra.length > 0) snippet = [snippet, ...extra].filter((s) => s !== undefined).join("\n\n");
		}
		// Prefer the ISO `page_age`; fall back to Brave's human-readable `age`.
		const publishedAt = typeof item.page_age === "string" && item.page_age.length > 0 ? item.page_age : typeof item.age === "string" && item.age.length > 0 ? item.age : undefined;
		sources.push({
			url,
			...typeof item.title === "string" && item.title.length > 0 ? { title: item.title } : {},
			...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
			...publishedAt !== undefined ? { publishedAt } : {}
		});
	}
	return { sources, truncated: false };
}

/** Add endpoint and credential recovery guidance to failures after dispatch begins. */
function searchEndpointError(options, message, cause) {
	const hints = [];
	if (options.apiKey.length === 0) hints.push(`No Brave API key is configured; set "apiKey" in the web-search-brave config (or the DSH_WEB_SEARCH_BRAVE_API_KEY environment variable).`);
	hints.push(`The web request used endpoint ${JSON.stringify(options.endpoint)}.`);
	return new WebError([message, ...hints].join("\n\n"), "WEB_PROVIDER_ERROR", cause === undefined ? undefined : { cause });
}

/**
 * The Brave-backed search provider.
 *
 * `resolveOptions` is a thunk: each operation snapshots the settings section at
 * its own entry, so one search never mixes two sections. Re-registering the
 * provider to carry a changed key would make the seam's selection observable to
 * the user as a flicker, which is why the plugin keeps its id stable.
 */
class BraveSearchProvider {
	id = BRAVE_PROVIDER_ID;

	/**
	 * @param resolveOptions - the options for the NEXT operation.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}

	/** True when a key is present and the endpoint is a parseable absolute URL. */
	available() {
		const options = this.resolveOptions();
		return options.apiKey.length > 0 && URL.canParse(options.endpoint);
	}

	/**
	 * Run one Brave web search.
	 * @param request - `{ query, maxResults? }`; `maxResults` truncation is the seam's job.
	 * @param signal - cancellation signal for the surrounding search.
	 * @returns `{ sources, truncated }` with deduped sources.
	 * @throws {@link WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_ERROR` otherwise.
	 */
	async search(request, signal) {
		const options = this.resolveOptions();
		if (options.apiKey.length === 0) throw new WebError("Brave search has no API key configured; set \"apiKey\" in the web-search-brave config", "WEB_PROVIDER_CREDENTIAL_MISSING");
		const url = new URL(options.endpoint);
		url.searchParams.set("q", String(request?.query ?? ""));
		url.searchParams.set("count", String(options.count));
		if (options.country.length > 0) url.searchParams.set("country", options.country.toUpperCase());
		if (options.searchLang.length > 0) url.searchParams.set("search_lang", options.searchLang);
		if (options.safesearch.length > 0) url.searchParams.set("safesearch", options.safesearch);
		if (options.freshness.length > 0) url.searchParams.set("freshness", options.freshness);
		if (options.extraSnippets === true) url.searchParams.set("extra_snippets", "true");

		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(url, {
				method: "GET",
				redirect: "error",
				headers: {
					"x-subscription-token": options.apiKey,
					accept: "application/json",
					"accept-encoding": "gzip",
					"user-agent": USER_AGENT
				},
				...signal !== undefined ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw searchEndpointError(options, `Brave search request failed: ${String(error)}`, error);
		}
		if (!response.ok) {
			const status = response.status;
			let message = `Brave Search API error (HTTP ${status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed?.error === "string" ? parsed.error : parsed?.message ?? parsed?.error?.message;
				if (typeof detail === "string" && detail.length > 0) message += `: ${detail}`;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			if (status === 401 || status === 403) message += "\n\nBrave rejected the API key. Guide the user to check the key in the web-search-brave plugin settings (a leaked or rotated key is the usual cause).";
			else if (status === 429) message += "\n\nBrave rate limit reached. The free tier allows roughly 2000 requests per month; retry later or reduce search frequency.";
			else if (status === 422) message += "\n\nBrave rejected the query parameters (usually `count` above 20 or an invalid `country`/`freshness` value).";
			throw searchEndpointError(options, message);
		}
		try {
			return mapBraveResponse(await response.json(), options);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw searchEndpointError(options, error instanceof WebError ? error.message : `Brave returned an unprocessable response body: ${String(error)}`, error);
		}
	}
}

/**
 * Project the authoritative settings section into one operation's options.
 * @param config - the current section, read through accessors.
 * @returns the options for one search.
 */
function resolveOptions(config) {
	return {
		apiKey: (read(config.apiKey, "") || String(process.env.DSH_WEB_SEARCH_BRAVE_API_KEY ?? "")).trim(),
		count: clampCount(read(config.count, BRAVE_DEFAULT_COUNT)),
		endpoint: read(config.endpoint, BRAVE_DEFAULT_ENDPOINT),
		extraSnippets: read(config.extraSnippets, true) === true,
		safesearch: String(read(config.safesearch, "moderate") ?? "").trim(),
		country: String(read(config.country, "") ?? "").trim(),
		searchLang: String(read(config.searchLang, "") ?? "").trim(),
		freshness: String(read(config.freshness, "") ?? "").trim()
	};
}

/** Register the Brave search provider with `ctx.web`. */
function apply(ctx, config) {
	ctx.web.registerSearchProvider(new BraveSearchProvider(() => resolveOptions(config)));
}

export { BRAVE_DEFAULT_COUNT, BRAVE_DEFAULT_ENDPOINT, BRAVE_MAX_COUNT, BRAVE_PROVIDER_ID, BraveSearchProvider, Config, apply, inject, mapBraveResponse, name };
