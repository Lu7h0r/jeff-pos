#!/usr/bin/env python3
"""
FinOpenPOS Jeff — UserPromptSubmit hook.

Infers intent from the prompt and injects matching context modules
from .claude/context/*.md as additionalContext.

Never blocks. Falls back to no-op if intent map is missing.
"""

import json
import os
import sys

HOOK_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HOOK_DIR))
INTENT_MAP_PATH = os.path.join(PROJECT_ROOT, ".claude", "jeff-intent-map.json")
MAX_BYTES = 40_000


def load_payload():
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def infer_intent(prompt):
    lowered = prompt.lower()
    if any(w in lowered for w in ("deploy", "prod", "produccion", "producción", "docker", "vps", "server", "servidor", "devir-server")):
        return "deploy"
    if any(w in lowered for w in ("arquitectura", "architecture", "refactor", "estructura")):
        return "architecture"
    if any(w in lowered for w in ("bug", "fix", "corregir", "error", "falla", "broken", "roto", "no funciona")):
        return "fix"
    if any(w in lowered for w in ("schema", "tabla", "columna", "migración", "migracion", "drizzle", "db")):
        return "schema"
    if any(w in lowered for w in ("orden", "venta", "sale", "order", "caja", "cash", "turno", "cobro", "pago", "payment")):
        return "sale"
    if any(w in lowered for w in ("inventario", "inventory", "stock", "balance", "movimiento")):
        return "inventory"
    if any(w in lowered for w in ("staff", "comision", "comisión", "commission", "artista", "artist", "estación", "estacion", "workstation", "alquiler", "rental")):
        return "staff"
    if any(w in lowered for w in ("frontend", "ui", "componente", "component", "página", "pagina", "shadcn", "tailwind", "react")):
        return "frontend"
    if any(w in lowered for w in ("test", "bun test", "spec", "qa", "coverage")):
        return "test"
    if any(w in lowered for w in ("auth", "login", "cookie", "sesión", "sesion", "sanctum", "better-auth")):
        return "auth"
    return "default"


def load_modules(intent, intent_map):
    entry = intent_map.get(intent) or intent_map.get("default") or {}
    modules = entry.get("modules", [])
    hint = entry.get("hint")
    loaded = []
    total = 0
    for rel in modules:
        full_path = os.path.join(PROJECT_ROOT, rel)
        if not os.path.isfile(full_path):
            continue
        try:
            body = open(full_path, encoding="utf-8").read()
        except OSError:
            continue
        block = f"\n--- jeff-context: {rel} ---\n{body}"
        if total + len(block) > MAX_BYTES:
            break
        loaded.append(block)
        total += len(block)
    return loaded, hint


def main():
    payload = load_payload()
    prompt = str(payload.get("prompt", ""))

    if not os.path.isfile(INTENT_MAP_PATH):
        json.dump({"continue": True}, sys.stdout)
        sys.stdout.write("\n")
        return 0

    try:
        intent_map = json.load(open(INTENT_MAP_PATH, encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        json.dump({"continue": True}, sys.stdout)
        sys.stdout.write("\n")
        return 0

    intent = infer_intent(prompt)
    modules, hint = load_modules(intent, intent_map)

    lines = [f"JeffIntent: {intent}"]
    if hint:
        lines.append(f"JeffHint: {hint}")
    if modules:
        lines.append("\n## Jeff Context Modules:")
        lines.extend(modules)

    context = "\n".join(lines)

    json.dump(
        {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context,
            },
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
