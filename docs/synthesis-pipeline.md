# 真人样机印花合成管线

`app/src/ModelGrid.tsx` 的合成管线。每件模特照 + 一张印花图 → 合成出"印花贴在衫上、跟着褶皱起伏"的样机图。

## 总览

输入：

- `photo` — 模特照（RGB JPEG/PNG，~1024² 量级）
- `pattern` — 用户上传的印花图（带 alpha）
- `quad` — pose 检测出的印花板四边形（基于 MediaPipe Pose 的肩 / 髋点）
- `foldStrength` — 用户滑杆，默认 2.0

输出：单张 canvas，印花已合成进衫上。

每张照片首次进入时，会预算几张衍生图（pose、shading、wide-shading、highlight、fabric、garment 采样），全部 cache 进 in-mem map + localStorage。后续拖动印花、改尺寸只走渲染管线，不重算 map。

## 渲染步骤

| Step | 操作 | 目的 |
|---|---|---|
| 1 | 把 pattern 单次仿射 warp 到印花板 quad，画到 `tmp` canvas | 避免双重 resample 模糊；clip 到 quad 范围 |
| 1.5a | 跑 `sampleGarment` + `classifyShirt` | 衫色采样 + 选 white/black/color preset |
| 1.5b | `applyCylindricalBend` | 圆柱压缩，让印花往两侧压，读起来像"裹"在躯干上 |
| 1.5c | `applyGarmentBlend` | 印花染上衫的色调（chromatic adaptation）+ 抬黑（liftFrac） |
| 2 | source-over 把 `tmp` 画上 photo（带 0.5px 模糊软化矢量边） | 合并印花与衫，killing sticker 边 |
| 2.5 | hard-light × narrow shading map | 主褶皱：5–50 px 宽的细褶 |
| **2.5b** | **hard-light × wide shading map** | **30–80 px 宽的软折，黑/彩衫专用** |
| 2.6 | screen × highlight map | 凸起处的轻微提亮（保留印花饱和度） |
| 2.7 | overlay × fabric texture | 把衫的高频织纹/颗粒灌进印花 |

## 核心 map 编码（DoG 比例）

`buildShadingMap(photo, bigBlurFrac=0.05)` 的逐像素公式：

```
lS = blur(photo, 0.4% × min(w,h))   // 小模糊：去噪 ≈ 5px
lB = blur(photo, bigBlurFrac × ...) // 大模糊：局部均值 ≈ 50px / 100px
r  = (lS - lB) / max(lB, 40)        // FLOOR=40 防黑衫被噪声放大
v  = clamp(128 + r * 256, 0, 128)   // hard-light 单位元 128，cap 防图案饱和度被洗
post-blur 0.2%                       // 量化噪点平滑
```

为什么 lS 不直接用 lO：

- 5 px 以下的传感器噪声 / JPEG 块状被 small blur 干掉
- ≥ 10 px 宽的真褶皱 lS ≈ lO，编码不动

为什么 cap 在 128：

- hard-light `1 - 2·(1-bg)·(1-src)` 的提亮分支会把饱和印花（黄、蓝）的暗通道往 1 推 → 颜色被洗成淡彩
- cap 后只走 `2·bg·src` 的压暗分支；提亮交给 Step 2.6 的 screen 兜底

## 双频段 shading map（核心架构）

单条 5% 大模糊有"自吃"问题：当真实褶皱宽度 ≥ 50 px 时，模糊核大部分落在褶皱内 → `lB ≈ lS` → DoG 信号 ≈ 0 → 印花上看不出。

解决：建两张 map。

| | bigBlurFrac | 缓存 | 捕获褶皱宽度 |
|---|---|---|---|
| `shadingRef` | 0.05（≈50 px） | `sh-cache:v8` | 5–50 px 细褶 |
| `wideShadingRef` | 0.10（≈100 px） | `wsh-cache:v1` | 30–80 px 软折 |

两条 map 都用同一份 `buildShadingMap` 函数，只 bigBlurFrac 不同。Step 2.5 和 Step 2.5b 各跑一次 hard-light，alpha 由 preset 各自决定。

## Preset

```ts
type PresetCfg = {
  tint: number;          // chromatic adaptation 强度
  liftFrac: number;      // 印花纯黑抬到 garment.lumP5 的几分之
  foldMul: number;       // Step 2.5 narrow shading hard-light alpha
  wideFoldMul: number;   // Step 2.5b wide shading hard-light alpha
  hlMul: number;         // Step 2.6 screen highlight alpha
  fabricMul: number;     // Step 2.7 fabric overlay alpha
  bendExp: number;       // 圆柱弯曲指数
};
```

