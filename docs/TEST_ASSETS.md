# /displace 测试素材清单

本目录只服务 `/displace` 效果测试。模特素材按“上衣空白、上衣主体尽量完整、可调整大图案”为优先标准筛选；明显有 logo/已有印花、裁切过近、胸前被大面积遮挡的候选已移入 `_rejected`。

## 目录

| 路径 | 用途 |
|---|---|
| `app/public/test-models/` | 可直接在 `/displace` 缩略图中选择的测试模特图 |
| `app/public/test-models/_rejected/` | 下载后判定不符合“空白完整上衣”的候选，不参与 Vite 扫描 |
| `app/public/test-patterns/` | 可直接在 `/displace` 图案分组中选择的测试图案素材 |

## 模特图

| 文件 | 类别 | 测试点 | 来源 |
|---|---|---|---|
| `hoodie-black-front-pexels-10850112.jpg` | 黑色卫衣 | 深色、正面/手部靠近胸口 | Pexels photo 10850112 |
| `hoodie-gray-front-unsplash-N6BP12FB_XU.jpg` | 灰色卫衣 | 中深色、正面 | Unsplash photo N6BP12FB_XU |
| `hoodie-white-city-pexels-10285696.jpg` | 白色卫衣 | 白色、全身远景 | Pexels photo 10285696 |
| `longsleeve-black-front-pexels-11000250.jpg` | 黑色长袖 | 深色、轻侧身、完整上衣 | Pexels photo 11000250 |
| `longsleeve-white-man-front-pexels-8727340.jpg` | 白色长袖 | 浅色、宽松褶皱 | Pexels photo 8727340 |
| `tshirt-black-front-pexels-26125921.jpg` | 黑色短袖 T | 深色、完整上衣 | Pexels photo 26125921 |
| `tshirt-green-front-pexels-19107957.jpg` | 绿色短袖 T | 中亮彩衫、户外光 | Pexels photo 19107957 |
| `tshirt-red-front-pexels-8211326.jpg` | 红色短袖 T | 高饱和彩衫、手部遮挡 | Pexels photo 8211326 |
| `tshirt-white-front-complete-pexels-8217507.jpg` | 白色短袖 T | 白色、全身远景 | Pexels photo 8217507 |
| `tshirt-white-pose-pexels-9558713.jpg` | 白色短袖 T | 白色、轻微姿势变化 | Pexels photo 9558713 |
| `local-tshirt-black-seated.png` | 黑色短袖 T | 深色、坐姿、褶皱 | 既有项目素材 |
| `local-tshirt-blue-seated.png` | 蓝色短袖 T | 彩衫、坐姿、褶皱 | 既有项目素材 |
| `local-tshirt-green-seated.png` | 绿色短袖 T | 深绿、坐姿、褶皱 | 既有项目素材 |
| `local-tshirt-purple-seated.png` | 紫色短袖 T | 深紫、坐姿、褶皱 | 既有项目素材 |
| `local-tshirt-red-seated.png` | 红色短袖 T | 深红、坐姿、褶皱 | 既有项目素材 |
| `local-tshirt-yellow-seated.png` | 黄色短袖 T | 亮色彩衫、坐姿、褶皱 | 既有项目素材 |
| `local-tshirt-white-fullbody.png` | 白色短袖 T | 白色、完整上衣 | 既有项目素材 |
| `local-tshirt-white-hands-waist.png` | 白色短袖 T | 白色、手在腰部 | 既有项目素材 |
| `local-tshirt-white-seated.png` | 白色短袖 T | 白色、坐姿、轻褶皱 | 既有项目素材 |
| `local-tshirt-white-sitting.png` | 白色短袖 T | 白色、坐姿 | 既有项目素材 |
| `local-tshirt-white-street.png` | 白色短袖 T | 白色、户外光、全身 | 既有项目素材 |

## 图案素材

| 文件 | 类别 | 测试点 |
|---|---|---|
| `text-black-bold.svg` | 黑色大字 | 白衫文字边缘、褶皱下可读性 |
| `text-white-bold.svg` | 白色大字 | 黑衫/深色衫亮度和贴纸感 |
| `text-small-lines.svg` | 小字/细线 | 缩放、位移、抗锯齿 |
| `logo-geometric-color.svg` | 彩色 logo | 高饱和色、边缘干净度 |
| `cartoon-cat-dark.svg` | 暗部卡通 | 黑衫/深色衫暗部可见性 |
| `cartoon-bright.svg` | 明亮卡通 | 彩衫、白衫颜色融合 |
| `photo-gradient-blocks.svg` | 照片/渐变类 | 色偏、暗部层次、光照叠加 |
| `transparent-smoke.svg` | 半透明图案 | alpha 区域、深色衣服可见性 |
| `thin-line-grid.svg` | 细线几何 | 边缘质量、位移变形 |

## 授权说明

- Pexels 素材来自 `pexels.com`，Pexels License 允许免费使用和修改，且无需署名。
- Unsplash 素材来自 `unsplash.com`，Unsplash License 允许免费商用/非商用使用，且无需署名。
- `app/public/test-patterns/` 下的 SVG 图案为本项目自生成测试图案，不依赖第三方版权素材。
