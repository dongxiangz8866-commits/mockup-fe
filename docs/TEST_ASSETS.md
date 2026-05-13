# /displace 测试素材清单

本目录服务 `/displace` 效果测试。2026-05-13 经过四轮筛选：前三轮做组合扩展，第四轮（本次）按用户反馈「我图案要印到衣服上的胸前或者背后的，要完整的上身」净空了 10 张胸口/背部不入框的样本。

## 目录

| 路径 | 用途 |
|---|---|
| `app/public/test-models/` | 在 `/displace` 缩略图中可选的模特图（24 张） |
| `app/public/test-models/MANIFEST.json` | 每张图的 C/P/W/garment/遮挡维度标签（机读） |
| `app/public/test-models/_rejected/` | 下载后人工拒绝的候选（28 张 + `old-synthetic-locals/` 11 张），不参与扫描 |
| `app/public/test-patterns/` | 在 `/displace` 图案分组中可选的图案（30 张：23 SVG + 7 Pexels JPG） |

> **2026-05-13 vite.config.ts 改动**：`MODEL_DIRS` 只扫 `public/test-models`，原 `public/models/` 19 张老素材已隐藏（文件保留在磁盘）。

## 入选标准（round-4 起明确）

1. **胸口或背部必须在画面里**（几何上完整）— 即使被手/头发遮挡也算 in-frame；裁到锁骨以上不行。
2. **不能有现成印花/Logo/文字** — 否则与算法的目标印图冲突。
3. **不能是开襟衣服**（button-up / zip-up hoodie / polo），中线的扣子/拉链会切断印图区域。
4. **garment 必须是 T / 长袖 T / 套头 hoodie / 无袖** — 衬衫、西装、外套不算。

## 模特图（24 张）

★ 标记为「完整展示衣服」标杆样张。

### 短袖 T (tshirt, 16 张)

| 文件 | 维度 | 备注 | 来源 |
|---|---|---|---|
| `tshirt-black-front-pexels-26125921.jpg` | C2 / P1 / W2 | 黑短袖 正面 完整 | Pexels |
| `tshirt-green-front-pexels-19107957.jpg` | C4 / P1 / W2 | 中亮绿 户外 | Pexels |
| `tshirt-red-front-pexels-8211326.jpg` | C4 / P4 / W2 | 高饱和红 手部接近胸口 | Pexels |
| `tshirt-white-front-complete-pexels-8217507.jpg` | C1 / P1 / W1 | 白短袖 全身远景 平整 | Pexels |
| `tshirt-white-pose-pexels-9558713.jpg` | C1 / P2 / W2 | 白短袖 轻微姿势 | Pexels |
| `tshirt-black-arms-crossed-pexels-4584267.jpg` | C2 / P4 / W2 | 黑 T 交叉手臂横跨胸口 | Pexels |
| `tshirt-orange-hair-strap-pexels-1848468.jpg` | C4 / P5 / W2 / S6 | 红橙 + 长发遮 + denim 背带 | Pexels |
| `tshirt-black-studio-mart-pexels-9558252.jpg` | C2 / P1 / W2 | ★ Mart 黑 oversized T 完整展示 | Pexels |
| `tshirt-white-studio-mart-pexels-6786614.jpg` | C1 / P1 / **W1** | ★ Mart 纯白短袖 + W1 平整标杆 | Pexels |
| `tshirt-brown-front-pexels-9558684.jpg` | C3 / P1 / W2 | ★ Mart 深棕/橄榄 T | Pexels |
| `tshirt-neon-green-fullbody-pexels-2777067.jpg` | **C5** / P6 / W2 | ★ 霓虹绿 oversized T 户外蹲姿 | Pexels |
| `tshirt-orange-fullbody-pexels-2221132.jpg` | C4 / P4 / **W5** | 橙 T 户外阳光透叶光斑 | Pexels |
| `tshirt-blue-excited-pexels-3768724.jpg` | C4 / P1 / W2 | 青绿 T 双拳举到肩部 | Pexels |
| `tshirt-mart-black-oversized-pexels-9558577.jpg` | C2 / P1 / W2 | ★ Mart 黑 oversized 卷发男士 | Pexels |
| `tshirt-gray-wakeup-pexels-5990953.jpg` | C2 / P6 / **W3** | 灰短袖 床上起床 W3 标杆 | Pexels |

