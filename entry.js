import worker from "./src/worker.js";
Deno.serve((req) => worker.fetch(req));
