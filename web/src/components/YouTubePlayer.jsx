/** Embed publico, sin OAuth ni API key — youtube-nocookie.com es el dominio que YouTube ofrece
 * exactamente para esto (no pone cookies de seguimiento hasta que el usuario le da play). */
export function YouTubePlayer({ videoId, className = '' }) {
  if (!videoId) return null;
  return (
    <div className={`aspect-video w-full overflow-hidden rounded-xl bg-black ${className}`}>
      <iframe
        className="h-full w-full"
        src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0`}
        title="YouTube video player"
        frameBorder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  );
}
