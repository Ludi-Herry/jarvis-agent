import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { JarvisApp } from './app';
import { LiveJarvisApp } from './live/live-app';
import './styles/tokens.css';
import './styles/app.css';
import './styles/review.css';
import './styles/overlays.css';
import './styles/responsive.css';
import './styles/live.css';
import './styles/workbench.css';

// Specimens stay out of the live bundle; they are verification material, not product code path.
const FixtureJarvisApp = lazy(() => import('./workbench/fixture-app').then((module) => ({
  default: module.FixtureJarvisApp,
})));

const root = document.getElementById('root');
if (root === null) throw new Error('Jarvis GUI root element is missing');
const params = new URLSearchParams(window.location.search);
const showDemo = params.get('demo') === '1';
const fixtureId = params.get('fixture');
document.documentElement.dataset.surface = showDemo ? 'demo' : fixtureId === null ? 'live' : 'fixture';

createRoot(root).render(
  <StrictMode>
    {showDemo
      ? <JarvisApp />
      : fixtureId === null
        ? <LiveJarvisApp />
        : (
          <Suspense fallback={null}>
            <FixtureJarvisApp fixtureId={fixtureId} />
          </Suspense>
        )}
  </StrictMode>,
);
