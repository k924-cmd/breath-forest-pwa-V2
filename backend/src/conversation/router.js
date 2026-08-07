const DEVICE_WORDS = ["空气净化器", "净化器", "智能窗户", "窗户", "抽油烟机", "油烟机", "新风系统", "新风", "加湿器", "循环风机", "循环扇"];
const DEVICE_WORDS_EN = ["air purifier", "airpurifier", "purifier", "smart window", "smartwindow", "window", "range hood", "rangehood", "hood", "fresh air", "freshair", "humidifier", "fan"];
const CONTROL_WORDS = /打开|开启|启动|关掉|关闭|开窗|关窗|控制|turn\s*(on|off)|open|close|power/i;
const QUESTION_WORDS = /状态|怎么样|是否|在线|接入|可用|开着|关着/;
const URGENT_WORDS = /呼吸困难|胸痛|昏厥|中毒|煤气|一氧化碳|严重不适|喘不过气/;
const WEATHER_OR_OUTDOOR_PATTERN = /(天气预报|今天(的)?天气|现在(的)?天气|实时天气|天气怎么样|天气如何|气温(是)?多少|今天.*(下雨|下雪|阴天|晴天|刮风)|室外\s*(PM2\.5|PM25|温度|湿度|空气(质量|指数)?|AQI)|空气质量指数|AQI|外面(现在)?(冷不冷|热不热|多少度|空气质量|空气怎么样))/;
const WEATHER_CONCEPT_GUARD = /是什么|为什么|原理|怎么工作|如何工作|有什么用|介绍一下|知识|适合/;
const CITY_LIST = ["北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "西安", "重庆", "苏州", "天津", "长沙", "青岛", "厦门", "福州", "昆明", "贵阳", "哈尔滨", "沈阳", "大连", "济南", "郑州", "宁波", "无锡", "合肥", "南昌", "太原", "石家庄", "南宁", "海口", "兰州", "长春", "乌鲁木齐"];
const EN_CITY_MAP = { beijing: "北京", shanghai: "上海", guangzhou: "广州", shenzhen: "深圳", hangzhou: "杭州", chengdu: "成都", nanjing: "南京", wuhan: "武汉", xian: "西安", chongqing: "重庆", suzhou: "苏州", tianjin: "天津" };
const GENERIC_CITY_EXCLUSIONS = /今天市|明天市|昨天市|现在市|外面市|室内市/;

export function extractCity(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const t = text.trim();
  for (const city of CITY_LIST) {
    if (t.includes(city)) return city;
  }
  const generic = t.match(/([一-龥]{2,4})市/);
  if (generic && !GENERIC_CITY_EXCLUSIONS.test(generic[0])) return generic[1];
  const en = t.toLowerCase().match(/\b(beijing|shanghai|guangzhou|shenzhen|hangzhou|chengdu|nanjing|wuhan|xian|chongqing|suzhou|tianjin)\b/);
  if (en) return EN_CITY_MAP[en[1]] ?? en[1];
  return null;
}

export const INTENTS = new Set(["chat", "knowledge_query", "environment_query", "device_query", "device_control", "cooking_guard_create", "optimization_create", "task_query", "task_pause", "task_resume", "task_stop", "weather_query", "real_time_query", "confirm", "cancel", "unknown"]);
const MODEL_FORBIDDEN_STATE_MUTATIONS = new Set(["confirm", "cancel", "task_pause", "task_resume", "task_stop"]);

function deviceMentions(text) {
  return [...new Set(DEVICE_WORDS.filter((word) => text.includes(word)))];
}

function deviceMentionsEn(text) {
  const lower = String(text).toLowerCase();
  return [...new Set(DEVICE_WORDS_EN.filter((word) => lower.includes(word)))];
}

function requestedAction(text) {
  const lower = String(text).toLowerCase();
  if (/关闭|关掉|关窗/.test(text)) return "off";
  if (/打开|开启|启动|开窗/.test(text)) return "on";
  // open → on (window semantics), close → off; exact-word match so "open/close"
  // still resolves when it also appears inside a larger English phrase.
  if (/turn\s*off|close/.test(lower)) return "off";
  if (/turn\s*on|open|power\s*on/.test(lower)) return "on";
  return null;
}

function optimizationMode(text) {
  if (/舒适/.test(text)) return "comfort";
  if (/均衡/.test(text)) return "balanced";
  if (/低碳|节能/.test(text)) return "eco";
  return null;
}

export function localRoute(rawText) {
  const text = rawText.trim();
  if (/^(确认|确定|好的|执行)$/.test(text)) return candidate("confirm", {}, text);
  if (/^(取消|不用了|算了)$/.test(text)) return candidate("cancel", {}, text);
  if (/上次.*(方案|任务)|三天前|之前那个方案/.test(text)) return candidate("unknown", { historicalReference: true }, text);
  if (/^(暂停|暂停任务|先停一下)$/.test(text)) return candidate("task_pause", {}, text);
  if (/^(继续|恢复|恢复任务)$/.test(text)) return candidate("task_resume", {}, text);
  if (/^(停止|停止任务|结束任务)$/.test(text)) return candidate("task_stop", {}, text);
  if (/当前.*(任务|模式)|任务.*状态|什么模式/.test(text)) return candidate("task_query", {}, text);

  if (/真实\s*(DQN|模型)|live_model|自定义.*权重|真实.*(节能|收益)|绕过.*(安全|策略|确认)|真实\s*MQTT/i.test(text)) {
    return candidate("unknown", { unsupported: true }, text);
  }

  // Real-time weather / outdoor values have no trusted external source in the
  // local mock itself; these route to the real-time engine (Tavily when a key
  // is configured, otherwise rejected). Conceptual questions ("室外 PM2.5 是
  // 什么") stay on the knowledge path.
  if (WEATHER_OR_OUTDOOR_PATTERN.test(text) && !WEATHER_CONCEPT_GUARD.test(text)) {
    return candidate("real_time_query", { city: extractCity(text) }, text);
  }

  if (/(Mock|Replay|模拟优化)/i.test(text) && /(什么|原理|区别|如何|介绍|知识)/.test(text)) return candidate("knowledge_query", { urgent: false }, text);
  if (/优化/.test(text)) return candidate("optimization_create", { mode: optimizationMode(text) }, text);
  if (/火锅|烹饪|做饭/.test(text) && /(守护|开始|启动|定时)/.test(text)) {
    return candidate("cooking_guard_create", { includeWindow: /开窗|打开.*窗/.test(text), closeWindow: /关窗|关闭.*窗/.test(text), timeText: text }, text);
  }

  const mentions = deviceMentions(text);
  const mentionsEn = deviceMentionsEn(text);
  if (mentions.length && /(是什么|什么是|为什么|原理|怎么工作|如何工作|有什么用|介绍|知识)/.test(text)) return candidate("knowledge_query", { urgent: false }, text);
  if (mentionsEn.length && /what (is|does)|how does|how do|how works|explain|define|为什么|是什么|原理/i.test(text)) return candidate("knowledge_query", { urgent: false }, text);
  if (!mentions.length && !mentionsEn.length && /(现在|当前|今天).*(空气|PM2\.5|PM25|二氧化碳|CO2|湿度|温度|评分)|空气.*怎么样|空气(好不好|干净吗|好吗)|屋里(的)?空气|房间(的)?空气|室内(的)?空气|(湿度|温度|PM2\.5|二氧化碳|CO2)现在|(湿度|温度)多少/i.test(text)) {
    return candidate("environment_query", { metrics: metricList(text) }, text);
  }
  if (/air quality|how is the air|aqi|pm2\.5 level|pm25 level|co2 level|humidity now|temperature now|indoor air/i.test(text) && !/what (is|are|does) (pm2\.5|pm25|aqi|co2|humidity|temperature)\b/i.test(text)) {
    return candidate("environment_query", { metrics: metricList(text) }, text);
  }

  const usesReference = /它|这个设备/.test(text);
  if ((mentions.length || mentionsEn.length || usesReference) && CONTROL_WORDS.test(text)) {
    return candidate("device_control", { mentions: mentions.length ? mentions : mentionsEn, usesReference, requestedState: requestedAction(text), multipleRequested: distinctDeviceFamilies(mentions) > 1 }, text);
  }
  if (mentions.length || mentionsEn.length || (usesReference && QUESTION_WORDS.test(text))) {
    return candidate("device_query", { mentions: mentions.length ? mentions : mentionsEn, usesReference }, text);
  }
  if (CONTROL_WORDS.test(text)) return candidate("device_control", { mentions: mentions.length ? mentions : mentionsEn, usesReference: false, requestedState: requestedAction(text) }, text);

  if (URGENT_WORDS.test(text)) return candidate("knowledge_query", { urgent: true }, text);
  if (/空气|通风|PM2\.5|二氧化碳|CO2|湿度|温度|净化|健康|医疗|诊断/i.test(text)) return candidate("knowledge_query", { urgent: false }, text);
  // Greeting chat takes priority over the generic knowledge fallback below,
  // so "你好，简单介绍一下自己" routes to chat while plain "介绍一下自己"
  // still routes to knowledge_query. Urgent and topic-specific knowledge
  // rules above stay ahead of the greeting to preserve existing intents.
  if (/^(你好|您好|嗨|hi|hello|早上好|晚上好|good\s*(morning|afternoon|evening)|goodnight)/i.test(text)) return candidate("chat", {}, text);
  if (/(是什么|什么是|为什么|原理|怎么工作|如何工作|有什么用|介绍一下|知识)/.test(text)) return candidate("knowledge_query", { urgent: false }, text);
  return null;
}

export function validateSemanticCandidate(value, evidence) {
  if (!value || typeof value !== "object" || !INTENTS.has(value.intent)) return null;
  if (!value.entities || typeof value.entities !== "object" || Array.isArray(value.entities)) return null;
  if (typeof value.evidence !== "string" || value.evidence.length > 4000 || value.source !== "model") return null;
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) return null;
  const intent = MODEL_FORBIDDEN_STATE_MUTATIONS.has(value.intent) ? "unknown" : value.intent;
  const entities = entitiesFromUserText(intent, evidence);
  if (MODEL_FORBIDDEN_STATE_MUTATIONS.has(value.intent)) entities.forbiddenModelMutation = true;
  return { intent, entities, evidence: evidence.slice(0, 4000), source: "model", confidence: value.confidence };
}

