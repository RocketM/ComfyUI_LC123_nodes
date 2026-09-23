# ComfyUI LC123 Nodes — RocketM 分支

[English](README.md) | 简体中文

## 相对上游的改动

| 改动节点 | 改动点 |
| --- | --- |
| LC Save Image 💾 | `Size` 记录实际保存图片的尺寸；有效的原始尺寸与输出尺寸不同时，额外写入 `Source size`。导出 LoRA 模型强度标签，并在 PNG 结构化元数据中分别保存模型与 CLIP 强度。修正仅一项强度为零时误排除有效 LoRA 的问题。 |
| LC LoRA Loader 🎚️ | 将行设置接入强度元数据与 LoRA 哈希收集，遵循逐行开关、强度以及仅连接 MODEL 或 CLIP 的情况。加载器的采样行为不变。 |

启用 `embed_civitai` 时写入元数据，不修改采样提示词或图片尺寸。仅 LC LoRA Loader 🎚️ 使用专门适配，其他加载器统一按输入字段识别。LC LoRA Stack / LC Apply LoRA Stack 尚未接入强度元数据收集。图关联不代表实际执行，因此结构化记录标记为 `execution_verified: false`。

## 安装

在 `ComfyUI/custom_nodes` 内执行：

```sh
git clone --branch main https://github.com/RocketM/ComfyUI_LC123_nodes.git
```

只保留一份 LC123 插件，安装后重启 ComfyUI 并刷新浏览器。

## 上游节点说明

节点用法、图片与示例请参阅[上游 README](https://github.com/lonecatone23/ComfyUI_LC123_nodes#readme)。原始节点及资源由 [lonecatone23](https://github.com/lonecatone23) 提供，本 fork 沿用原项目[许可证](LICENSE)。
