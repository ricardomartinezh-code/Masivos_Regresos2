#!/usr/bin/env python3
"""
convert_costos.py
Convierte el archivo 'Costos 2025.xlsx' al formato JSON esperado por index.js
"""

import pandas as pd
import json
import sys
from pathlib import Path

# ==== CONFIGURACIÓN ====
EXCEL_FILE = "Costos 2025.xlsx"   # nombre del archivo fuente
SHEET_NAME = "Becas"              # hoja donde están los costos
OUTPUT_JSON = Path("data/costos.json")  # salida final

# ==== LECTURA DEL EXCEL ====
try:
    df = pd.read_excel(EXCEL_FILE, sheet_name=SHEET_NAME, header=None)
except Exception as e:
    print(f"❌ Error leyendo Excel: {e}")
    sys.exit(1)

records = []

# ==== PARSEO ====
# El Excel que me compartiste trae las columnas:
# Nivel, Modalidad, Plan (9, 11, etc.), % Beca (con rango), Monto
# Aquí convertimos cada fila en un dict.

for i in range(len(df)):
    row = df.iloc[i].dropna().tolist()
    if len(row) < 3:
        continue

    # ejemplo: ['Licenciatura', 'Presencial', '11', 'Promedio 8-8.9 → 20%', 2800]
    nivel = str(row[0]).strip().lower()
    modalidad = str(row[1]).strip().lower()
    plan = str(row[2]).strip()

    # porcentaje puede venir con texto tipo "8.0–8.9 = 20%"
    porcentaje = str(row[3]).strip() if len(row) > 3 else ""
    monto = float(row[4]) if len(row) > 4 else None

    # normalizamos nombres
    if "online" in modalidad:
        modalidad = "online"
    elif "presencial" in modalidad:
        modalidad = "presencial"

    if "prepa" in nivel or "bachillerato" in nivel:
        nivel = "preparatoria"
    elif "lic" in nivel:
        nivel = "licenciatura"
    elif "maestr" in nivel or "pos" in nivel:
        nivel = "maestria"
    elif "salud" in nivel:
        nivel = "salud"

    records.append({
        "nivel": nivel,
        "modalidad": modalidad,
        "plan": plan,
        "porcentaje": porcentaje,
        "monto": monto
    })

# ==== GUARDADO ====
OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
    json.dump(records, f, ensure_ascii=False, indent=2)

print(f"✅ Convertido: {len(records)} registros -> {OUTPUT_JSON}")