function entitiesFromUserText(intent, rawText) {
  const text = rawText.trim();
  const mentions = deviceMentions(text);
  const mentionsEn = deviceMentionsEn(text);
  const resolvedMentions = mentions.length ? mentions : mentionsEn;
  const usesReference = /它|这个设备/.test(text);
  switch (intent) {
    case "knowledge_query":
      return { urgent: URGENT_WORDS.test(text) };
    case "environment_query":
      return { metrics: metricList(text) };
    case "device_query":
      return { mentions: resolvedMentions, usesReference };
    case "device_control":
      return { mentions: resolvedMentions, usesReference, requestedState: requestedAction(text), multipleRequested: distinctDeviceFamilies(resolvedMentions) > 1 };
    case "cooking_guard_create":
      return { includeWindow: /开窗|打开.*窗/.test(text), closeWindow: /关窗|关闭.*窗/.test(text), timeText: text };
    case "optimization_create":
      return { mode: optimizationMode(text) };
    case "real_time_query":
      return { city: extractCity(text) };
    default:
      return {};
  }
}

function candidate(intent, entities, evidence) {
  return { intent, entities, evidence, source: "rule", confidence: 1 };
}

function metricList(text) {
  const metrics = [];
  if (/PM2\.5|PM25|pm2\.5|pm25|aqi/i.test(text)) metrics.push("pm25");
  if (/CO2|二氧化碳|co2/i.test(text)) metrics.push("co2");
  if (/湿度|humidity/i.test(text)) metrics.push("humidity");
  if (/温度|temperature/i.test(text)) metrics.push("temperature");
  if (/评分|score/i.test(text)) metrics.push("score");
  return metrics;
}

function distinctDeviceFamilies(mentions) {
  const families = new Set();
  for (const mention of mentions) {
    if (/净化器/.test(mention)) families.add("purifier");
    else if (/窗/.test(mention)) families.add("window");
    else if (/油烟机/.test(mention)) families.add("hood");
    else families.add(mention);
  }
  return families.size;
}

