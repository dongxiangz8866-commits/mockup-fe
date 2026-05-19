功能: Displace 路印图贴合大修 — 保宽比 + cloth-mask 裁剪 + 光照按衣物明度 + 定下 SfS 位移为下一步

总结:
- 修印图「上下变形」: shader 加保宽比 contain(按 pattern 原比例放进印区), uPatternAspect 贯通 displaceShader/DisplaceCanvas/DisplacePage
- 关掉照片明暗 fold warp 默认(wrinkleDepthStrength 0), 深度径向 wrap 默认调柔 2.0→1.0
- 新增 B1 布料分割: 复用 hairSegmenter 的 selfie-multiclass(class4) → clothSegmenter.ts / useClothMask.ts, 三层缓存 cloth-cache:v2, 形态学闭运算补洞; 加「布料」debug 视图
- B3 曾用 cloth-mask 在 vertex 门控 warp → 边界剪切「变形」, 已撤; warp 保持全局平滑
- B4: frag 把印图 alpha 软裁到 cloth mask(印图不再溢出衣外), 1×1 白兜底保证永不比裁剪前差
- autoLightStrength 改成按 maxRGB 连续: 黑衣→≈0(印图保真色), 白衣→1.0~1.5, color 公式不动防回归
- 结论锁定: 照片明暗用「微分」(Sobel/∇)生成位移必撕裂(向量场要相干, 标量光照能扛噪声位移扛不住); 用户否决一切 API, 要纯前端 + 任意照片(场景B) + 真贴合

TODO:
- 实现 SfS/Poisson 位移(下一次主任务): 把衣服明暗「积分」成平滑高度场(非微分), cloth-mask 圈定 + 取原始模特照(无印图污染), 256² 强正则烘成静态资产 + 三层缓存(新前缀), 梯度喂现有 32×32 mesh-warp, 与深度径向 wrap 互补(深度=身体圆柱, SfS=局部褶皱)
- B4 收尾未完: 衣缘接触阴影 + ControlRail 收单滑杆 + 清死常数
- cloth mask 在白衣/白底质量未经用户肉眼确认(用户一直没看「布料」调试视图)
