import { HashRouter, Route, Routes } from 'react-router-dom';
import DisplacePage from './displace/DisplacePage';
import ShadingLayout from './ShadingLayout';
import './app.css';

function TopBar() {
  return (
    <header className="top-bar">
      <span className="title">样机系统</span>
    </header>
  );
}

export default function App() {
  return (
    <HashRouter>
      <div className="layout">
        <TopBar />
        <Routes>
          <Route path="/" element={<DisplacePage />} />
          <Route path="/displace" element={<DisplacePage />} />
          <Route path="/shading" element={<ShadingLayout />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
