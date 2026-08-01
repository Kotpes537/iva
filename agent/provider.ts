import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { CODEX_BASE_URL, codexAuthHeaders } from "../scripts/lib/codex-oauth.mjs";

import { EFFORTS } from "../scripts/lib/model-catalog.mjs";
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

// Единый источник конфигурации провайдера модели (выбор раз при старте через MODEL_PROVIDER).
// ollama/opencode/openrouter — OpenAI-совместимы (chat/completions, статичный ключ из .env).
// codex — личная подписка OpenAI (ChatGPT): Responses API + OAuth-токен (data/codex-auth.json,
// `iva login`). Здесь же зашита vision-модель провайдера — её зовёт agent/vision.ts.
const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";

const PROVIDERS = {
  ollama: {
    // OLLAMA_BASE_URL — не пользовательская настройка, а шов для тестов: replica-смоук
    // подставляет сюда локальный mock-провайдер (scripts/lib/mock-openai-server.mjs).
    baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    textModel: process.env.OLLAMA_MODEL ?? "deepseek-v4-pro",
    contextWindow: Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 131072),
    // Дешёвая мультимодалка того же провайдера (проверено на проде: принимает image_url, http 200).
    // Ollama Cloud снимает теги с раздачи: gemma3:12b отвечает 410 "retired at 2026-07-15" —
    // заменён на gemma4:31b (проверено 2026-07-28). Текстовые модели (deepseek, glm, gpt-oss)
    // отдают 400 "does not support image input", так что подменять vision на них нельзя.
    visionModel: "gemma4:31b",
  },
  opencode: {
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    // Эндпоинт ждёт bare-ID — срезаем внутренний UI-префикс "opencode-go/" из дефолта и старых .env.
    textModel: (process.env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(/^opencode-go\//, ""),
    contextWindow: Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131072),
    // gemini-3-flash выпал из каталога Go (401 "Model gemini-3-flash is not supported") — теперь
    // qwen3.7-plus: отвечает 200 и кладёт описание в message.content. У glm-5.2/minimax-m3 текст
    // уходит в reasoning, у mimo-v2.5 content пустой — vision.ts читает только content.
    visionModel: "qwen3.7-plus",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    // Слаг модели вида vendor/model (напр. anthropic/claude-sonnet-4.5) — задаётся мастером.
    // Дефолт — лишь заглушка на случай ручного .env; мастер всегда перезапишет живой проверкой.
    textModel: process.env.OPENROUTER_MODEL ?? "openai/gpt-5.1",
    contextWindow: Number(process.env.OPENROUTER_CONTEXT_WINDOW ?? 131072),
    // Дешёвая гарантированно-мультимодальная модель для картинок (как qwen3.7-plus у opencode):
    // vision работает независимо от выбранной текстовой модели (та может быть text-only).
    visionModel: "google/gemini-2.5-flash",
  },
  codex: {
    baseURL: CODEX_BASE_URL,
    apiKey: undefined, // авторизация — OAuth-токен подписки, не статичный ключ (см. codexFetch)
    textModel: process.env.CODEX_MODEL ?? "gpt-5.5",
    contextWindow: Number(process.env.CODEX_CONTEXT_WINDOW ?? 272000),
    // gpt-5* мультимодальны — картинки идут через ту же подписку (см. agent/vision.ts).
    visionModel: process.env.CODEX_MODEL ?? "gpt-5.5",
  },
} as const;

export const providerName = PROVIDER;
export const providerConfig = PROVIDERS[PROVIDER as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;

// THINKING_EFFORT (.env, пишут /model и /think в Telegram): reasoning-усилие модели.
// Codex получает его через providerOptions.openai.reasoningEffort ниже. Ollama Cloud
// и OpenCode Go говорят на OpenAI-compatible chat/completions; eve передаёт им
// provider-agnostic reasoning как reasoning_effort (см. compatibleThinkingEffort).
// Уровни — из общего каталога мастера, чтобы кнопки и рантайм не разъезжались.
const effortRaw = (process.env.THINKING_EFFORT ?? "").toLowerCase();
export const thinkingEffort = EFFORTS.includes(effortRaw) ? effortRaw : undefined;
const COMPATIBLE_EFFORTS = ["low", "medium", "high"] as const;
type CompatibleEffort = (typeof COMPATIBLE_EFFORTS)[number];
export const compatibleThinkingEffort: CompatibleEffort | undefined =
  (PROVIDER === "ollama" || PROVIDER === "opencode")
  && (COMPATIBLE_EFFORTS as readonly string[]).includes(effortRaw)
    ? effortRaw as CompatibleEffort
    : undefined;

// --- Codex (подписка ChatGPT): Responses API через @ai-sdk/openai ----------------------------
// Кастомный fetch: перед КАЖДЫМ запросом подставляет свежий Bearer + ChatGPT-Account-ID
// (getAccessToken рефрешит истёкший токен) и форсит store:false — бэкенд подписки stateless,
// историю eve шлёт целиком каждый ход. Тело патчим здесь же (точка правки, если бэкенд строже).
function stripCodexReferences(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(stripCodexReferences)
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  if (source.type === "item_reference") return undefined;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "previous_response_id") continue;
    if (
      (key === "id" || key === "item_id" || key === "itemId") &&
      typeof child === "string" &&
      child.startsWith("msg_")
    )
      continue;
    const next = stripCodexReferences(child);
    if (next !== undefined) cleaned[key] = next;
  }
  return cleaned;
}

