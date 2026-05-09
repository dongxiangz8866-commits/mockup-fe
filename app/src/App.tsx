import { HashRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import DisplacePage from './displace/DisplacePage';
import ShadingLayout from './ShadingLayout';
import './app.css';

function TopBar() {
  const { pathname } = useLocation();
  return (
    <header className="top-bar">
      <span className="title">样机系统</span>
      <NavLink
        to="/"
        end
        className={({ isActive }) => `tab-btn${isActive ? ' active' : ''}`}
      >
        明暗对比
      </NavLink>
      <NavLink
        to="/displace"
        className={({ isActive }) => `tab-btn${isActive ? ' active' : ''}`}
      >
        位移派生
      </NavLink>
      {pathname === '/' && (
        <span className="subtitle">左：UV 模板 · 右：真人模特</span>
      )}
    </header>
  );
}

export default function App() {
  return (
    <HashRouter>
      <div className="layout">
        <TopBar />
        <Routes>
          <Route path="/" element={<ShadingLayout />} />
          <Route path="/displace" element={<DisplacePage />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
