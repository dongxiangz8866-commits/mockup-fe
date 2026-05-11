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

**顺序变更（127d304）**：pose detect 先于 maps build。原因是 A1 luminance 预处理（见下）需要用 pose quad 在衫上采样估亮度分位，pose 必须先就位。代价：首次冷加载多 ~1-2 s（pose cache 命中后无影响）。

## 渲染步骤

| Step | 操作 | 目的 |
|---|---|---|
| **0.5** | **`preprocessForShading`（127d304）** | **深色衫专用：把 pose quad 内 [P10, P90] 拉伸到 [10, 120]，给 DoG 信号 ~5× 增益** |
| 1 | 把 pattern 单次仿射 warp 到印花板 quad，画到 `tmp` canvas | 避免双重 resample 模糊；clip 到 quad 范围 |
| 1.5a | 跑 `sampleGarment` + `classifyShirt` | 衫色采样 + 选 white/black/color preset |
| 1.5b | `applyCylindricalBend` | 圆柱压缩，让印花往两侧压，读起来像"裹"在躯干上 |
| 1.5c | `applyGarmentBlend` | 印花染上衫的色调（chromatic adaptation）+ 抬黑（`max(liftFrac×lumP5, liftMin)`） |
| ~~1.5d~~ | ~~`applyEdgeInnerShadow`~~ | ~~B1 内阴影 — 函数留着但全档 alpha=0，对复杂插画 scale 太差（见失败档案）~~ |
| 2 | source-over 把 `tmp` 画上 photo（带 0.5px 模糊软化矢量边） | 合并印花与衫，killing sticker 边 |
| 2.5 | hard-light × narrow shading map | 主褶皱：5–50 px 宽的细褶 |
| **2.5b** | **hard-light × wide shading map** | **30–80 px 宽的软折，黑/彩衫专用** |
| 2.6 | screen × highlight map | 凸起处的轻微提亮（保留印花饱和度） |
| 2.7 | overlay × fabric texture | 把衫的高频织纹/颗粒灌进印花 |

## A1 — 深色衫 luminance 预处理（127d304）

`preprocessForShading(photo, shirtQuad)` 在 build shading map 之前对深色衫做亮度拉伸：

```
quad 内 64×64 bilinear 采样 → P10, P50, P90
if P50 ≥ 80           → return photo（白衫/浅色衫，逐字节守合约）
if P90 - P10 < 10     → return photo（动态范围太窄，拉伸只会放大噪声）
else                  → 每像素 multiplicative gain 把 [P10, P90] 映射到 [10, 120]
```

**为什么用 pose quad 采样**：早期版本采样 photo 中央 30-70% × 30-70%。但人脸/水面反光把 P95 刷到 168（黑衫真实值），所有深色衫都被判成"亮"短路掉。pose quad 是衫范围的精确估计，纯黑衫 quad 内 P50=13、P90=25，明确判为深色。

**为什么 [10, 120] 不是 [10, 210]**：早期 [10, 210] 给 ~10× 增益，配合 hard-light 把图案暗内容（猫插画、smoke）压成大块黑斑。[10, 120] ~5× 增益是观察出的拐点——fold cue 还看得见但不会塌陷。

