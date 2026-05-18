import type { DebugMode } from './DisplaceCanvas';
import c from './ControlRail.module.css';

type Props = {
  scale: number;
  setScale: (n: number) => void;
  light: number;
  setLight: (n: number) => void;
  sceneBrightness: number;
  setSceneBrightness: (n: number) => void;
  depthWrap: number;
  setDepthWrap: (n: number) => void;
  depthEnabled: boolean;
  wrinkle: number;
  setWrinkle: (n: number) => void;
  wrinkleEnabled: boolean;
  debug: DebugMode;
  setDebug: (m: DebugMode) => void;
};

const DEBUG_LABEL: Record<DebugMode, string> = {
  composite: '合成',
  displace: '位移',
  light: '光照',
  shading: 'Shading',
  fine: 'Fine',
  foldGrad: '褶皱强度',
};

type RangeProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  disabled?: boolean;
};

function Range({ label, value, min, max, step, onChange, disabled }: RangeProps) {
  return (
    <label className={`${c.range} ${disabled ? c.rangeDisabled : ''}`}>
      <span className={c.rangeLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={c.rangeValue}>{value.toFixed(2)}</span>
    </label>
  );
}

export default function ControlRail(p: Props) {
  const modes: DebugMode[] = ['composite', 'displace', 'light', 'shading', 'fine', 'foldGrad'];
  return (
    <section className={c.rail}>
      <div className={c.groupTitle}>调节</div>
      <Range label="图案大小" value={p.scale} min={0.4} max={2.0} step={0.02} onChange={p.setScale} />
      <Range label="光照" value={p.light} min={0} max={2} step={0.05} onChange={p.setLight} />
      <Range
        label="整体亮度"
        value={p.sceneBrightness}
        min={0.3}
        max={1.2}
        step={0.05}
        onChange={p.setSceneBrightness}
      />
      <Range
        label="贴合强度"
        value={p.depthWrap}
        min={0}
        max={30}
        step={0.5}
        onChange={p.setDepthWrap}
        disabled={!p.depthEnabled}
      />
      <Range
        label="褶皱深度"
        value={p.wrinkle}
        min={0}
        max={3}
        step={0.05}
        onChange={p.setWrinkle}
        disabled={!p.wrinkleEnabled}
      />

      <div className={c.groupTitle}>调试视图</div>
      <div className={c.debugGrid}>
        {modes.map((m) => (
          <label key={m} className={`${c.chip} ${p.debug === m ? c.chipActive : ''}`}>
            <input
              type="radio"
              name="debug-mode"
              checked={p.debug === m}
              onChange={() => p.setDebug(m)}
            />
            {DEBUG_LABEL[m]}
          </label>
        ))}
      </div>
    </section>
  );
}
