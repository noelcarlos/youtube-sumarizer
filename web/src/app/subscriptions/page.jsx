'use client';

import dynamic from 'next/dynamic';

// ssr:false por la misma razon que la pagina de cola: usa useSession (next-auth/react) y hace
// fetch de datos en el cliente, sin nada que se beneficie de un primer render en servidor.
const Subscriptions = dynamic(() => import('../../views/Subscriptions.jsx').then((m) => m.Subscriptions), { ssr: false });

export default function SubscriptionsPage() {
  return <Subscriptions />;
}
