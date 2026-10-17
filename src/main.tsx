import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { session } from './app/session';
import type { ThemeTokens } from './core/model/types';
import './styles/base.css';
import './styles/components.css';
import { installFonts } from './styles/fonts';
import { applyTheme } from './ui/theme/applyTheme';
import { DEFAULT_THEME } from './ui/theme/themes';

installFonts();

// Paint with the last theme straight away, before the vault is open.
try {
  const saved = localStorage.getItem('trazo.theme');
  applyTheme(saved ? (JSON.parse(saved) as ThemeTokens) : DEFAULT_THEME.tokens);
} catch {
  applyTheme(DEFAULT_THEME.tokens);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void session.boot();
