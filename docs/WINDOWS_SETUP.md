# Setup en Windows — Pizza Demo Auditor (paso a paso)

> Guía completa para correr el MCP server en una máquina Windows desde cero.
> Seguí los pasos en orden. Cada bloque de comandos es para **PowerShell**
> (la terminal azul de Windows — buscá "PowerShell" en el menú inicio).

---

## 0. Qué vas a necesitar

- Una PC con Windows 10 u 11.
- La connection string de la Supabase de Pizza Demo (la armamos abajo).
- ~20 minutos.

---

## 1. Instalar Bun

Bun es el runtime que corre el server. En **PowerShell**:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

**Cerrá PowerShell y abrí una ventana NUEVA** (para que tome el cambio de PATH). Verificá:

```powershell
bun --version
```

Si imprime un número (ej. `1.3.x`), está OK. Si dice "no se reconoce", reiniciá la PC y reintentá.

---

## 2. Instalar Git (si no lo tenés)

```powershell
winget install --id Git.Git -e
```

Cerrá y abrí PowerShell de nuevo. Verificá:

```powershell
git --version
```

---

## 3. Traer el código a la PC

Tenés **dos opciones**. Elegí una.

### Opción A — Copiar la carpeta (más simple si no usás GitHub)

1. En tu Mac, copiá la carpeta `mcpserver` COMPLETA a un USB o a tu nube (Drive, OneDrive, etc.).
   - **IMPORTANTE:** NO copies la subcarpeta `node_modules` (es enorme y específica de cada sistema operativo — se regenera en Windows). Sí copiá todo lo demás, incluido `.env.local`.
2. En Windows, pegá la carpeta donde quieras, por ejemplo en `C:\Users\TU_USUARIO\Desktop\mcpserver`.
3. En PowerShell, entrá a la carpeta:

```powershell
cd C:\Users\TU_USUARIO\Desktop\mcpserver
```

### Opción B — Vía GitHub (recomendado si vas a trabajar en las 2 máquinas)

Primero, **en tu Mac**, subí el repo a un GitHub privado (una sola vez):

```bash
# En la Mac, dentro de ~/Desktop/mcpserver:
git add .
git commit -m "MCP auditor v1"
# Creá un repo privado en github.com llamado "mcpserver", después:
git remote add origin git@github.com:TU_USUARIO_GITHUB/mcpserver.git
git push -u origin main
```

Después, **en Windows**:

```powershell
cd C:\Users\TU_USUARIO\Desktop
git clone https://github.com/TU_USUARIO_GITHUB/mcpserver.git
cd mcpserver
```

> Con la Opción B, el `.env.local` NO viaja (está en .gitignore, y así debe ser — tiene la
> contraseña). Lo vas a crear a mano en el Paso 5.

---

## 4. Instalar las dependencias

Dentro de la carpeta `mcpserver` en PowerShell:

```powershell
bun install
```

Esto baja el SDK de MCP, el driver de Postgres y Zod. Tarda ~1 min.

---

## 5. Configurar la conexión (`.env.local`)

Si copiaste la carpeta con la Opción A y trajiste el `.env.local`, **saltá al Paso 6**.

Si usaste GitHub (Opción B) o no tenés el `.env.local`, crealo:

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

En el Notepad que se abre, dejá la línea `DATABASE_URL` así (reemplazá `TU_PASSWORD`
por la contraseña del rol `mcp_auditor` — es la misma que pusiste en el `ALTER ROLE`
en Supabase; la tenés en el `.env.local` de tu Mac):

```
DATABASE_URL=postgres://mcp_auditor.oqkhzqgvofqkjbgreoli:TU_PASSWORD@aws-1-us-east-1.pooler.supabase.com:5432/postgres

LOG_LEVEL=info
```

Guardá (Ctrl+S) y cerrá el Notepad.

> **Recordá:** la contraseña tiene que ser **solo letras y números** (sin `+ * @ / #` etc.),
> porque los símbolos rompen la URL de conexión. Si la tuya tiene símbolos, cambiala en
> Supabase con `ALTER ROLE mcp_auditor PASSWORD 'soloLetrasYNumeros';` y usá esa.

---

## 6. Probar la conexión

```powershell
bun run check-db
```

