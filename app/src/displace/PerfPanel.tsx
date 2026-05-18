import { useState } from 'react';
import type { CacheSource, StageName } from './perfBus';
import type { PerfMetrics } from './usePerfMetrics';
import s from './PerfPanel.module.css';

type Tone = 'good' | 'warn' | 'bad' | 'idle';

const STAGE_LABEL: Record<StageName, string> = {
  load: '加载',
  pose: '姿态',
  maps: '光影',
  depth: '深度',
  hair: '头发',
  cloth: '布料',
};

const SOURCE_LABEL: Record<CacheSource, string> = {
  mem: '内存',
  localStorage: '缓存',
  compute: '计算',
};

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function toneFor(ms: number | null, warn: number, bad: number): Tone {
  if (ms == null) return 'idle';
  if (ms >= bad) return 'bad';
  if (ms >= warn) return 'warn';
  return 'good';
}

function fpsTone(fps: number | null): Tone {
  if (fps == null) return 'idle';
  if (fps < 40) return 'bad';
  if (fps < 55) return 'warn';
  return 'good';
}

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={s.metric}>
      <span className={s.metricLabel}>{label}</span>
      <span className={`${s.metricValue} ${s[tone]}`}>{value}</span>
    </div>
  );
}

export default function PerfPanel({ metrics }: { metrics: PerfMetrics }) {
  const [open, setOpen] = useState(true);
  const { snapshot, parseTotalMs, drag } = metrics;
  const stages: StageName[] = ['load', 'pose', 'maps', 'depth', 'hair', 'cloth'];
  const dragText = drag.fps == null
    ? '—'
    : `${drag.fps} fps · p95 ${drag.p95Ms} ms`;

  return (
    <section className={s.panel}>
      <button
        type="button"
        className={s.header}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={s.title}>⚡ 性能指标</span>
        <span className={`${s.chevron} ${open ? s.chevronOpen : ''}`}>⌃</span>
      </button>

      {open && (
        <div className={s.body}>
          <Metric
            label="解析模特图"
            value={fmtMs(parseTotalMs)}
            tone={toneFor(parseTotalMs, 1500, 4000)}
          />
          <div className={s.stages}>
            {stages.map((name) => {
              const rec = snapshot.stages[name];
              return (
                <div key={name} className={s.stageRow}>
                  <span className={s.stageName}>{STAGE_LABEL[name]}</span>
                  <span className={s.stageMs}>{rec ? fmtMs(rec.ms) : '—'}</span>
                  {rec && (
                    <span className={`${s.src} ${s[`src_${rec.source}`]}`}>
                      {SOURCE_LABEL[rec.source]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <Metric
            label="印图渲染"
            value={fmtMs(snapshot.printMs)}
            tone={toneFor(snapshot.printMs, 60, 150)}
          />
          <Metric
            label={drag.active ? '拖拽帧率 ·实时' : '拖拽帧率 ·上次'}
            value={dragText}
            tone={fpsTone(drag.worstFps ?? drag.fps)}
          />

          {snapshot.render && (
            <div className={s.meta}>
              纹理 {snapshot.render.textures} · 几何 {snapshot.render.geometries} · 着色器{' '}
              {snapshot.render.programs}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
