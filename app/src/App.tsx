import { HashRouter, Route, Routes } from 'react-router-dom';
import CanvasKitPage from './canvaskit/CanvasKitPage';
import DisplacePage from './displace/DisplacePage';
import ShadingLayout from './ShadingLayout';
import './app.css';

export default function App() {
  return (
    <HashRouter>
      <div className="layout">
        <Routes>
          <Route path="/" element={<DisplacePage />} />
          <Route path="/displace" element={<DisplacePage />} />
          <Route path="/gradient" element={<DisplacePage warpMode="gradient" />} />
          <Route path="/canvaskit" element={<CanvasKitPage />} />
          <Route path="/canvaskit-gradient" element={<CanvasKitPage dispSource="luma" />} />
          <Route path="/shading" element={<ShadingLayout />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