### 长袖 T (longsleeve, 3 张)

| 文件 | 维度 | 备注 | 来源 |
|---|---|---|---|
| `longsleeve-black-front-pexels-11000250.jpg` | C2 / P2 / W2 | 黑长袖针织（粉领探出领口，胸口干净） | Pexels |
| `longsleeve-white-man-front-pexels-8727340.jpg` | C1 / P1 / W3 | 白长袖 宽松褶皱 | Pexels |
| `longsleeve-white-mug-pexels-6823493.jpg` | C1 / P1 / W2 | ★ 米色 cream crewneck 长袖卫衣完整展示 | Pexels |

### 卫衣 (hoodie, 5 张)

| 文件 | 维度 | 备注 | 来源 |
|---|---|---|---|
| `hoodie-white-city-pexels-10285696.jpg` | C1 / P1 / W4 | 白卫衣 全身远景 | Pexels |
| `hoodie-yellow-cap-pexels-6332442.jpg` | C4 / P1 / W2 | 亮黄 hoodie + 黑帽 + 工作室 | Pexels |
| `hoodie-yellow-dance-pexels-1183266.jpg` | C4 / P2 / W2 | 亮黄 hoodie 户外戴 hood 侧身 | Pexels |
| `hoodie-green-sit-pexels-4114920.jpg` | C3 / P6 / W4 | 橄榄/苔绿 hoodie 棕沙发卧躺 | Pexels |
| `hoodie-pink-woman-pexels-6543909.jpg` | **C5** / P1 / W2 | ★ 粉色 hoodie 完整展示 + 紫色背景 | Pexels |

### 无袖背心 (sleeveless, 1 张)

| 文件 | 维度 | 备注 | 来源 |
|---|---|---|---|
| `sleeveless-black-fullbody-pexels-2896427.jpg` | C2 / P1 / W2 | 黑无袖完整展示 + 外搭印花夹克不遮胸 | Pexels |

### 维度覆盖（24 张总分布）

| 维度 | 分布 |
|---|---|
| C 颜色 | C1×6 / C2×8 / C3×3 / C4×6 / C5×2 |
| P 姿势 | P1×14 / P2×3 / P3×0 / P4×4 / P5×1 / P6×3 |
| W 褶皱 | W1×2 / W2×17 / W3×2 / W4×3 / W5×1 |
| garment | tshirt×15 / hoodie×5 / longsleeve×3 / sleeveless×1 |

剩余空缺记在 `MANIFEST.json` 的 `gaps` 数组（round-4 新增 navy/pink T、back-print 样本、C2 黑/C3 灰 pullover hoodie、P3 强侧身 等空缺）。

## 图案素材（30 张）

### Web 来源 JPG 彩色印花（7 张，2026-05-13 新增）

| 文件 | 风格 | 主色 | 来源 |
|---|---|---|---|
| `pattern-skull-illustration-pexels-534590.jpg` | 真实头骨 + 森林背景 | 暖色泥土 | Pexels |
| `pattern-abstract-multicolor-pexels-1045299.jpg` | 厚涂油画 抽象 | 橙/红/蓝/绿 | Pexels |
| `pattern-abstract-vibrant-pexels-30612390.jpg` | 表现主义大色块 | 蓝/红/紫/黄/绿 | Pexels |
| `pattern-abstract-canvas-pexels-11309626.jpg` | 流动液态画 | 红/绿 | Pexels |
| `pattern-abstract-swirls-pexels-3844788.jpg` | 流体艺术 | 橙/蓝/黄/深蓝 | Pexels |
| `pattern-orange-blue-paint-pexels-1174000.jpg` | 简约色块抽象 | 蓝/橙/白 | Pexels |
| `pattern-bird-banana-leaf-pexels-12634730.jpg` | 鸟 + 热带蕉叶 | 绿/棕 | Pexels |

### 自生成 SVG（23 张，前两轮）

