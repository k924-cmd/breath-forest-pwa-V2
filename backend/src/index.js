import {
  FakeDeviceAdapter,
  FakeEnvironmentAdapter,
  FakeModelAdapter,
  FakeOptimizerAdapter,
  InMemoryStateRepository,
  InMemoryTelemetryAdapter,
  ManualClock,
  SequentialIdGenerator,
} from "./adapters/fakes.js";
import { SqliteStateRepository } from "./adapters/sqlite.js";
import { AssistantService } from "./conversation/assistant-service.js";
import { InMemoryDeviceRegistry } from "./devices/registry.js";
import { DeepSeekModelAdapter } from "./adapters/deepseek.js";
import { TavilySearchAdapter } from "./adapters/tavily.js";

export function createLocalAssistant(overrides = {}) {
  const clock = overrides.clock ?? new ManualClock();
  const dependencies = {
    clock,
    ids: overrides.ids ?? new SequentialIdGenerator(),
    repository: overrides.repository ?? new InMemoryStateRepository(),
    model: overrides.model ?? new FakeModelAdapter(),
    realtime: overrides.realtime ?? null,
    environment: overrides.environment ?? new FakeEnvironmentAdapter({
      pm25: 18,
      co2: 720,
      humidity: 48,
      temperature: 24,
      score: 88,
      status: "良好",
      observedAt: clock.iso(),
      source: "mock",
      freshness: "fresh",
    }),
    devices: overrides.devices ?? new FakeDeviceAdapter(),
    optimizer: overrides.optimizer ?? new FakeOptimizerAdapter(),
    telemetry: overrides.telemetry ?? new InMemoryTelemetryAdapter(),
  };
  dependencies.registry = overrides.registry ?? new InMemoryDeviceRegistry(undefined, clock);
  const assistant = new AssistantService(dependencies);
  return Object.assign(assistant, { adapters: dependencies });
}

export * from "./adapters/fakes.js";
export { SqliteStateRepository } from "./adapters/sqlite.js";
export { DeepSeekModelAdapter, DEEPSEEK_DEFAULT_ENDPOINT, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_MAX_TOKENS_CAP, DEEPSEEK_TIMEOUT_MS_CAP } from "./adapters/deepseek.js";
export { TavilySearchAdapter, TAVILY_DEFAULT_ENDPOINT, TAVILY_TIMEOUT_MS_CAP, TAVILY_MAX_RESULTS_DEFAULT } from "./adapters/tavily.js";
export * from "./devices/registry.js";
export * from "./core/errors.js";
