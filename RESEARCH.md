# 服装图形样机系统技术路线调研

> 需求：输入一张模特图片，将一张平面图案"印"到模特身上的衣服上，要求图案贴合衣服的形状、褶皱与光影，输出合成图。
> 目标：从 2D / 3D / 纯前端 / 需后端 四个维度做详细调研，**前端方案优先**。
> 术语：行业里常说的 "mockup"，本文一律叫 **"样机系统"**——指"输入图案 + 选模板/模特 → 输出印花成品图"的一整套图形管线与编辑器。

---

## 1. 问题拆解

把"图形贴合衣服"拆成 5 个独立的子问题，后续所有方案都是这 5 个子问题的不同组合：

| 子问题              | 技术名词                                             | 难度  |
| ---------------- | ------------------------------------------------ | --- |
| ① 衣服在图中的位置/边界    | image segmentation / mask                        | 中   |
| ② 衣服表面的形状（褶皱、起伏） | displacement / normal / depth map                | 高   |
| ③ 图案随衣服形状变形      | UV warp / mesh deformation / shader displacement | 中-高 |
| ④ 图案受到衣服光影影响     | multiply / overlay blend、PBR lighting            | 低-中 |
| ⑤ 图案位置缩放可交互调整    | 2D/3D transform 编辑器                              | 低   |

不同方案在子问题①②上差距最大，③④⑤几乎都用同一套图形管线。

---

## 2. 技术路线总览（决策矩阵）

| 方案                                             |  真实感  | 通用性（任意输入图） | 性能  | 实施难度 | 是否需后端  |
| ---------------------------------------------- | :---: | :--------: | :-: | :--: | :----: |
| A. 2D 纯叠加（alpha）                               |   ★   |     高      | 极快  |  极低  |   否    |
| B. 2D Mesh Warp（手动锚点）                          |  ★★   |     中      |  快  |  低   |   否    |
| C. **2D Displacement + Light（PSD 工作流）**        | ★★★★  |   仅预制模板    |  快  |  中   |   否    |
| D. 2D + AI 分割 + 自动 displacement                |  ★★★  |     高      |  慢  |  高   |  视情况   |
| E. 全 3D 渲染（无真实模特）                              |  ★★★  |  仅 3D 资产   |  中  |  中   |   否    |
| F. 简化 3D：3D Plane + Pose 估计                    |  ★★★  |     高      |  中  |  中   |   否    |
| G. 真实照片 + 3D 体型重建（SMPL）                        | ★★★★  |     高      |  慢  |  极高  |  通常需   |
| H. AI Inpainting（SD + ControlNet + IP-Adapter） | ★★★★★ |     极高     |  慢  |  中   | **必需** |
| I. 专用虚拟试穿模型（IDM-VTON 等）                        | ★★★★★ |     高      |  慢  |  中   | **必需** |
| J. 模板型商业样机系统 API（Printful/DynamicMockups）   | ★★★★  |  仅平台 SKU   |  快  |  极低  | 接 API  |
| K1. AI 一体化 SaaS — Recraft（海外，开发者 API）        | ★★★★  |     高      |  中  |  极低  |  云服务   |
| K2. AI 一体化 SaaS — 灵图POD（国内跨境 POD 工作站）       | ★★★★  |   跨境品类    |  中  |  极低  |  云服务   |

---

## 3. 详细方案

### 3.1 2D 路线

#### A. 纯透明叠加
- 把图案 PNG 用 `position: absolute` 或 `<canvas>` 直接放上去
- 不处理透视、不处理光影
- **使用场景**：极简风格、卡通风格、产品图标贴纸
- **栈**：HTML+CSS / Canvas2D，0 依赖

#### B. 2D Mesh Warp（手动锚点透视）
- 在衣服区域预设 4 ~ 9 个控制点，把图案做 perspective transform 或 thin-plate-spline 变形
- 解决了①透视问题，但没有褶皱、没有光影
- **栈**：
  - `pixi.js` 的 `Mesh` + `PerspectiveMesh`（v8 内置）
  - `three.js` 的 `PlaneGeometry` + UV 操作
  - `fabric.js`（透视变换支持有限，可走 plugin）
  - `konva.js` 适合 2D 编辑器交互层
- **使用场景**：用户上传任意照片，只需"大致贴合"

