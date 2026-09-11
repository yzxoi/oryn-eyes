import type { GitHub } from "./github";

export function readGateway(github: GitHub) {
  let searches = 0;
  const queries: string[] = [];
  const capability = crypto.randomUUID();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const prefix = `/${capability}`;
    if (request.method !== "GET" || !url.pathname.startsWith(prefix + "/")) return new Response("Not found", { status: 404 });
    try {
      if (url.pathname === prefix + "/search") {
        const q = url.searchParams.get("q") || "";
        const data = await github.search(q, url.searchParams.get("kind") === "pr" ? "pr" : "issue");
        searches++; queries.push(q.slice(0, 180));
        return Response.json(data);
      }
      const match = url.pathname.slice(prefix.length).match(/^\/issue\/(\d+)$/);
      if (match) return Response.json(await github.issueContext(Number(match[1])));
      return new Response("Not found", { status: 404 });
    } catch { return Response.json({ error: "GitHub evidence could not be retrieved. Do not infer that no issue exists." }, { status: 502 }); }
  } });
  return { url: `http://127.0.0.1:${server.port}/${capability}`, get searches() { return searches; }, get queries() { return queries; }, close: () => server.stop(true) };
}
