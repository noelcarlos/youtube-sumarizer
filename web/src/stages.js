// Espejo de STAGE_ORDER en server.js — si se anade una etapa alli, tambien aqui. Los textos ya
// NO viven aqui (antes estaban en español a pelo) — esto solo expone claves, la traduccion la
// hace cada componente con useTranslations() usando esas claves contra messages/es.json|en.json.
export const STATIONS = ['DOWNLOAD', 'AI_SUMMARIZE', 'INTERPRET_SUMMARY', 'EMAIL'];

// Stage constante -> clave del namespace "Stages"/"StageLabel" en los .json de mensajes.
export const STAGE_MESSAGE_KEY = {
  DOWNLOAD: 'download',
  AI_SUMMARIZE: 'aiSummarize',
  INTERPRET_SUMMARY: 'interpretSummary',
  EMAIL: 'email',
  DONE: 'done',
};

export const TABS = ['ALL', 'DOWNLOAD', 'AI_SUMMARIZE', 'INTERPRET_SUMMARY', 'EMAIL', 'DONE', 'ERROR'];

export function matchesTab(video, tabKey) {
  if (tabKey === 'ALL') return true;
  if (tabKey === 'ERROR') return video.bucket === 'error';
  return video.stage === tabKey;
}

export function stationClasses(video) {
  const doneAll = video.stage === 'DONE';
  const currentIdx = STATIONS.indexOf(video.stage);
  return STATIONS.map((_, i) => {
    if (doneAll) return 'done';
    if (i < currentIdx) return 'done';
    if (i === currentIdx) return video.bucket === 'error' ? 'errored' : 'active';
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
