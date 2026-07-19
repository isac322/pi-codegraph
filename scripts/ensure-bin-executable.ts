import { chmod } from "node:fs/promises";

await chmod(new URL("../dist/bin/codegraph-mcp.js", import.meta.url), 0o755);
