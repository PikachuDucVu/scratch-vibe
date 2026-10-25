import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { TOOL_DEFINITIONS, parseTool, requiresConfirmation } from "../shared/tools";
import { requestAgent } from "../server/agent";
import { sseData } from "../shared/sse";
const config = { apiKey: "mock-key", model: "mock", baseUrl: "https://mock.invalid/v1" };
const messages = [{ role: "user" as const, content: "test" }];
const delta = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
const call = delta({ choices: [{ delta: { tool_calls: [{ index: 0, id: "one", type: "function", function: { name: "set_sprite", arguments: '{"targetId":"cat","x":10}' } }] } }] });
const finish = delta({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
function mockStream(content: string, split = 7) {
  const bytes = new TextEncoder().encode(content);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split)); c.close(); } }), { headers: { "content-type": "text/event-stream" } }));
}
describe("tool schema and stream contract", () => {
  it("all advertised schemas compile and preserve recursive block constraints", () => {
    const ajv = new Ajv({ strict: false });
    for (const t of TOOL_DEFINITIONS) expect(ajv.compile(t.function.parameters)).toBeTypeOf("function");
    for (const [name, args] of [["set_sprite", { targetId: "cat", size: 10000 }], ["add_scripts", { targetId: "cat", scripts: [] }], ["load_extension", { extension: "https://evil.example/code.js" }]] as const) {
      expect(ajv.validate(TOOL_DEFINITIONS.find(t => t.function.name === name)!.function.parameters, args)).toBe(false);
      expect(() => parseTool(name, args)).toThrow();
    }
    const args = { targetId: "cat", scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "control_repeat", inputs: { TIMES: 2, SUBSTACK: [{ opcode: "motion_movesteps", inputs: { STEPS: 10 } }] } }]] };
    expect(ajv.validate(TOOL_DEFINITIONS.find(t => t.function.name === "add_scripts")!.function.parameters, args)).toBe(true);
    expect(() => parseTool("add_scripts", args)).not.toThrow();
  });
  it.each([call, call + finish, call + "data: [DONE]\n\n", call + delta({ error: { message: "SECRET" } }) + finish + "data: [DONE]\n\n", call + "data: {invalid}\n\n" + finish + "data: [DONE]\n\n"])("rejects incomplete/error streams before any tool can run", async stream => {
    mockStream(stream);
    await expect(requestAgent(config, messages, {}, undefined, () => {})).rejects.toThrow();
  });
  it("reassembles complete fragmented UTF-8 tool events", async () => {
    mockStream(delta({ choices: [{ delta: { content: "Xin chào Việt Nam" } }] }) + call + finish + "data: [DONE]\n\n", 1);
    const result = await requestAgent(config, messages, {}, undefined, () => {});
    expect(result.content).toBe("Xin chào Việt Nam");
    expect(result.tool_calls?.[0].function.arguments).toBe('{"targetId":"cat","x":10}');
  });
  it("supports multiline SSE data and CRLF", async () => {
    const body = new Response('data: {\r\ndata: "ok":true}\r\n\r\n').body!;
    const results = []; for await (const value of sseData(body)) results.push(value);
    expect(results).toEqual(['{\n"ok":true}']);
  });
  it("destructive and execution tools fail closed behind confirmation", () => {
    for (const name of ["delete_sprite", "delete_block", "replace_script", "restore_snapshot", "import_file", "run_project", "test_input"]) expect(requiresConfirmation(name, {})).toBe(true);
    expect(requiresConfirmation("manage_asset", { action: "delete" })).toBe(true);
    expect(requiresConfirmation("get_scripts", {})).toBe(false);
    expect(requiresConfirmation("update_block", { inputs: { SUBSTACK: [] } })).toBe(true);
  });
});
