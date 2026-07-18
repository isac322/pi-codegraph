import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { CodeGraphSettings } from "./types.ts";

const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");

export const defaultSettings: Readonly<CodeGraphSettings> = Object.freeze({
  autoSync: true,
  autoGc: true,
  indexStore: path.join(cacheHome, "pi-codegraph"),
  workerIdleTimeoutMs: 5 * 60_000,
  maxWorkers: 6,
  requestTimeoutMs: 30_000,
  syncMinIntervalMs: 15_000,
  maxOutputChars: 60_000,
  allowedProjectRoots: [],
  promptInjection: true,
  codegraphExecutable: "",
  configFile: path.join(configHome, "pi-codegraph", "config.json"),
});

function booleanValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function integerValue(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function stringArray(value, fallback = []) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (typeof value === "string" && value.trim()) return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function normalizeSettings(input) {
  return {
    autoSync: booleanValue(input.autoSync, defaultSettings.autoSync),
    autoGc: booleanValue(input.autoGc, defaultSettings.autoGc),
    indexStore: path.resolve(String(input.indexStore || defaultSettings.indexStore)),
    workerIdleTimeoutMs: integerValue(input.workerIdleTimeoutMs, defaultSettings.workerIdleTimeoutMs, 1_000),
    maxWorkers: integerValue(input.maxWorkers, defaultSettings.maxWorkers, 1),
    requestTimeoutMs: integerValue(input.requestTimeoutMs, defaultSettings.requestTimeoutMs, 1_000),
    syncMinIntervalMs: integerValue(input.syncMinIntervalMs, defaultSettings.syncMinIntervalMs, 0),
    maxOutputChars: integerValue(input.maxOutputChars, defaultSettings.maxOutputChars, 4_000),
    allowedProjectRoots: stringArray(input.allowedProjectRoots).map((root) => path.resolve(root)),
    promptInjection: booleanValue(input.promptInjection, defaultSettings.promptInjection),
    codegraphExecutable: typeof input.codegraphExecutable === "string" ? input.codegraphExecutable.trim() : "",
    configFile: String(input.configFile || defaultSettings.configFile),
  };
}

export async function loadSettings(overrides: Partial<CodeGraphSettings> = {}): Promise<CodeGraphSettings> {
  const configFile = process.env.PI_CODEGRAPH_CONFIG || overrides.configFile || defaultSettings.configFile;
  let fileSettings = {};
  try {
    fileSettings = JSON.parse(await readFile(configFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Invalid pi-codegraph config at ${configFile}: ${error.message}`);
  }

  const environment = {
    autoSync: process.env.PI_CODEGRAPH_AUTO_SYNC,
    autoGc: process.env.PI_CODEGRAPH_AUTO_GC,
    indexStore: process.env.PI_CODEGRAPH_INDEX_STORE,
    workerIdleTimeoutMs: process.env.PI_CODEGRAPH_WORKER_IDLE_MS,
    maxWorkers: process.env.PI_CODEGRAPH_MAX_WORKERS,
    requestTimeoutMs: process.env.PI_CODEGRAPH_REQUEST_TIMEOUT_MS,
    syncMinIntervalMs: process.env.PI_CODEGRAPH_SYNC_MIN_INTERVAL_MS,
    maxOutputChars: process.env.PI_CODEGRAPH_MAX_OUTPUT_CHARS,
    allowedProjectRoots: process.env.PI_CODEGRAPH_ALLOWED_ROOTS,
    promptInjection: process.env.PI_CODEGRAPH_PROMPT_INJECTION,
    codegraphExecutable: process.env.PI_CODEGRAPH_EXECUTABLE,
    configFile,
  };

  const compactEnvironment = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
  return normalizeSettings({ ...defaultSettings, ...fileSettings, ...compactEnvironment, ...overrides, configFile });
}

export function settingsEnvironment(settings: CodeGraphSettings, baseRoot: string, trusted = true): NodeJS.ProcessEnv {
  return {
    PI_CODEGRAPH_BASE_ROOT: baseRoot,
    PI_CODEGRAPH_TRUSTED: trusted ? "1" : "0",
    PI_CODEGRAPH_AUTO_SYNC: String(settings.autoSync),
    PI_CODEGRAPH_AUTO_GC: String(settings.autoGc),
    PI_CODEGRAPH_INDEX_STORE: settings.indexStore,
    PI_CODEGRAPH_WORKER_IDLE_MS: String(settings.workerIdleTimeoutMs),
    PI_CODEGRAPH_MAX_WORKERS: String(settings.maxWorkers),
    PI_CODEGRAPH_REQUEST_TIMEOUT_MS: String(settings.requestTimeoutMs),
    PI_CODEGRAPH_SYNC_MIN_INTERVAL_MS: String(settings.syncMinIntervalMs),
    PI_CODEGRAPH_MAX_OUTPUT_CHARS: String(settings.maxOutputChars),
    PI_CODEGRAPH_ALLOWED_ROOTS: settings.allowedProjectRoots.join(path.delimiter),
    PI_CODEGRAPH_PROMPT_INJECTION: String(settings.promptInjection),
    ...(settings.codegraphExecutable ? { PI_CODEGRAPH_EXECUTABLE: settings.codegraphExecutable } : {}),
  };
}
