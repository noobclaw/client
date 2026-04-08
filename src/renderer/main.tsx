import { initTauriShim } from './tauriShim';

// Initialize Tauri shim BEFORE any React code runs.
// In Tauri mode, this creates a window.electron compatible API using HTTP+SSE.
// In Electron mode, this is a no-op (window.electron already exists from preload).
initTauriShim();

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import './noobclaw-theme.css';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>
  );
} catch (error) {
  console.error('Failed to render the app:', error);
}
