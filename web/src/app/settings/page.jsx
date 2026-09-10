'use client';

import dynamic from 'next/dynamic';

// ssr:false por la misma razon que la pagina de cola y de suscripciones: usa fetch de datos en
// el cliente (useSettings), sin nada que se beneficie de un primer render en servidor.
const Settings = dynamic(() => import('../../views/Settings.jsx').then((m) => m.Settings), { ssr: false });

export default function SettingsPage() {
  return <Settings />;
}
