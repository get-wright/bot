from __future__ import annotations

import pytest
from sast_triage.context.code_extractor import CodeExtractor


@pytest.fixture
def extractor():
    return CodeExtractor()


class TestDetectLanguage:
    def test_detect_language(self, extractor):
        assert extractor.detect_language("app.py") == "python"
        assert extractor.detect_language("index.js") == "javascript"
        assert extractor.detect_language("utils.ts") == "typescript"
        assert extractor.detect_language("App.tsx") == "tsx"
        assert extractor.detect_language("lib.rb") is None


class TestExtractFunctionBodyPython:
    def test_extract_function_body_python(self, extractor):
        src = b"def greet(name):\n    return f'Hello {name}'\n"
        body = extractor.extract_function_body(src, 2, "python")
        assert body is not None
        assert "def greet(name):" in body
        assert "return f'Hello {name}'" in body

    def test_extract_function_body_nested(self, extractor):
        src = b"def outer():\n    def inner():\n        return 42\n    return inner\n"
        body = extractor.extract_function_body(src, 3, "python")
        assert body is not None
        assert "def inner():" in body
        assert "return 42" in body
        assert "def outer" not in body

    def test_function_not_found(self, extractor):
        src = b"x = 1\ny = 2\n"
        assert extractor.extract_function_body(src, 1, "python") is None

    def test_empty_source(self, extractor):
        assert extractor.extract_function_body(b"", 1, "python") is None
        assert extractor.extract_imports(b"", "python") == []
        assert extractor.extract_enclosing_scopes(b"", 1, "python") == []
        assert extractor.extract_callers(b"", "foo", "python") == []


class TestExtractFunctionSignaturePython:
    def test_extract_function_signature_python(self, extractor):
        src = b"def process(data, flag=True):\n    pass\n"
        sig = extractor.extract_function_signature(src, 1, "python")
        assert sig == "def process(data, flag=True)"

    def test_extract_function_signature_with_return_type(self, extractor):
        src = b"def calculate(x: int, y: int) -> float:\n    return x / y\n"
        sig = extractor.extract_function_signature(src, 1, "python")
        assert sig == "def calculate(x: int, y: int) -> float"


class TestExtractDecoratorsPython:
    def test_extract_decorators_python(self, extractor):
        src = (
            b"@login_required\n"
            b"@require_GET\n"
            b"def my_view(request):\n"
            b"    pass\n"
        )
        decorators = extractor.extract_decorators(src, 4, "python")
        assert len(decorators) == 2
        assert "@login_required" in decorators[0]
        assert "@require_GET" in decorators[1]

    def test_extract_decorators_none(self, extractor):
        src = b"def plain_func():\n    pass\n"
        assert extractor.extract_decorators(src, 1, "python") == []

    def test_extract_decorators_js_returns_empty(self, extractor):
        src = b"function hello() { return 1; }\n"
        assert extractor.extract_decorators(src, 1, "javascript") == []


class TestExtractImports:
    def test_extract_imports_python(self, extractor):
        src = b"import os\nfrom django.http import HttpResponse\n\ndef view():\n    pass\n"
        imports = extractor.extract_imports(src, "python")
        assert len(imports) == 2
        assert "import os" in imports[0]
        assert "from django.http import HttpResponse" in imports[1]

    def test_extract_imports_javascript(self, extractor):
        src = (
            b"const fs = require('fs');\n"
            b"import React from 'react';\n"
            b"\n"
            b"function main() {}\n"
        )
        imports = extractor.extract_imports(src, "javascript")
        assert len(imports) == 2
        texts = [i for i in imports]
        assert any("require('fs')" in t for t in texts)
        assert any("React" in t for t in texts)

    def test_extract_imports_typescript(self, extractor):
        src = (
            b"import { Component } from '@angular/core';\n"
            b"import type { Config } from './config';\n"
            b"\n"
            b"const x = 1;\n"
        )
        imports = extractor.extract_imports(src, "typescript")
        assert len(imports) == 2
        assert any("Component" in i for i in imports)
        assert any("Config" in i for i in imports)


class TestExtractEnclosingScopes:
    def test_extract_enclosing_scopes(self, extractor):
        src = (
            b"class MyClass:\n"
            b"    def method(self):\n"
            b"        x = 1\n"
            b"        return x\n"
        )
        scopes = extractor.extract_enclosing_scopes(src, 3, "python")
        assert len(scopes) == 2
        assert scopes[0]["kind"] == "function"
        assert scopes[0]["name"] == "method"
        assert scopes[1]["kind"] == "class"
        assert scopes[1]["name"] == "MyClass"


class TestExtractCallers:
    def test_extract_callers(self, extractor):
        src = (
            b"def helper():\n"
            b"    return 42\n"
            b"\n"
            b"def caller_a():\n"
            b"    result = helper()\n"
            b"    return result\n"
            b"\n"
            b"def caller_b(x):\n"
            b"    return helper() + x\n"
        )
        callers = extractor.extract_callers(src, "helper", "python")
        assert len(callers) == 2
        assert any("caller_a" in c for c in callers)
        assert any("caller_b" in c for c in callers)


class TestJavaScriptFunctions:
    def test_extract_function_body_javascript(self, extractor):
        src = b"function add(a, b) {\n  return a + b;\n}\n"
        body = extractor.extract_function_body(src, 2, "javascript")
        assert body is not None
        assert "function add(a, b)" in body
        assert "return a + b" in body

    def test_extract_function_body_arrow(self, extractor):
        src = b"const multiply = (a, b) => {\n  return a * b;\n};\n"
        body = extractor.extract_function_body(src, 2, "javascript")
        assert body is not None
        assert "return a * b" in body
