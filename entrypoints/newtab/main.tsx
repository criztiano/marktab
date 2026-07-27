import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { BUNDLE_VERSION, reloadForNewerBundle } from './runtime-version';
import './style.css';

// A refreshed unpacked new-tab bundle can arrive before Chrome refreshes its
// runtime manifest metadata. Reload once rather than mounting mismatched assets.
if (!reloadForNewerBundle(browser.runtime, BUNDLE_VERSION)) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
