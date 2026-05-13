import { usePatternUrls } from '../shading';
import s from './DisplacePage.module.css';

type Props = {
  current: string | null;
  onPick: (src: string) => void;
};

type Group = {
  key: string;
  label: string;
  urls: string[];
};

const GROUP_LABELS: Record<string, string> = {
  text: '文字',
  illustration: '卡通 / Logo',
  tone: '渐变 / 半透明',
  line: '细线',
};

function cleanUrl(url: string) {
  return url.split('?')[0];
}

function patternGroup(url: string) {
  const name = cleanUrl(url).split('/').pop() ?? '';
  if (name.startsWith('text-')) return 'text';
  if (name.includes('gradient') || name.includes('transparent')) return 'tone';
  if (name.includes('line')) return 'line';
  return 'illustration';
}

function groupPatterns(urls: string[]): Group[] {
  const grouped = urls.reduce<Record<string, string[]>>((acc, url) => {
    const key = patternGroup(url);
    acc[key] = [...(acc[key] ?? []), url];
    return acc;
  }, {});
  return ['text', 'illustration', 'tone', 'line']
    .filter((key) => grouped[key]?.length)
    .map((key) => ({ key, label: GROUP_LABELS[key], urls: grouped[key] }));
}

export default function PatternPicker({ current, onPick }: Props) {
  const patterns = usePatternUrls();
  const groups = groupPatterns(patterns);

  const handleFile = (file: File) => {
    onPick(URL.createObjectURL(file));
  };

  return (
    <div className={s.assetSection}>
      <div className={s.assetHeader}>
        <span className={s.assetTitle}>图案</span>
        <label className={s.uploadBtn}>
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <span>选择图案</span>
        </label>
      </div>
      <div className={s.assetGroups}>
        {groups.map((group) => (
          <section key={group.key} className={s.assetGroup} aria-label={group.label}>
            <div className={s.groupLabel}>{group.label}</div>
            <div className={s.patternThumbs}>
              {group.urls.map((url) => (
                <button
                  key={url}
                  type="button"
                  className={`${s.patternThumb}${url === current ? ' ' + s.thumbActive : ''}`}
                  onClick={() => onPick(url)}
                  title={cleanUrl(url).split('/').pop() ?? ''}
                >
                  <img src={url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
