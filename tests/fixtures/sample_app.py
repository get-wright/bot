import os
from django.http import JsonResponse, HttpResponse
from django.contrib.auth.decorators import login_required
from django.views.decorators.http import require_http_methods
from django.db import connection

SECRET_KEY = "hardcoded-secret-key-123"


@login_required
@require_http_methods(["GET"])
def safe_user_view(request):
    user_id = int(request.GET.get('id', 0))
    return JsonResponse({"user_id": user_id})


def unsafe_sql_view(request):
    user_name = request.GET.get('name')
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT * FROM users WHERE name = '{user_name}'")
        results = cursor.fetchall()
    return JsonResponse({"results": results})


def safe_orm_view(request):
    from django.contrib.auth.models import User
    name = request.GET.get('name')
    users = User.objects.filter(username=name)
    return JsonResponse({"users": list(users.values())})


def reflected_xss(request):
    user_input = request.args.get('q')
    return make_response(user_input)


def safe_json_response(request):
    data = request.GET.get('data')
    return JsonResponse({"data": data})


def dangerous_exec(request):
    code = request.GET.get('code')
    exec(code)
    return HttpResponse("executed")


def process_data(data):
    validated = validate_input(data)
    return format_output(validated)


def validate_input(data):
    return data.strip()


def format_output(data):
    return f"<div>{data}</div>"
