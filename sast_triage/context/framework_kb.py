from __future__ import annotations

FRAMEWORK_SANITIZERS: dict[str, dict[str, list[str]]] = {
    "django": {
        "xss": [
            "Django templates auto-escape all variables by default",
            "mark_safe() explicitly bypasses escaping - check if intentional",
            "The |safe filter bypasses auto-escaping",
            "{% autoescape off %} disables escaping for a block",
            "JsonResponse is safe from XSS (application/json content-type)",
        ],
        "sqli": [
            "Django ORM .filter()/.exclude()/.get() are parameterized and safe",
            ".raw() queries require manual parameterization",
            ".extra() is deprecated and potentially unsafe",
            "cursor.execute() with string formatting is vulnerable",
            "cursor.execute() with %s placeholders is safe",
        ],
        "csrf": [
            "CsrfViewMiddleware is enabled by default",
            "@csrf_exempt explicitly disables CSRF protection",
        ],
        "ssrf": [
            "No built-in SSRF protection in Django",
        ],
        "path_traversal": [
            "Django's FileResponse validates paths within MEDIA_ROOT by default",
            "os.path.join with user input can escape base directory",
        ],
        "command_injection": [
            "subprocess with shell=True is dangerous",
            "subprocess with shell=False and list args is safe",
        ],
    },
    "flask": {
        "xss": [
            "Jinja2 auto-escapes in .html templates by default",
            "Markup() explicitly marks strings as safe",
            "|safe filter bypasses auto-escaping",
            "make_response() defaults to text/html content-type",
            "Response() with string defaults to text/html",
            "jsonify() is safe (application/json content-type)",
        ],
        "sqli": [
            "SQLAlchemy ORM queries are parameterized by default",
            "db.engine.execute() with string formatting is vulnerable",
            "text() with :param syntax is parameterized and safe",
        ],
        "ssrf": [
            "No built-in SSRF protection in Flask",
        ],
    },
    "fastapi": {
        "xss": [
            "FastAPI returns JSON by default (safe from XSS)",
            "HTMLResponse must be used explicitly for HTML output",
            "Jinja2Templates auto-escapes by default",
        ],
        "sqli": [
            "SQLAlchemy ORM queries are parameterized",
            "Pydantic validators provide input validation layer",
        ],
    },
    "express": {
        "xss": [
            "Express does NOT auto-escape output by default",
            "res.json() is safe (application/json content-type)",
            "res.send() with strings is potentially vulnerable",
            "EJS templates do NOT auto-escape by default - use <%- %> vs <%= %>",
            "Handlebars auto-escapes with {{ }} but not {{{ }}}",
        ],
        "sqli": [
            "Parameterized queries with ? placeholders are safe",
            "Sequelize ORM queries are parameterized by default",
            "String concatenation in SQL queries is vulnerable",
        ],
    },
    "react": {
        "xss": [
            "JSX auto-escapes all embedded expressions by default",
            "dangerouslySetInnerHTML explicitly bypasses escaping",
            "href attributes with javascript: protocol are vulnerable",
        ],
    },
    "nextjs": {
        "xss": [
            "React JSX auto-escaping applies in Next.js",
            "Server Components render on server - different attack surface",
            "API routes should validate input explicitly",
        ],
        "ssrf": [
            "Server-side fetch() in API routes can be SSRF vector",
        ],
    },
}

FRAMEWORK_DETECTION: dict[str, list[str]] = {
    "django": ["django", "django.http", "django.views", "django.db", "django.shortcuts"],
    "flask": ["flask", "Flask"],
    "fastapi": ["fastapi", "FastAPI"],
    "express": ["express", "require('express')", "require(\"express\")"],
    "react": ["react", "React"],
    "nextjs": ["next", "next/"],
}

SAFE_DECORATORS: dict[str, list[str]] = {
    "django": ["@login_required", "@permission_required", "@staff_member_required", "@csrf_protect", "@require_http_methods", "@require_POST", "@require_GET"],
    "flask": ["@login_required", "@roles_required", "@fresh_login_required"],
    "fastapi": ["Depends(", "@app.middleware"],
}

TYPE_COERCION_SANITIZERS: list[str] = [
    "int(", "float(", "bool(", "str(int(", "str(float(",
    "parseInt(", "parseFloat(", "Number(",
]