#### C. ★ 2D Displacement + Light Map（PSD Smart Object 工作流）— **推荐**
**核心思想**：把"褶皱"和"光影"信息一次性烘焙到两张贴图，运行时只需把图案当贴图替换即可。这就是 Photoshop "智能对象 + 置换滤镜"的程序化版本，也是 Printful、Placeit、Smartmockups 等行业样机系统的标准做法。

**资产准备（一次性，美工配合）**：

| 资产 | 作用 | 制作方式 |
|------|------|--------|
| `base.jpg` | 模特原图 | 摄影 |
| `mask.png` | 衣服可印区域，alpha 通道 | PS 钢笔/魔棒抠图 |
| `displace.png` | RG 通道编码 x/y 像素位移 | PS 滤镜→扭曲→置换 用的 PSD 转灰度图 |
| `light.png` | 灰度乘法光影层 | 把 base 转灰度 → 高反差保留 → 调级 |

**前端运行时（GLSL 片段）**：
```glsl
// 顶点用 PlaneGeometry 全屏四边形
varying vec2 vUv;

uniform sampler2D uBase;       // 模特原图
uniform sampler2D uMask;       // 衣服 alpha
uniform sampler2D uDisplace;   // 位移图
uniform sampler2D uLight;      // 光影
uniform sampler2D uGraphic;    // 用户上传图案

uniform vec2  uOffset;         // 图案位置（用户调整）
uniform vec2  uScale;          // 图案缩放
uniform float uStrength;       // 位移强度

void main() {
  vec4 base = texture2D(uBase, vUv);
  float m = texture2D(uMask, vUv).a;

  // 把屏幕 UV 转为图案 UV，应用置换
  vec2 disp = texture2D(uDisplace, vUv).rg * 2.0 - 1.0;
  vec2 gUv  = (vUv - uOffset) / uScale + disp * uStrength;

  vec4 graphic = texture2D(uGraphic, gUv);
  vec3 light   = texture2D(uLight, vUv).rgb;

  // multiply 融合到 base
  vec3 mixed = mix(base.rgb, graphic.rgb * light * 2.0, graphic.a * m);
  gl_FragColor = vec4(mixed, 1.0);
}
```

**库选择对比**：

| 库 | 优势 | 劣势 |
|----|------|------|
| **pixi.js v8** | 内置 `DisplacementFilter`，<200 行可跑通；2D 性能极好 | 自定义 shader 不如 three.js 灵活 |
| **three.js + R3F** | 完全自定义 shader，方便后续扩 3D | 2D 用稍重 |
| **gl-react** | 声明式，React 友好 | 维护活跃度一般 |
| **regl** | 极轻量 | 要自己写所有抽象 |

**首选 pixi.js v8**：体积小、API 直白、`DisplacementFilter` + `Sprite` blend mode (`MULTIPLY`/`OVERLAY`) 几乎已覆盖该方案。

**优缺点**：
- ✅ 真实感非常高（业界主流商用样机方案）
- ✅ 实时性能好，支持几十帧 GIF/视频
- ✅ 纯前端
- ❌ 仅支持预先准备好的样机模板，不能任意上传模特图
- ❌ 模板制作有一次性人工成本（一件衣服 30 分钟 - 1 小时美工时间）

#### D. 2D + AI 分割 + 自动 Displacement
**思路**：让任意上传的模特图也能用 C 方案的管线，关键是自动生成 `mask` 与 `displace`。

- `mask`：衣服分割模型
  - 轻量：U²-Net / MODNet / Cloth-Segmentation（onnxruntime-web 跑得动，~50MB，CPU 1-3s）
  - 重量：SAM / Grounding-DINO + SAM（精度高但~700MB，前端不现实）
- `displace`：单目深度估计模型
  - MiDaS small / Depth Anything small（onnxruntime-web 可跑，~100MB，CPU 2-5s）
  - 把 depth 的梯度转为 displacement
- `light`：从 base 图 luminance 直接取

**栈**：`onnxruntime-web` + `@mediapipe/pose`（拿到肩膀/胸部 landmark 用作图案锚点）

**优缺点**：
- ✅ 通用性高，用户上传任意照片
- ✅ 仍可纯前端（首次加载慢，结果缓存）
- ❌ 模型加载几十到几百 MB，首次体验差
- ❌ 自动 displacement 远不如手工烘焙的精度，褶皱处易看出"贴纸感"
- 折中：模型放后端推理，前端只做合成

#### 现成商业 / 库

