import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { startCapacitorBackButton } from './lib/capacitor-back';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found.');
}

// Before the first render, and outside React: the Android back button is a property of the
// process, not of any component, and a listener attached inside a tree that remounts would
// register more than once. A no-op in a browser - see capacitor-back.ts.
startCapacitorBackButton();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
