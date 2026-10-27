import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

declare global {
  interface Window {
    /** Runtime errors, read by checks that drive the UI in a browser. */
    __agflowErrors: string[];
  }
}

window.__agflowErrors = [];
window.addEventListener('error', (event) => window.__agflowErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__agflowErrors.push(String(event.reason)));

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
