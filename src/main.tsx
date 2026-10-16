import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CockpitApp } from './ui/CockpitApp';
import './ui/cockpit.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <CockpitApp />
  </StrictMode>,
);
