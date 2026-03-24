import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  const base = import.meta.env.BASE_URL ?? '/';
  navigator.serviceWorker.register(`${base}sw.js`);
}