function finalResponseFromSse(payload: string): unknown {
  let finalResponse: unknown;
  const outputItems: Array<Record<string, unknown>> = [];

  for (const block of payload.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;

    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const response = event.response as { status?: string } | undefined;
      const type = String(event.type || eventName || "");
      if (type === "response.output_item.done" && event.item) {
        outputItems.push(event.item as Record<string, unknown>);
      }
      const status = response?.status || "";
      if (
        response &&
        (/^response\.(completed|failed|incomplete)$/u.test(type) ||
          ["completed", "failed", "incomplete"].includes(status))
      ) {
        finalResponse = response;
      }
    } catch {
      // Keep scanning: comments and non-JSON keepalive events are valid SSE.
    }
  }

  if (finalResponse === undefined) {
    throw new Error("Codex stream ended without a final response event");
  }
  const completed = finalResponse as { output?: unknown[] };
  if (outputItems.length > 0 && (!Array.isArray(completed.output) || completed.output.length === 0)) {
    completed.output = outputItems;
  }
  return completed;
}

async function codexStreamAsJson(response: Response): Promise<Response> {
  const payload = await response.text();
  try {
    const finalResponse = finalResponseFromSse(payload);
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(finalResponse), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.error(`[codex] stream adapter: ${String((error as Error)?.message || error)}`);
    return new Response(JSON.stringify({ error: { message: "Invalid Codex streaming response" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

const codexFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(await codexAuthHeaders())) headers.set(k, v);
  let body = init?.body;
  let adaptStreamToJson = false;
  if (typeof body === "string" && String((input as Request).url ?? input).endsWith("/responses")) {
    try {
      const j = JSON.parse(body);
      j.store = false;
      // История может содержать item_reference и itemId не только на верхнем уровне, но и внутри
      // content/providerOptions. При store:false такие msg_-ссылки не существуют на сервере.
      const cleaned = stripCodexReferences(j) as Record<string, unknown>;
      // ChatGPT subscription accepts Responses calls only with stream:true. AI SDK still uses
      // doGenerate for compaction and several internal Eve steps, so transparently collect the
      // SSE response and return its final response.completed payload as ordinary JSON.
      // The subscription endpoint also rejects max_output_tokens even though the public Responses
      // API accepts it; omit it here and let the backend apply the model/session limit.
      delete cleaned.max_output_tokens;
      if (cleaned.stream !== true) {
        cleaned.stream = true;
        adaptStreamToJson = true;
      }
      body = JSON.stringify(cleaned);
    } catch {
      /* не JSON — не трогаем */
    }
  }
  const response = await fetch(input, { ...init, headers, body });
  if (!response.ok) {
    try {
      console.error(`[codex] HTTP ${response.status}: ${(await response.clone().text()).slice(0, 1200)}`);
    } catch {
      console.error(`[codex] HTTP ${response.status}`);
    }
  }
  if (adaptStreamToJson && response.ok) return codexStreamAsJson(response);
  return response;
};

// Форсит store:false на этапе СБОРКИ тела (не пост-фактум в codexFetch). Без этого @ai-sdk/openai
// берёт store:true по умолчанию и реплеит прошлые ответы ассистента как item_reference (голая
// ссылка на msg_-item, без контента); codexFetch затем ставит store:false — и stateless-бэкенд
// подписки не находит item → сессия падает со второго запроса ("Item ... not found. Items are not
// persisted when store is set to false"). store:false заставляет SDK инлайнить историю целиком.
const forceStoreFalse: LanguageModelMiddleware = {
  async transformParams({ params }) {
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openai: { ...params.providerOptions?.openai, store: false },
      },
    };
  },
};

/** Строит Codex-модель (Responses API подписки). Общая для agent.ts и vision.ts. */
export function makeCodexModel(model: string = providerConfig.textModel) {
  const openai = createOpenAI({ baseURL: CODEX_BASE_URL, apiKey: "chatgpt-subscription", fetch: codexFetch });
  return wrapLanguageModel({ model: openai.responses(model), middleware: forceStoreFalse });
}

// --- Анти-InvalidPrompt: срезаем reasoning из вывода модели ---------------------------------
// deepseek (openai-compatible) иногда отдаёт reasoning-часть без поля `text`. eve хранит reasoning
// в истории и реплеит её каждый ход, а ai@7 ModelMessage-схема требует у reasoning непустой string
// `text` → одна такая часть бросает AI_InvalidPromptError в standardizePrompt и отравляет сессию
// навсегда (Iva молчит в треде до ручного сброса). reasoning в реплее не нужен — это приватное
// «мышление», юзеру не видно — поэтому выкидываем его из ВЫВОДА целиком, и в историю он не попадает.
// Подтверждено репродукцией: reasoning с text:"" проходит, без text — FAIL (см. implementation-notes).
const REASONING_PART_TYPES = new Set([
  "reasoning",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "reasoning-file",
]);

const stripReasoningMiddleware: LanguageModelMiddleware = {
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    return { ...result, content: result.content.filter((p) => p.type !== "reasoning") };
  },
  async wrapStream({ doStream }) {
    const { stream, ...rest } = await doStream();
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (!REASONING_PART_TYPES.has(part.type)) controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

/** Оборачивает текстовую модель так, чтобы reasoning не попадал в реплеемую историю. */
export function withReasoningStripped(model: WrappableModel): WrappableModel {
  return wrapLanguageModel({ model, middleware: stripReasoningMiddleware });
}
