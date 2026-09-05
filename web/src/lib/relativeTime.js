const RELATIVE_UNITS = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

/** Intl.RelativeTimeFormat, no una libreria — ya viene en el navegador y respeta el idioma
 * activo solo (ES -> "hace 2 dias", EN -> "2 days ago") sin tener que mantener las cadenas de
 * texto a mano en messages/es.json|en.json. */
export function formatRelativeTime(timestampMs, locale) {
  if (!timestampMs) return null;
  const diffSec = (timestampMs - Date.now()) / 1000;
  const absSec = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, secInUnit] of RELATIVE_UNITS) {
    if (absSec >= secInUnit || unit === 'second') {
      return rtf.format(Math.round(diffSec / secInUnit), unit);
    }
  }
}