**编码 cap=128 与 stretch 的关系**：`buildShadingMap` 的 `r = (lS-lB)/max(lB, FLOOR=40)` 在拉伸后输入上跑。黑衫拉伸后 lB ≈ 50-80，FLOOR 不再压低分母，r 自然放大；这就是 A1 给深色衫"看得见褶皱"的核心。白衫 lB ≥ 100 拉伸前后相同，FLOOR 也不动，输出字节同。

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
  tint: number;             // chromatic adaptation 强度
  liftFrac: number;         // 印花纯黑抬到 garment.lumP5 的几分之
  liftMin: number;          // ABS byte 下限（127d304）覆盖 liftFrac 的相对值
  foldMul: number;          // Step 2.5 narrow shading hard-light alpha
  wideFoldMul: number;      // Step 2.5b wide shading hard-light alpha
  hlMul: number;            // Step 2.6 screen highlight alpha
  fabricMul: number;        // Step 2.7 fabric overlay alpha
  bendExp: number;          // 圆柱弯曲指数
  edgeShadowPx: number;     // step 1.5d B1 内阴影模糊半径（当前全档 alpha=0 关闭）
  edgeShadowAlpha: number;  // step 1.5d B1 内阴影强度
};
```

`lift = max(liftFrac × lumP5, liftMin)` —— 相对项处理白衫 vector-ink cue（图案纯黑不能掉到衫阴影以下），绝对项 `liftMin` 处理深色衫 invisible-blob cue（图案暗内容不能跟衫融成黑斑）。

| Preset | tint | liftFrac | **liftMin** | foldMul | **wideFoldMul** | hlMul | fabricMul | bendExp |
|---|---|---|---|---|---|---|---|---|
| white  | 0.20 | 0.10 | **0**  | 1.10 | **0.0**  | 0.90 | 0.20 | 1.10 |
| black  | 0.30 | 0.0  | **50** | 0.40 | **0.20** | 0.50 | 0.15 | 1.15 |
| color  | 0.12 | 0.08 | **0**  | 1.00 | **0.55** | 0.92 | 0.22 | 1.12 |

**`black` preset 现在是"深色衫" preset**——不是字面纯黑，而是 lumP95 < 90 的所有深色（黑/深绿/深红/深蓝/深紫）。命名是历史包袱，没改是因为代码引用面比较广。

### `classifyShirt` 路由（127d304 修过）

```
lumP95 > 200 && sat < 0.10  → white
lumP95 < 90                 → black（深色统一档）
其他                          → color
```

**bug 修复历史（127d304）**：旧规则 `lumP95<70 && sat<0.25` → black 把纯黑漏掉。原因：纯黑衫像素 rgb=(9,13,14)，P95=26，但 byte 量化噪声让 sat=(14-9)/14=0.36 > 0.25 → fall through 到 color。结果：连续几个迭代 black preset 全是死代码，黑/深绿/深红/深蓝/深紫衫看到的都是 color preset（强 fold + 零 lift）。修法是直接用 lumP95<90 单条件，绕开 sat 判断。

| 旧规则下分类 | 实际衫色 | 实际走的 preset |
|---|---|---|
| color | rgb=(9,13,14) lumP95=26 纯黑 | color（错） |
| color | rgb=(53,60,41) lumP95=83 深绿 | color（错） |
| color | rgb=(63,37,83) lumP95=72 深紫 | color（错） |
| color | rgb=(90,4,20) lumP95=49 深红 | color（错） |
| black | 实际几乎走不到 | （死代码） |

## ⚠ 白衫不变性合约

白衫合成结果必须**逐字节**等于"加 wide map 之前"的版本。靠三条契约保证：

1. `white.wideFoldMul = 0.0` → Step 2.5b 的 `if (wideAlpha > 0)` guard 短路，整段跳过；wide map 即使 build 出来也不参与白衫渲染
2. shading map 编码里 `FLOOR = 40`，但白衫每个像素 `lB ≥ 100` → `max(lB, 40) === lB`，FLOOR 是 40 还是 50 对白衫数学上没区别
3. **A1 preprocessForShading（127d304）**：白衫 quad 内 P50 ≥ 220 ≫ 80 → short-circuit `return photo` → buildShadingMap 输入是原 HTMLImageElement，逐字节复现旧版本。`white.liftMin = 0` 也保证 `applyGarmentBlend` 的 `lift = max(lumP5×liftFrac, 0)` 仍然由相对项主导，跟旧版相同。

之后任何调整若可能动到白衫，必须在 PR 描述里显式说明并截图对比白衫前后。截图链路见下方"Screenshot harness"——`pnpm screenshot M016_white_front` 可以快速 hash diff 白衫 byte-equal 验证。

## 缓存版本

| Key | 当前 | 触发重建条件 |
|---|---|---|
| `sh-cache` | **v12** | shading map 编码（small blur / FLOOR / scale / post-blur）变；A1 stretch 的 target/source 范围变 |
| `wsh-cache` | **v5** | wide shading 编码或 bigBlurFrac 变 |
| `hl-cache` | v6 | highlight map 编码变 |
| `fb-cache` | v1 | fabric texture 编码变 |

改 map 编码必须 bump 对应 cache version，否则旧 localStorage 不刷。

127d304 之后新增辅助开关：脚本运行时设 `CLEAR_SHADING=1` 在 reload 前清掉 `sh-cache:` / `wsh-cache:` 所有 entries，强制 buildShadingMap 重跑——调 A1 / encoding 时不用每次手动 bump 版本号。

## 调参历史（重要决策保留）

| 时间 | 改动 | 原因 |
|---|---|---|
| e87b146 | source-over + 部分 multiply + bicubic 升采样 | 还原图案贴合感 |
| 3b21a43 | 引入相对光照 hard-light 立体感 | 比绝对差 highPass 更稳 |
| fd3ecf9 | 加 Step 2.6 screen 高光层 | 找回凸起处立体感（hard-light cap 后丢的） |
| e7014a3 | 感知比例 shading + 衬衫 preset 系统 + 一批模特素材 | 黑衫上 absolute-diff 高通看不到褶皱 |
| 7b9435f | 双频段 wide shading map | 黑/彩衫 30-80 px 软折看不到 |
| **127d304** | **classifyShirt 修 + A1 luminance stretch + liftMin + screenshot harness** | **黑/深色衫 black preset 死代码 → 全部正确路由；图案暗内容跟衫融合 → liftMin 抬到可见** |

详细数学推导见 `app/src/ModelGrid.tsx` 内联注释。

## 当前轮迭代摘要（2026-05 第一轮）

1. **白衫褶皱回弹**：scale 160→256，post-blur 0.8%→0.4%，liftFrac 0.40→0.10，foldMul 0.85→1.10
2. **黑衫斑驳修复**：FLOOR 30→50（黑衫 lB≈12 时除数翻倍，噪声放大率减半）
3. **红衫色偏**：color.tint 0.40→0.12（红衫 RGB(170,30,30) 把图案 G/B 拉到 0.67× → 猫变粉）
4. **shadow→wrinkle 锐化**：lO→lS（DoG 小模糊去噪），FLOOR 50→40，post-blur 0.4%→0.2%
5. **双频段 wide map**：加 `wsh-cache:v1`，`bigBlurFrac=0.10`，配合 `wideFoldMul` preset，仅黑/彩衫使用

## 当前轮迭代摘要（2026-05 第二轮 — 127d304）

用户痛点：黑/深色衫复杂插画 (猫主题，built-in 暗内容) → 大块黑斑、看不见图案形状、看不见褶皱、贴纸感。

1. **classifyShirt bug 发现并修**：旧 `lumP95<70 && sat<0.25` 因为 byte 量化噪声 (rgb=(9,13,14) → sat=0.36) 把纯黑漏给 color preset。一连串迭代下来 black preset 全是死代码。修法：单条件 lumP95<90 → black，覆盖所有深色衫。靠 `[classify]` console log + screenshot harness 才发现。
2. **A1 luminance stretch (`preprocessForShading`)**：pose quad 64×64 采样 P10/P50/P90；P50≥80 短路（白衫零变化），否则 [P10, P90] → [10, 120]。给深色衫 DoG 信号 ~5× 增益。早期 [10, 210] target 太猛把 fold 砸成黑斑——5× 是观察到的拐点。
3. **PresetCfg 新增 `liftMin`**：绝对 byte 下限。`applyGarmentBlend` 的 lift = `max(liftFrac×lumP5, liftMin)`。black.liftMin=50 让图案纯黑抬到 byte 50，在 byte 5-30 的深色衫上能看见。代价 ~20% pattern 对比度损失，换可见性。
4. **black preset 数值收紧**（现在终于会生效了）：foldMul 1.05→0.40，wideFoldMul 0.85→0.20，hlMul 0.95→0.50，fabricMul 0.18→0.15。配合 A1 的 ~5× DoG 增益，温和 hard-light alpha 防止暗 pattern × 深 shading byte 的乘法塌陷。
5. **B1 内阴影实现+全档关闭**：`applyEdgeInnerShadow` 走 source-in fill → destination-out blurred-tmp 两步 Porter-Duff，对单 alpha 边方块有效，对复杂插画 (几百条内部 alpha 边) 全部加 ring → 黑斑。关掉 (`edgeShadowAlpha=0`)，函数留着等以后 alpha 形态学 dilate 出外轮廓再用。
6. **Screenshot harness**：`pnpm screenshot [regex]` + Playwright headless + persistent userDataDir。注入纯黄 swatch 到 `pattern-cache:v1` → 等所有 `.model-item data-model-status=ready/fail` → toDataURL 截原生分辨率。`CLEAR_SHADING=1` 强制重算 maps。这套链路是发现 classifyShirt bug 的关键工具——单看 thumbnail 永远抓不到 preset 路由错。

## 下一步可能动作

按 ROI 排序：

1. **middle-tone 彩衫 (lumP95 90-200) preset 调研**（半天）— 米色、卡其、亮黄等中等亮度彩衫现在仍走原 color preset，复杂插画上是否复现"暗内容融合"问题待截图验证；如果有再加 darkColor 中间档
2. **alpha-aware lift**（1-2 小时）— liftMin 现在对半透明像素（alpha=0.3-0.5 的 smoke）补偿不足；改成 `lift_effective = liftMin / max(alpha, 0.3)` 把半透明区也抬起来
3. **B1 边缘内阴影 — 形态学版**（半天）— 用 alpha 二值化 + dilate-erode 抽外轮廓 mask，只对外轮廓 ring，避开复杂插画的内部 alpha 边
4. **程序生成褶皱层**（半天）— 给"照片本身完全没褶皱"的衫兜底，Perlin 纵向条纹 + 姿态法向
5. **预烤织物/褶皱贴图**（1–2 小时）— 通用 PNG warp 进印花 quad，hard-light 叠 ~15%
6. **切 pixi.js + PSD 位移管线**（1–2 天 + 美术 asset）— RESEARCH.md §3.1 C 推荐路；最终质量但是另起一个项目体量

## 已知限制

- 单 canvas 2D 合成，无真位移（褶皱只是亮度调制，不会让图案"弯曲"）
- 圆柱弯曲是固定指数，不跟随真实身体姿态
- 印花板 quad 来自 MediaPipe Pose 的 4 个关键点，对侧身 / 手举起 / 极端姿势鲁棒性差
- shading map 上限 128，凸起感全靠 Step 2.6 screen + Step 2.7 fabric 兜底，比真 hard-light 提亮要弱
- ~~preset 只有 3 档（white/black/color），深色彩衫（暗红、深蓝）和亮色彩衫共用同一档~~ — 127d304 后 black 档扩到 lumP95<90，覆盖了深色彩衫；middle-tone 彩衫（lumP95 90-200 的米色、卡其、亮黄等）仍然共享 color 档
- A1 stretch 不能凭空造出原图没有的褶皱信号；衫本身平整（坐姿胸前无折）的照片即使深色也看不出 fold cue，只能靠程序生成褶皱兜底
- liftMin 是 RGB-only 的简单 floor，对图案的半透明像素（猫插画 smoke 的 alpha=0.3-0.5 区域）只能部分提亮；alpha=0.5 的 byte-30 像素 lift 到 byte-50 后跟衫合成仍然偏暗。要彻底解决需要 alpha-aware 的 lift 公式（按 1/alpha 补偿）

## Screenshot harness（127d304）

`app/scripts/screenshot-thumbs.mjs` + `pnpm screenshot [filter]`。是这次发现 classifyShirt 死代码 bug 的关键工具，建议任何后续 shading / preset / blend 改动都用它做 byte-equal 检查。

```bash
# 跑全量 18 张 thumbnail
pnpm screenshot

