/** Marca: un "play" que se convierte en lineas de resumen — el vídeo entra, el texto sale. Mismo
 * dibujo que public/../app/icon.svg (favicon), pero como componente para poder controlar tamaño
 * y color desde donde se use (cabecera, etc.) sin depender de un <img> estatico. */
export function Logo({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <path
        d="M9 8.5C9 7.67 9.9 7.16 10.6 7.58L21 13.83C21.67 14.23 21.67 15.17 21 15.57L10.6 21.82C9.9 22.24 9 21.73 9 20.9V8.5Z"
        fill="var(--color-primary-foreground)"
      />
      <rect x="22.5" y="9.5" width="4.5" height="2.4" rx="1.2" fill="var(--color-primary-foreground)" fillOpacity="0.95" />
      <rect x="22.5" y="14.8" width="6.5" height="2.4" rx="1.2" fill="var(--color-primary-foreground)" fillOpacity="0.95" />
      <rect x="22.5" y="20.1" width="3.2" height="2.4" rx="1.2" fill="var(--color-primary-foreground)" fillOpacity="0.95" />
    </svg>
  );
}
