import { z } from "zod";
import type { Incoming } from "../contracts";
import type { EyesPort } from "./bridge";

export class EyesHTTP implements EyesPort {
  constructor(private base: string, private token: string, private transport: typeof fetch = fetch) {}
  private async request(route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(20_000);
    const response = await this.transport(`${this.base.replace(/\/$/, "")}${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Oryn service HTTP ${response.status}`);
    return response.json();
  }
  async submit(message: Incoming, signal: AbortSignal) {
    signal.throwIfAborted();
    // Retain the accepted job ID even when stop arrives during admission, so it can be cancelled.
    return z.object({ id: z.string() }).parse(await this.request("/v1/messages", message)).id;
  }
  async status(id: string, signal: AbortSignal) {
    return z.object({ status: z.enum(["queued", "running", "completed", "failed", "cancelled"]), reply: z.string().optional() }).parse(await this.request(`/v1/jobs/${encodeURIComponent(id)}`, undefined, signal));
  }
  async cancel(id: string, actor: { conversation: string; sender: string }) {
    await this.request(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { conversation: actor.conversation, sender: actor.sender });
  }
}
