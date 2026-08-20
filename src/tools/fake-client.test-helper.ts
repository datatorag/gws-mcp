import { vi } from "vitest";
import type { GwsClient } from "../gws-client.js";

/** A GwsClient stand-in shared by the tool-module test suites: `calls`
 * records every api() invocation, `plan` decides each call's fate in order. */
export function fakeClient(
  plan: Array<{ data?: unknown; throws?: string }>
): { client: GwsClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const api = vi.fn(async (service, resource, method, opts) => {
    calls.push({ service, resource, method, ...opts });
    const step = plan.shift();
    if (!step) throw new Error("fake client: no planned response left");
    if (step.throws) throw new Error(step.throws);
    return { success: true, data: step.data };
  });
  return { client: { api } as unknown as GwsClient, calls };
}

/** The JSON body a handler wrapped in its MCP response envelope. */
export const payload = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0].text);
