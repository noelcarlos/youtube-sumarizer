# Pruebas de rendimiento — SummarizeStage (resumen)

Todas las pruebas usan el prompt exacto de `SummarizeStage.buildPrompt()` contra oMLX
(`http://localhost:1234`), un modelo a la vez (correr dos en paralelo compite por memoria/CPU
y contamina los tiempos — no repetir ese error).

## Documento largo (referencia): `MGxcosNuC8k` — "Andrew Huberman: The 10 Protocols for Human Performance"
- Transcript: 454.612 caracteres / ~107.968 tokens de prompt.

| Modelo | Tiempo total | Formato | Calidad |
|---|---|---|---|
| `gemma-4-12B-it-qat-oQ4e-mtp` | **18 min 25s** (1105s) | `TITLE:/LANGUAGE:/SUMMARY:` perfecto | Excelente — resumen extenso y fiel (cortisol, hidratación, ejercicio, frío, sueño, nutrición, péptidos...), sin alucinaciones. 934 tokens de salida. |
| `gemma-4-12B-agentic-fable5-composer2.5-v2-nvfp4` | 27 min 41s (1661s) — el más lento | `TITLE:/LANGUAGE:/SUMMARY:` correcto | **Mala** — degenera en bucle de repeticion (el mismo parrafo casi textual 3 veces) y termina con texto corrupto a media palabra ("...10,0an a good idea."). No usar para documentos largos completos. |
| `Qwen3.6-35B-A3B-oQ4e-mtp` | **12 min 44s** (764s) — el más rápido | `TITLE:/LANGUAGE:/SUMMARY:` perfecto | Excelente, más completo que gemma-it: 10 protocolos numerados con mecanismos especificos, dosis de suplementos, sin truncar (105.727 prompt + 5.171 salida = 110.898/128.000) |
| `gemma-4-12B-TurboQuant-MLX-4bit` | descartado | roto | vacío en chunk1, respuesta ajena a la tarea en chunk2, reproducible — no usar |

## Chunks (~12.000 caracteres, tamaño real que usa RewriteStage)

| Modelo | Tiempo/chunk | Formato | Calidad |
|---|---|---|---|
| `gemma-4-12B-it-qat-oQ4e-mtp` | 16-37s | Correcto | Estructurado (headings + bullets), fiel |
| `gemma-4-12B-agentic-fable5-composer2.5-v2-nvfp4` | 19-36s | Correcto | Prosa fiel, menos estructurada |
| `gemma-4-12B-TurboQuant-MLX-4bit` | — | Roto | Descartado |
| `LFM2.5-1.2B-Instruct-MLX-6bit` | rápido | Roto en Rewrite (echo del prompt), formato inconsistente en Summarize (~50% falla) | No usar en Rewrite |

## Conclusión

- **Para Summarize con el documento completo (un solo transcript entero, sin trocear): `Qwen3.6-35B-A3B-oQ4e-mtp`** — el más rápido (12:44) Y el más completo/coherente de los tres. Ganador claro.
- **`gemma-4-12B-it-qat-oQ4e-mtp`** es la alternativa segura si Qwen no está disponible — más lento (18:25) pero fiable, sin degradación.
- **`gemma-4-12B-agentic-fable5-composer2.5-v2-nvfp4` NO sirve a esta escala** — a pesar de ir perfecto en chunks de 12k, con el documento entero (~108k tokens) degenera en bucles de repetición y termina con texto corrupto. Sí es una opción válida para Rewrite (que trabaja en chunks, no con el documento entero).
- `gemma-4-12B-TurboQuant-MLX-4bit` descartado por completo, roto en cualquier escala.

## Map-reduce (post-fix de deduplicación de rolling captions)

Con `collapseRollingCaptions` implementado, el documento de referencia real son **155.105 caracteres**
deduplicados (no 454.612 — ver hallazgo de Opus sobre triplicación de subtítulos). El peor caso
histórico entre los 148 vídeos descargados es `Lf5oqGOCRCM` con **177.061 caracteres** deduplicados.

**Test contaminado (documento MGxcosNuC8k, 155.105 chars)**: `Qwen3.6-35B-A3B-oQ4e-mtp`, map-reduce,
14 chunks + 1 reduce plano, 17min 26s — descartado, corrido sin comprobar carga de la máquina ni
pedir permiso, con otra actividad en paralelo (vídeo 4K + probablemente otro proceso usando el
modelo). Resultado (15.696 chars, 9 temas, sin degeneración) probablemente sí representativo en
calidad, el tiempo no.

**Test limpio (peor caso real, `Lf5oqGOCRCM`, 177.061 chars)** — máquina confirmada libre antes de
arrancar, un modelo a la vez, sin nada en paralelo:

| Modelo | Estrategia | Tiempo | Resultado |
|---|---|---|---|
| `Qwen3.6-35B-A3B-oQ4e-mtp` | map-reduce, **15 chunks** de 12.000 chars + 1 reduce plano | **14min 20s** (860s) | 10.013 caracteres, organizado por tema ("Financial Realities & Capex Cycle"...), sin mencionar "parte 1/parte 2", muy grounded (cifras concretas: pérdida $20,9B OpenAI, $1,1T compromisos cloud, capex $175B/$115B Microsoft), sin degeneración. |

## Barrido de tamaño de chunk (Qwen, mismo documento, mismo método limpio)

