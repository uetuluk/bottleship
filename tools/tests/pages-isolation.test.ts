import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function worker() {
    const handlers: Record<string, (event: any) => void> = {};
    const requests: Request[] = [];
    runInNewContext(readFileSync(new URL("../../public/isolation-sw.js", import.meta.url), "utf8"), {
        self: {
            location: { origin: "https://example.github.io" },
            registration: { scope: "https://example.github.io/bottleship/" },
            addEventListener: (name: string, callback: (event: any) => void) => { handlers[name] = callback; },
        },
        URL, Headers, Response,
        fetch: async (request: Request) => {
            requests.push(request);
            return new Response("wasm", { status: 206, headers: { "Content-Range": "bytes 0-3/100" } });
        },
    });
    return { handlers, requests };
}

test("Pages isolation preserves partial responses and request headers", async () => {
    const { handlers, requests } = worker();
    let pending: Promise<Response> | undefined;
    handlers.fetch({
        request: new Request("https://example.github.io/bottleship/v86.wasm", { headers: { Range: "bytes=0-3" } }),
        respondWith: (response: Promise<Response>) => { pending = response; },
    });
    const response = await pending!;
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-3/100");
    expect(requests[0].headers.get("Range")).toBe("bytes=0-3");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(await response.text()).toBe("wasm");
});

test("Pages isolation does not intercept other projects or remote sites", () => {
    const { handlers, requests } = worker();
    for (const url of ["https://example.github.io/other/", "https://other.example/bottleship/"]) {
        handlers.fetch({ request: new Request(url), respondWith: () => { throw new Error("Outside worker scope"); } });
    }
    expect(requests).toHaveLength(0);
});