| 名字 | 类型 | 备注 |
|------|------|------|
| `pixi.js` | OSS | DisplacementFilter |
| `fabric.js` | OSS | 2D 编辑器，透视/滤镜有限 |
| `mockoo.js` / `mockup.js` | 各种 npm 包 | 多数停留在 2D 叠加 |
| Photopea SDK | 闭源 | PSD 在浏览器渲染，可作为样机模板编辑器 |
| `psd.js` | OSS | 解析 PSD，配合自定义渲染 |

---

### 3.2 3D 路线

#### E. 全 3D 渲染（无真实模特照片）
**思路**：场景里就是 3D 模特 + 3D T-shirt，把图案作为衣服的 albedo/decal texture，three.js 直接渲染。

```jsx
// react-three-fiber 大致写法
<Canvas>
  <Environment preset="studio" />
  <Suspense>
    <Tshirt graphicTexture={userGraphic} fabricNormal={fabricNormalMap} />
  </Suspense>
</Canvas>
```

- 衣服模型：Sketchfab CC0、Quaternius、CLO-Set，或 Marvelous Designer 自制 → 导出 GLB
- 图案位置交互：投到衣服 UV 空间（DecalGeometry），可直接在 3D 上拖拽
- 光照：HDRI Environment + 简单方向光

**优缺点**：
- ✅ 视角、姿势完全可控
- ✅ 印花贴合通过 UV 自然解决
- ✅ 一次资产多次复用，可拓展成 3D 产品配置器
- ❌ 失去真实模特"摄影感"
- ❌ 3D 模型成本不低（购买或自建）

**栈**：`three.js` + `react-three-fiber` + `@react-three/drei`（含 `Decal`、`Environment`、`useGLTF`）

#### F. ★ 简化 3D：3D Plane + Pose 估计 — **任意照片场景的折中方案**
**思路**：保留真实照片背景，只在前面摆一个朝向相机的 3D 平面（贴用户图案），通过姿态估计把这个平面定位到胸部位置。

流程：
1. `@mediapipe/pose` → 33 个 2D landmark（包括左肩、右肩、左髋、右髋）
2. 用四个 landmark 定一个四边形（胸部区域）
3. three.js 用 `BufferGeometry` 构造一个对应四边形的 3D 平面（z=0 即可）
4. 把图案作为 `MeshStandardMaterial.map`，叠加从原图采样的 `aoMap` 或 `lightMap` 模拟光影
5. 加一个 procedural noise 的 normal map 模拟褶皱
6. 渲染结果 alpha 合成到原图

**优缺点**：
- ✅ 纯前端、任意照片可用（含 mediapipe 模型 ~10MB）
- ✅ 中等真实感
- ❌ 不如 PSD 方案精细，褶皱靠 procedural 不够真实
- ❌ 极端姿势（侧身、俯仰）可能定位失败

**栈**：`three.js` + `@mediapipe/pose` + `@mediapipe/tasks-vision`

#### G. 真实照片 + 3D 体型重建（SMPL/SMPL-X）
**思路**：从 2D 模特图反推 SMPL 参数（身材+姿势），把 3D 衣服 drape 到 SMPL 上，UV 贴图后渲染回原图。研究界主流路线。

代表项目：TryOnDiffusion (Google)、StableVITON、DressCode、M3D-VTON、ClothCap。

**实施现实**：
- SMPL 拟合需要 GPU + 训练好的回归网络
- 衣服仿真（cloth simulation）耗时
- 几乎不可能纯前端
- 商业系统（如 Zalando、阿里 FashionAI）都是后端

**结论**：Hybrid，前端只负责 UI 和最终合成预览，重计算放后端。

---

### 3.3 AI 路线（基本必需后端）

#### H. ★ Stable Diffusion + ControlNet + IP-Adapter（Inpainting）
**最通用、效果最自然**。

ComfyUI workflow 示意：
```
模特图 ──┬─► [Auto Mask: SAM / GroundingDINO] ──┐
        ├─► [ControlNet: Canny / Depth / Pose]  ├─► [SDXL Inpaint] ──► 输出
图案图 ──┴─► [IP-Adapter Plus]                   ┘
```

- **Mask**：自动用 SAM 选中衣服区域，或用户手刷
- **ControlNet**：保持模特姿势/构图不变（Pose + Canny 组合最稳）
- **IP-Adapter**：把图案作为 reference（强 weight 保形）
- **SDXL/SD3 Inpaint**：在 mask 区域生成

