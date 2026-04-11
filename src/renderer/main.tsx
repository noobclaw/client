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
import CommandBarView from './components/commandBar/CommandBarView';
import './noobclaw-theme.css';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

// The `command-bar` secondary Tauri window loads index.html with
// `#command-bar` in its URL (see tauri.conf.json windows[1].url).
// Mount a tiny Spotlight-style component instead of the full app in
// that window — it shares the same bundle so there's zero extra CSS
// / JS to ship, but renders a totally different tree.
const isCommandBar =
  typeof window !== 'undefined' &&
  (window.location.hash === '#command-bar' ||
    window.location.hash.startsWith('#command-bar'));

try {
  if (isCommandBar) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <Provider store={store}>
          <CommandBarView />
        </Provider>
      </React.StrictMode>
    );
  } else {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <Provider store={store}>
          <App />
        </Provider>
      </React.StrictMode>
    );
  }
} catch (error) {
  console.error('Failed to render the app:', error);
}
