"""
Lambda Proxy HTTP para Action Groups de Bedrock.

Esta Lambda es un puente generico entre Bedrock Agents y cualquier API REST externa.
Bedrock no puede llamar APIs HTTP directamente, necesita una Lambda como intermediario.

Flujo:
  Agente razona -> Action Group se activa -> Invoca esta Lambda ->
  Lambda hace HTTP request a BASE_URL + apiPath -> Retorna respuesta al agente

Variables de entorno:
  BASE_URL    - URL base de la API del cliente (ej: https://api.kroni.io)
  API_KEY     - (opcional) API key para autenticacion
  AUTH_HEADER - (opcional) Header de autenticacion personalizado (default: Authorization)
"""

import os
import json
import urllib3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext

logger = Logger()
http = urllib3.PoolManager()

BASE_URL = os.getenv("BASE_URL", "")
API_KEY = os.getenv("API_KEY", "")
AUTH_HEADER = os.getenv("AUTH_HEADER", "Authorization")


def lambda_handler(event: dict, context: LambdaContext):
    logger.info("Event received", extra={"event": event})

    # Extraer info del evento de Bedrock Action Group
    action_group = event.get("actionGroup", "")
    api_path = event.get("apiPath", "")
    http_method = event.get("httpMethod", "GET").upper()
    parameters = event.get("parameters", [])
    request_body = event.get("requestBody", {})

    try:
        # Construir la URL: BASE_URL + apiPath
        url = f"{BASE_URL}{api_path}"

        # Construir headers
        headers = {"Content-Type": "application/json"}
        if API_KEY:
            headers[AUTH_HEADER] = f"Bearer {API_KEY}"

        # Hacer el HTTP request segun el metodo
        if http_method == "GET":
            query_params = {p["name"]: p["value"] for p in parameters}
            if query_params:
                qs = "&".join(f"{k}={v}" for k, v in query_params.items())
                url = f"{url}?{qs}"
            response = http.request("GET", url, headers=headers)

        elif http_method in ("POST", "PUT", "PATCH"):
            body = {}
            if request_body:
                content = request_body.get("content", {})
                json_content = content.get("application/json", {})
                properties = json_content.get("properties", [])
                body = {p["name"]: p["value"] for p in properties}
            if not body and parameters:
                body = {p["name"]: p["value"] for p in parameters}
            response = http.request(
                http_method, url, headers=headers,
                body=json.dumps(body).encode("utf-8")
            )

        elif http_method == "DELETE":
            response = http.request("DELETE", url, headers=headers)

        else:
            raise ValueError(f"HTTP method not supported: {http_method}")

        response_data = response.data.decode("utf-8")
        status_code = response.status
        logger.info(f"API response: status={status_code}")

        # Retornar en el formato que Bedrock Action Group espera
        return {
            "messageVersion": "1.0",
            "response": {
                "actionGroup": action_group,
                "apiPath": api_path,
                "httpMethod": http_method,
                "httpStatusCode": status_code,
                "responseBody": {
                    "application/json": {
                        "body": response_data
                    }
                }
            }
        }

    except Exception as e:
        logger.error(f"Error calling external API: {str(e)}")
        return {
            "messageVersion": "1.0",
            "response": {
                "actionGroup": action_group,
                "apiPath": api_path,
                "httpMethod": http_method,
                "httpStatusCode": 500,
                "responseBody": {
                    "application/json": {
                        "body": json.dumps({"error": str(e)})
                    }
                }
            }
        }