# 筛选黑/红/蓝/绿/紫衫
pnpm screenshot 'black|red|blue|green|pulple'

# 强制清掉 sh-cache/wsh-cache localStorage 强制重算
CLEAR_SHADING=1 pnpm screenshot
```

输出到 `app/screenshots/<slug>.png`（原生 canvas 分辨率，不是 CSS 缩略图尺寸）。

启动时 inject 一个纯黄 512×512 swatch 到 `pattern-cache:v1`（dataUrl + box）触发首次 render，然后等 `.model-item[data-model-status=ready|fail]` 全部就位再截图。pose 检测结果走 Playwright persistent userDataDir 缓存到 `app/.playwright-cache/`，第二次 run 起飞快。

DEV 端 console.log 输出会被 forward 到脚本 stdout：

```
[A1] stretch black.png p50=13 p10=4 p90=25 → [10,120]
[classify] rgb=(9,13,14) lumP5=2 lumP95=26 sat=0.32 → black
[blend] lift=50 liftMin=50 foldMul=0.4 wideFoldMul=0.2 fabricMul=0.15
```

白衫不变性合约自动验证：

```bash
md5 -q before/M016_white_front.png after/M016_white_front.png  # 应 IDENTICAL
```

## 失败方案档案（避免重复踩坑）

下面这几条都试过，**回归到 e7014a3 之前的纯 Canvas2D 双频段 shading 路线最稳**。

### A. MediaPipe ImageSegmenter 衫 mask（confidence 0.25–0.55 软阈值）
**做法**：multi-class selfie 段，clothes 通道软阈值 → alpha mask，destination-in 切印花。  
**结果**：白衫白背景边界 confidence 模糊，掉块风险高；正常背景下边缘比 quad 切干净。  
**结论**：边界场景不稳，纯 4 点 quad 切的退化版本反而更鲁棒。要"精准 mask"得上 SAM/SAM2，浏览器跑不动。

### B. 浏览器 Depth Anything V2 Small 推位移（**2026-05-11 部分翻案**：见下方「位移派生管线」）
**做法**：`@huggingface/transformers` 跑 25 MB ONNX，输出深度灰度 → wsh 梯度 → R/G displace map → resample 印花 quad。  
**结果**：深度模型只看得到**身体宏观 3D**（胸口大致凸出），看不到布料**微观褶皱**。胸口 disp viz 是大片均匀褐色（局部梯度 ≈ 0），印花视觉无变化。  
**结论**：深度推位移**对"印花跟着褶皱弯"无效**——褶皱细节根本不在 DAv2 输出范围内。

**翻案点（2026-05-11）**：DAv2 的输出对**身体宏观 wrap**（不是微观褶皱）是合适的工具——只是不能用 Sobel-of-depth（凸面中心梯度=0 的同一个物理盲区），要换成「绝对深度径向 drop warp」。详见下方「位移派生管线」章节。原档案的"无效"结论只针对当时的目标（找微观褶皱）。

### C0. B1 图案边缘内阴影（127d304 实现 → 关闭）
**做法**：`applyEdgeInnerShadow(tmp, bbox, blurPx, strength)` —— Porter-Duff 三步：
1. 把 `tmp` bbox 拷到 buf
2. `source-in` 填 `rgba(0,0,0,strength)`，buf 变成"纯黑 mask × tmp 原 alpha"
3. `destination-out` blur(2px) drawImage(tmp)，把内部减掉，剩内 ring
4. tmp `source-atop` drawImage(buf)，ring 只画在有 alpha 的地方

**结果**：单 alpha 边方块（纯黄 swatch test）效果好，看起来像"陷进布料 1.5 px"。但用户实测复杂插画（猫主题，几十到几百条内部 alpha 边）→ 每条边都加 2 px 暗 ring → 累加成大片黑斑，比无 B1 时 sticker 感更糟。

**结论**：B1 在简单 logo / 文字印花上可用，**对复杂插画 scale O(n) 失败**。要做 B1 必须先用 alpha 形态学（外轮廓 dilate-then-erode）抽出 pattern 的"外边界"，再只对外边界上 ring。代码留在 `ModelGrid.tsx`（`applyEdgeInnerShadow` 函数 + `edgeShadowPx/Alpha` PresetCfg 字段），所有 preset 当前 alpha=0，等以后做形态学再启用。

### C. WebGL fragment shader 一次性合成（含 SharedGL 单例 + drawImage 拷贝）
**做法**：把 hard-light / wide-shading / highlight / fabric / displace / garment-blend 全部端到端合成进一个 GLSL fragment shader；module 级单例 GL context 走 offscreen + Canvas2D drawImage 分发到各 thumb。  
**结果**：
- ❌ **比 Canvas2D 更卡**——drawImage 从 WebGL canvas 到 Canvas2D 涉及 GPU→CPU readback，每张 thumb 多一次 sync，整体反而比纯 Canvas2D 慢
- ❌ 黑衫看着还是纯阴影——shader 只是把同样的数学搬到 GPU 跑，没改算法，结果当然一样
- ❌ 白衫图案有掉块——hard-light 的 alpha clamp 边界 + garment blend 公式精度跟 Canvas2D globalAlpha+globalCompositeOperation 路径有微小差异，叠加 SharedGL drawImage 路径在某些 RGB 区间出问题  

**结论**：Recraft 那种"丝滑"靠的是**后端预烘 4 张资产** + 前端 WebGL displace shader，**不是把现有 2D 数学翻译成 shader**。在我们这个"美工 0 + 后端 0"的约束下，**纯 shader 化对最终效果零增益**，反而引入新的渲染路径 bug。

### D. 路径推断（未来可能采纳）
按可行性 / 成本 / 上限排序：
1. **接 Recraft API（路线 K1）**——半天，30 张/天免费，质量 = Recraft 本人
2. **Replicate SDXL inpaint + IP-Adapter（路线 H）**——1–2 天，可定制，~$0.005–0.05/张
3. **自烘 1 件四件套（PS）+ pixi.js displacement filter**（路线 C）——美工 1–2 小时/件，质量 Recraft 同档但需积累模板库
4. **自建 ComfyUI 服务跑 Sapiens-Normal**——周级工时 + ~$300/月 GPU，能复现 Recraft 自动烘流水线，长尾需求

---

# 位移派生管线（`/displace`）— 2026-05-11

跟「明暗对比」管线（`/`）独立的另一条路。Recraft 风格的「3D 贴合」靠这条路实现。HashRouter 切换：`/` 是双频段 shading 缩略图网格，`/displace` 是单图 + WebGL shader。

## 总览

输入：

- `photo` — 模特照（任意，DAv2 通用）
- `pattern` — 印花图（带 alpha）
- `quad` — pose 检测出的印花板四边形（沿用 shading 路的 MediaPipe pose）
- `depth` — DAv2 Base 输出的深度图（首次 ~7s WebGPU，后续从 cache）

输出：单张 canvas，印花径向贴合身体凸面，自动跟随姿态。

文件：
- `app/src/displace/depthPipeline.ts` — DAv2 单例 + 推理
- `app/src/displace/useDepthMap.ts` — 三层缓存 hook（mem → localStorage → run）
- `app/src/displace/displaceShader.ts` — WebGL fragment shader
- `app/src/displace/DisplaceCanvas.tsx` — r3f 包装，绑定 uniforms
- `app/src/displace/DisplacePage.tsx` — UI + 状态编排

## 核心算法：径向 drop warp

**问题**：Sobel-of-depth 在身体凸面中心（如胸口正前方）梯度 ≈ 0，displace 信号为零，印花贴不上。这是失败档案 B 当时的死路。

**解法**：不用梯度，**用绝对深度的径向落差**。

```
zCenter = depth(印花中心)                  // CPU 端预算，传 uniform
zHere   = depth(当前像素)                  // shader 内 texture2D(uDisplace)
drop    = clamp((zCenter - zHere) / zCenter, 0, 1)
                                            // 印花中心 drop=0；身体侧面 drop>0
