#!/usr/bin/env node

import { generateText, streamText } from "ai";
import { makeCodexModel, providerConfig, providerName } from "../agent/provider.ts";

if (providerName !== "codex") {
  throw new Error(`Expected MODEL_PROVIDER=codex, got ${providerName}`);
}

const result = await generateText({
  model: makeCodexModel(),
  prompt: "Reply with exactly one word: OK",
  maxOutputTokens: 64,
});
const text = result.text.trim();

if (!text) {
  console.error(
    JSON.stringify({
      text,
      reasoningText: result.reasoningText,
      finishReason: result.finishReason,
      usage: result.usage,
      content: result.content,
      warnings: result.warnings,
    }),
  );
  throw new Error("Codex generate smoke test returned empty text");
}

const streamed = streamText({
  model: makeCodexModel(),
  prompt: "Reply with exactly one word: STREAM",
  maxOutputTokens: 64,
});
let streamTextValue = "";
for await (const chunk of streamed.textStream) streamTextValue += chunk;
streamTextValue = streamTextValue.trim();
if (!streamTextValue) throw new Error("Codex stream smoke test returned empty text");

console.log(
  JSON.stringify({
    provider: providerName,
    model: providerConfig.textModel,
    generate: text,
    stream: streamTextValue,
  }),
);