| Preset | tint | liftFrac | foldMul | **wideFoldMul** | hlMul | fabricMul | bendExp |
|---|---|---|---|---|---|---|---|
| white  | 0.20 | 0.10 | 1.10 | **0.0**  | 0.90 | 0.20 | 1.10 |
| black  | 0.30 | 0.0  | 1.05 | **0.85** | 0.95 | 0.18 | 1.15 |
| color  | 0.12 | 0.08 | 1.00 | **0.55** | 0.92 | 0.22 | 1.12 |

`classifyShirt(garmentSample)` 走简单分流：

- `lumP95 > 200 && sat < 0.10` → white
- `lumP95 < 70 && sat < 0.25` → black
- 其他 → color

## ⚠ 白衫不变性合约

白衫合成结果必须**逐字节**等于"加 wide map 之前"的版本。靠两条契约保证：

1. `white.wideFoldMul = 0.0` → Step 2.5b 的 `if (wideAlpha > 0)` guard 短路，整段跳过；wide map 即使 build 出来也不参与白衫渲染
2. shading map 编码里 `FLOOR = 40`，但白衫每个像素 `lB ≥ 100` → `max(lB, 40) === lB`，FLOOR 是 40 还是 50 对白衫数学上没区别

之后任何调整若可能动到白衫，必须在 PR 描述里显式说明并截图对比白衫前后。

## 缓存版本

| Key | 当前 | 触发重建条件 |
|---|---|---|
| `sh-cache` | v8 | shading map 编码（small blur / FLOOR / scale / post-blur）变 |
| `wsh-cache` | v1 | wide shading 编码或 bigBlurFrac 变 |
| `hl-cache` | v6 | highlight map 编码变 |
| `fb-cache` | v1 | fabric texture 编码变 |

改 map 编码必须 bump 对应 cache version，否则旧 localStorage 不刷。

## 调参历史（重要决策保留）

| 时间 | 改动 | 原因 |
|---|---|---|
| e87b146 | source-over + 部分 multiply + bicubic 升采样 | 还原图案贴合感 |
| 3b21a43 | 引入相对光照 hard-light 立体感 | 比绝对差 highPass 更稳 |
| fd3ecf9 | 加 Step 2.6 screen 高光层 | 找回凸起处立体感（hard-light cap 后丢的） |
| e7014a3 | 感知比例 shading + 衬衫 preset 系统 + 一批模特素材 | 黑衫上 absolute-diff 高通看不到褶皱 |
| 当前轮次 | 白衫褶皱回弹 → 黑衫斑驳修复 → 红衫色偏修复 → DoG + post-blur 锐化 → 双频段 wide map | 见文末 |

详细数学推导见 `app/src/ModelGrid.tsx` 内联注释。

## 当前轮迭代摘要（2026-05）

1. **白衫褶皱回弹**：scale 160→256，post-blur 0.8%→0.4%，liftFrac 0.40→0.10，foldMul 0.85→1.10
2. **黑衫斑驳修复**：FLOOR 30→50（黑衫 lB≈12 时除数翻倍，噪声放大率减半）
3. **红衫色偏**：color.tint 0.40→0.12（红衫 RGB(170,30,30) 把图案 G/B 拉到 0.67× → 猫变粉）
4. **shadow→wrinkle 锐化**：lO→lS（DoG 小模糊去噪），FLOOR 50→40，post-blur 0.4%→0.2%
5. **双频段 wide map**：加 `wsh-cache:v1`，`bigBlurFrac=0.10`，配合 `wideFoldMul` preset，仅黑/彩衫使用

## 下一步可能动作

按 ROI 排序：

1. **微调 wideFoldMul**（半小时）— 看用户实际反馈，black 0.85 / color 0.55 是否合适
2. **程序生成褶皱层**（半天）— 给"照片本身完全没褶皱"的衫兜底，Perlin 纵向条纹 + 姿态法向
3. **预烤织物/褶皱贴图**（1–2 小时）— 通用 PNG warp 进印花 quad，hard-light 叠 ~15%
4. **切 pixi.js + PSD 位移管线**（1–2 天 + 美术 asset）— RESEARCH.md §3.1 C 推荐路；最终质量但是另起一个项目体量

## 已知限制

- 单 canvas 2D 合成，无真位移（褶皱只是亮度调制，不会让图案"弯曲"）
- 圆柱弯曲是固定指数，不跟随真实身体姿态
- 印花板 quad 来自 MediaPipe Pose 的 4 个关键点，对侧身 / 手举起 / 极端姿势鲁棒性差
- shading map 上限 128，凸起感全靠 Step 2.6 screen + Step 2.7 fabric 兜底，比真 hard-light 提亮要弱
- preset 只有 3 档（white/black/color），深色彩衫（暗红、深蓝）和亮色彩衫共用同一档
