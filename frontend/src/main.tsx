import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { startCapacitorBackButton } from './lib/capacitor-back';
import { startCapacitorDeepLinks } from './lib/capacitor-deep-link';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found.');
}

// Before the first render, and outside React: the Android back button is a property of the
// process, not of any component, and a listener attached inside a tree that remounts would
// register more than once. A no-op in a browser - see capacitor-back.ts.
startCapacitorBackButton();

// For the same reason, and before the first render for a second one: the link that launched the
// app has to be read before anything can act on it, and AppShell does not exist yet. Buffered
// until it does - see capacitor-deep-link.ts. Also a no-op in a browser, where the address bar
// carries the parameters already.
startCapacitorDeepLinks();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