**优缺点**：
- ✅ 真实感天花板最高，自动处理褶皱、光影、阴影
- ✅ 任意输入照片
- ✅ 任意图案
- ❌ 必须 GPU（RTX 3090 一张图 5-15s，A100 < 5s）
- ❌ 文字、品牌 logo 容易扭曲（精确度差）
- ❌ 有随机性，需要"重新生成"按钮

**部署方式**：
- 商业 API：Replicate / Fal.ai / RunPod / Modal（按用量计费 ~ $0.005-0.05/图）
- 自托管：ComfyUI server + workflow REST API（投入更高，月固定 GPU 费）

#### I. 专用虚拟试穿模型
为"换衣服"设计，输入是一张完整服装图（不是平面图案）：

| 模型 | 是否开源 | 备注 |
|------|---------|------|
| **IDM-VTON** | ✅ | 当前开源 SOTA，HuggingFace 有 demo |
| **CatVTON** | ✅ | 轻量，效果接近 IDM-VTON |
| **OOTDiffusion** | ✅ | 字节出品 |
| **OutfitAnyone**（阿里） | ❌ 仅 demo | 效果非常好 |
| **Kling Virtual Try-On** | API | 商业 |

**用于"印花"场景**：要先把"印好图案的平铺衣服"合成出来（用 H 路线或 PS 模板），再喂给 VTON 模型 → 效果最自然。属于两阶段管线。

#### J. 商业样机 API（最快上线）

| 服务 | 价格 | 接入难度 | 备注 |
|------|------|--------|------|
| **DynamicMockups.com** | $19+/月 | 易，REST | 可上传自己的 PSD 作为样机模板 |
| **Printful Mockup Generator API** | 免费 | 易 | 仅 Printful 商品库 |
| **Pacdora API** | $29+/月 | 易 | 偏包装 |
| **Smartmockups API** | $9+/月 | 易 | 大量样机模板 |

直接调 API：1-2 天即可上线 MVP，月费 $20-200，缺点是模板/模特受限。

---

### 3.4 AI 一体化 SaaS 路线（云服务，零基础设施）

把 H/I 路线（SD + ControlNet + IP-Adapter / VTON）封装成产品的成熟厂商。前端只负责"上传图案 + 选模板/场景 + 拿结果"，模型调度、GPU、模特库、场景库都在云端。和 J（PSD 模板型）的差别：J 是"云端 PSD displacement"，K 是"云端 SD inpaint + 模板/场景调度"。

#### K1. Recraft（海外通用，开发者友好）
- **定位**：通用 AI 设计平台（文生图、矢量化、样机生成、风格库、批量），同时面向设计师和 POD 卖家
- **样机能力**
  - T-shirt mockup generator：上传图案 → 选模板 → 自动贴合，自带阴影、曲面、光影
  - "Convert any image to mockup"：把任意图变成印花样机
  - 矢量 + raster 同栈，可在同一平台先生成印花再出样机
