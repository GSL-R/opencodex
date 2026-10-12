import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, loadConfig } from "../../src/config";
import * as configModule from "../../src/config";
import { addProviderApiKey, removeProviderApiKey } from "../../src/providers/api-keys";
import { setProviderKeychainEntryFactoryForTests, storeProviderKeyInKeychain, restoreProviderKeyFromKeychain, providerKeyStoreKind } from "../../src/providers/key-store";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import { handleProviderCommand } from "../../src/cli/provider";
import * as destinationPolicy from "../../src/lib/destination-policy";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const credential = JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" });
let home: string;
let previousHome: string | undefined;
let config: OcxConfig;
const secrets = new Map<string, string>();

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-gcp-input-"));
  process.env.OPENCODEX_HOME = home;
  secrets.clear();
  setProviderKeychainEntryFactoryForTests((service, account) => ({
    getPassword: () => secrets.get(`${service}:${account}`) ?? null,
    setPassword: value => { secrets.set(`${service}:${account}`, value); },
    deletePassword: () => secrets.delete(`${service}:${account}`),
  }));
  spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  config = { port: 10199, defaultProvider: "relay", providers: {
    relay: { adapter: "openai-chat", baseUrl: "https://relay.example/v1", apiKey: "old-key" },
  } };
  saveConfig(config);
});

afterEach(() => {
  mock.restore();
  setProviderKeychainEntryFactoryForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function assertNoPlaintext() {
  for (const file of readdirSync(home).filter(file => file.startsWith("config.json"))) {
    const content = readFileSync(join(home, file), "utf8");
    expect(content).not.toContain("fixture-secret");
    expect(content).not.toContain("fixture-refresh");
  }
}

test.each([
  { name: "new-provider", values: { apiKey: credential } },
  { name: "relay", values: { apiKey: credential } },
  { name: "relay", values: { apiKey: credential, apiKeyPool: [{ id: "raw", key: credential }] } },
  { name: "relay", values: { apiKey: "plain-key", apiKeyPool: [{ id: "raw", key: credential }] } },
  { name: "relay", values: { apiKey: `plain-key, ${credential}` } },
])("provider create/overwrite refuses raw JSON before saving: %j", async ({ name, values }) => {
  const before = structuredClone(config);
  const url = new URL("http://127.0.0.1/api/providers");
  const response = await handleProviderRoutes({
    req: new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name, provider: { adapter: "openai-chat", baseUrl: "https://relay.example/v1", ...values },
    }) }), url, config, deps: {}, version: "test", trustedLoopbackIngress: true, guiSessionIssuance: null,
    convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }),
    syncClaudeAgentDefsBestEffort: async () => {},
  });
  expect(response?.status).toBe(400);
  expect(await response!.json()).toMatchObject({ error: expect.stringMatching(/API-key|credential|JSON/i) });
  expect(config).toEqual(before);
  expect(loadConfig().providers).toEqual(before.providers);
  expect(secrets.size).toBe(0);
  assertNoPlaintext();
});

test.each([`plain-key, ${credential}`, `${credential}, plain-key`])("mixed key/JSON pool paste is entirely rejected", paste => {
  const before = structuredClone(config);
  const result = addProviderApiKey(config, "relay", paste);
  expect(result).toMatchObject({ error: expect.stringMatching(/Mixing|separate/i) });
  expect(config).toEqual(before);
  expect(secrets.size).toBe(0);
  assertNoPlaintext();
});

test("dedicated pool paste persists markers only, including subsequent backups", () => {
  expect(addProviderApiKey(config, "relay", credential)).toHaveProperty("id");
  expect(config.providers.relay!.apiKey).toStartWith("gcp-sa:");
  saveConfig(config);
  expect([...secrets.values()]).toEqual([credential]);
  assertNoPlaintext();
});

test("CLI provider add refuses credential JSON before config or backups change", async () => {
  const before = readFileSync(join(home, "config.json"), "utf8");
  const previousExitCode = process.exitCode;
  const output = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleProviderCommand(["add", "relay", "--force", "--adapter", "openai-chat", "--base-url", "https://relay.example/v1", "--api-key", credential]);
    expect(process.exitCode).toBe(2);
    expect(output.mock.calls.flat().join(" ")).toContain("API-key pool endpoint");
    expect(output.mock.calls.flat().join(" ")).not.toContain("fixture-secret");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    expect(secrets.size).toBe(0);
    assertNoPlaintext();
  } finally { process.exitCode = previousExitCode ?? 0; }
});

test("OS-store failures propagate without echoing credential material or committing a pool", () => {
  const before = structuredClone(config);
  setProviderKeychainEntryFactoryForTests(() => ({
    getPassword: () => null,
    setPassword: () => { throw new Error(`store failed: ${credential}`); },
    deletePassword: () => {},
  }));
  const result = addProviderApiKey(config, "relay", credential);
  expect(result).toMatchObject({ error: expect.stringContaining("credential storage failed") });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(config).toEqual(before);
  assertNoPlaintext();
});

