import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, loadConfig } from "../../src/config";
import { addProviderApiKey } from "../../src/providers/api-keys";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
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