- **Dos ✅** (conexión OK + total de pedidos) → la conexión anda. Seguí al Paso 7.
- **❌ `password authentication failed`** → la contraseña no coincide o tiene símbolos. Revisá el Paso 5.
- **❌ después de varios intentos seguidos** → es el "circuit breaker" de Supabase (bloquea tu IP ~2 min tras intentos fallidos). **Esperá 5 minutos sin correr nada** y probá UNA sola vez.

---

## 7. Conectar a Claude Code

### Opción rápida (recomendada) — comando

En PowerShell, una sola línea (ajustá la ruta si pusiste la carpeta en otro lado):

```powershell
claude mcp add pizza-demo-auditor -s user -- bun --env-file=C:/Users/TU_USUARIO/Desktop/mcpserver/.env.local run C:/Users/TU_USUARIO/Desktop/mcpserver/src/index.ts
```

> Usá **barras normales `/`** en las rutas aunque sea Windows — Bun las entiende y evitás
> problemas de escape con `\`.

### Opción manual — editar el JSON

El archivo de config en Windows está en `C:\Users\TU_USUARIO\.claude.json`. Abrilo:

```powershell
notepad $env:USERPROFILE\.claude.json
```

Agregá la key `mcpServers` al nivel superior (hermana de las demás keys; **ojo con la coma**):

```json
{
  "mcpServers": {
    "pizza-demo-auditor": {
      "command": "bun",
      "args": [
        "--env-file=C:/Users/TU_USUARIO/Desktop/mcpserver/.env.local",
        "run",
        "C:/Users/TU_USUARIO/Desktop/mcpserver/src/index.ts"
      ]
    }
  }
}
```

> El flag `--env-file` con ruta absoluta es **obligatorio**: Claude Code lanza el server
> desde otra carpeta y sin esto no encuentra el `.env.local` (el server muere con
> "DATABASE_URL no está seteado").

---

## 8. Verificar y usar

1. **Reiniciá Claude Code** (cerralo y abrilo).
2. Confirmá que quedó registrado:

```powershell
claude mcp list
```

Debería aparecer `pizza-demo-auditor`.

3. Probalo escribiéndole en español, sin mencionar las tools:

```
auditá la última semana de Pizza Demo
```

Claude elige las herramientas, lee los datos y te responde. Otros ejemplos:
- *"¿hubo silencios en horario pico este mes?"*
- *"mostrame los pedidos de hoy agrupados por método de pago"*
- *"comparame esta semana con la anterior"*

---

## 9. Rutina diaria (después del setup)

Cada vez que quieras usarlo, no hace falta hacer nada — Claude Code levanta el server solo.
Solo asegurate de que la PC tenga internet (para llegar a Supabase).

Si actualizaste el código (Opción B con GitHub):

```powershell
cd C:\Users\TU_USUARIO\Desktop\mcpserver
git pull
bun install
```

---

## 10. Troubleshooting (los problemas que ya conocemos)

| Síntoma | Causa | Fix |
|---|---|---|
| `bun no se reconoce` | PATH no actualizado | Cerrá/abrí PowerShell o reiniciá la PC |
| `DATABASE_URL no está seteado` | Falta `--env-file` en el config, o falta `.env.local` | Revisá Paso 5 y 7 |
| `password authentication failed` | Password mal o con símbolos | Paso 5: usá password alfanumérico, mismo en Supabase y en `.env.local` |
| Falla tras varios intentos seguidos | Circuit breaker de Supabase (~2 min de bloqueo) | Esperá 5 min, probá UNA vez |
| `claude mcp list` no muestra el server | JSON mal editado o no reiniciaste | Usá el comando del Paso 7 en vez de editar a mano; reiniciá Claude Code |
| `relation "orders" does not exist` | El rol `mcp_auditor` no tiene los GRANT | Re-corré los `GRANT SELECT` del README §Setup en Supabase |
| Conexión muy lenta o timeout | Red IPv4 + conexión directa | Ya estás usando el pooler (`aws-1-...pooler`), que es IPv4 — debería andar |

---

## Referencias

- Setup general (Mac/Linux/Windows): [README.md](../README.md)
- Qué hace cada tool y por qué: [PRD.md](PRD.md)
- Reglas de código: [RULES.md](RULES.md)
- Historial de decisiones: [ENGRAM.md](ENGRAM.md)