puv_warped = printCenter + (puv - printCenter) * (1 + drop * uDepthWrap * uStrength)
                                            // 径向外推 → 视觉上印花往中心压缩
patUV = photoToPatternUV(puv_warped)
```

效果：

- 印花**中心**：drop=0，原位采样，无变形
- 印花**边缘**：drop>0，源像素往外采，pattern 视觉压缩 = cylinder wrap
- 自动跟 pose（quad u 轴沿肩线）+ 跟身体姿态（depth 反映真实 3D）
- 帽子 / 包 等任意凸物都能处理，因为 DAv2 是通用深度模型

`uDepthWrap` 是滑杆「贴合强度」，0–10 范围，默认 5.0。

## DAv2 推理路径

```
photo → HTMLImageElement
     → RawImage (canvas readback)        // depthPipeline.ts: estimateDepth()
     → DAv2 Base (WebGPU fp32)           // ~7s 首次，~1-2s 后续
     → RawImage (depth grayscale ~518×518)
     → 上采样到 photo native size (bilinear)
     → HTMLCanvasElement (depth map)
```

WebGPU fall back 到 WASM；Apple Silicon / 现代 dGPU 上 WebGPU 推理 ~2-7s，WASM 是 10-20s。

## 缓存

按 `src` URL 三层：

| 层 | 命中速度 | 限制 |
|---|---|---|
| `depthMemCache` (Map) | 同 session 即时 | 切 photo 再切回来不重算 |
| `depth-cache:v1` (localStorage 半res JPEG) | 100-200 ms 解码 | 跨 reload 持久；~50-100 KB / 张 |
| 重新跑 DAv2 | 7s+ | 上面两层都 miss 时 |

跟 sh-cache / wsh-cache / hl-cache 同套机制（`shading/cache.ts`）。

## Cloth integration（移植自 shading 路）

DAv2 出深度只解决几何 wrap，不解决"贴纸感"。shader 里同时做：

- **色彩融合**（`uTint`，默认 0.20）：印花 RGB 染上衫色调，per-channel gain `1 - tint·(1 - shirt_norm_channel)`
- **黑度抬升**（`uLift`，默认 0.05）：印花纯黑抬到 byte uLift×255，避免沉到衫色阴影里
- **0.5 px alpha 模糊**（`rasterizePattern`）：印花外轮廓软化，杀 sticker 边

这三个加起来 ≈ shading 路 `applyGarmentBlend` + 0.5px composite blur。

## 性能优化点（2026-05-11）

发现的几个瓶颈和修法：

1. **sampleGarment 拖动重跑**：原来 quad 改一次就重扫全图（~50-200 ms）。改成按 `photoSrc` 缓存（衫色跟印花位置无关）
2. **`photoSize` 对象字面量每渲染重建** → 触发依赖它的 useMemo / useQuadDrag 失效。`useMemo([photo])` 稳定引用
3. **`printCenterUV` / `garmentRGB` 每渲染新数组** → 子组件 useEffect 重炸。useMemo 稳定
4. **`zCenter` shader 内每像素采**：CPU 预算一次当 `uZCenter` uniform，省一次 texture2D / fragment

剩余瓶颈：DAv2 首次推理无并行（~7s 阻塞主线程）；后续可考虑 web worker 跑推理。

## UI 控制

| 滑杆 / 开关 | 默认 | 范围 |
|---|---|---|
| 强度 | 1.0 | 0–1 |
| 幅度 | 10.0 px | 0–20 |
| 反向位移 | 关 | bool |
| 光照 | 0.30 | 0–1 |
| 色彩融合 | 0.20 | 0–0.5 |
| 黑度抬升 | 0.05 | 0–0.4 |
| **贴合强度** | **5.0** | **0–10** |
| 圆柱角度 | 0° | 0–90° |
| 身体阴影 | 0 | 0–1 |
| 位移源 | 深度 | 深度 / DoG (旧) |
| Debug | 合成 | 合成 / 位移 / 光照 / Shading |

「圆柱角度」「身体阴影」是早期纯几何 wrap 的实验滑杆，**用户拒绝过 2 次**（看到"图案横向拉伸"），默认关，留作对比。「贴合强度」=「圆柱角度」的物理替代品。

## 已知限制

- DAv2 Base 100 MB 首入下载 + ~7s 推理，首次体验差
- DAv2 输出分辨率固定 ~518²，上采样到 4K photo 时身体边缘有 1-2 px 模糊
- 非站立 / 非正面姿势深度估计可能不准（DAv2 训练集偏向站立人像）
- 「贴合强度」5.0 在大多数胸口印花上合适，胸大 / 凸度大的可能要降到 3-4
- shader 内 `if (uDepthWrap > 0)` 分支：所有 fragment 走同一分支，性能上等价于无分支
