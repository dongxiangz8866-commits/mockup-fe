import p from './SourcePreview.module.css';

type Props = {
  photoSrc: string | null;
  patternSrc: string | null;
};

// Large views of the currently-selected model photo and pattern — the top
// band only shows tiny thumbnails, so this lets you actually inspect what
// is selected. object-fit:contain so neither image is ever stretched.
export default function SourcePreview({ photoSrc, patternSrc }: Props) {
  return (
    <section className={p.card}>
      <div className={p.block}>
        <div className={p.label}>选中模特</div>
        <div className={p.frame}>
          {photoSrc ? (
            <img className={p.img} src={photoSrc} alt="选中模特" />
          ) : (
            <span className={p.placeholder}>未选模特图</span>
          )}
        </div>
      </div>
      <div className={p.block}>
        <div className={p.label}>选中图案</div>
        <div className={`${p.frame} ${p.checker}`}>
          {patternSrc ? (
            <img className={p.img} src={patternSrc} alt="选中图案" />
          ) : (
            <span className={p.placeholder}>未选图案</span>
          )}
        </div>
      </div>
    </section>
  );
}
