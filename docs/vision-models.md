# Video-capable models and ACP

ACP `ContentBlock` supports `text | image | audio | resource | resource_link`
only — **no video**. Real video understanding must go through a side-channel
API (`VideoVisionClient`); results are injected back as text (or frames as
images for agents that only accept `image`).

## Provider matrix

| Provider | Native video? | Wire shape | Notes |
|---|---|---|---|
| Gemini | Yes | Files API / inline `video/mp4` / YouTube | Best long-video support |
| StepFun `step-5-preview` | Yes | OpenAI-compat `video_url` (URL, base64, `stepfile://`) | MP4/MOV/MKV, &lt;128MB |
| Qwen-VL (DashScope) | Yes | `video_url` + optional `fps` | Same OpenAI-compat shape |
| Doubao / 火山方舟 | Yes | `video_url` or Responses `input_video` | Files API for large clips |
| OpenRouter | Passthrough | `video_url` / `input_video` | Only video-capable upstreams |
| OpenAI GPT-4o | **No** | Extract frames → `image_url` | Official API rejects video files |
| Claude | **No** | Frames → `image` blocks | GIF = first frame only |

## Default path in this extension

`acp.vision.provider = openai-compat` → StepFun-style:

```http
POST {endpoint}/chat/completions
Authorization: Bearer {apiKey}

{
  "model": "step-5-preview",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "video_url", "video_url": { "url": "data:video/mp4;base64,..." } },
      { "type": "text", "text": "..." }
    ]
  }]
}
```

Large files (&gt;15MB) upload via Files API and reference `stepfile://{id}` when
the endpoint base looks like StepFun; otherwise base64 is still attempted with
a size warning.

Frame fallback (no vision endpoint, agent has `promptCapabilities.image`):
ffmpeg extracts JPEGs and they ride the existing image ContentBlock path.
