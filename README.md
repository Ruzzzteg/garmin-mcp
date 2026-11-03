# garmin-mcp

Servidor MCP remoto que da acceso, en solo lectura, a tus datos de Garmin Connect desde Claude (web, escritorio, móvil y Claude Code) o cualquier cliente MCP. Usa la [Personal API oficial de Garmin](https://developer.garmin.com/gc-developer-program/personal/personal-api): no necesita tu contraseña de Garmin ni hace scraping. Corre en Cloudflare Workers con el [Agents SDK](https://developers.cloudflare.com/agents/) y está protegido con OAuth 2.1.

Cada persona lo despliega en su propia cuenta de Cloudflare con su propia key de Garmin: es un servidor para un único usuario (ver [Despliegue](#despliegue)).

## Índice

- [Cómo funciona](#cómo-funciona)
- [Tools y prompts](#tools-y-prompts)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Configuración](#configuración)
- [Desarrollo local](#desarrollo-local)
- [Tests, CI y evals](#tests-ci-y-evals)
- [Despliegue](#despliegue)
- [Conectar un cliente](#conectar-un-cliente)
- [Operación](#operación)
- [Seguridad](#seguridad)
- [Límites](#límites)
- [Solución de problemas](#solución-de-problemas)

## Cómo funciona

```
Cliente MCP ──OAuth 2.1──▶ Worker garmin-mcp ─┬─ /authorize       página de consentimiento (contraseña del propietario)
(Claude, Cursor…)                              ├─ /token, /register, /.well-known/*   servidor OAuth (OAuthProvider)
                                               └─ /mcp            servidor MCP (Streamable HTTP, sin estado)
                                                                   └─▶ personal.connectapi.garmin.com
```

1. **El cliente se conecta a `/mcp`.** Sin token recibe un `401` que apunta a la metadata OAuth (`/.well-known/oauth-protected-resource/mcp`).
2. **El cliente se registra solo.** Lo hace por registro dinámico (`/register`) o con un Client ID Metadata Document, y abre `/authorize` en el navegador.
3. **Apruebas en la página de consentimiento.** Muestra qué aplicación pide acceso y adónde se enviará el token. Tú introduces `OWNER_PASSWORD` y pulsas *Permitir*. El servidor tiene un único usuario: tú.
4. **El cliente obtiene sus tokens.** Recibe un token de acceso de 1 hora y un token de refresco. El de refresco dura mientras uses el cliente al menos una vez al mes, con un máximo de un año.
5. **El servidor llama a Garmin.** En cada llamada a una tool canjea tu Personal API key por un token de Garmin de 24 h, lo cachea en memoria y en KV y llama a la API.

La key de Garmin nunca sale del Worker: los clientes MCP solo reciben tokens OAuth emitidos por este servidor.

Además de reenviar las llamadas a la API, el servidor adapta las respuestas para que las lea bien un modelo:

- **Rangos largos:** parte los rangos de fechas en las ventanas que admite cada endpoint (28 días para pasos y estrés, 31 para sueño o Body Battery, 1 año para los resúmenes diarios) y une los resultados.
- **Vistas compactas:** la búsqueda de actividades y los históricos de días y sueño devuelven por defecto una fila con las métricas clave; `detail=full` devuelve la respuesta completa de Garmin.
- **Agregación:**
  - Los históricos de días, sueño y pesajes calculan medias por semana o mes (`period`).
  - La búsqueda de actividades da totales por periodo y deporte (`groupBy`). Une los subtipos: calle, trail y cinta cuentan como correr.
- **Salida limpia:**
  - Quita los `null` y el ruido social.
  - Convierte los timestamps epoch a ISO 8601 y redondea los decimales.
  - Deja fuera los arrays de muestras salvo que se pidan (`includeSamples`) y limita cada respuesta a unos 100.000 caracteres.
- **Unidades corregidas:** Garmin manda el peso y la composición corporal en gramos aunque su referencia diga kilos; el servidor los devuelve en kilos.
- **FIT decodificado:** `garmin_get_activity_fit` descarga el ZIP original y lo decodifica con el [SDK oficial de FIT](https://github.com/garmin/fit-javascript-sdk). Devuelve sesiones, vueltas, parciales por km calculados con todos los registros, splits de Garmin, zonas y, si se pide, la serie temporal en formato tabla.
- **Errores accionables:** los fallos de Garmin (key caducada, rango no válido, 429…) llegan al modelo como errores de la tool con instrucciones para corregirlos.
- **"Hoy" en tu zona horaria:** usa `TIMEZONE`. Las instrucciones del servidor incluyen la fecha y el día de la semana.

## Tools y prompts

Hay una tool por cada uno de los 26 endpoints de la Personal API, con todos sus parámetros documentados. Todas son de solo lectura (`readOnlyHint`).

| Tool | Qué devuelve | Endpoint de Garmin |
|---|---|---|
| **Día** | | |
| `garmin_get_daily_summary` | Todo un día: pasos, calorías, pisos, minutos de intensidad, FC, estrés, Body Battery, SpO2, respiración, hidratación | `usersummary/daily` |
| `garmin_get_daily_summaries` | Resumen por día de un rango, o medias por semana o mes | `v2/dailysummaries` |
| `garmin_get_steps` | Pasos, distancia y objetivo por día | `stats/steps/daily` |
| `garmin_get_stress` | Estrés diario (0-100) | `stats/stress/daily` |
| `garmin_get_hydration` | Agua registrada, objetivo y sudoración estimada | `stats/hydration/daily` |
| `garmin_get_heart_rate` | FC de un día: reposo, mín./máx., media de 7 días y, opcionalmente, la serie completa | `wellness/dailyHeartRate` |
| `garmin_get_spo2` | Pulsioximetría de un día y medias por hora | `wellness/daily/spo2acclimation` |
| `garmin_get_body_battery` | Body Battery por día, con `chunks` para mínimo y máximo por intervalo (p. ej. por horas) | `wellness/bodyBattery/reports/daily` |
| **Sueño y HRV** | | |
| `garmin_get_sleep` | Una noche: fases, puntuación, necesidad de sueño, FC, estrés, SpO2 | `sleep/dailySleep` |
| `garmin_get_sleep_history` | Noches de un rango, o medias por semana o mes | `sleep/dailySleepSummariesByDate` |
| `garmin_get_hrv` | HRV nocturna: media, línea base y estado | `hrv-service/hrv/{fecha}` |
| `garmin_get_hrv_history` | HRV por día de un rango | `hrv-service/hrv/daily` |
| **Actividades** | | |
| `garmin_search_activities` | Búsqueda con todos los filtros de Garmin; con `groupBy`, totales por semana, mes o rango y deporte | `activitylist-service/activities/search` |
| `garmin_get_activity` | Resumen completo de una actividad y sus splits | `activity-service/activity/{id}` |
| `garmin_get_activity_workouts` | Entreno estructurado realizado en la actividad | `activity-service/activity/{id}/workouts` |
| `garmin_get_activity_fit` | El FIT decodificado: sesiones, vueltas, parciales por km, zonas y serie temporal | `download-service/files/activity/{id}` |
| `garmin_get_wellness_activities` | Actividades de bienestar de un rango | `wellnessactivity-service/activity/summary/range` |
| **Cuerpo** | | |
| `garmin_get_weight` | Resumen de peso por día, media del rango y pesajes vecinos | `weight-service/weight/range` |
| `garmin_get_weigh_ins` | Cada pesaje con composición corporal, o medias por semana o mes con mínimo y máximo | `weight-service/weight/all` |
| `garmin_get_weight_goals` | Objetivos de peso | `goal-service/goal/user/effective/weightgoal` |
| `garmin_get_fitness_age` | Edad fitness y sus componentes | `fitnessage-service/fitnessage/v2` |
| `garmin_get_heart_rate_zones` | Zonas de FC configuradas por deporte | `biometric-service/heartRateZones/v2` |
| **Otros** | | |
| `garmin_get_nutrition` | Comidas registradas, objetivos y totales | `nutrition-service/food/logs` |
| `garmin_get_menstrual_cycle` | Resumen del ciclo menstrual | `periodichealth-service/menstrualcycle/summary` |
| `garmin_get_menstrual_cycle_day` | Detalle del ciclo de un día | `periodichealth-service/menstrualcycle/dayview` |
| `garmin_get_profile_settings` | Unidades, zona horaria y preferencias del perfil | `userprofile-service/userprofile/settings` |

Prompts (atajos que el cliente muestra como comandos):

- `readiness_check`: ¿cómo estoy hoy para entrenar? Cruza sueño, HRV, Body Battery, FC en reposo, estrés y la carga reciente.
- `training_review`: revisión de las últimas semanas de entreno (volumen, intensidad, recuperación).

## Estructura del repositorio

```
src/
  index.ts              Punto de entrada: OAuthProvider protege /mcp y sirve /authorize
  env.d.ts              Tipos de bindings que añade OAuthProvider en tiempo de ejecución
  auth/authorize.ts     Página de consentimiento: contraseña del propietario y límite de intentos
  garmin/
    client.ts           Cliente de la Personal API: canje de key, caché del token, errores
    dates.ts            Fechas: "hoy" por zona horaria, ventanas de rangos
    fit.ts              Descompresión y decodificación de FIT, parciales por distancia
  mcp/
    server.ts           Servidor MCP: instrucciones, registro de tools y prompts
    context.ts          Esquemas comunes (fechas, rangos) y troceo de rangos
    result.ts           Formato de respuestas: limpieza, timestamps, límite de tamaño, errores
    summaries.ts        Vistas compactas y agregaciones (period, groupBy)
    tools/              Tools por área: daily, sleep, activities, body, profile
test/                   Tests con Vitest dentro de workerd (Garmin simulado)
evals/                  Prompts sintéticos y runner para probar con Claude real
.github/workflows/      CI: typecheck y tests en cada push y PR
wrangler.jsonc          Configuración del Worker: bindings, variables, secretos requeridos
worker-configuration.d.ts  Tipos generados con `pnpm cf-typegen`
```

## Configuración

### Secretos

Están en `.env` en local y como secretos del Worker en producción. Nunca van a git.

| Nombre | Qué es | Dónde obtenerlo |
|---|---|---|
| `GARMIN_API_KEY` | Personal API key de tu cuenta de Garmin Connect. El servidor la canjea por tokens de 24 h. | En [Garmin Connect → Personal API](https://connect.garmin.com/app/settings/personalApiToken), con sesión iniciada en la web: *Create Key*, aceptar los términos y elegir la caducidad (30, 90, 180 días o 1 año). Se muestra **una sola vez**. Solo puede haber una key activa: crear otra exige borrar la anterior. |
| `OWNER_PASSWORD` | Contraseña de la página de consentimiento. Es lo que impide que otra persona conecte un cliente a tu servidor. | Invéntala, larga y aleatoria: `openssl rand -base64 32`. Guárdala en tu gestor de contraseñas: la pedirá cada vez que conectes un cliente nuevo. |

### Variables

Están definidas en `wrangler.jsonc`, en `vars`. No son secretas.

| Nombre | Valor | Para qué |
|---|---|---|
| `GARMIN_REGION` | `global` | `global` usa `personal.connectapi.garmin.com`; `cn` usa la de Garmin Connect China. |
| `TIMEZONE` | `Europe/Madrid` | Zona horaria IANA para resolver "hoy" cuando una tool no recibe fecha. |

### Bindings

| Binding | Tipo | Para qué |
|---|---|---|
| `OAUTH_KV` | KV namespace (`garmin-mcp-oauth-kv`) | Estado de OAuth: clientes registrados, permisos concedidos y tokens (guardados solo como hash, con los datos asociados cifrados). También cachea el token de Garmin para que todas las instancias del Worker lo compartan. |
| `LOGIN_LIMITER` | Rate limiting | Máximo de 5 intentos de contraseña por minuto e IP en la página de consentimiento. |

### Ficheros de entorno

| Fichero | En git | Contenido |
|---|---|---|
| `.env.example` | sí | Plantilla con las claves documentadas y vacías |
| `.env` | no | Tus secretos locales. `wrangler dev` los carga y el despliegue puede subirlos (`--secrets-file .env`). |

## Desarrollo local

Necesitas Node 26 (`fnm use`, lee `.node-version`) y pnpm, en la versión que fija `packageManager`.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Rellena `GARMIN_API_KEY` y `OWNER_PASSWORD` en `.env` y arranca el servidor. Queda en `http://localhost:8787/mcp`:

```bash
pnpm dev
```

Para probarlo a mano tienes dos opciones:

- **MCP Inspector:** arráncalo y conecta a `http://localhost:8787/mcp`. Te llevará a la página de consentimiento.

  ```bash
  pnpm dlx @modelcontextprotocol/inspector
  ```

- **Claude Code**, en la misma máquina:

  ```bash
  claude mcp add --transport http garmin-local http://localhost:8787/mcp
  ```

En local, el KV y el rate limiter son simulados y se guardan en `.wrangler/state`.

Scripts:

| Script | Qué hace |
|---|---|
| `pnpm dev` | Servidor local con recarga en caliente |
| `pnpm check` | Typecheck y tests |
| `pnpm typecheck` | TypeScript de `src/` y `test/` |
| `pnpm test` | Tests con Vitest dentro de workerd |
| `pnpm run deploy` | Despliega a Cloudflare (`pnpm deploy` a secas es otro comando de pnpm) |
| `pnpm cf-typegen` | Regenera `worker-configuration.d.ts` tras cambiar `wrangler.jsonc` |
| `pnpm evals` | Lanza los prompts sintéticos contra un servidor en marcha |

## Tests, CI y evals

- **Tests (`test/`):** corren dentro del runtime de Workers con `@cloudflare/vitest-plugin`, simulando las respuestas de Garmin. Cubren:
  - el cliente de Garmin: canje y caché del token, reintento en 401 y errores;
  - el flujo OAuth completo;
  - el troceo de rangos y los filtros de búsqueda;
  - las vistas compactas, las agregaciones y la conversión a kilos;
  - un FIT real generado con el encoder del SDK.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) ejecuta `pnpm typecheck` y `pnpm test` en cada push a `main` y en cada pull request. No despliega.
- **Evals:** `evals/prompts.json` tiene 25 preguntas realistas: sueño, recuperación, tendencias, entrenos, totales y casos sin datos o fuera de alcance. `evals/run.mjs` las lanza con Claude Code en modo headless contra un servidor en marcha, sin más tools que este MCP. Registra qué tools elige el modelo, los errores, los tamaños y la respuesta. Necesita el CLI de Claude con sesión iniciada. Los resultados contienen tus datos y van a `evals/results/`, fuera de git.

  ```bash
  pnpm evals --base http://localhost:8787 --model sonnet
  ```

## Despliegue

### Qué se despliega

| | |
|---|---|
| Worker | `garmin-mcp`, en tu cuenta de Cloudflare |
| URL del MCP | `https://garmin-mcp.<tu-subdominio>.workers.dev/mcp` (el subdominio `workers.dev` es el de tu cuenta) |
| Raíz (`/`) | JSON con el nombre, la versión y la URL del MCP, útil como comprobación |
| KV | `garmin-mcp-oauth-kv`, creado por el primer despliegue y reutilizado por los siguientes |
| Secretos | `GARMIN_API_KEY`, `OWNER_PASSWORD` (tipo `secret_text`) |
| Observabilidad | Logs de Workers activados (dashboard → Workers & Pages → garmin-mcp → Logs) |
| Preview URLs | Desactivadas: el único origen OAuth es el de producción |
| Cómo se despliega | A mano desde local con `pnpm run deploy`. La CI solo verifica. |

### Primer despliegue

1. Inicia sesión en wrangler (si se queda esperando, mira [Solución de problemas](#solución-de-problemas)):

   ```bash
   pnpm wrangler login
   ```

2. Prepara `.env` con los dos secretos y despliega subiéndolos a la vez:

   ```bash
   pnpm wrangler deploy --secrets-file .env
   ```

3. Wrangler muestra la URL del Worker: añade `/mcp` y [conecta un cliente](#conectar-un-cliente).

### Desplegar cambios

Verifica y despliega. Los secretos y el KV se conservan entre despliegues:

```bash
pnpm check && pnpm run deploy
```

## Conectar un cliente

- **Claude (web, escritorio, móvil):** Ajustes → Conectores → Añadir conector personalizado, con la URL del MCP.
- **Claude Code:**

  ```bash
  claude mcp add --transport http garmin https://garmin-mcp.<tu-subdominio>.workers.dev/mcp
  ```

  Después autentícalo desde `/mcp`.
- **Otros clientes (Cursor, VS Code…):** cualquier cliente MCP con OAuth y transporte Streamable HTTP. Añádelo con la misma URL.

El cliente abre la página de consentimiento: revisa el nombre y el destino que muestra, introduce `OWNER_PASSWORD` y pulsa *Permitir*.

## Operación

- **La key de Garmin caduca:** Garmin envía un email una semana antes. Crea una key nueva (borrando la anterior) y actualiza el secreto. El token de Garmin cacheado deja de valer solo, porque la caché está ligada a la key.

  ```bash
  pnpm wrangler secret put GARMIN_API_KEY
  ```

- **Cambiar la contraseña de consentimiento.** Los clientes ya conectados siguen funcionando hasta que caduquen sus tokens.

  ```bash
  pnpm wrangler secret put OWNER_PASSWORD
  ```

- **Ver logs en directo:**

  ```bash
  pnpm wrangler tail garmin-mcp
  ```

- **Desconectar todos los clientes:** borra el contenido del namespace `garmin-mcp-oauth-kv` desde el dashboard. Tendrán que volver a autorizarse.

## Seguridad

- **Acceso a `/mcp`:** solo con un token OAuth emitido por este servidor para su propia URL y con el scope `garmin:read`.
- **Página de consentimiento:**
  - Muestra el nombre de la aplicación, si está verificada y el host al que se enviará el token, y avisa cuando el destino es una app local.
  - El formulario lleva un identificador de un solo uso ligado al navegador y no se puede incrustar en otra web.
  - La contraseña se compara en tiempo constante y hay un límite de 5 intentos por minuto e IP.
- **Secretos:** la key de Garmin solo vive en los secretos del Worker. Los clientes MCP nunca la ven y no aparece en logs ni en respuestas.
- **Solo lectura:** la Personal API no permite escribir y el servidor solo hace `GET`.
- **Uso personal:** la Personal API es para el titular de la key. Este servidor está pensado para un único usuario y no debe compartirse con terceros.

## Límites

- **Lo que no da la Personal API:** Training Readiness, VO2 max, predicciones de carrera, dispositivos, equipo, rutas, ni subir entrenos. Es de solo lectura y bajo demanda, sin webhooks.
- **Rate limits:** Garmin no publica límites. El servidor hace en serie las peticiones de un rango, y `groupBy` revisa como máximo 1.000 actividades (10 peticiones).
- **CPU:** decodificar un FIT largo consume más de los 10 ms de CPU por petición del plan gratuito de Workers. En producción el FIT más pesado probado usó 157 ms y funcionó.
- **Coste:** el uso de KV y de Workers de un único usuario entra de sobra en el plan gratuito de Cloudflare.

## Solución de problemas

- **`wrangler login` se queda esperando y caduca:** usa el flujo con código. No necesita que el navegador vuelva a `localhost`, y aquí pide solo los permisos necesarios:

  ```bash
  pnpm wrangler login --device --scopes account:read user:read workers:write workers_kv:write workers_scripts:write workers_tail:read
  ```

- **Las tools responden "Garmin rejected the Personal API key":** la key ha caducado o la has borrado. Crea otra y actualiza `GARMIN_API_KEY`.
- **El cliente no puede conectar o pide autorizar otra vez:** su token de refresco caducó (más de un mes sin uso) o se borró el KV. Vuelve a autorizarlo desde el cliente.
- **Dos `wrangler dev` a la vez fallan con `SQLITE_BUSY`:** comparten `.wrangler/state`. Arranca el segundo con su propio estado:

  ```bash
  pnpm dev --port 8788 --persist-to /tmp/garmin-mcp-state
  ```
