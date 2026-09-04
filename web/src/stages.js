// Espejo de STAGE_ORDER/STAGE_LABEL en server.js — si se anade una etapa alli, tambien aqui.
export const STATIONS = ['DOWNLOAD', 'AI_SUMMARIZE', 'INTERPRET_SUMMARY', 'EMAIL'];

export const STATION_LABEL = {
  DOWNLOAD: 'descarga',
  AI_SUMMARIZE: 'resumen (ia)',
  INTERPRET_SUMMARY: 'interpretar',
  EMAIL: 'email',
};

export const TABS = [
  { key: 'ALL', label: 'Todos' },
  { key: 'DOWNLOAD', label: 'Descarga' },
  { key: 'AI_SUMMARIZE', label: 'Resumen IA' },
  { key: 'INTERPRET_SUMMARY', label: 'Interpretar' },
  { key: 'EMAIL', label: 'Email' },
  { key: 'DONE', label: 'Terminado' },
  { key: 'ERROR', label: 'Error' },
];

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

export function isProcessing(video) {
  return video.bucket !== 'error' && video.stage !== 'DONE' && stationClasses(video).includes('active');
}

export function currentLabel(video) {
  if (video.stage === 'DONE') return 'enviado';
  const base = STATION_LABEL[video.stage] || video.stage.toLowerCase();
  return video.bucket === 'error' ? `${base} — falló` : base;
}
