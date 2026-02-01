import { ProxyAgent, fetch as undiciFetch } from "undici";
import { wrapFetchWithAbortSignal } from "./fetch.js";

export function getProxyUrl(): string | undefined {
    return (
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
    );
}

export function resolveProxyFetch(): typeof fetch {
    // Check env vars directly for proxy
    const proxy = getProxyUrl();
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";

    if (!proxy) {
        return globalThis.fetch;
    }

    try {
        const dispatcher = new ProxyAgent(proxy);

        // Parse NO_PROXY list
        const noProxyList = noProxy.split(",").map(s => s.trim()).filter(Boolean);

        const shouldBypass = (urlStr: string) => {
            if (!noProxyList.length) return false;
            try {
                const u = new URL(urlStr);
                return noProxyList.some(domain => {
                    // Handle wildcard *.example.com (simple check)
                    if (domain.startsWith("*.")) {
                        return u.hostname.endsWith(domain.slice(1));
                    }
                    // Handle .example.com convention
                    if (domain.startsWith(".")) {
                        return u.hostname.endsWith(domain);
                    }
                    // Exact match or suffix match if domain doesn't start with dot?
                    // Standard convention: "example.com" matches "example.com" and "foo.example.com"
                    return u.hostname === domain || u.hostname.endsWith(`.${domain}`);
                });
            } catch {
                return false;
            }
        };

        const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
            let useProxy = true;
            if (noProxyList.length > 0) {
                const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
                if (shouldBypass(urlStr)) {
                    useProxy = false;
                }
            }

            return undiciFetch(input as any, {
                ...(init as any),
                dispatcher: useProxy ? dispatcher : undefined,
            }) as unknown as Promise<Response>;
        }) as typeof fetch;
        return wrapFetchWithAbortSignal(fetchFn);
    } catch (err) {
        console.warn(`[Proxy] Failed to initialize proxy agent for ${proxy}: ${err}`);
        return globalThis.fetch;
    }
}