const overwriteArgs = ["add", "relay", "--force", "--adapter", "openai-chat", "--base-url", "https://relay.example/v1", "--api-key", "replacement-key"];

test.each(["none", "gcp-sa", "keychain"])("CLI overwrite includes a newer durable row, retaining %s shared references", async shared => {
  expect(addProviderApiKey(config, "relay", credential)).toHaveProperty("id");
  const lateCredential = JSON.stringify({ ...JSON.parse(credential), client_id: "late-client" });
  const lock = configModule.withConfigMutationLockSync;
  let wrote = false, lateAccount = "";
  if (shared !== "none") {
    const originalRow = structuredClone(config.providers.relay!);
    const added = addProviderApiKey(config, "relay", lateCredential);
    if ("error" in added) throw new Error(added.error);
    lateAccount = config.providers.relay!.apiKeyPool!.find(entry => entry.id === added.id)!.key.slice("gcp-sa:".length);
    config.providers.relay = originalRow;
    config.providers.shared = { adapter: "openai-chat", baseUrl: "https://shared.example/v1", apiKey: `${shared}:${lateAccount}` };
    saveConfig(config);
  }
  spyOn(configModule, "withConfigMutationLockSync").mockImplementation(<T>(fn: () => T, dir?: string): T => {
    if (!wrote) {
      wrote = true;
      const fresh = loadConfig();
      fresh.providers.relay!.apiKey = undefined;
      fresh.providers.relay!.apiKeyPool = undefined;
      expect(addProviderApiKey(fresh, "relay", lateCredential)).toHaveProperty("id");
      lateAccount = fresh.providers.relay!.apiKey!.slice("gcp-sa:".length);
      saveConfig(fresh);
    }
    return lock(fn, dir);
  });
  spyOn(console, "log").mockImplementation(() => {});
  await handleProviderCommand(overwriteArgs);
  expect(wrote).toBe(true);
  const saved = loadConfig();
  expect(saved.providers.relay!.apiKey).toBe("replacement-key");
  expect(saved.providers.relay!.apiKeyPool).toBeUndefined();
  if (shared !== "none") expect(saved.providers.shared!.apiKey).toBe(`${shared}:${lateAccount}`);
  expect(secrets.size).toBe(shared === "none" ? 0 : 1);
  if (shared !== "none") expect(secrets.get(`opencodex.provider-api-key.v1:${lateAccount}`)).toBe(lateCredential);
  assertNoPlaintext();
});

test.each(["none", "gcp-sa", "keychain"])("CLI overwrite cleans old pool credentials after commit, preserving %s shared references", async shared => {
  expect(addProviderApiKey(config, "relay", credential)).toHaveProperty("id");
  const retainedMarker = config.providers.relay!.apiKey!;
  const account = retainedMarker.slice("gcp-sa:".length);
  expect(addProviderApiKey(config, "relay", JSON.stringify({ ...JSON.parse(credential), client_id: "second-client" }))).toHaveProperty("id");
  if (shared !== "none") config.providers.shared = {
    adapter: "openai-chat", baseUrl: "https://shared.example/v1", apiKey: `${shared}:${account}`,
  };
  saveConfig(config);
  expect(secrets.size).toBe(2);
  let deletions = 0;
  setProviderKeychainEntryFactoryForTests((service, key) => ({
    getPassword: () => secrets.get(`${service}:${key}`) ?? null,
    setPassword: value => { secrets.set(`${service}:${key}`, value); },
    deletePassword: () => {
      expect(loadConfig().providers.relay!.apiKey).toBe("replacement-key");
      deletions += 1;
      return secrets.delete(`${service}:${key}`);
    },
  }));
  spyOn(console, "log").mockImplementation(() => {});
  await handleProviderCommand(overwriteArgs);
  expect(loadConfig().providers.relay!.apiKey).toBe("replacement-key");
  expect(deletions).toBe(shared === "none" ? 2 : 1);
  expect(secrets.size).toBe(shared === "none" ? 0 : 1);
  if (shared !== "none") expect(secrets.get(`opencodex.provider-api-key.v1:${account}`)).toBe(credential);
  assertNoPlaintext();
});

test.each(["save failure", "refused paste"])("CLI overwrite preserves credentials on %s", async failure => {
  expect(addProviderApiKey(config, "relay", credential)).toHaveProperty("id");
  const before = readFileSync(join(home, "config.json"), "utf8");
  const previousExitCode = process.exitCode;
  try {
    if (failure === "save failure") {
      spyOn(configModule, "saveConfig").mockImplementation(() => { throw new Error("synthetic save failure"); });
      await expect(handleProviderCommand(overwriteArgs)).rejects.toThrow("synthetic save failure");
    } else {
      spyOn(console, "error").mockImplementation(() => {});
      await handleProviderCommand([...overwriteArgs.slice(0, -1), credential]);
      expect(process.exitCode).toBe(2);
    }
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    expect([...secrets.values()]).toEqual([credential]);
    assertNoPlaintext();
  } finally { process.exitCode = previousExitCode ?? 0; }
});

