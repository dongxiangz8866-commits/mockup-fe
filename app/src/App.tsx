import Editor2D from './Editor2D';
import Viewer3D from './Viewer3D';
import './app.css';

export default function App() {
  return (
    <div className="layout">
      <header className="top-bar">
        <span className="title">样机系统 · 3D 原型</span>
        <span className="subtitle">左：2D 轮廓编辑 · 右：3D 实时渲染</span>
      </header>
      <main className="main">
        <section className="left-panel">
          <Editor2D />
        </section>
        <section className="right-panel">
          <Viewer3D />
        </section>
      </main>
    </div>
  );
}
