import { createLocalAssistant, ManualClock } from "../src/index.js";

export const transport = { actorId: "actor-1", scopeId: "home-1" };

export function harness(overrides = {}) {
  const clock = overrides.clock ?? new ManualClock();
  const app = createLocalAssistant({ ...overrides, clock });
  let sequence = 0;
  const send = (message, options = {}) => {
    sequence += 1;
    return app.sendMessage({
      contractVersion: "1.0.0",
      conversationId: options.conversationId ?? "conversation-1",
      clientMessageId: options.clientMessageId ?? `client-${sequence}`,
      idempotencyKey: options.idempotencyKey ?? `key-${sequence}`,
      message,
      locale: options.locale ?? "zh-CN",
      timezone: options.timezone ?? "Asia/Shanghai",
      ...(options.continuation ? { continuation: options.continuation } : {}),
      ...(options.city ? { city: options.city } : {}),
    }, options.transport ?? transport);
  };
  return { app, send };
}

export async function confirm(send, confirmation, options = {}) {
  return send("确认", { ...options, continuation: { type: "confirmation", id: confirmation.confirmationId } });
}
