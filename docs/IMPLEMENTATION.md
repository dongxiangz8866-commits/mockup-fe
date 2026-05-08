# 样机系统 · 技术实现文档

本文档详细说明 `mock-research_test/app` 中前端样机系统（clothing 样机系统 / mockup）的技术实现。系统目标：用户上传一张 2D 平面图案 (PNG/JPG)，系统在三个视图中实时生成"印在 T 恤上"的视觉效果：

1. **2D UV 编辑器** — 显示衣身轮廓 + 可印区域，用户可以拖拽/缩放图案
2. **3D 模型预览** — 把图案以纹理形式贴到 GLB 模型的前片上
3. **真人模特合成** — 在 7 张真人照片上，把图案"印"到衣服区域

三个视图共用同一份"已上传图案"和"放置位置"，由共享纹理管线驱动同步刷新。

---

## 目录

- [1. 整体架构](#1-整体架构)
- [2. 共享纹理管线](#2-共享纹理管线)
- [3. 坐标系与尺寸](#3-坐标系与尺寸)
- [4. UV 编辑器 (Editor2D)](#4-uv-编辑器-editor2d)
- [5. T 恤轮廓生成 (shirtOutline)](#5-t-恤轮廓生成-shirtoutline)
- [6. 3D 视图 (Viewer3D)](#6-3d-视图-viewer3d)
- [7. 真人模特合成 (ModelGrid)](#7-真人模特合成-modelgrid)
- [8. 姿态检测 (poseDetector)](#8-姿态检测-posedetector)
- [9. 关键算法详解](#9-关键算法详解)
- [10. 文件结构](#10-文件结构)
- [11. 配置常量速查](#11-配置常量速查)

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                          App.tsx                             │
│  ┌──────────────┐   ┌────────────────────────────────────┐  │
│  │  Editor2D    │   │            ModelGrid                │  │
│  │  (UV 编辑器) │   │  (7 张真人照片网格)                 │  │
│  ├──────────────┤   │                                     │  │
│  │  Viewer3D    │   │                                     │  │
│  │  (3D 模型)   │   │                                     │  │
│  └──────────────┘   └────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
              ↓                            ↓
              ↓                            ↓
       ┌──────────────────────────────────────┐
       │      textureStore.ts (共享状态)      │
       │  · sharedCanvas / sharedCtx          │
       │  · sharedTexture (THREE.CanvasTex)   │
       │  · photoPatternCanvas                │
       │  · setPatternRelBox / getPatternRel… │
       │  · markTextureDirty + listeners      │
       └──────────────────────────────────────┘
```

**数据流：**

1. 用户在 Editor2D 上传图案 → Editor2D 把图案绘制到 `sharedCanvas` 上 → 调用 `markTextureDirty()`
2. `markTextureDirty()` 把 `sharedTexture.needsUpdate = true`，并通知所有订阅者 (ModelGrid 重渲染)
3. Viewer3D 通过 `useFrame` (react-three-fiber) 自动看到 `sharedTexture` 的变化
4. ModelGrid 在订阅回调里把 `photoPatternCanvas` 的图案合成到每张照片

这是一个**单源数据流** (single source of truth)：图案放置位置只在一处编辑，三处读取。

---

## 2. 共享纹理管线

文件：[`app/src/textureStore.ts`](../app/src/textureStore.ts)

### 2.1 sharedCanvas — 4K UV 纹理

```ts
export const TEX_W = 4096;
export const TEX_H = 4096;
const canvas = document.createElement('canvas');
canvas.width = TEX_W;
canvas.height = TEX_H;
export const sharedCanvas = canvas;
export const sharedCtx = canvas.getContext('2d')!;
```

这是一张 **4096 × 4096 像素**的离屏 canvas，用作 3D 模型的 `MeshStandardMaterial.map`。坐标系是模型 UV 空间：

- `(0, 0)` 对应 UV `(0, 0)`
- `(TEX_W, TEX_H)` 对应 UV `(1, 1)`

Editor2D 把用户图案绘制到这张 canvas 的"可印区域"对应的像素矩形内，然后通过 `sharedTexture.needsUpdate = true` 把这张 canvas 的最新像素上传到 GPU。

**为什么用 4K：** 模型本身可能放大到接近实物比例（30 cm 印花在 56 cm 衣身上）。1K (1024) 纹理在打印区会出现像素化；4K 提供 ≥200 DPI 的有效分辨率。

### 2.2 sharedTexture — Three.js 纹理对象

```ts
export const sharedTexture = new THREE.CanvasTexture(canvas);
sharedTexture.colorSpace = THREE.SRGBColorSpace;
sharedTexture.flipY = false;
sharedTexture.anisotropy = 16;
sharedTexture.minFilter = THREE.LinearMipmapLinearFilter;
sharedTexture.magFilter = THREE.LinearFilter;
sharedTexture.generateMipmaps = true;
```

关键点：

- `flipY = false`：GLTF 加载器期望的 V 轴方向；如果 `flipY = true` 会上下颠倒
- `anisotropy = 16`：各向异性过滤的最大值，使纹理在斜视角度下也保持锐利
- `LinearMipmapLinearFilter` (三线性) + 自动生成 mipmap：缩小时不闪烁
- `colorSpace = SRGBColorSpace`：让纹理颜色经过 GPU 的 sRGB 解码 → 线性空间运算 → 再编码回 sRGB，避免颜色失真

### 2.3 photoPatternCanvas — 真人合成专用

```ts
export const PHOTO_PATTERN_W = 2048;
export const PHOTO_PATTERN_H = Math.round((2048 * 45.72) / 40.64);  // = 2304
```

**这是一个独立的 canvas**，宽高比严格等于压板尺寸 16:18 (40.64 × 45.72 cm)。Editor2D 把用户图案按"图案在压板内的相对位置"绘制到这张 canvas 上。

ModelGrid 把这张 canvas warp 到照片上的衣服区域。

**为什么不直接用 `sharedCanvas`：** `sharedCanvas` 是模型 UV 空间，包含了大量空白区域（衣身只占 UV 的一部分）。如果直接 warp 整张 4K canvas 到照片，需要把 photo 上的"压板区域"对应到模型 UV 上的"压板区域"，多一道映射。`photoPatternCanvas` 直接代表"压板内容"，省去这一步。

### 2.4 patternRelBox — 图案相对位置

```ts
export type PatternRelBox = { u: number; v: number; w: number; h: number };
let patternRelBox: PatternRelBox | null = null;
export function setPatternRelBox(b: PatternRelBox | null) { … }
export function getPatternRelBox(): PatternRelBox | null { … }
```

这是图案在压板内的归一化矩形（0..1 范围）。例如 `{u: 0.2, v: 0.1, w: 0.5, h: 0.6}` 表示图案占据压板的 (20%~70%, 10%~70%) 区域。

ModelGrid 用它来计算高通图（high-pass）应该裁剪到压板的哪个子区域。

### 2.5 订阅 / 通知

```ts
let listeners: Array<() => void> = [];
export function subscribePattern(cb: () => void): () => void { … }
export const markTextureDirty = () => {
  sharedTexture.needsUpdate = true;
  for (const l of listeners) l();
};
```

ModelGrid 的每个 `<ModelComposite>` 实例都通过 `subscribePattern(render)` 订阅。当 Editor2D 修改图案后，所有订阅者重渲染。

3D 视图不需要订阅，因为 `sharedTexture.needsUpdate = true` + react-three-fiber 的 `useFrame` 自然会在下一帧上传新像素。

---

## 3. 坐标系与尺寸

### 3.1 尺码表 (Memebuy 白坯 男T TEE001 — M 码)

文件：[`app/src/modelAssets.ts`](../app/src/modelAssets.ts)、[`app/src/shirtOutline.ts`](../app/src/shirtOutline.ts)

| 维度 | 数值 (cm) | 用途 |
|---|---|---|
| 衣长 | 68 | 衣身高度 (V 轴 0..1) |
| 胸围 / 2 | 56.5 | 衣身宽度 (U 轴 0..1) |
| 肩宽 | 53 | 肩缝两端 inset 1.75 cm |
| 下摆围 / 2 | 57 | 下摆比胸围外扩 0.25 cm/侧 |
| 袖长 | 23.5 | 沿袖缝方向长度 |
| 袖口围 / 2 | 18.75 | 平铺袖口宽度（垂直袖缝） |

### 3.2 压板规格（同尺码表）

| 维度 | 数值 | 含义 |
|---|---|---|
| 宽 | 40.64 cm (16 in) | 压板水平宽度 |
| 高 | 45.72 cm (18 in) | 压板垂直高度 |
| 正面领下 | 5 cm | 压板顶端距前领口 |

### 3.3 派生常量

```ts
const CLOTH_W_CM = 113 / 2;       // = 56.5
const CLOTH_H_CM = 68;
export const PRINT_W_CM = 40.64;
export const PRINT_H_CM = 45.72;
export const PRINT_W_UV = PRINT_W_CM / CLOTH_W_CM;  // = 0.7193
export const PRINT_H_UV = PRINT_H_CM / CLOTH_H_CM;  // = 0.6724
export const PRINT_U = 0.5 - PRINT_W_UV / 2;        // = 0.140
export const PRINT_V = 12 / CLOTH_H_CM;             // = 0.176
                                                     // (= 7 cm 领口深度 + 5 cm 领下)
export const EDITOR_V_FACTOR = CLOTH_H_CM / CLOTH_W_CM;  // = 1.2035
```

### 3.4 三套坐标系

| 坐标系 | 范围 | 含义 |
|---|---|---|
| **归一化 UV** | `U ∈ [0, 1]`, `V ∈ [0, 1]` | 衣身的归一化位置；所有视图共用 |
| **3D 网格 UV (raw)** | `U ∈ [-0.013, 9.606]`, `V ∈ [21.027, 0.284]` | GLB 文件里 mesh 自带的原始 UV，需要重映射 |
| **照片像素** | `(0, 0)` ~ `(naturalW, naturalH)` | 真人照片的原始像素 |

**3D Mesh UV 重映射**（[`Viewer3D.tsx`](../app/src/Viewer3D.tsx)）：

```ts
const rangeU = FBX_FRONT_UV_BOUNDS.maxU - FBX_FRONT_UV_BOUNDS.minU;  // 9.619
const rangeV = FBX_FRONT_UV_BOUNDS.maxV - FBX_FRONT_UV_BOUNDS.minV;  // -20.743 (V 翻转)
sharedTexture.repeat.set(1 / rangeU, 1 / rangeV);
sharedTexture.offset.set(-FBX_FRONT_UV_BOUNDS.minU / rangeU, -FBX_FRONT_UV_BOUNDS.minV / rangeV);
```

这把 mesh 的 raw UV `[-0.013, 9.606] × [0.284, 21.027]` 映射回归一化 `[0, 1] × [0, 1]`。**注意 `minV > maxV`**：原 OBJ 导出的 V 轴是反向的（V=21 在衣身顶部，V=0.28 在底部），重映射后 `V_normalized=0` 对应衣身顶部、`V_normalized=1` 对应下摆。

---

## 4. UV 编辑器 (Editor2D)

文件：[`app/src/Editor2D.tsx`](../app/src/Editor2D.tsx)

### 4.1 视觉布局

- 380 × 320 px 的 stage
- SVG 渲染：T 恤轮廓 (`SHIRT_OUTLINE_PATH_D`) + 前领口曲线 (`SHIRT_FRONT_NECK_PATH_D`) + 压板虚线矩形 + 角标 (`bracket`)
- 上传后，图案以 HTML `<div className="pattern-box">` 浮在 SVG 之上，可拖拽/缩放
- DPI 提示：图案的物理 DPI = `naturalWidth / inches`，<100 红色，<200 黄色，≥200 绿色

### 4.2 坐标变换 — `computeTransform()`

```ts
const uvW = FOCUS_BOUNDS.maxU - FOCUS_BOUNDS.minU;
const uvH = FOCUS_BOUNDS.maxV - FOCUS_BOUNDS.minV;
const scaleU = Math.min(DISPLAY_W / uvW, DISPLAY_H / (uvH * EDITOR_V_FACTOR));
const scaleV = scaleU * EDITOR_V_FACTOR;
```

`EDITOR_V_FACTOR = CLOTH_H_CM / CLOTH_W_CM = 1.2035` 让 1 cm 在 U 轴和 V 轴在屏幕上等长。如果不乘这个因子，UV `[0,1] × [0,1]` 会被画成正方形，但实际衣身是 56.5 cm 宽 × 68 cm 高，应该看起来略竖。

`Math.min(width-bound, height-bound)` 保证 silhouette 完整放进 stage。

### 4.3 拖拽与缩放

```ts
type DragMode =
  | { kind: 'move'; offU: number; offV: number }
  | { kind: 'resize'; corner: 'nw' | 'ne' | 'se' | 'sw'; orig: Box; ratio: number }
  | null;
```

- **move**：记录指针落点和 box 左上角的 UV 偏移；每次 pointer 移动重设 box 位置
- **resize**：记录起点 box 和源图宽高比；按对角缩放，保持图案像素比不变
- **吸附 (snap)**：图案中心距离压板中心 < `SNAP_THRESHOLD_UV = 0.003` 时自动吸附 + 显示红色虚线

### 4.4 图案 → 纹理 — `paintTexture()`

核心两步：

**Step 1：写入 sharedCanvas (3D 模型用)**

```ts
const texBox = { u: 1 - box.u - box.w, v: box.v, w: box.w, h: box.h };
// 注意 U 翻转：3D 模型贴图是镜像的（前片是从模特视角看的"右"在屏幕"左"）
const tx = texBox.u * TEX_W;
const ty = texBox.v * TEX_H;
const tw = texBox.w * TEX_W;
const th = texBox.h * TEX_H;
const clipX = (1 - PRINT_U - PRINT_W_UV) * TEX_W;
const clipY = PRINT_V * TEX_H;
const clipW = PRINT_W_UV * TEX_W;
const clipH = PRINT_H_UV * TEX_H;

sharedCtx.save();
sharedCtx.beginPath();
sharedCtx.rect(clipX, clipY, clipW, clipH);
sharedCtx.clip();
sharedCtx.scale(-1, 1);  // U 翻转
sharedCtx.drawImage(img, 0, 0, tw, th);  // 在压板裁剪区内绘制图案
sharedCtx.restore();
```

`ctx.clip(rect)` 限制后续绘制只在压板矩形内有效；超出压板的图案被裁掉。

**Step 2：写入 photoPatternCanvas (真人合成用)**

```ts
const relU = (box.u - PRINT_U) / PRINT_W_UV;  // 图案相对压板的位置
const relV = (box.v - PRINT_V) / PRINT_H_UV;
const relW = box.w / PRINT_W_UV;
const relH = box.h / PRINT_H_UV;
setPatternRelBox({ u: relU, v: relV, w: relW, h: relH });

photoPatternCtx.drawImage(
  img,
  relU * PHOTO_PATTERN_W,
  relV * PHOTO_PATTERN_H,
  relW * PHOTO_PATTERN_W,
  relH * PHOTO_PATTERN_H,
);
```

`photoPatternCanvas` 完全不是 UV 空间；它直接代表压板的物理比例 (40.64:45.72)，所以 ModelGrid 不再需要知道 cloth UV。

### 4.5 持久化

`localStorage` 缓存最近一次上传：

```ts
const PATTERN_CACHE_KEY = 'pattern-cache:v1';
type PatternCache = { dataUrl: string; box: Box };
```

刷新后自动恢复，避免每次都要重新上传。

---

## 5. T 恤轮廓生成 (shirtOutline)

文件：[`app/src/shirtOutline.ts`](../app/src/shirtOutline.ts)

### 5.1 设计原则

之前的版本从 3D mesh 抽取边界边（`uvOutline.ts`，已删除），存在两个问题：

1. mesh 的 UV 边界是不规则的多边形，难看
2. 短袖 mesh 是闭合曲面（无拓扑边界边），袖子画不出来

新方案：**直接从尺码表数值参数化生成**一个风格化 SVG path。所有几何都来自 M 码尺码：

```ts
const BODY_W_CM = 56.5;        // 胸围 113 / 2
const BODY_H_CM = 68;          // 衣长
const SHOULDER_W_CM = 53;      // 肩宽
const HEM_W_CM = 57;           // 下摆围 114 / 2
const SLEEVE_LEN_CM = 23.5;    // 袖长
const CUFF_FLAT_CM = 18.75;    // 袖口围 / 2
```

加上几个尺码表没给的、风格化估计值：

```ts
const NECK_HALF_W_CM = 7;
const NECK_DEPTH_FRONT_CM = 7;
const NECK_DEPTH_BACK_CM = 2.5;
const ARMPIT_FROM_TOP_CM = 22;
const SHOULDER_DROP_CM = 4;
const SLEEVE_DROOP_DEG = 35;   // 袖子下垂角度
```

### 5.2 关键几何

**肩线斜度**：肩缝从领口角向外、向下斜到肩端点：

- 领口角 `(NECK_LEFT_U, 0)` = 衣身最高点
- 肩端点 `(SHOULDER_LEFT_U, SHOULDER_DROP_V)` = 比领口角低 4 cm，且 inset 1.75 cm

**袖子下垂**：袖子从肩端点出发，方向是水平偏下 `SLEEVE_DROOP_DEG` 度。袖口 (cuff) 垂直于袖缝方向（不是垂直）：

```ts
// 袖缝方向（左袖）：(-cos θ, sin θ)
const leftCuffTop = {
  u: shoulderLeft.u - SLEEVE_LEN_CM * cos(θ) / BODY_W_CM,
  v: shoulderLeft.v + SLEEVE_LEN_CM * sin(θ) / BODY_H_CM,
};
// 袖口方向（袖缝顺时针 90°）：(sin θ, cos θ)
const leftCuffBot = {
  u: leftCuffTop.u + CUFF_FLAT_CM * sin(θ) / BODY_W_CM,
  v: leftCuffTop.v + CUFF_FLAT_CM * cos(θ) / BODY_H_CM,
};
```

**注意**：U 和 V 的物理尺度不同（U=1 对应 56.5 cm，V=1 对应 68 cm）。所以三角函数要先在 cm 空间算出 (Δx, Δy)，再分别除以 `BODY_W_CM` / `BODY_H_CM` 得到 UV 偏移。

**下摆外扩**：

```ts
const HEM_OUTSET_U = (HEM_W_CM - BODY_W_CM) / 2 / BODY_W_CM;  // 0.0044
const HEM_LEFT_U = -HEM_OUTSET_U;
const HEM_RIGHT_U = 1 + HEM_OUTSET_U;
```

下摆比胸围宽 0.5 cm，每边外扩 0.25 cm（≈0.44% 衣身宽）。

### 5.3 路径绘制顺序（顺时针）

```
M  左袖口顶
L  左肩端点（袖子顶边外侧）
L  左领口角（肩缝向上向内）
Q  后领口曲线
L  右肩端点
L  右袖口顶（袖子下垂方向）
L  右袖口底（垂直于袖缝）
Q  右袖底曲线 → 右腋
L  右下摆角（下摆外扩）
L  左下摆角（下摆水平）
L  左腋（衣身左侧上行）
Q  左袖底曲线 → 左袖口底
L  左袖口顶（封闭）
Z
```

衣身肩端点 → 衣身腋下这一段（在 silhouette 内部、被袖子覆盖）**不画**。

### 5.4 前后领分层

后领作为主路径的一部分（浅曲线 `NECK_DEPTH_BACK = 2.5/68 = 0.037`），前领单独画一条更深的内曲线（`NECK_DEPTH_FRONT = 7/68 = 0.103`）：

```ts
export const SHIRT_FRONT_NECK_PATH_D =
  `M${NECK_LEFT_U + 0.012} 0 Q 0.5 ${NECK_DEPTH_FRONT} ${NECK_RIGHT_U - 0.012} 0`;
```

视觉上呈现"领圈双线"效果，匹配印刷模板风格。

---

## 6. 3D 视图 (Viewer3D)

文件：[`app/src/Viewer3D.tsx`](../app/src/Viewer3D.tsx)

### 6.1 模型加载

```ts
import { GLTFLoader } from 'three-stdlib';
const gltf = useLoader(GLTFLoader, SOURCE_MODEL_URL);
const cloned = useMemo(() => gltf.scene.clone(true), [gltf]);
```

模型从 OBJ 转换为 GLB（脚本：`scripts/`，工具：`obj2gltf`）。**为什么不用 FBX**：

- FBX 文件 10 MB，GLB 7.9 MB
- `FBXLoader` 比 `GLTFLoader` 慢 3-5 倍（FBX 有自己的解析器，GLTF 解析就是 JSON + glTF 二进制 buffer）
- GLB 加载完后启动延迟 < 1 s

### 6.2 材质改造

```ts
cloned.traverse((obj) => {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh) return;
  const tuned = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((mat) => {
    const next = mat.clone() as THREE.MeshStandardMaterial;
    next.color = new THREE.Color('#ffffff');
    next.metalness = 0;
    next.roughness = 0.86;
    next.side = THREE.DoubleSide;
    if (mesh.name === FRONT_CLOTH_MESH) {
      next.map = sharedTexture;  // 只把前片接入 sharedTexture
    }
    return next;
  });
  mesh.material = Array.isArray(mesh.material) ? tuned : tuned[0];
});
```

要点：

1. **所有衣片纯白**（`color = #ffffff`）：模型原贴图可能有杂色，覆盖掉
2. **`roughness = 0.86`** + `metalness = 0`：模拟棉布的漫反射
3. **`DoubleSide`**：避免某些几何法线翻转的衣片显示成空洞
4. **只有前片 (`FRONT_CLOTH_MESH`) 挂 sharedTexture**：其他衣片（背面、袖子、领口）保持纯白

### 6.3 mesh.name 的坑

GLTFLoader 把 mesh 命名为**节点 (node) 名字**，不是 mesh 定义的名字。所以前片 mesh 的 `name` 是 `'ClothPiece_Fabric_0_ClothPiece_3'`（来自 GLB 的 `nodes[].name`），不是 mesh JSON 里 `meshes[].name` 那个带 `_1` 后缀的。

之前没注意这点，导致前片找不到、贴图不上去。修复后在 `modelAssets.ts` 显式记录：

```ts
export const FRONT_CLOTH_MESH = 'ClothPiece_Fabric_0_ClothPiece_3';
```

### 6.4 视角切换

```ts
const VIEW_DIRS = {
  front: { dir: [0, 0.08, 1] },
  back:  { dir: [0, 0.08, -1] },
  left:  { dir: [-1, 0.08, 0.1] },
  right: { dir: [1, 0.08, 0.1] },
};
```

`<CameraRig view={view}>` 监听 `view` 变化，把相机摆到 `target + dir * distance`，保持距离 + 视角焦点不变。

---

## 7. 真人模特合成 (ModelGrid)

文件：[`app/src/ModelGrid.tsx`](../app/src/ModelGrid.tsx)

### 7.1 流程概览

每张照片走以下流水线：

```
1. 加载图片 → 2. 检测姿态 → 3. 计算 4 顶点 → 4. warp 图案
                                              ↓
6. 绘制完成 ← 5. 合成多通道 (multiply / hard-light)
```

### 7.2 姿态检测 → 校准的 cloth UV

MediaPipe BlazePose 返回 33 个关键点的归一化坐标。我们只用 4 个：左/右肩 (11/12)、左/右髋 (23/24)。

**校准常量**：

```ts
const MIDSHOULDER_CLOTH_V = 0.10;   // 肩关节在衣身上的归一化 V
const MIDHIP_CLOTH_V = 0.90;        // 髋关节 V
const SHOULDER_SPAN_OF_CLOTH_W = 0.85;  // 肩跨距 / 衣身宽
```

为什么是 0.10 和 0.90 而不是 0.0 和 1.0？

- MediaPipe 的肩关节在三角肌附近，**不**在衣身最高点。它实际位置约 5-7 cm 低于肩缝，归一化 ≈ V=0.10
- 髋关节 + 衣摆有约 6-8 cm 富余 → 髋关节 ≈ V=0.90

### 7.3 把 cloth UV → 照片像素

```ts
const PRINT_TOP_T = (PRINT_V - MIDSHOULDER_CLOTH_V) / (MIDHIP_CLOTH_V - MIDSHOULDER_CLOTH_V);
const PRINT_BOT_T = (PRINT_V + PRINT_H_UV - MIDSHOULDER_CLOTH_V) / (MIDHIP_CLOTH_V - MIDSHOULDER_CLOTH_V);
```

`PRINT_TOP_T` 是"压板顶"沿"中肩→中髋"轴的参数 t。然后：

```ts
const printTop = lerpPt(midShoulder, midHip, PRINT_TOP_T);
const printBot = lerpPt(midShoulder, midHip, PRINT_BOT_T);
```

### 7.4 处理身体倾斜

身体歪了之后，压板四角不能简单用 (printTop ± half_x_axis) 计算。我们按"沿身体轴的方向"决定**水平方向向量**：

```ts
const shoulderAngle = atan2(leftShoulder.y - rightShoulder.y, leftShoulder.x - rightShoulder.x);
const hipAngle = atan2(leftHip.y - rightHip.y, leftHip.x - rightHip.x);
const tiltAngle = (shoulderAngle + hipAngle) / 2;  // 平均
```

**为什么平均**：

- 单用肩线：举手时肩线被抬起，导致压板假性倾斜
- 单用髋线：身体真倾斜时髋线变化小，压板没跟上
- 平均：肩与髋一致 → 完整倾斜；肩异常但髋正常 → 倾斜被减半（消除手臂干扰）

最终 quad：

```ts
const halfMag = shoulderLen * 0.5 * PRINT_W_FRAC;
const halfX = cos(tiltAngle) * halfMag;
const halfY = sin(tiltAngle) * halfMag;
return {
  tl: { x: printTop.x - halfX, y: printTop.y - halfY },
  tr: { x: printTop.x + halfX, y: printTop.y + halfY },
  bl: { x: printBot.x - halfX, y: printBot.y - halfY },
  br: { x: printBot.x + halfX, y: printBot.y + halfY },
};
```

注意：四角是**平行四边形**（`tr - tl == br - bl`），不是任意四边形。这一点在 §9.1 单仿射 warp 中至关重要。

### 7.5 单仿射 warp（关键算法）

```ts
const tmp = document.createElement('canvas');
tmp.width = cv.width;
tmp.height = cv.height;
const tctx = tmp.getContext('2d')!;
const pw = photoPatternCanvas.width;
const ph = photoPatternCanvas.height;
const ax = (quad.tr.x - quad.tl.x) / pw;
const ay = (quad.tr.y - quad.tl.y) / pw;
const bx = (quad.bl.x - quad.tl.x) / ph;
const by = (quad.bl.y - quad.tl.y) / ph;
tctx.setTransform(ax, ay, bx, by, quad.tl.x, quad.tl.y);
tctx.drawImage(photoPatternCanvas, 0, 0);
tctx.setTransform(1, 0, 0, 1, 0, 0);
```

详细原理见 §9.1。这一段把 `photoPatternCanvas` (40.64:45.72 比例) 精确映射到平行四边形 quad。无三角划分，无缝。

### 7.6 抗锯齿合成 (createPattern + fill)

```ts
const patFill = ctx.createPattern(tmp, 'no-repeat');
ctx.globalCompositeOperation = 'multiply';
ctx.fillStyle = patFill;
ctx.beginPath();
ctx.moveTo(quad.tl.x, quad.tl.y);
ctx.lineTo(quad.tr.x, quad.tr.y);
ctx.lineTo(quad.br.x, quad.br.y);
ctx.lineTo(quad.bl.x, quad.bl.y);
ctx.closePath();
ctx.fill();
```

`globalCompositeOperation = 'multiply'`：图案像素 RGB 与衣服像素 RGB 相乘。白色 (1,1,1) 透明，深色保留。这就是"印在白衣服上"的效果。

**为什么用 fill 而不是 clip**：`ctx.clip()` 是二值光栅化，路径边缘是锯齿；`ctx.fill()` 路径边缘有抗锯齿。详见 §9.2。

### 7.7 高通图叠加（折痕保留）

衣服上原本有褶皱、阴影。如果只 multiply 图案，褶皱被图案覆盖；衣服看起来像贴纸，不像印的。

解法：**预先从原照片提取高通图**（亮度细节），印上图案后再用 `hard-light` 模式叠回去。

```ts
function buildHighPass(photo: HTMLImageElement, strength: number): HTMLCanvasElement {
  // 1. 模糊原图
  blurCtx.filter = `blur(${blurRadius}px)`;
  blurCtx.drawImage(photo, 0, 0);
  // 2. 像素级 (原 - 模糊) * strength + 128
  for (let i = 0; i < Od.length; i += 4) {
    const lO = Od[i] * 0.299 + Od[i + 1] * 0.587 + Od[i + 2] * 0.114;  // 原亮度 (BT.601)
    const lB = Bd[i] * 0.299 + Bd[i + 1] * 0.587 + Bd[i + 2] * 0.114;  // 模糊亮度
    const v = (lO - lB) * strength + 128;
    Dd[i] = Dd[i+1] = Dd[i+2] = clamp(v, 0, 255);
  }
}
```

得到一张灰度图：亮的地方 > 128 表示原图比模糊版亮（高光、突出），暗的地方 < 128 表示被遮挡（阴影、褶皱底部）。

合成时用 `hard-light`：原图灰阶 > 128 加亮，< 128 变暗。等于把"原图相对于平均亮度的偏离"叠加到印好图案的衣服上 → 折痕回来了。

**只裁剪到 sub-quad**：图案如果只占压板一部分（用户没填满），高通图也只在那块区域叠加，否则压板空白处也被加亮变暗，看起来像幽灵图案。

### 7.8 缓存策略

每张照片的姿态 + 高通图都用 `localStorage` 缓存：

```ts
const HIGHPASS_CACHE_PREFIX = 'hp-cache:v1:';  // key 含 strength，避免拉条改变后用旧缓存
const POSE_CACHE_PREFIX = 'pose-cache:v1:';
```

姿态检测一次约 200-500 ms（CPU），高通图建立 100-300 ms（取决于图大小）。缓存后第二次打开应用 < 50 ms。

---

## 8. 姿态检测 (poseDetector)

文件：[`app/src/poseDetector.ts`](../app/src/poseDetector.ts)

### 8.1 MediaPipe Tasks Vision

```ts
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
return PoseLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
  runningMode: 'IMAGE',
  numPoses: 1,
});
```

- `delegate: 'GPU'`：用 WebGL 跑模型（CPU fallback 也可以）
- `runningMode: 'IMAGE'`：每次 `lm.detect(img)` 是独立帧（VIDEO 模式会维持帧间状态）
- `numPoses: 1`：只跟踪一个人

### 8.2 BlazePose 关键点

返回 33 个 landmark，含 x/y (归一化 0..1) + z (相对深度) + visibility。我们只用 4 个：

```ts
export const POSE_INDEX = {
  leftShoulder: 11,    // 模特左肩 = 观察者画面右侧
  rightShoulder: 12,   // 模特右肩 = 观察者画面左侧
  leftHip: 23,
  rightHip: 24,
};
```

注意 `leftShoulder` 是**模特视角**的左（画面里看是右）。这影响 quad 顶点的命名。

### 8.3 模型尺寸

`pose_landmarker_lite.task` ≈ 5 MB。第一次访问需要下载 + WASM 初始化（约 1-2 s）。后续推理 < 200 ms / 张。

---

## 9. 关键算法详解

### 9.1 单仿射映射（矩形 → 平行四边形）

任意 2D 仿射变换可以写成 6 参数矩阵：

```
| ax  bx  ex |     | x_src |     | x_dst |
| ay  by  ey |  *  | y_src |  =  | y_dst |
| 0   0   1  |     |   1   |     |   1   |
```

要把矩形 `(0,0)-(pw,ph)` 映射到平行四边形 `(tl, tr, bl, br)`，需要让：

- `(0, 0)`     → tl
- `(pw, 0)`    → tr  ⇒ (ax, ay) * pw + (ex, ey) = tr
- `(0, ph)`    → bl  ⇒ (bx, by) * ph + (ex, ey) = bl
- `(pw, ph)`   → br  (自动满足，因为 br = tr + bl - tl 是平行四边形约束)

解得：

```ts
ex = tl.x;             ey = tl.y;
ax = (tr.x - tl.x) / pw;  ay = (tr.y - tl.y) / pw;
bx = (bl.x - tl.x) / ph;  by = (bl.y - tl.y) / ph;
```

Canvas 2D 直接支持这种变换：

```ts
ctx.setTransform(ax, ay, bx, by, ex, ey);
ctx.drawImage(photoPatternCanvas, 0, 0);
```

**整张图就一次仿射**，没有三角划分（之前用过 4-三角和 2-三角划分，都会因为像素级取整误差产生肉眼可见的对角缝）。前提是 quad **必须是平行四边形**——所以 §7.4 用了对称的 ±half 计算。

### 9.2 createPattern + fill 的抗锯齿

`ctx.clip(rect)` 把后续绘制限制在路径内，但 clip 路径本身是**二值光栅化**：每个像素要么在内、要么在外，没有部分覆盖。结果是 quad 边缘锯齿明显（特别是斜的边）。

`ctx.fillStyle = ctx.createPattern(canvas, 'no-repeat')` 创建一个填充模式，`ctx.fill()` 绘制路径时同时**采样模式**作为颜色。fill 路径边缘有抗锯齿（部分覆盖像素的 alpha 值在 0..255 之间）。

```
clip + drawImage  →  二值边缘，锯齿
fill + pattern    →  抗锯齿边缘
```

代价：pattern 不能 transform（创建时已经包含变换；这就是为什么 §7.5 先 warp 到一张离屏 canvas，再用那张 canvas 做 pattern）。

### 9.3 sub-quad 的双线性插值定位

高通图只裁到压板的一部分（用户图案占压板的子矩形）。已知 4 个角的照片像素位置 (tl, tr, bl, br)，要找到子矩形 `(u0, v0) - (u1, v1)` 在压板归一化坐标内的对应照片像素：

```ts
const bilerp = (u: number, v: number): Pt => {
  const lx = quad.tl.x + (quad.bl.x - quad.tl.x) * v;  // 沿左边线插值
  const ly = quad.tl.y + (quad.bl.y - quad.tl.y) * v;
  const rx = quad.tr.x + (quad.br.x - quad.tr.x) * v;  // 沿右边线插值
  const ry = quad.tr.y + (quad.br.y - quad.tr.y) * v;
  return { x: lx + (rx - lx) * u, y: ly + (ry - ly) * u };  // 在两条边线之间再插
};
```

平行四边形的双线性插值等价于仿射变换（因为对边平行），所以 sub-quad 也是平行四边形 → 同样可以用单仿射 warp。

### 9.4 `multiply` vs `hard-light`

Canvas 2D 的 `globalCompositeOperation` 实现的是 W3C 定义的混合模式：

| 模式 | 公式 (R/G/B 各自处理) |
|---|---|
| `multiply` | `dst * src` |
| `hard-light` | `src ≤ 0.5 ? 2*dst*src : 1 - 2*(1-dst)*(1-src)` |

(都把通道值归一化到 [0, 1])

- **multiply**：白源 (=1) 透明，深源覆盖。适合"印颜色到白布"
- **hard-light**：灰度 0.5 透明，亮变更亮、暗变更暗。适合"叠加局部对比度"

两阶段合成：
1. `multiply` 把图案颜色染到衣服
2. `hard-light` 把高通图的明暗变化叠回去 → 得到既有图案、又有原褶皱光影的合成

### 9.5 V 翻转的来历

GLB 是从 OBJ 转换来的；OBJ 的 V 轴习惯是"V=0 在底部、V=1 在顶部"，FBX 等其他格式是"V=0 在顶部"。

3D mesh 里 raw UV 范围 `V ∈ [0.284, 21.027]`，但**最高点对应 V=21.027，最低点对应 V=0.284**（OBJ 的 V 翻转习惯）。所以归一化时：

```ts
export const FBX_FRONT_UV_BOUNDS = {
  minV: 21.027,  // 注意 minV 是数值大的那个 — 表示"V 轴的起点"是衣身顶部
  maxV: 0.284,   // maxV 是数值小的 — "V 轴的终点"是衣身底部
};
```

`minV / maxV` 不是数值意义上的最小 / 最大，而是**语义上的起点 / 终点**。这样后续代码 `(v - minV) / (maxV - minV)` 在 V=21（顶部）时返回 0，在 V=0.28（底部）时返回 1。

---

## 10. 文件结构

```
app/src/
├── App.tsx                  # 顶层布局：左 Editor2D + Viewer3D，右 ModelGrid
├── main.tsx                 # ReactDOM 入口
│
├── modelAssets.ts           # 衣身 / 压板 / 模型 URL / FBX UV bounds 等常量
├── shirtOutline.ts          # 尺码表驱动的 T 恤轮廓 SVG path
├── textureStore.ts          # 共享 canvas + sharedTexture + listeners
│
├── Editor2D.tsx             # UV 编辑器（拖拽 + 缩放 + paintTexture）
├── Viewer3D.tsx             # 3D 视图（GLTFLoader + 视角切换）
├── ModelGrid.tsx            # 真人照片网格（姿态 + warp + 多通道合成）
├── SourceModelViewer.tsx    # （独立的）原始 mesh 调试视图
│
├── poseDetector.ts          # MediaPipe BlazePose 包装 + localStorage 缓存
│
├── app.css                  # 主样式（layout / editor / model-grid）
├── styles.css               # 全局 reset
└── vite-env.d.ts            # Vite 类型补丁（__MODELS__ 注入等）
```

```
app/public/
├── mock-models/             # GLB 模型
│   └── glb-no-model/霞湖世家男T-001.glb
└── mock-photos/             # 真人照片（7 张）
    └── *.jpg
```

```
app/
├── vite.config.ts           # Vite 配置（__MODELS__ define、模型/照片路径）
├── tsconfig.json
└── package.json
```

---

## 11. 配置常量速查

### 11.1 衣身尺寸 (modelAssets.ts / shirtOutline.ts)

| 常量 | 值 | 来源 |
|---|---|---|
| `BODY_W_CM` / `CLOTH_W_CM` | 56.5 | 胸围 113 / 2 |
| `BODY_H_CM` / `CLOTH_H_CM` | 68 | 衣长 |
| `SHOULDER_W_CM` | 53 | 肩宽 |
| `HEM_W_CM` | 57 | 下摆围 / 2 |
| `SLEEVE_LEN_CM` | 23.5 | 袖长 |
| `CUFF_FLAT_CM` | 18.75 | 袖口围 / 2 |
| `EDITOR_V_FACTOR` | 1.2035 | `BODY_H_CM / BODY_W_CM` |

### 11.2 压板 (modelAssets.ts)

| 常量 | 值 | 来源 |
|---|---|---|
| `PRINT_W_CM` | 40.64 | 16 in 压板宽 |
| `PRINT_H_CM` | 45.72 | 18 in 压板高 |
| `PRINT_W_UV` | 0.7193 | `PRINT_W_CM / CLOTH_W_CM` |
| `PRINT_H_UV` | 0.6724 | `PRINT_H_CM / CLOTH_H_CM` |
| `PRINT_U` | 0.140 | `0.5 - PRINT_W_UV / 2` |
| `PRINT_V` | 0.176 | `(7 cm 领口深度 + 5 cm 领下) / 68` |

### 11.3 风格化常量 (shirtOutline.ts)

| 常量 | 值 | 含义 |
|---|---|---|
| `NECK_HALF_W_CM` | 7 | 领口半宽（估计） |
| `NECK_DEPTH_FRONT_CM` | 7 | 前领口深度（估计） |
| `NECK_DEPTH_BACK_CM` | 2.5 | 后领口深度（估计） |
| `ARMPIT_FROM_TOP_CM` | 22 | 腋下离衣身顶部距离（估计） |
| `SHOULDER_DROP_CM` | 4 | 肩斜（领口角到肩端点的下降） |
| `SLEEVE_DROOP_DEG` | 35 | 袖子下垂角度 |

### 11.4 真人合成校准 (ModelGrid.tsx)

| 常量 | 值 | 含义 |
|---|---|---|
| `MIDSHOULDER_CLOTH_V` | 0.10 | MediaPipe 肩关节在衣身 V 轴的位置 |
| `MIDHIP_CLOTH_V` | 0.90 | 髋关节在衣身 V 轴的位置 |
| `SHOULDER_SPAN_OF_CLOTH_W` | 0.85 | 肩关节跨距 / 衣身宽 |
| `PRINT_W_FRAC` | `PRINT_W_UV / 0.85 ≈ 0.846` | 压板宽 / 肩跨距 |

### 11.5 纹理 (textureStore.ts)

| 常量 | 值 | 含义 |
|---|---|---|
| `TEX_W` / `TEX_H` | 4096 | 共享 canvas 像素 |
| `PHOTO_PATTERN_W` | 2048 | 真人合成图案 canvas 宽 |
| `PHOTO_PATTERN_H` | 2304 | `2048 * 45.72 / 40.64` |

---

## 附：未来改进方向

1. **3D mesh 折痕保留**：3D 视图当前是干净的纯白衣服 + 图案；如果加 normal map 或 ambient occlusion，会更真实
2. **多压板**：背面、左/右袖各一个压板，需要扩展 `PRINT_*` 常量为数组
3. **PSD-style 位移图**：[`RESEARCH.md`](../RESEARCH.md) §3.1 C 描述的 base/mask/displace/light 工作流，能让 2D 合成更接近真实印染（包括法线变形）
4. **纸样调整**：当前轮廓是 M 码硬编码；改成 props 后可动态切换 XS/S/L/XL/2XL/3XL（数据已在尺码表里）
5. **AI 兜底**：[`RESEARCH.md`](../RESEARCH.md) §3.3 H 提到 SD + ControlNet + IP-Adapter，对真人照片中的复杂褶皱效果最好，但需要后端
