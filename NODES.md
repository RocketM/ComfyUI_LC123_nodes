# LC123 node inventory

**127 Python nodes** + **5 JS-only** · version 1.42.3

Registered class IDs: 128 (127 in search, 1 deprecated but still loads in old workflows).

## LC123/Regional Canvas/Anima (1)

- `AnimaRegionalCanvasInline`: LC Anima Regional Inline Canvas

## LC123/Regional Canvas/Krea2 (1)

- `Krea2RegionalCanvasInline`: LC Krea2 Regional Inline Canvas

## LC123/conditioning (5)

- `LCNegative`: LC Negative
- `LCPositive`: LC Positive
- `LCPromptToConditioningZero`: LC Prompt to Conditioning + Zero
- `LCReferenceLatent`: LC Reference Latent
- `LCPromptToConditioning`: Prompt to Conditioning

## LC123/image (49)

- `LCApplyLUT`: LC Apply LUT
- `LCAspectRatioPipeIn`: LC Aspect Ratio Pipe (In/Edit)
- `LCAspectRatioPipe`: LC Aspect Ratio Pipe Out
- `LCAutoWhiteBalance`: LC Auto White Balance
- `LCBatchImage`: LC Batch Image 🖼️
- `LCBloom`: LC Bloom
- `LCChromaticAberration`: LC Chromatic Aberration
- `LCColorMatch`: LC Color Match 🎨
- `LCDepthFX`: LC Depth FX 🌫️
- `LCDimensionResize`: LC Dimension Resize 📐
- `LCDirectionalBlur`: LC Directional Blur
- `LCDynamicOverlay`: LC Dynamic Overlay
- `LCFilmGrain`: LC Film Grain
- `LCFilmStockBW`: LC Film Stock (B&W)
- `LCFilmStockColor`: LC Film Stock (Color)
- `LCGetImage`: LC Get Image 📐
- `LCImageAdjust`: LC Image Adjust
- `LCImageBatchFromFolder`: LC Image Batch From Folder 📂
- `LCBatchImageComparer`: LC Image Compare 🔎
- `LCImageCrop`: LC Image Crop 🖼️🔪
- `LCImageDenoise`: LC Image Denoise
- `LCImageDesaturate`: LC Image Desaturate
- `LCImageGrid`: LC Image Grid 🖼️
- `LCImageLabel`: LC Image Label
- `LCImagePass`: LC Image Pass
- `LCImageRGB`: LC Image RGB
- `LCImageSplit`: LC Image Split 🖼️
- `LCImageToTotalMegapixels`: LC Image to Total Megapixels 📐
- `LCImageMaskResize`: LC Image-Mask Resize 📐
- `LCLastImageHolder`: LC Last Image Holder
- `LCLensFX`: LC Lens FX (deprecated) *(hidden from search)*
- `LCLensProfile`: LC Lens Profile
- `LCLiftGammaGain`: LC Lift Gamma Gain
- `LCLightingControlV2`: LC Lighting Control V2 🔦
- `LCRelight`: LC Lighting Control 🔦
- `LCPhoneFilters`: LC Phone Filters 📱
- `LCPhoneLook`: LC Photo Style 📷
- `LCPreviewImage`: LC Preview Image 🖼️
- `LCPreviewMask`: LC Preview Mask 🎭
- `LCClarity`: LC Sharpen Pro
- `LCSkinBeauty`: LC Skin Beauty ✨
- `LCSkinUpscale`: LC Skin Upscale
- `LCTextOverlay`: LC Text Overlay
- `LCToneMatch`: LC Tone Match
- `LCVibrance`: LC Vibrance
- `LCVignette`: LC Vignette
- `LCWatermark`: LC Watermark 💧
- `AspectRatioSimplifier`: 📐 LC Aspect Ratio Simplifier
- `LCAspectRatioPipeOut`: 📐 LC Aspect Ratio Simplifier (pipe)

## LC123/io (4)

- `LCAdvancedFolder`: LC Advanced Folder 📂
- `LCEasyFolder`: LC Easy Folder 📂
- `LCSaveImage`: LC Save Image 💾
- `LCSaveImageMetadata`: LC Save Metadata 🏷️

## LC123/latent (1)

- `LCDenoise`: LC Denoise 💉

## LC123/loaders (3)

- `LCApplyLoraStack`: LC Apply LoRA Stack 🎚️
- `LCLoraLoaderStack`: LC LoRA Loader Stack 🎚️
- `LCLoraLoader`: LC LoRA Loader 🎚️

