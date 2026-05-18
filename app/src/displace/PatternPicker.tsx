import { usePatternUrls } from '../shading';
import s from './DisplacePage.module.css';

type Props = {
  current: string | null;
  onPick: (src: string) => void;
};

function cleanUrl(url: string) {
  return url.split('?')[0];
}

export default function PatternPicker({ current, onPick }: Props) {
  const patterns = usePatternUrls();

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
      <div className={s.patternThumbs}>
        {patterns.map((url) => (
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
    </div>
  );
}
