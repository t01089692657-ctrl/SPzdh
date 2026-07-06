// 视觉分析：调用 OpenAI 兼容的 chat/completions 接口（默认 sakai.my 中转）。
function joinApiPath(baseUrl, endpointPath) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  if (cleanBase.endsWith("/v1")) return `${cleanBase}${endpointPath.replace(/^\/v1/, "")}`;
  return `${cleanBase}${endpointPath}`;
}

function extractMessageText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => item?.text || item?.content || "").filter(Boolean).join("\n");
  }
  if (typeof value === "object") return value.text || value.content || "";
  return String(value);
}

async function callAnalysisModel(config, messages, options = {}) {
  const { apiKey, baseUrl, model } = config.analysis;
  if (!apiKey) {
    const error = new Error("分析接口未配置。请在 config.json 的 analysis.apiKey 或环境变量 SAKAI_API_KEY 中配置。");
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);
  let response;
  try {
    response = await fetch(joinApiPath(baseUrl, "/v1/chat/completions"), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.25,
        max_tokens: options.maxTokens ?? 1600
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("分析接口响应超时，请减少图片数量、换更短的视频，或稍后重试。");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const errorText = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
    const error = new Error(`分析接口调用失败：${errorText}`);
    error.status = response.status;
    throw error;
  }

  const content = extractMessageText(data?.choices?.[0]?.message?.content)
    || extractMessageText(data?.output_text)
    || extractMessageText(data?.text);
  if (!content) {
    const error = new Error("分析接口已返回，但没有解析到文本内容。");
    error.status = 502;
    throw error;
  }
  return { content, model };
}

function dataUrlImageContent(files, limit = 6) {
  return (files || [])
    .filter((file) => /^data:image\//.test(String(file.dataUrl || "")))
    .slice(0, limit)
    .map((file) => ({
      type: "image_url",
      image_url: { url: file.dataUrl, detail: "high" }
    }));
}

function describeFiles(files, limit = 8) {
  return (files || []).slice(0, limit).map((file, index) => {
    const name = String(file.name || `素材${index + 1}`);
    const type = String(file.type || "未知类型");
    const size = String(file.dataUrl || "").length;
    return `素材${index + 1}：${name}，类型 ${type}，约 ${Math.round(size / 1024)}KB`;
  }).join("\n");
}

function isVisionTimeout(error) {
  const text = String(error?.message || "");
  return error?.status === 504 || error?.status === 524 || /timeout|超时|524|Failed to fetch|aborted/i.test(text);
}

async function analyzeProduct(config, payload) {
  const images = dataUrlImageContent(payload.productImages, 6);
  if (!images.length) {
    const error = new Error("请先上传产品图片。");
    error.status = 400;
    throw error;
  }

  const productText = String(payload.productInfo || "").trim();
  const messages = [
    {
      role: "system",
      content: "你是外贸短视频的产品视觉分析师。只根据图片和用户补充信息判断，不确定的地方要写“需确认”。输出中文，直接给可用于视频脚本的产品信息。"
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "请分析这些产品图片，返回结构化结果：",
            "1. 产品可能是什么",
            "2. 可见外观、材质、结构、颜色、尺寸感",
            "3. 适合强调的卖点和使用场景",
            "4. 拍短视频时建议的镜头",
            "5. 可直接填入“产品描述”的中文文本",
            productText ? `用户已填写的产品补充信息：${productText}` : "用户没有填写补充信息，请以图片为主。"
          ].join("\n")
        },
        ...images
      ]
    }
  ];

  try {
    const result = await callAnalysisModel(config, messages, { maxTokens: 1400, timeoutMs: 25_000 });
    return { analysis: result.content, model: result.model, fallback: false };
  } catch (error) {
    if (!isVisionTimeout(error)) throw error;
    const fallbackMessages = [
      {
        role: "system",
        content: "你是外贸短视频产品策划。现在视觉接口超时，不能声称已经看清图片，只能基于文件信息和用户补充信息生成可编辑产品描述，并明确提示需要人工补充外观细节。"
      },
      {
        role: "user",
        content: [
          "请生成一份产品信息兜底分析，要求中文、结构清楚、可直接填到产品描述里。",
          "必须说明：视觉接口超时，以下内容没有识别图片细节，需要用户核对。",
          productText ? `用户补充产品信息：${productText}` : "用户暂未补充产品信息。",
          `上传文件：\n${describeFiles(payload.productImages, 6)}`,
          "",
          "输出：产品名称待确认、可补充字段、短视频卖点方向、镜头建议、可直接填入产品描述的文本。"
        ].join("\n")
      }
    ];
    const fallback = await callAnalysisModel(config, fallbackMessages, { maxTokens: 1000, timeoutMs: 90_000 });
    return {
      analysis: `提示：视觉识别接口超时，下面是基于文件信息和你填写内容生成的兜底分析，请补充/核对图片里的真实外观细节。\n\n${fallback.content}`,
      model: fallback.model,
      fallback: true
    };
  }
}

