from __future__ import annotations

import os

import tree_sitter_python as tspython
import tree_sitter_javascript as tsjavascript
import tree_sitter_typescript as tstypescript
from tree_sitter import Language, Parser


LANG_MAP = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
}


class CodeExtractor:
    def __init__(self):
        self._languages: dict[str, Language] = {}
        self._parsers: dict[str, Parser] = {}
        self._init_languages()

    def _init_languages(self):
        self._languages["python"] = Language(tspython.language())
        self._languages["javascript"] = Language(tsjavascript.language())
        self._languages["typescript"] = Language(tstypescript.language_typescript())
        self._languages["tsx"] = Language(tstypescript.language_tsx())
        for name, lang in self._languages.items():
            self._parsers[name] = Parser(lang)

    def detect_language(self, filepath: str) -> str | None:
        ext = os.path.splitext(filepath)[1].lower()
        return LANG_MAP.get(ext)

    def extract_function_body(self, source: bytes, line: int, language: str = "python") -> str | None:
        tree = self._parse(source, language)
        if not tree:
            return None
        fn = self._find_enclosing_function(tree.root_node, line - 1, language)
        return fn.text.decode() if fn else None

    def extract_function_signature(self, source: bytes, line: int, language: str = "python") -> str | None:
        tree = self._parse(source, language)
        if not tree:
            return None
        fn = self._find_enclosing_function(tree.root_node, line - 1, language)
        if not fn:
            return None
        return self._build_signature(fn, language)

    def extract_decorators(self, source: bytes, line: int, language: str = "python") -> list[str]:
        if language != "python":
            return []
        tree = self._parse(source, language)
        if not tree:
            return []
        fn = self._find_enclosing_function(tree.root_node, line - 1, language)
        if not fn:
            return []
        parent = fn.parent
        if parent and parent.type == "decorated_definition":
            return [
                child.text.decode()
                for child in parent.children
                if child.type == "decorator"
            ]
        return []

    def extract_imports(self, source: bytes, language: str = "python") -> list[str]:
        tree = self._parse(source, language)
        if not tree:
            return []
        imports = []
        for node in self._walk(tree.root_node):
            if language == "python" and node.type in ("import_statement", "import_from_statement"):
                imports.append(node.text.decode())
            elif language in ("javascript", "typescript", "tsx"):
                if node.type == "import_statement":
                    imports.append(node.text.decode())
                if (node.type == "lexical_declaration"
                    and node.parent and node.parent.type == "program"
                    and "require(" in node.text.decode()):
                    imports.append(node.text.decode())
        return imports

    def extract_enclosing_scopes(self, source: bytes, line: int, language: str = "python") -> list[dict]:
        tree = self._parse(source, language)
        if not tree:
            return []
        target = line - 1
        scopes = []
        func_types = self._get_function_types(language)
        class_types = self._get_class_types(language)

        for node in self._walk(tree.root_node):
            if node.type in func_types or node.type in class_types:
                if node.start_point[0] <= target <= node.end_point[0]:
                    name_node = node.child_by_field_name("name")
                    name = name_node.text.decode() if name_node else "<anonymous>"
                    kind = "class" if node.type in class_types else "function"
                    scopes.append({
                        "kind": kind,
                        "name": name,
                        "line_start": node.start_point[0] + 1,
                        "line_end": node.end_point[0] + 1,
                    })
        scopes.sort(key=lambda s: s["line_end"] - s["line_start"])
        return scopes

    def extract_callers(self, source: bytes, fn_name: str, language: str = "python") -> list[str]:
        tree = self._parse(source, language)
        if not tree:
            return []
        callers = []
        seen: set[str] = set()
        call_types = {"call"} if language == "python" else {"call_expression"}
        for node in self._walk(tree.root_node):
            if node.type in call_types:
                func_node = node.child_by_field_name("function")
                if func_node and func_node.text.decode() == fn_name:
                    enclosing = self._find_parent_function(node, language)
                    if enclosing:
                        sig = self._build_signature(enclosing, language)
                        if sig and sig not in seen:
                            seen.add(sig)
                            callers.append(sig)
        return callers

    def _parse(self, source: bytes, language: str):
        parser = self._parsers.get(language)
        if not parser:
            return None
        return parser.parse(source)

    def _walk(self, node):
        yield node
        for child in node.children:
            yield from self._walk(child)

    def _get_function_types(self, language: str) -> set[str]:
        if language == "python":
            return {"function_definition"}
        return {"function_declaration", "arrow_function", "method_definition", "function_expression"}

    def _get_class_types(self, language: str) -> set[str]:
        if language == "python":
            return {"class_definition"}
        return {"class_declaration"}

    def _find_enclosing_function(self, root, line_0based: int, language: str):
        func_types = self._get_function_types(language)
        best = None
        best_size = float("inf")
        for node in self._walk(root):
            if node.type in func_types:
                start = node.start_point[0]
                end = node.end_point[0]
                if start <= line_0based <= end:
                    size = end - start
                    if size < best_size:
                        best_size = size
                        best = node
            # decorated_definition wraps function_definition in Python
            if language == "python" and node.type == "decorated_definition":
                for child in node.children:
                    if child.type == "function_definition":
                        start = node.start_point[0]
                        end = node.end_point[0]
                        if start <= line_0based <= end:
                            size = end - start
                            if size < best_size:
                                best_size = size
                                best = child
        return best

    def _find_parent_function(self, node, language: str):
        func_types = self._get_function_types(language)
        current = node.parent
        while current:
            if current.type in func_types:
                return current
            current = current.parent
        return None

    def _build_signature(self, fn_node, language: str) -> str | None:
        if language == "python":
            name_node = fn_node.child_by_field_name("name")
            params_node = fn_node.child_by_field_name("parameters")
            return_node = fn_node.child_by_field_name("return_type")
            name = name_node.text.decode() if name_node else "<anonymous>"
            params = params_node.text.decode() if params_node else "()"
            ret = f" -> {return_node.text.decode()}" if return_node else ""
            prefix = ""
            for child in fn_node.children:
                if hasattr(child, "type") and child.type == "async":
                    prefix = "async "
                    break
            return f"{prefix}def {name}{params}{ret}"
        else:
            name_node = fn_node.child_by_field_name("name")
            params_node = fn_node.child_by_field_name("parameters")
            name = name_node.text.decode() if name_node else "<anonymous>"
            params = params_node.text.decode() if params_node else "()"
            if fn_node.type == "arrow_function":
                if name == "<anonymous>" and fn_node.parent:
                    p = fn_node.parent
                    if p.type == "variable_declarator":
                        pname = p.child_by_field_name("name")
                        if pname:
                            name = pname.text.decode()
                return f"const {name} = {params} =>"
            return f"function {name}{params}"
