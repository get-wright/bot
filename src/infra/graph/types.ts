import { z } from "zod";

export const NodeKindSchema = z.enum([
  "function", "class", "method", "file", "module", "variable", "interface", "import",
]).or(z.string());

export const NodeInfoSchema = z.object({
  name: z.string(),
  qualified_name: z.string(),
  kind: NodeKindSchema,
  file_path: z.string(),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  params: z.string().optional(),
  return_type: z.string().optional(),
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;

export const QueryGraphPatternSchema = z.enum([
  "callers_of",
  "callees_of",
  "imports_of",
  "importers_of",
  "children_of",
  "tests_for",
  "file_summary",
]);
export type QueryGraphPattern = z.infer<typeof QueryGraphPatternSchema>;

export const QueryGraphArgsSchema = z.object({
  pattern: QueryGraphPatternSchema,
  target: z.string(),
});
export type QueryGraphArgs = z.infer<typeof QueryGraphArgsSchema>;

export const SearchSymbolArgsSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).default(5).optional(),
});
export type SearchSymbolArgs = z.infer<typeof SearchSymbolArgsSchema>;
