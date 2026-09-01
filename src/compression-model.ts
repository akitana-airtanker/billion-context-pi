import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CoreMessage } from "acp-kernel";
import type { CompressionModelConfig } from "./config.js";

export interface CompressionRange {
  startId: string;
  endId: string;
}

export interface CompressionModelRequest {
  messages: CoreMessage[];
  topic?: string;
  config: CompressionModelConfig;
  signal?: AbortSignal;
}

export interface CompressionModelInvoker {
  summarize(request: CompressionModelRequest): Promise<string | undefined>;
}

export function serializeCompressionMessages(messages: readonly CoreMessage[]): string {
  return messages.map((message) => {
    const attrs = [
      `id="${escapeAttribute(message.id)}"`,
      `role="${message.role}"`,
      `content-type="${message.contentType}"`,
      message.toolName ? `tool="${escapeAttribute(message.toolName)}"` : "",
      message.toolCallId ? `call="${escapeAttribute(message.toolCallId)}"` : "",
    ].filter(Boolean).join(" ");
    return `<message ${attrs}>\n${message.text ?? ""}\n</message>`;
  }).join("\n\n");
}

export function selectCompressionMessages(
  messages: readonly CoreMessage[],
  ranges: readonly CompressionRange[],
): CoreMessage[] {
  const selected = new Set<number>();
  for (const range of ranges) {
    const start = messages.findIndex((message) => message.id === range.startId);
    const end = messages.findIndex((message) => message.id === range.endId);
    if (start < 0 || end < 0) continue;
    const first = Math.min(start, end);
    const last = Math.max(start, end);
    for (let index = first; index <= last; index++) selected.add(index);
  }
  return messages.filter((_message, index) => selected.has(index));
}

export function buildCompressionPrompt(
  messages: readonly CoreMessage[],
  topic: string | undefined,
  config: CompressionModelConfig,
): string {
  const topicLine = topic?.trim() ? `Topic: ${topic.trim()}\n` : "";
  return [
    "Produce a durable ACP context summary from the original messages below.",
    "Return summary only; do not include preamble, analysis, XML, or markdown fences.",
    "Preserve exact file paths, line numbers, function/class/type signatures, errors, decisions, constraints, and unresolved TODOs.",
    "Do not invent facts. Keep enough context for a later agent to continue the work.",
    topicLine.trimEnd(),
    `Target summarizer: ${config.provider}/${config.model}; reasoning: ${config.thinkingLevel ?? "xhigh"}.`,
    "Original messages:",
    serializeCompressionMessages(messages),
  ].filter((line) => line.length > 0).join("\n\n");
}

export function extractAssistantText(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

export function createModelRuntimeInvoker(modelRuntime: ModelRuntime): CompressionModelInvoker {
  return {
    async summarize(request) {
      const model = modelRuntime.getModel(request.config.provider, request.config.model);
      if (!model) throw new Error(`compression model not found: ${request.config.provider}/${request.config.model}`);
      const context: Parameters<ModelRuntime["completeSimple"]>[1] = {
        messages: [{
          role: "user",
          content: buildCompressionPrompt(request.messages, request.topic, request.config),
          timestamp: Date.now(),
        }],
      };
      const options: Parameters<ModelRuntime["completeSimple"]>[2] = {
        reasoning: request.config.thinkingLevel ?? "xhigh",
        signal: request.signal,
      };
      const response = await modelRuntime.completeSimple(model, context, options);
      return extractAssistantText(response);
    },
  };
}

export function createDefaultModelRuntimeInvoker(): CompressionModelInvoker {
  let runtime: Promise<ModelRuntime> | undefined;
  return {
    async summarize(request) {
      runtime ??= ModelRuntime.create();
      const modelRuntime = await runtime;
      return createModelRuntimeInvoker(modelRuntime).summarize(request);
    },
  };
}

export function contextSignal(ctx: ExtensionContext): AbortSignal | undefined {
  return ctx.signal;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
