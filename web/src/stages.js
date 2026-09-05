// Orden REAL del pipeline (para calcular done/pending) — espejo de STAGE_ORDER en server.js.
// SUMMARIZE y REWRITE en realidad corren en PARALELO (las dos leen el mismo download/output a
// la vez, cada una con su propio modelo), no una detras de otra — pero un video solo puede
// tener UN "stage actual" en /api/state (el que todavia no ha terminado de las dos), asi que
// tratarlas como dos casillas seguidas aqui es una simplificacion razonable: si UNA termina
// antes que la otra, su segmento se queda pintado "pending" hasta que la otra tambien termine,
// en vez de mostrarse ya "done" por separado. Los textos ya NO viven aqui (antes estaban en
// español a pelo) — esto solo expone claves, la traduccion la hace cada componente con
// useTranslations() contra messages/es.json|en.json.
export const PIPELINE_ORDER = ['DOWNLOAD', 'SUMMARIZE', 'REWRITE', 'INTERPRET_SUMMARY', 'EMAIL'];

// Orden VISUAL (tabs y segmentos de la barra de progreso) — al reves del pipeline real, a
// peticion: lo mas cercano a terminar se ve primero. stationClasses() traduce cada entrada de
// aqui a su posicion real en PIPELINE_ORDER para pintar done/pending correctamente sin importar
// en que orden se muestren.
export const STATIONS = ['EMAIL', 'INTERPRET_SUMMARY', 'REWRITE', 'SUMMARIZE', 'DOWNLOAD'];

// Stage constante -> clave del namespace "Stages"/"StageLabel" en los .json de mensajes.
export const STAGE_MESSAGE_KEY = {
  DOWNLOAD: 'download',
  SUMMARIZE: 'summarize',
  REWRITE: 'rewrite',
  INTERPRET_SUMMARY: 'interpretSummary',
  EMAIL: 'email',
  DONE: 'done',
};

export const TABS = ['ALL', 'EMAIL', 'INTERPRET_SUMMARY', 'REWRITE', 'SUMMARIZE', 'DOWNLOAD', 'DONE', 'ERROR'];

export function matchesTab(video, tabKey) {
  if (tabKey === 'ALL') return true;
  if (tabKey === 'ERROR') return video.bucket === 'error';
  return video.stage === tabKey;
}

export function stationClasses(video) {
  const doneAll = video.stage === 'DONE';
  const currentIdx = PIPELINE_ORDER.indexOf(video.stage);
  return STATIONS.map((stationKey) => {
    if (doneAll) return 'done';
    const idx = PIPELINE_ORDER.indexOf(stationKey);
    if (idx < currentIdx) return 'done';
    if (idx === currentIdx) return video.bucket === 'error' ? 'errored' : 'active';
    return 'pending';
  });
}

/** `video.processing` viene de server.js, que sabe cual video es el que su worker esta corriendo
 * de verdad ahora mismo (ver activeInfoFor en server.js) — antes esto se adivinaba mirando solo
 * la etapa/bucket, y por eso 4 videos esperando turno en la misma carpeta se pintaban los 4 como
 * "procesando" cuando en realidad el worker solo trabaja en uno a la vez. */
export function isProcessing(video) {
  return Boolean(video.processing);
}

/** Los que estan en la MISMA etapa que uno activo pero no son ESE video — a la espera de que el
 * worker les llegue el turno, no procesando nada todavia. */
export function isQueued(video) {
  return !video.processing && video.bucket !== 'error' && video.stage !== 'DONE' && stationClasses(video).includes('active');
}

/** Devuelve la clave de StageLabel a usar ('sent' o la etapa actual) y si hay que componerla
 * con el sufijo de fallo — la interpolacion real ("{stage} — falló") la hace el componente con
 * t('StageLabel.failedSuffix', {stage}), para que el orden de palabras lo decida cada idioma. */
export function currentLabelKey(video) {
  if (video.stage === 'DONE') return { key: 'sent', failed: false };
  const key = STAGE_MESSAGE_KEY[video.stage] || video.stage.toLowerCase();
  return { key, failed: video.bucket === 'error' };
}
