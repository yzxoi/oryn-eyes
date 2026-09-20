export function modelDefinition(
  modelID: string,
  variant?: "low" | "high" | "max",
) {
  const glm = modelID === "glm-5.3-flash";
  const qwen = modelID === "Qwen3.8-27B";
  const interleaved = glm || modelID.startsWith("deepseek-");
  // The SII vLLM endpoint accepts reasoning_effort of none/low/medium only and
  // applies its strongest built-in level with thinking enabled when the field is
  // omitted. Oryn's "max" maps to that omission; "high" maps to medium.
  const effort = !variant || variant === "max" ? undefined : variant === "high" ? ("medium" as const) : variant;
  const reasoning: {
    reasoningEffort?: "low" | "medium" | "high" | "max";
    thinking?: { type: "enabled" };
  } = qwen
    ? effort ? { reasoningEffort: effort } : {}
    : variant
      ? { reasoningEffort: variant, ...(interleaved ? { thinking: { type: "enabled" } } : {}) }
      : {};
  return {
    name: modelID,
    limit: { context: glm || qwen ? 1000000 : 128000, output: 32768 },
    ...(glm || qwen
      ? {
          attachment: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        }
      : {}),
    ...(variant ? { reasoning: true, variants: { [variant]: reasoning } } : {}),
    ...(modelID.startsWith("deepseek-")
      ? { interleaved: { field: "reasoning_content" } }
      : {}),
    options: { response_format: { type: "json_object" }, ...reasoning },
  };
}
