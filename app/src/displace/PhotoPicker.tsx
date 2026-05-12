import { useModelUrls } from '../shading';
import s from './DisplacePage.module.css';

type Props = {
  current: string | null;
  onPick: (src: string) => void;
};

export default function PhotoPicker({ current, onPick }: Props) {
  const presets = useModelUrls();

  const handleFile = (file: File) => {
    const url = URL.createObjectURL(file);
    onPick(url);
  };

  return (
    <div className={s.picker}>
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
        <span>上传模特图</span>
      </label>
      <div className={s.thumbs}>
        {presets.map((url) => (
          <button
            key={url}
            type="button"
            data-photo-src={url}
            className={`${s.thumb}${url === current ? ' ' + s.thumbActive : ''}`}
            onClick={() => onPick(url)}
            title={url.split('/').pop() ?? ''}
          >
            <img src={url} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}
