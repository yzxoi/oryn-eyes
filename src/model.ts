export function modelDefinition(
  modelID: string,
  variant?: "low" | "high" | "max",
) {
  const glm = modelID === "glm-5.3-flash";
  const interleaved = glm || modelID.startsWith("deepseek-");
  const reasoning: {
    reasoningEffort?: typeof variant;
    thinking?: { type: "enabled" };
  } = variant
    ? {
        reasoningEffort: variant,
        ...(interleaved ? { thinking: { type: "enabled" } } : {}),
      }
    : {};
  return {
    name: modelID,
    limit: { context: glm ? 1000000 : 128000, output: 32768 },
    ...(glm
      ? {
          attachment: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        }
      : {}),
    ...(variant ? { reasoning: true, variants: { [variant]: reasoning } } : {}),
    ...(modelID.startsWith("deepseek-")
      ? { interleaved: { field: "reasoning_content" } }
      : {}),
    options: { ...reasoning },
  };
}
