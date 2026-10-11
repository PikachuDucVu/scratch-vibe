import { describe, expect, it } from "vitest";
import { parseModelList } from "../shared/models";

describe("parseModelList", () => {
  it("parses OpenAI style { data: [{ id: '...' }] }", () => {
    const input = {
      object: "list",
      data: [
        { id: "gpt-4.1", created: 123456 },
        { id: "o3-mini", created: 123457 },
      ],
    };
    expect(parseModelList(input)).toEqual(["gpt-4.1", "o3-mini"]);
  });

  it("parses Ollama style { models: [{ name: '...' }] }", () => {
    const input = {
      models: [
        { name: "llama3:latest", model: "llama3:latest", size: 1000 },
        { name: "deepseek-coder", model: "deepseek-coder", size: 2000 },
      ],
    };
    expect(parseModelList(input)).toEqual(["llama3:latest", "deepseek-coder"]);
  });

  it("parses array of strings", () => {
    const input = ["gpt-4o", "claude-3-7-sonnet", "o1"];
    expect(parseModelList(input)).toEqual(["gpt-4o", "claude-3-7-sonnet", "o1"]);
  });

  it("parses array of objects with id or name", () => {
    const input = [{ id: "model-a" }, { name: "model-b" }, { model: "model-c" }];
    expect(parseModelList(input)).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("parses { model_list: [...] } or { items: [...] }", () => {
    expect(parseModelList({ model_list: ["m1", "m2"] })).toEqual(["m1", "m2"]);
    expect(parseModelList({ items: [{ id: "m3" }] })).toEqual(["m3"]);
  });

  it("filters out empty or duplicate entries", () => {
    const input = {
      data: [{ id: "gpt-4" }, { id: "" }, { id: "   " }, { id: "gpt-4" }, { id: "gpt-3.5" }],
    };
    expect(parseModelList(input)).toEqual(["gpt-4", "gpt-3.5"]);
  });

  it("handles null, undefined, and unexpected types gracefully", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList({})).toEqual([]);
    expect(parseModelList("not a list")).toEqual([]);
    expect(parseModelList(12345)).toEqual([]);
  });
});