## LC123/mask (1)

- `LCMaskPass`: LC Mask Pass

## LC123/pipe (9)

- `LCDetailPipeOut`: LC Detail Pipe Out
- `LCImageRefPipeIn`: LC Image Ref Pipe In 🖼️
- `LCImageRefPipeOut`: LC Image Ref Pipe Out 🖼️
- `LCMiniMaxH3Pipe`: LC MiniMax H3 Pipe
- `LCMiniMaxH3PipeOut`: LC MiniMax H3 Pipe Out
- `LCMiniMaxH3PipeOutV2`: LC MiniMax H3 Pipe Out V2
- `LCMiniMaxH3PipeV2`: LC MiniMax H3 Pipe V2
- `LCPipeEdit`: LC Pipe (in/edit)
- `LCPipeOut`: LC Pipe Out

## LC123/prompt (9)

- `LCColorPalette`: 🎨LC Color Palette
- `LCWildcard`: 🎲LC Wildcard
- `LCCamera`: 🗒️LC Camera
- `LCLighting`: 🗒️LC Lighting
- `LCSceneBuilder`: 🗒️LC Scene Builder
- `LCStyleSelector`: 🗒️LC Style Selector
- `LCSubject`: 🗒️LC Subject
- `LCSubjectArray`: 🗒️LC Subject Array
- `LCPromptAssembler`: 🧩LC Prompt Assembler

## LC123/sampling (11)

- `LCBasicScheduler`: LC Basic Scheduler
- `LCSamplerConfigure`: LC Sampler Configure
- `LCSamplerConfigurePipeOut`: LC Sampler Configure (pipe)
- `LCSamplerConfigurePipe`: LC Sampler Configure Pipe Out
- `LCSamplerConfigureSimple`: LC Sampler Configure Simple
- `LCSamplerConfigureSimplePipeOut`: LC Sampler Configure Simple (pipe)
- `LCSigmaCurve`: LC Sigma Curve
- `LCSigmaResample`: LC Sigma Resample
- `LCChangeStepCount`: LC Sigma Resample
- `LCSplitSigmaScheduler`: LC Split Sigma Scheduler
- `LCSplitSigmasAdvanced`: LC Split Sigmas (Advanced)

## LC123/text (2)

- `LCCivitaiStrip`: Civitai 🚩🔪
- `LCWidgetToString`: LC Widget To String

## LC123/utils (32)

- `LCAnyEmptyBool`: LC Any Empty Bool
- `LCAnyEmptyFloat`: LC Any Empty Float
- `LCAnyEmptyInt`: LC Any Empty Int
- `LCIndexSwitch`: LC Any Index Switch
- `LCAnySwitch`: LC AnySwitch
- `LCBoolean`: LC Boolean
- `LCBooleanFlip`: LC Boolean Flip
- `LCBooleanSwitch`: LC Boolean Switch
- `LCBooleanValue`: LC Boolean Value
- `LCBypassRelay`: LC Bypass Relay
- `LCComboSelector`: LC Combo Selector
- `LCCustomCombo`: LC Custom Combo
- `LCCustomComboPanel`: LC Custom Combo Panel
- `LCFloatCompare`: LC Float Compare
- `LCIntCompare`: LC Int Compare
- `LCIntSplit`: LC Int Split
- `LCInvertBoolean`: LC Invert Boolean
- `LCIsBypassedOrMuted`: LC Is Bypassed / Muted
- `LCJoinStrings`: LC Join Strings 🔗
- `LCLabel`: LC Label 🏷️
- `LCNodeSnapshot`: LC Node Snapshot 📋
- `LCNotify`: LC Notify 🔊
- `LCSeedJump`: LC Seed Jump 🌱
- `LCShowAny`: LC Show Any 🔤
- `LCShowText`: LC Show Text 🔤
- `LCSlider`: LC Slider
- `LCStop`: LC Stop 🛑
- `LCTextRemove`: LC Text Remove 🔪
- `LCTextReplace`: LC Text Replace ✂️
- `LCVRAMCacheClear`: LC VRAM Cache Clear
- `LCSeed`: 🌱LC Seed
- `LC123SaveText`: 📝 LC Save Text

## JS-only (no Python class, 5)

- LC Bypasser
- LC Mute
- LC Groups Bypasser
- LC Bypasser Panel
- LC Note 📝

> Comfy Registry discovers nodes from `NODE_CLASS_MAPPINGS` at publish time; this file is a human-readable inventory. Manager “node count” depends on a successful registry publish, not this list alone.
