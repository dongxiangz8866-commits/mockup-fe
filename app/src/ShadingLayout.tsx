import Editor2D from './Editor2D';
import ModelGrid from './ModelGrid';

export default function ShadingLayout() {
  return (
    <main className="main">
      <section className="left-panel">
        <div className="left-top">
          <Editor2D />
        </div>
      </section>
      <section className="right-panel">
        <ModelGrid />
      </section>
    </main>
  );
}
