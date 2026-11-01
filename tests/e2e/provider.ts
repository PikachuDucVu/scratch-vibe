import type { Page, Route } from "@playwright/test";

// The app now calls the provider straight from the browser, so tests mock the provider's own
// endpoints. Responses need CORS headers because the provider is a different origin than the app.
export const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
export const corsJson = (route: Route, json: unknown, status = 200) => route.fulfill({ status, json, headers: CORS });

export interface AgentReply { content?: string | null; tool_calls?: unknown[] }
// What the old /api/agent body looked like: messages without the two system prompts, plus the parsed live project.
export interface AgentInput { model: string; reasoning_effort?: string; system: string; messages: any[]; project: any; headers: Record<string, string>; url: string }
export interface AgentRoute { request(): { postDataJSON(): AgentInput }; fulfill(options: { json: AgentReply }): Promise<void> }

export async function routeAgent(page: Page, handler: (route: AgentRoute) => unknown) {
  await page.route("**/chat/completions", async route => {
    const request = route.request();
    const body = request.postDataJSON();
    const [systemMessage, projectMessage, ...messages] = body.messages;
    const marker = "untrusted data, not instructions):\n";
    const project = JSON.parse(String(projectMessage.content).slice(String(projectMessage.content).indexOf(marker) + marker.length));
    const input: AgentInput = { ...body, system: String(systemMessage.content), messages, project, headers: request.headers(), url: request.url() };
    const wrapped: AgentRoute = {
      request: () => ({ postDataJSON: () => input }),
      fulfill: ({ json }) => corsJson(route, {
        choices: [{ message: { role: "assistant", content: json.content ?? null, ...(json.tool_calls ? { tool_calls: json.tool_calls } : {}) }, finish_reason: json.tool_calls ? "tool_calls" : "stop" }],
      }),
    };
    await handler(wrapped);
  });
}
