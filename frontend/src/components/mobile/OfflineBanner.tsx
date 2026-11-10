import { useEffect, useState } from 'react';
import { hapticNotification } from '../../lib/haptics';

export const OfflineBanner = () => {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [justRestored, setJustRestored] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      setOnline(true);
      setJustRestored(true);
      void hapticNotification('success');
      const timer = setTimeout(() => setJustRestored(false), 3000);
      return () => clearTimeout(timer);
    };

    const handleOffline = () => {
      setOnline(false);
      setJustRestored(false);
      void hapticNotification('warning');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online && !justRestored) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`fixed top-2.5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold shadow-lg backdrop-blur-md transition-all duration-300 ${
        justRestored
          ? 'bg-emerald-500/90 text-white shadow-emerald-500/20'
          : 'bg-rose-500/90 text-white shadow-rose-500/20'
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          justRestored ? 'bg-white' : 'animate-ping bg-white'
        }`}
      />
      <span>
        {justRestored ? 'Connection restored' : 'Offline — waiting for connection…'}
      </span>
    </div>
  );
};

export default OfflineBanner;