Opus predijo (con datos de sus logs de servidor) que agrandar el chunk del map NO ayudaría — que
el coste es por volumen de decode, no por overhead fijo de llamada, y que el prefill se degrada
con contexto grande, cancelando cualquier ahorro. El usuario no se lo creyó y pidió comprobarlo en
la práctica. Metodología: `SummarizeStage.mapChunkChars`/`mapBulletCap` overrides (bullets escalados
proporcionalmente, ~1 bullet por 1.000 chars, para no perjudicar a los chunks grandes con un tope de
12 fijo), calentamiento con "Hello world" antes de cada medición para que la carga en frío no cuente,
**y reinicio completo del servidor entre cada tamaño** (para descartar caché de prefijo de prompt
entre tandas — el primer intento con 24.000 salió sospechosamente rápido sin reiniciar, así que se
repitió limpio y salió AÚN más rápido, descartando la caché como explicación).

| Chunk | Chunks | Bullets/chunk | Tiempo total |
|---|---|---|---|
| 12.000 | 15 | 12 | 878s |
| 24.000 | 8 | 24 | 636s |
| 48.000 | 4 | 48 | 751s |
| **92.000** | **2** | **92** | **509s** ← el más rápido |

**Veredicto: la predicción de Opus queda refutada por estos datos.** De 12K a 92K el tiempo total
bajó un 42% (878s → 509s), con menos llamadas y menos "pensamiento"/instrucciones repetidas por
llamada — justo el mecanismo que Opus descartó. La curva no es perfectamente monótona (48K salió
peor que 24K), pero la tendencia general con chunks grandes es clara.

**Aplicado en producción**: `SUMMARIZE_MAP_CHUNK_CHARS = 92_000` (era `TRANSCRIPT_CHUNK_CHARS =
12_000`, compartida con Rewrite). **Importante**: esta subida NO se aplicó a `RewriteStage` — su
propio sweep (documentado en el código) ya mostraba colapso en repetición a partir de 32.000 chars
para reescritura 1:1, un mecanismo de fallo distinto al de Summarize (Rewrite escala el output con
el input, Summarize no). Las dos etapas ahora tienen constantes separadas y explícitas
(`REWRITE_CHUNK_CHARS = 12_000`, sin cambios; `SUMMARIZE_MAP_CHUNK_CHARS = 92_000`) en vez de
compartir una por coincidencia — verificado que `RewriteStage` sigue dando 15 chunks sobre
`Lf5oqGOCRCM` tras el cambio.

Pendiente: repetir el barrido con al menos otro modelo para confirmar que 92.000 no es un efecto
específico de Qwen (podría no generalizar, o el óptimo real podría estar más arriba — no probamos
por encima de 92K). Lista pendiente de la ronda anterior (un modelo a la vez, con pausa para que el
usuario recargue): `Ling-3.0-tiny-oQ4e`, `NVIDIA-Nemotron-3.5-Lightning-30B-A3B-oQ4-mtp`,
`gemma-4-12B-it-qat-oQ4e-mtp`. Opcionales: `gemma-4-12B-agentic-fable5-composer2.5-v2-nvfp4`,
`Qwen3.6-11B-A3B-Niwaki-4bit-mlx`, `Ornith-1.5-35B-A3B-OptiQ-4bit-REAP-19B`.

**Aún pendiente**: comparar map-reduce (mejor chunk encontrado) vs. llamada única a 60.000-180.000
chars en este mismo documento, para saber si de verdad hace falta trocear el peor caso real una vez
quitada la triplicación.

## Modelos pendientes de registrar/probar
- `Ling-3.0-tiny-oQ4e` (131.072 de contexto) — descargado, aún sin probar.

## Palancas del map-reduce, por ventana de contexto (tabla de Opus)

Configurado en `resumir_video.js` para **64K** (los valores en negrita son los activos ahora mismo).
Solo `SUMMARIZE_SINGLE_CALL_MAX_CHARS` y `SUMMARIZE_OUTLINE_THRESHOLD_CHARS` escalan con la ventana —
`TRANSCRIPT_CHUNK_CHARS` y `SUMMARIZE_MAP_OVERLAP_CHARS` NO, están limitados por el presupuesto de
bullets del prompt del map (12 bullets por chunk), no por la memoria disponible.

| Ventana | `SUMMARIZE_SINGLE_CALL_MAX_CHARS` | `TRANSCRIPT_CHUNK_CHARS` | `SUMMARIZE_MAP_OVERLAP_CHARS` | `SUMMARIZE_OUTLINE_THRESHOLD_CHARS` |
|---|---|---|---|---|
| **64K** | **60.000** | **12.000** | **600** | **30.000** |
| 96K | 72.000 | 12.000 | 600 | 35.000 |
| 128K | 80.000 | 12.000 | 600 | 40.000 |
| 256K | 80.000 (no sube) | 12.000 | 600 | 40.000 (no sube) |

Por qué no sube más allá de 128K: el límite real no es la ventana (el techo aritmético a 128K son
~320.800 chars, muy por encima de 80.000) — es la degeneración del modelo en textos muy largos, que
no se ha probado más allá de ~108k tokens (y ese test fue sobre texto SIN deduplicar, un caso peor
del que ya no existe tras el fix). Fila defensiva para ventanas por debajo de 64K, si hiciera falta:
32K → `24.000 / 10.000 / 500 / 18.000` (aquí sí empieza a ser la ventana el limitante real, no la
fiabilidad del modelo).

`LOCAL_CONTEXT_WINDOW_TOKENS` (env, default 64.000) es lo que usa la comprobación de arranque en
`resumir_video.js` para avisar si `SUMMARIZE_SINGLE_CALL_MAX_CHARS` no cabe con margen — hay que
mantenerlo sincronizado a mano con lo que de verdad esté configurado en oMLX, no hay forma de leerlo
en caliente desde aquí.
