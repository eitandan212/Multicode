import { describe, expect, it } from "vitest";
import { checkConnection, explain } from "../server/health.js";
import { SignIn } from "../server/signin.js";
import type { Connection } from "../server/config.js";

const api: Connection = { id: "a", kind: "openai-compatible", label: "Ollama", baseUrl: "http://localhost:11434/v1" };
const acp: Connection = { id: "c", kind: "acp", label: "Cline", acp: { agentId: "cline", agentName: "Cline" } };

describe("connection health in plain words", () => {
  it("explains the errors people actually hit, with the fix", () => {
    expect(explain("connect ECONNREFUSED 127.0.0.1:11434", api)).toMatchObject({ status: "problem", message: expect.stringMatching(/Nothing is answering at http:\/\/localhost:11434\/v1/) });
    expect(explain("401 Incorrect API key provided", { ...api, baseUrl: "https://api.openai.com/v1" })).toMatchObject({ action: "edit", message: expect.stringMatching(/key was rejected/) });
    expect(explain("Cline isn't installed yet. Open Connections and press Install.", acp)).toMatchObject({ status: "install", action: "install" });
    expect(explain('Needs Node.js (npx). Install Node.js 20+ from nodejs.org.', acp)).toMatchObject({ action: "node" });
    expect(explain("Cline needs you to sign in first (Cline account). Run the agent once…", acp)).toMatchObject({ status: "sign-in" });
    expect(explain("429 Too Many Requests: rate limit", api)).toMatchObject({ message: expect.stringMatching(/out of quota/) });
    expect(explain("something odd", acp)).toMatchObject({ status: "problem", message: expect.stringMatching(/isn't working: something odd/) });
  });

  it("checks an API by listing its models, spending no tokens", async () => {
    let generated = false;
    const ok = await checkConnection(api, { editsFiles: false, generate: async () => ((generated = true), ""), listModels: async () => ["a", "b"] }, new SignIn());
    expect(ok).toEqual({ status: "ready", message: "Works · 2 models available" });
    const bad = await checkConnection(api, { editsFiles: false, generate: async () => "", listModels: async () => { throw new Error("fetch failed"); } }, new SignIn());
    expect(bad.status).toBe("problem");
    expect(generated).toBe(false);
  });
});