| 文件 | 维度 | 测试点 |
|---|---|---|
| `text-black-bold.svg` | A1 / K1 | 黑色大字 |
| `text-white-bold.svg` | A1 / K2 | 白色大字 |
| `text-small-lines.svg` | A2 / K1 | 小字/细线 |
| `text-multiline-ingredients.svg` | A2 / K1 | 多行配料标 |
| `text-stacked-slogan.svg` | A1 / K1 | Impact 体堆叠 slogan |
| `text-handwritten-script.svg` | A1 / K1 | 斜体手写体 |
| `logo-geometric-color.svg` | A3 / K3 | 彩色 logo |
| `logo-mono-circle.svg` | A3 / K1 | 单色几何 |
| `thin-line-grid.svg` | A3 / K1 | 细线几何 |
| `badge-shield-vintage.svg` | A3 / K4 | 复古盾形 badge |
| `cartoon-cat-dark.svg` | A4 / K4 | 暗部卡通猫 |
| `cartoon-bright.svg` | A4 / K4 | 明亮卡通脸 |
| `cartoon-mascot-color.svg` | A4 / K4 | 吉祥物彩色 |
| `cartoon-anime-linework.svg` | A4 / K1 | 黑线动漫线稿 |
| `photo-gradient-blocks.svg` | A5 / K5 | 色块渐变 |
| `photo-portrait-vector.svg` | A5 / K4 | 山景日落矢量 |
| `photo-portrait-face.svg` | A5 / K4 | 彩绘人脸 |
| `transparent-smoke.svg` | A6 / K5 | 烟雾半透明 |
| `transparent-glow-halo.svg` | A6 / K5 | 光晕 + 边角射线 |
| `transparent-watercolor-splash.svg` | A6 / K3 | 三色水彩泼溅 |
| `full-bleed-tile.svg` | A7 / K4 | 圆 + 方块全幅瓷砖 |
| `full-bleed-floral.svg` | A7 / K4 | 深绿底花朵全幅 |
| `full-bleed-camo.svg` | A7 / K1 | 军绿 camo 全幅 |

## 授权说明

- Pexels 素材来自 `pexels.com`，Pexels License 允许免费使用和修改，且无需署名。
- Unsplash 素材来自 `unsplash.com`，Unsplash License 允许免费商用/非商用使用，且无需署名。
- 自生成 SVG 图案不依赖第三方版权素材。

## 拒绝清单

### `_rejected/` 28 张

round-4 净空（2026-05-13 第四轮，新增 10 张）：

| 文件 | 拒绝原因 |
|---|---|
| `tshirt-heather-gray-pexels-1327281_portrait-no-chest-rejected.jpg` | portrait crop 仅到锁骨，胸口不在画面 |
| `tshirt-navy-blue-front-pexels-2379005_portrait-collar-only-rejected.jpg` | portrait 仅领口可见 |
| `tshirt-white-long-hair-pexels-8721957_portrait-no-chest-rejected.jpg` | portrait 头发占主体，胸口被截 |
| `tshirt-white-side-hair-pexels-1624192_portrait-side-rejected.jpg` | portrait 侧面，胸口不入框 |
| `tshirt-black-side-pexels-4729203_90deg-no-chest-rejected.jpg` | 90° 完全侧身，胸/背都不可见 |
| `tshirt-khaki-arms-crossed-pexels-18036888_henley-buttons-rejected.jpg` | henley 三粒扣开襟，扣线切断胸口印图区 |
| `tshirt-crewneck-bed-pexels-3981599_lying-overhead-no-chest-rejected.jpg` | 床上俯视拍头部，主要是头发和阴影 |
| `hoodie-black-front-pexels-10850112_zipup-zipper-splits-chest-rejected.jpg` | zip-up hoodie 中线拉链切断胸口印图区 |
| `hoodie-gray-front-unsplash-N6BP12FB_XU_portrait-hood-up-no-chest-rejected.jpg` | portrait 戴 hood 仅露面部，胸口不入框 |
| `tshirt-white-wall-shadow-pexels-97218_portrait-head-down-no-chest-rejected.jpg` | portrait 低头看桌面，仅一侧肩膀可见 |

round 1–3 旧拒绝（18 张）：

