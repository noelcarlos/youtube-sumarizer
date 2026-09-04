'use client';

import dynamic from 'next/dynamic';

// ssr:false a proposito: esta pagina es un dashboard en tiempo real (reloj, sondeo cada 1.5s,
// portapapeles, drawer) sin ningun contenido que se beneficie de un primer render en servidor —
// intentarlo solo trae discrepancias de hidratacion (el reloj del servidor nunca coincide con el
// del navegador). Se renderiza entera en el cliente, igual que hacia con Vite.
const Queue = dynamic(() => import('../views/Queue.jsx').then((m) => m.Queue), { ssr: false });

export default function Home() {
  return <Queue />;
}