async function analyzeReference(config, payload) {
  const referenceKind = String(payload.referenceKind || "material");
  const frameImages = dataUrlImageContent(payload.videoFrames, 8);
  const referenceImages = dataUrlImageContent(payload.referenceFiles, 4);
  const images = referenceKind === "video" ? frameImages : referenceImages;
  if (!images.length) {
    const error = new Error("请先上传参考视频、参考图片或长图。");
    error.status = 400;
    throw error;
  }

  const notes = String(payload.notes || "").trim();
  const productInfo = String(payload.productInfo || "").trim();
  const frameNote = frameImages.length
    ? `系统已从视频中抽取 ${frameImages.length} 个关键帧，请按画面顺序推断节奏。`
    : "请按上传图片/长图画面分析。";

  const messages = [
    {
      role: "system",
      content: "你是短视频拆解导演，擅长把参考视频、长图或图片拆成可复用的脚本结构。输出中文，必须基于用户上传画面，不要套固定模板；看不清的地方写“画面未能确认”。"
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `素材类型：${referenceKind === "video" ? "参考视频关键帧" : "参考图片/长图"}`,
            frameNote,
            notes ? `用户补充想模仿的地方：${notes}` : "用户没有补充说明。",
            productInfo ? `待植入的产品信息：${productInfo}` : "产品信息暂未填写。",
            "",
            "请输出：",
            "1. 参考素材里真实出现的画面/人物/产品/字幕元素",
            "2. 开头钩子和情绪/痛点",
            "3. 按时间或画面顺序拆解脚本节奏",
            "4. 可复用的分镜结构",
            "5. 替换成我的产品时应保留什么、改掉什么",
            "6. 一版可直接用于生成视频的中文脚本草稿"
          ].join("\n")
        },
        ...images
      ]
    }
  ];

  try {
    const result = await callAnalysisModel(config, messages, { maxTokens: 1800, timeoutMs: 30_000 });
    return { analysis: result.content, model: result.model, frames: images.length, fallback: false };
  } catch (error) {
    if (!isVisionTimeout(error)) throw error;
    const fallbackMessages = [
      {
        role: "system",
        content: "你是短视频脚本导演。现在视觉接口超时，不能声称看到了画面，只能基于素材类型、文件名、用户补充信息和产品信息，生成可编辑的参考拆解草稿，并明确提示需要人工核对。"
      },
      {
        role: "user",
        content: [
          `素材类型：${referenceKind === "video" ? "参考视频" : "参考图片/长图"}`,
          referenceKind === "video" ? `已从视频抽取 ${frameImages.length} 张关键帧，但视觉接口未能返回。` : "已上传参考图片/长图，但视觉接口未能返回。",
          notes ? `用户补充想模仿的地方：${notes}` : "用户没有补充想模仿的地方。",
          productInfo ? `待植入产品信息：${productInfo}` : "产品信息暂未填写。",
          `上传文件：\n${describeFiles(payload.referenceFiles, 4)}`,
          "",
          "请输出：视觉超时提示、可人工核对清单、通用但可编辑的拆解结构、替换成我的产品的脚本草稿。不要写“我看到画面中”。"
        ].join("\n")
      }
    ];
    const fallback = await callAnalysisModel(config, fallbackMessages, { maxTokens: 1400, timeoutMs: 90_000 });
    return {
      analysis: `提示：视觉识别接口超时，下面是基于素材信息和你补充内容生成的兜底拆解，请你对照参考视频/长图人工核对节奏和画面。\n\n${fallback.content}`,
      model: fallback.model,
      frames: images.length,
      fallback: true
    };
  }
}

module.exports = { analyzeProduct, analyzeReference, callAnalysisModel };
