import { auth } from '../../../../auth.js';

const YT = 'https://www.googleapis.com/youtube/v3';

// Cache en memoria de 5 min por accessToken: evita gastar cuota de la API de YouTube (o
// esperar 1-2s de mas de una tanda de fetches) cada vez que se abre el panel si no ha pasado
// nada nuevo. Vive solo mientras el proceso de `next dev`/`next start` este arriba — no hace
// falta que sobreviva un reinicio, es solo para no repetir trabajo dentro de la misma sesion.
const cache = new Map(); // accessToken -> { at, videos }
const CACHE_MS = 5 * 60 * 1000;

async function ytFetch(path, accessToken) {
  const res = await fetch(`${YT}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `YouTube API HTTP ${res.status}`);
  }
  return res.json();
}

/** subscriptions.list solo trae hasta 50 por pagina — se pide una sola pagina a proposito: para
 * uso personal es mas que de sobra, y no vale la pena la cuota extra de paginar canales que casi
 * nadie revisa. */
async function fetchSubscribedChannelIds(accessToken) {
  const data = await ytFetch('/subscriptions?part=snippet&mine=true&maxResults=50&order=alphabetical', accessToken);
  return (data.items || []).map((it) => it.snippet.resourceId.channelId);
}

/** channels.list acepta hasta 50 ids separados por coma en UNA sola llamada — mucho mas barato
 * en cuota que pedir uno a uno. contentDetails.relatedPlaylists.uploads es la playlist que
 * YouTube mantiene sola con "todo lo que ese canal ha subido", en orden — no hace falta buscar
 * nada con el endpoint `search` (que cuesta 100x mas cuota que `list`). */
async function fetchUploadsPlaylistIds(channelIds, accessToken) {
  if (channelIds.length === 0) return new Map();
  const data = await ytFetch(`/channels?part=contentDetails,snippet&id=${channelIds.join(',')}`, accessToken);
  const map = new Map();
  for (const ch of data.items || []) {
    map.set(ch.id, {
      uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads,
      channelTitle: ch.snippet?.title,
    });
  }
  return map;
}

async function fetchRecentUploads(playlistId, channelTitle, accessToken) {
  if (!playlistId) return [];
  // 15, no 5: con filtros de fecha/canal y "cargar mas" en el cliente, una tanda de 5 por
  // canal se vaciaba enseguida — el coste en cuota es el mismo (1 unidad por llamada a
  // `list`, sin importar maxResults hasta 50), asi que subirlo no cuesta nada extra.
  const data = await ytFetch(`/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=15`, accessToken);
  return (data.items || []).map((it) => ({
    videoId: it.snippet.resourceId.videoId,
    title: it.snippet.title,
    channelTitle,
    thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || null,
    publishedAt: it.snippet.publishedAt,
    url: `https://www.youtube.com/watch?v=${it.snippet.resourceId.videoId}`,
  }));
}

export async function GET(request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: 'not_authenticated' }, { status: 401 });
  }
  if (session.error) {
    return Response.json({ error: 'reauth_required', detail: session.error }, { status: 401 });
  }

  const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
  const cached = cache.get(session.accessToken);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_MS) {
    return Response.json({ videos: cached.videos, cached: true });
  }

  try {
    const channelIds = await fetchSubscribedChannelIds(session.accessToken);
    const channelInfo = await fetchUploadsPlaylistIds(channelIds, session.accessToken);

    const perChannel = await Promise.all(
      [...channelInfo.entries()].map(([, { uploadsPlaylistId, channelTitle }]) =>
        fetchRecentUploads(uploadsPlaylistId, channelTitle, session.accessToken).catch(() => [])
      )
    );

    const videos = perChannel.flat().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    cache.set(session.accessToken, { at: Date.now(), videos });
    return Response.json({ videos, cached: false });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