test("keychain store/restore leaves GCP markers and their stored JSON intact in mixed pools", () => {
  expect(addProviderApiKey(config, "relay", credential)).toHaveProperty("id");
  const marker = config.providers.relay!.apiKey!;
  const account = marker.slice("gcp-sa:".length);
  expect(providerKeyStoreKind(config.providers.relay)).toBe("keychain");
  expect(storeProviderKeyInKeychain(config, "relay")).toEqual({ ok: true, moved: 1 });
  expect(config.providers.relay!.apiKey).toBe(marker);
  expect(secrets.get(`opencodex.provider-api-key.v1:${account}`)).toBe(credential);
  expect(restoreProviderKeyFromKeychain(config, "relay")).toEqual({ ok: true, restored: 1 });
  expect(config.providers.relay!.apiKey).toBe(marker);
  expect(config.providers.relay!.apiKeyPool!.some(row => row.key === marker)).toBe(true);
  expect(secrets.get(`opencodex.provider-api-key.v1:${account}`)).toBe(credential);
  assertNoPlaintext();
});

test("cleanup retains the same OS account referenced by another provider through keychain syntax", () => {
  const result = addProviderApiKey(config, "relay", credential);
  if ("error" in result) throw new Error(result.error);
  const account = config.providers.relay!.apiKey!.slice("gcp-sa:".length);
  config.providers.shared = { adapter: "openai-chat", baseUrl: "https://shared.example/v1", apiKey: `keychain:${account}` };
  saveConfig(config);
  expect(removeProviderApiKey(config, "relay", result.id)).toBe(true);
  expect(secrets.get(`opencodex.provider-api-key.v1:${account}`)).toBe(credential);
  expect(loadConfig().providers.shared!.apiKey).toBe(`keychain:${account}`);
  assertNoPlaintext();
});

test("restore never publishes stored credential JSON through a keychain alias", () => {
  expect(addProviderApiKey(config, "relay", credential)).toHaveProperty("id");
  const marker = config.providers.relay!.apiKey!;
  const account = marker.slice("gcp-sa:".length);
  config.providers.relay!.apiKey = `keychain:${account}`;
  saveConfig(config);
  const before = structuredClone(config);
  expect(restoreProviderKeyFromKeychain(config, "relay")).toMatchObject({ ok: false, status: 400 });
  expect(config).toEqual(before);
  expect(secrets.get(`opencodex.provider-api-key.v1:${account}`)).toBe(credential);
  assertNoPlaintext();
});

test("credential re-add rebases and restores its payload after an overlapping last-reference removal", () => {
  const original = addProviderApiKey(config, "relay", credential);
  if ("error" in original) throw new Error(original.error);
  const marker = config.providers.relay!.apiKey!;
  const account = marker.slice("gcp-sa:".length);
  let written = false;
  let injectRemoval = true;
  let removed = false;
  setProviderKeychainEntryFactoryForTests((service, key) => ({
    getPassword: () => {
      const value = secrets.get(`${service}:${key}`) ?? null;
      if (key === account && written && injectRemoval) {
        injectRemoval = false;
        removed = removeProviderApiKey(loadConfig(), "relay", original.id);
      }
      return value;
    },
    setPassword: value => { secrets.set(`${service}:${key}`, value); if (key === account) written = true; },
    deletePassword: () => secrets.delete(`${service}:${key}`),
  }));
  expect(addProviderApiKey(config, "relay", credential)).toEqual(original);
  expect(removed).toBe(true);
  expect(loadConfig().providers.relay!.apiKey).toBe(marker);
  expect(secrets.get(`opencodex.provider-api-key.v1:${account}`)).toBe(credential);
  assertNoPlaintext();
});

test("a separate process cannot acquire the cleanup transaction during credential write/read-back", () => {
  const original = addProviderApiKey(config, "relay", credential);
  if ("error" in original) throw new Error(original.error);
  const account = config.providers.relay!.apiKey!.slice("gcp-sa:".length);
  let checked = false;
  let blocked = false;
  setProviderKeychainEntryFactoryForTests((service, key) => ({
    getPassword: () => secrets.get(`${service}:${key}`) ?? null,
    setPassword: value => {
      secrets.set(`${service}:${key}`, value);
      if (key !== account || checked) return;
      checked = true;
      const child = Bun.spawnSync([process.execPath, "-e", `
        import { Database } from "bun:sqlite";
        const db = new Database(process.argv[1]);
        let blocked = false;
        try { db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
        catch (error) { blocked = error.code === "SQLITE_BUSY"; }
        finally { db.close(); }
        console.log(JSON.stringify({ blocked }));
      `, join(home, "config-mutation.sqlite")], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      blocked = JSON.parse(child.stdout.toString()).blocked;
    },
    deletePassword: () => secrets.delete(`${service}:${key}`),
  }));
  expect(addProviderApiKey(config, "relay", credential)).toEqual(original);
  expect(checked).toBe(true);
  expect(blocked).toBe(true);
  assertNoPlaintext();
});