| 文件 | 拒绝原因 |
|---|---|
| `tshirt-yellow-front-pexels-3756993_STOP-print-rejected.jpg` | 衣服已印满"STOP"字样 |
| `tshirt-black-window-shadow-pexels-8957577_full-silhouette-rejected.jpg` | 几乎纯黑剪影，胸口完全在阴影里 |
| `tshirt-black-side-pexels-3779018_polo-side-back-rejected.jpg` | 老年男性 polo 侧后向，胸口不可见 |
| `tshirt-pink-front-pexels-5701652_breast-print-rejected.jpg` | 胸前已印插画 |
| `tshirt-orange-front-pexels-19863396_blazer-not-tshirt-rejected.jpg` | 橙色西装外套而非 T 恤 |
| `tshirt-dramatic-shadow-pexels-16764648_buttonup-not-tshirt-rejected.jpg` | button-up shirt + 极端绿/红双色光 |
| `tshirt-cap-fullbody-pexels-26447865_HIGHBOYZ-print-rejected.jpg` | 胸前已印 "HIGH BOYZ" 文字 |
| `tshirt-pink-fullbody-pexels-2960915_CITY-print-rejected.jpg` | 胸前已印 "CITY" + 项链 + crop top |
| `tshirt-maroon-fullbody-pexels-2286477_dot-print-rejected.jpg` | 酒红 T 但满布小白点图案 |
| `tshirt-orange-sun-pexels-3363970_hand-block-chest-rejected.jpg` | 手挡眼姿势，胸口被手臂横跨 |
| `tshirt-oversized-pexels-9726634_printed-sweatshirt-rejected.jpg` | cream sweatshirt 上印橙色花朵 + 袖标 |
| `tshirt-white-wrinkled-pexels-27045943_buttonup-not-tshirt-rejected.jpg` | 白色 button-up 衬衫不是 T 恤 |
| `longsleeve-brown-man-pexels-5537794_buttonup-workshirt-rejected.jpg` | 棕色 button-up 工装衬衫 |
| `longsleeve-woman-front-pexels-4869876_buttonup-not-LS-tshirt-rejected.jpg` | 白色 button-up 衬衫 + 圣诞家居场景 |
| `hoodie-red-fullbody-pexels-14350438_MANCHESTER-print-rejected.jpg` | 胸前已印 "MANCHESTER 1878" |
| `hoodie-green-man-pexels-9775640_portrait-no-chest-rejected.jpg` | 仅头部 portrait crop，胸口完全不在画面 |
| `hoodie-red-portrait-pexels-14350429_portrait-no-chest-rejected.jpg` | 仅头部 portrait crop |
| `longsleeve-black-portrait-pexels-12368103_badge-print-rejected.jpg` | 黑长袖胸前已印纪念章 logo |

### `_rejected/old-synthetic-locals/` 11 张

2026-05-13 用户决定不再使用合成生成的 `local-tshirt-*.png`（11 张，包含 black/blue/green/purple/red/yellow seated + 5 张白色变体），全部移入此子目录。维度覆盖由新 web 素材补齐。

## 修订日志

| 日期 | 改动 |
|---|---|
| 2026-05-13 round 1 | 第一批 +7 模特覆盖 P3/P4/P5/W5；+6 SVG 图案补 A2-A7 |
| 2026-05-13 round 2 | 第二批 +8 模特，Mart 工作室「完整展示」标杆 + C5 霓虹绿 + W1 平整；+8 SVG 图案 |
| 2026-05-13 round 3 | 第三批 +9 模特，长袖 cream sweatshirt + hoodie 黄/粉/绿 + 床上 W3/W5；+7 Pexels JPG 彩色图案；删除 11 张合成 local；隐藏原 `/models/` |
| 2026-05-13 round 4 | 用户反馈「图案要印到胸前或背后，要完整上身」，剔除 10 张胸口/背部不入框的样本：7 张 portrait crop（仅锁骨以上）、1 张 zip-up hoodie（拉链切胸）、1 张 henley（扣子切胸）、1 张 90° 完全侧身。明确入选标准。新批次补充图待下载（已被环境拦截，需要用户授权 curl）。 |
