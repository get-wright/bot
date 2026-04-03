# CONTEXT MODULE

Tree-sitter AST extraction + framework knowledge base + context assembly for LLM prompt construction.

## OVERVIEW

Converts a `SemgrepFinding` + source bytes into an `AssembledContext` — the structured payload sent to the LLM. Two distinct branches based on finding classification.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add language | `code_extractor.py` → `LANG_MAP` + `_init_languages()` | Also add `tree-sitter-<lang>` to pyproject.toml |
| Add framework sanitizers | `framework_kb.py` → `FRAMEWORK_SANITIZERS` | Dict keyed by framework name |
| Add framework detection | `framework_kb.py` → `FRAMEWORK_DETECTION` | Import-pattern → framework-name mapping |
| Add safe decorator | `framework_kb.py` → `SAFE_DECORATORS` | Framework-specific decorators that neutralize findings |
| Add vuln class hints | `assembler.py` → `_classify_vuln()` | CWE + keyword → vuln class string mapping |
| Change taint context | `assembler.py` → `_assemble_taint_context()` | Branch A: source→sink trace + function body |
| Change pattern context | `assembler.py` → `_assemble_pattern_context()` | Branch B: function body + callers |

## ARCHITECTURE

```
SemgrepFinding + source bytes
        │
        ├── classify as "taint" or "pattern"
        │
        ├─► Branch A (taint): _assemble_taint_context()
        │   ├── Extract function containing the sink (tree-sitter)
        │   ├── Extract source location code
        │   ├── Extract intermediate nodes from dataflow_trace
        │   └── Append framework hints from imports
        │
        └─► Branch B (pattern): _assemble_pattern_context()
            ├── Extract function containing the finding (tree-sitter)
            ├── Find callers of that function (tree-sitter)
            └── Append framework hints from imports

        ▼
  AssembledContext (→ sent to LLM)
```

## CONVENTIONS

- `CodeExtractor` is stateful — holds initialized tree-sitter parsers for all 4 languages
- `ContextAssembler` takes `CodeExtractor` at construction, not per-call
- `framework_kb.py` is pure data — module-level dicts, no classes, no I/O
- All tree-sitter queries use `node.children_by_field_name()` or `ts.Query` — no raw string parsing of AST
- Source bytes passed as `bytes`, not `str` — tree-sitter operates on byte buffers

## ANTI-PATTERNS

- **Never pass `str` to tree-sitter** — always `bytes`. Source files are read as `rb` throughout.
- **Don't add framework detection without sanitizers** — `FRAMEWORK_DETECTION` maps imports to framework names, which then index into `FRAMEWORK_SANITIZERS`. A detection without a sanitizer entry produces empty hints.
- **Tree-sitter parsers init eagerly** — all 4 languages load at `CodeExtractor()` construction. Adding a 5th language increases startup cost for all users.
