import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function valueForProperty(
  name: string,
  schema: Record<string, unknown>,
): unknown {
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[0];
  }
  if (name === "file" || name === "path" || name === "filePath") {
    return "src/service.ts";
  }
  if (name === "offset") {
    return 0;
  }
  if (name === "limit" || name.startsWith("max")) {
    return 10;
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "number" || schema.type === "integer") {
    return 1;
  }
  return "IntegrationTarget";
}

function requiredArguments(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object") {
    return {};
  }
  const parameterSchema = parameters as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const properties = parameterSchema.properties ?? {};
  return Object.fromEntries(
    (parameterSchema.required ?? []).map((name) => [
      name,
      valueForProperty(name, properties[name] ?? {}),
    ]),
  );
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-codegraph-pi-"));
  const fixture = join(temporaryRoot, "project");
  const indexStore = join(temporaryRoot, "indexes");
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(
    join(fixture, "src", "service.ts"),
    [
      "export function IntegrationTarget(): string {",
      "  return IntegrationCaller();",
      "}",
      "export function IntegrationCaller(): string {",
      "  return 'pi';",
      "}",
      "",
    ].join("\n"),
  );
  await execFile("git", ["init", "-b", "main"], { cwd: fixture });
  await execFile(
    "git",
    ["config", "user.email", "integration@example.invalid"],
    {
      cwd: fixture,
    },
  );
  await execFile("git", ["config", "user.name", "Integration Test"], {
    cwd: fixture,
  });
  await execFile("git", ["add", "."], { cwd: fixture });
  await execFile("git", ["commit", "-m", "pi fixture"], { cwd: fixture });
  process.env.PI_CODEGRAPH_INDEX_STORE = indexStore;
  process.env.PI_CODEGRAPH_WORKER_IDLE_MS = "1000";

  const extensionPath = join(packageRoot, "dist", "extensions", "pi.js");
  const loaded = await discoverAndLoadExtensions([extensionPath], fixture);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension);
  assert.equal(
    extension.tools.size,
    8,
    "Pi extension did not register all CodeGraph tools",
  );

  const context = {
    cwd: fixture,
    signal: undefined,
    ui: new Proxy(
      {},
      {
        get: () => () => undefined,
      },
    ),
  } as never;

  try {
    for (const handler of extension.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, context);
    }

    for (const [name, registered] of extension.tools) {
      const result = await registered.definition.execute(
        `pi-integration-${name}`,
        requiredArguments(registered.definition.parameters),
        undefined,
        undefined,
        context,
      );
      assert.notEqual(result.isError, true, `${name} returned an error`);
      assert.ok(result.content.length > 0, `${name} returned no content`);
    }
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown" }, context);
    }
  }

  console.log(
    "Pi integration passed: extension loader and all 8 CodeGraph tools",
  );
}

await main();
