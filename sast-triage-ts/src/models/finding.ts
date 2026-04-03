import { z } from "zod";

export const PositionSchema = z.object({
  line: z.number(),
  col: z.number(),
  offset: z.number().default(0),
});
export type Position = z.infer<typeof PositionSchema>;

export const LocationSchema = z.object({
  path: z.string(),
  start: PositionSchema,
  end: PositionSchema,
});
export type Location = z.infer<typeof LocationSchema>;

export const DataflowTraceNodeSchema = z.object({
  content: z.string(),
  location: LocationSchema,
});
export type DataflowTraceNode = z.infer<typeof DataflowTraceNodeSchema>;

function normalizeCliLoc(val: unknown): unknown {
  if (
    Array.isArray(val) &&
    val.length === 2 &&
    val[0] === "CliLoc" &&
    Array.isArray(val[1]) &&
    val[1].length === 2
  ) {
    const [loc, content] = val[1] as [unknown, unknown];
    if (typeof content === "string" && typeof loc === "object" && loc !== null) {
      return { location: loc, content };
    }
  }
  return val;
}

export const DataflowTraceSchema = z
  .object({
    taint_source: z.unknown().optional(),
    intermediate_vars: z.array(z.unknown()).default([]),
    taint_sink: z.unknown().optional(),
  })
  .passthrough()
  .transform((data) => {
    const source = data.taint_source
      ? DataflowTraceNodeSchema.parse(normalizeCliLoc(data.taint_source))
      : undefined;
    const sink = data.taint_sink
      ? DataflowTraceNodeSchema.parse(normalizeCliLoc(data.taint_sink))
      : undefined;
    const intermediates = data.intermediate_vars.map((iv) =>
      DataflowTraceNodeSchema.parse(normalizeCliLoc(iv)),
    );
    return { taint_source: source, taint_sink: sink, intermediate_vars: intermediates };
  });
export type DataflowTrace = z.infer<typeof DataflowTraceSchema>;

export const SemgrepMetadataSchema = z
  .object({
    cwe: z.array(z.string()).default([]),
    confidence: z.string().default("MEDIUM"),
    category: z.string().default("security"),
    technology: z.array(z.string()).default([]),
    owasp: z.array(z.string()).default([]),
    vulnerability_class: z.array(z.string()).default([]),
  })
  .passthrough();
export type SemgrepMetadata = z.infer<typeof SemgrepMetadataSchema>;

export const SemgrepExtraSchema = z
  .object({
    message: z.string().default(""),
    severity: z.string().default("WARNING"),
    metadata: SemgrepMetadataSchema.default({}),
    dataflow_trace: DataflowTraceSchema.optional(),
    lines: z.string().default(""),
    metavars: z.record(z.unknown()).default({}),
  })
  .passthrough();
export type SemgrepExtra = z.infer<typeof SemgrepExtraSchema>;

export const FindingSchema = z
  .object({
    check_id: z.string(),
    path: z.string(),
    start: PositionSchema,
    end: PositionSchema,
    extra: SemgrepExtraSchema.default({}),
  })
  .passthrough();
export type Finding = z.infer<typeof FindingSchema>;

export const SemgrepOutputSchema = z.object({
  results: z.array(FindingSchema).default([]),
});
