import http from "node:http";
import worker from "./src/worker.js";

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const init = { method: req.method, headers: req.headers };
    if (body && req.method !== "GET" && req.method !== "HEAD") init.body = body;
    const request = new Request(`http://localhost${req.url}`, init);
    const response = await worker.fetch(request);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("server error: " + e.message);
  }
});

server.listen(PORT, () => console.log("listening on " + PORT));
