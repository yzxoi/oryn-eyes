import { z } from "zod";

export function timeoutPolicy(budget: number, override?: string) {
  const seconds = Math.min(
    budget,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(3000)
      .parse(override?.trim() || budget),
  );
  return {
    invoke_sec: Math.min(budget, seconds + 5),
    provider: {
      wall_sec: seconds,
      ttfb_sec: Math.min(120, seconds),
      idle_sec: Math.min(60, seconds),
    },
  };
}
