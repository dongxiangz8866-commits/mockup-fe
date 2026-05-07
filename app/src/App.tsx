import Editor2D from './Editor2D';
import Viewer3D from './Viewer3D';
import ModelGrid from './ModelGrid';
import './app.css';

export default function App() {
  return (
    <div className="layout">
      <header className="top-bar">
        <span className="title">样机系统 · 3D 原型</span>
        <span className="subtitle">
          左：UV 模板 · 右上：3D 模型 · 右下：真人模特
        </span>
      </header>
      <main className="main">
        <section className="left-panel">
          <div className="left-top">
            <Editor2D />
          </div>
          <div className="left-bottom">
            <Viewer3D />
          </div>
        </section>
        <section className="right-panel">
          <ModelGrid />
        </section>
      </main>
    </div>
  );
}