- **接入**
  - 公开 REST API（[docs](https://www.recraft.ai/docs)），mockup 创建/转换 endpoint = 2 credits/次
  - 价格：raster $0.04/张，vector $0.08/张
  - 异步任务、批量、抠图、inpaint、outpaint 全覆盖
  - 免费额度：每天 30 张，无需信用卡
- **适用场景**
  - "上传图案 → 调 API 拿成品样机"，不想自维护 SD/ComfyUI 的团队
  - 同时需要印花生成 + 样机出图的 POD 工具链
- **优缺点**
  - ✅ 接入极快，单一 REST，海外稳定
  - ✅ 矢量+raster 同栈，覆盖"印花生成 → 样机出图"整链
  - ❌ 样机模板由平台维护，自定义模板/PSD 上传自由度不及 DynamicMockups
  - ❌ 国内访问与计费不便利

#### K2. 灵图POD（ipoddy / LingVisions，国内跨境 POD 工作站）
- **定位**：厦门灵图科技出品，面向跨境 POD 卖家的全链路工作站。覆盖采集 → 抠图 → 印花裂变 → AI 套图 → 标题 → 上架 → 侵权检测
- **样机（"AI 套图"）能力**
  - 上传图案 → 选品类（T 恤/卫衣/毛毯/抱枕…）+ 选场景（咖啡店/家居/户外…）→ 约 30 秒输出 5-8 张多角度模特实穿图
  - 自动处理面料褶皱、自然光影、模特实穿质感
  - 批量：卫衣等爆款约 10 分钟可产 100+ 张套图
  - 配合裂变/抠图/标题：一份原图 → 多 SKU 多平台铺货
- **接入**
  - 主要形态是 **Web SaaS 工作站**（[ipoddy.cn](https://www.ipoddy.cn/)）+ 浏览器插件，重点是运营效率，不是开发者集成
  - 公开 REST API 未在官网明示，定价亦需联系销售
  - 平台直连 Amazon、Temu、Etsy、Shein、TikTok Shop 上架
- **适用场景**
  - 国内跨境 POD 卖家"自己用"，把选品到上架完整自动化
  - **不**适合作为自研产品的图形管线后端（API 和定制能力不公开）
- **优缺点**
  - ✅ POD 全链路（样机只是其中一步），开箱即用
  - ✅ 中文 + 国内服务，模特/场景库贴近跨境爆款品类
  - ✅ 多店多平台一键铺货
  - ❌ 偏 end-user SaaS，不是 developer-platform，自有产品集成困难
  - ❌ 自定义模板、品牌资产、模特定制能力受限于平台

#### J vs K1 vs K2 横向对比

| 维度 | J. DynamicMockups/Printful | K1. Recraft | K2. 灵图POD |
|------|------|------|------|
| 底层技术 | 云端 PSD displacement（确定性） | 云端 AI（SD 生态） | 云端 AI（SD 生态） |
| 自定义模板 | ✅ 可上传 PSD | ⚠️ 平台模板为主 | ⚠️ 平台模板为主 |
| 开发者 API | ✅ 文档清晰 | ✅ 文档清晰、定价公开 | ❌ 未公开 |
| 印花生成 | ❌ | ✅（文生图 + 矢量） | ✅（裂变 + 抠图） |
| 一键多平台上架 | 部分（Printful 自家） | ❌ | ✅ |
| 适合 | 自研样机系统后端 | 自研样机系统后端 | 卖家自用工作站 |
| 主要风险 | 模板成本 | 国内不便 | 无法集成进自有产品 |

**一句话**：要把样机能力嵌进自有产品 → J 或 K1；做跨境 POD 卖家自营 → K2。

---

## 4. 各方案在 5 个子问题上的覆盖度

| 方案                 |  ① 区域   | ② 形状  | ③ 变形  | ④ 光影  |  ⑤ 交互   |
| ------------------ | :-----: | :---: | :---: | :---: | :-----: |
| A 叠加               |   手动    |   ❌   |   ❌   |   ❌   |    ✅    |
| B Mesh Warp        |   手动    |   ❌   |   ✅   |   ❌   |    ✅    |
| C PSD Displacement |   预烘焙   |  预烘焙  |   ✅   |  预烘焙  |    ✅    |
| D 自动 Displacement  |   AI    | AI 估  |   ✅   | 取自原图  |    ✅    |
| E 全 3D             |   UV    | 3D 模型 |   ✅   |  PBR  |    ✅    |
| F 3D Plane + Pose  |  Pose   |  简单   |   ✅   |  简单   |    ✅    |
| G SMPL 重建          | 3D Body | 3D 模型 |   ✅   |  PBR  |    ✅    |
| H SD Inpaint       |   AI    |  AI   |  AI   |  AI   |   部分    |
| I VTON 模型          |   AI    |  AI   |  AI   |  AI   |    ❌    |
| J 商业 API           |   平台    |  平台   |  平台   |  平台   |   API   |
| K1 Recraft         |  平台 AI  | 平台 AI | 平台 AI | 平台 AI |   API   |
| K2 灵图POD           |  平台 AI  | 平台 AI | 平台 AI | 平台 AI | SaaS UI |

---

## 5. 推荐选型（按业务目标）

### 场景 5.1：电商/印刷打样器，已知服装 SKU
**推荐 C：PSD Displacement（纯前端，pixi.js）**
- 一次性美工准备 10-20 个样机模板
- 前端代码 1-2 周
- 真实感与 Printful、Placeit 相当，可商用

### 场景 5.2：用户上传任意模特照都要贴图
**短期 F**（3D Plane + MediaPipe Pose，纯前端，靠用户拖拽微调）
**长期 H**（后端 SD inpainting，效果天花板最高）
- 也可结合：F 做实时预览，用户点"高质量渲染"再走 H

### 场景 5.3：完全 3D 可视化的产品配置器（如鞋服自定义）
**推荐 E：全 3D + react-three-fiber**

### 场景 5.4：要最快上线，不在乎自有资产
**直接 J：DynamicMockups 或 Printful API**

### 场景 5.5：自研样机系统要 AI 真实感，但不想自维护 SD/GPU
**推荐 K1：Recraft API**
- raster $0.04 / mockup 2 credits，REST 直调
- 比起自己跑 SD（H 路线）省运维，比起 J 路线又能拿 AI 真实感

### 场景 5.6：自营跨境 POD 店铺（不是做产品）
**推荐 K2：灵图POD 工作站**
- 不写代码，从选品到上架一站式
- 注意它是 SaaS 工作站不是 API，无法集成进自有产品

---

## 6. 推荐技术栈（前端优先实现 5.1 + 5.2 短期）

```
React 18 + TypeScript + Vite                 ── 项目脚手架（CLAUDE.md 已指定）
├─ 渲染层
│  └─ pixi.js v8                             ── 2D displacement 主力
│  └─ three.js + @react-three/fiber + drei   ── 3D 路线 / 复杂 shader
├─ 编辑器交互层
│  └─ konva.js 或 fabric.js                   ── 图层、拖拽、缩放、旋转
│  └─ leva                                   ── 调试参数面板（开发期）
├─ 输入处理（任意照片场景）
│  └─ @mediapipe/tasks-vision (Pose)         ── 姿态 landmark
│  └─ onnxruntime-web + U²-Net               ── 衣服分割（可选）
├─ 资产管线（样机模板场景）
│  └─ Photoshop / Affinity 导出              ── base / mask / displace / light
│  └─ 也可用 Blender bake light/displacement
├─ 导出
│  └─ Canvas.toBlob → PNG/JPG
│  └─ pdf-lib                                ── 高分辨率 PDF
└─ 后端（可选，按 5.2 长期）
   └─ Node.js + sharp                         ── 高清离屏合成
   └─ Python ComfyUI / Replicate API         ── SD 推理
```

---

## 7. 实施路线建议

| 阶段 | 时间 | 内容 | 交付 |
|------|------|------|------|
| MVP | 1-2 周 | 1-2 个预制样机模板 + pixi.js DisplacementFilter + 上传/拖拽/缩放/导出 | 可演示 demo |
| Q | 2-3 周 | 模板扩到 10-20 个；自定义 GLSL（更细粒度光影/混合）；可视化模板编辑器 | 内测版 |
| 通用化 | 2-4 周 | 任意照片：MediaPipe Pose + 3D Plane（方案 F） | 升级版 |
| 高真实 | 视情况 | 接 Replicate/Fal SD inpainting workflow，作为"高质量"按钮 | 商业版 |

---

## 8. 关键参考资料 / 关键词

- pixi.js v8 docs — `DisplacementFilter`, `Mesh`, `BlendMode`
- three.js — `ShaderMaterial`, `Decal`, `MeshStandardMaterial`
- React Three Fiber — drei `Decal` / `Environment`
- MediaPipe Tasks Vision — Pose Landmarker
- ONNX Runtime Web — 在浏览器跑 U²-Net / Depth Anything
- ComfyUI workflows — `IPAdapter Plus`、`ControlNet Inpaint`、`SDXL Inpaint`
- 论文/项目：IDM-VTON、OOTDiffusion、TryOnDiffusion、StableVITON
- 商业样机 API：DynamicMockups、Printful Mockup Generator、Smartmockups
- AI 一体化 SaaS：
  - Recraft — [recraft.ai](https://www.recraft.ai/)、[API docs](https://www.recraft.ai/docs)、[mockup generator](https://www.recraft.ai/mockup-generator)、[t-shirt generator](https://www.recraft.ai/generate/t-shirts)
  - 灵图POD — [ipoddy.cn](https://www.ipoddy.cn/)、辅助设计平台 [lingvisions.com](https://www.lingvisions.com/)
- "PSD smart object mockup pipeline"、"displacement map t-shirt mockup" 关键词搜索

---

## 9. 一句话结论

> **前端优先 + 已知 SKU 场景**：用 **pixi.js + PSD Displacement**（方案 C），纯前端、商用级效果、1-2 周可上线 MVP 样机系统。
> **任意照片**：短期上 **MediaPipe + 3D Plane**（F），长期接 **后端 SD Inpainting**（H）作为"高质量"按钮。
> **不想自维护 GPU**：直接接 **Recraft API**（K1，$0.04/张起），跳过 H 的运维成本；自营跨境 POD 卖家用 **灵图POD 工作站**（K2）。
