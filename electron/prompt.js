'use strict';

// Prompt 构建：四段 system（身份 / 记忆 / 摘要 / 约束）+ messages 组装 + 预算裁剪。
// 只接收数据、不读盘 —— 便于单元测试。

const BUDGET = {
  system: 600,
  history: 1200,
  factsMax: 5,
  summarySteps: [60, 40, 20],
  identityMax: 300,
};

const FACT_LABELS = {
  'user.name': '称呼',
  'user.like': '喜欢',
  'user.dislike': '不喜欢',
  'user.job': '工作',
  'user.schedule': '作息',
  'user.event': '近况',
};

/** 粗算 token：中日韩字符按 1 个，其余按 4 字符 1 个 */
function est(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

function factText(f) {
  const label = FACT_LABELS[f.key] || f.key;
  return `- ${label}：${f.value}`;
}

function topFacts(facts, limit) {
  return [...(facts || [])]
    .filter((f) => f && f.value)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, limit);
}

/**
 * 组装 prompt。
 * @returns {{system:string, messages:Array, budget:Object}}
 */
function build(opts = {}) {
  const {
    persona = {},
    facts = [],
    summary = '',
    yesterdaySummary = '',
    recent = [],
    userText = '',
    newChapter = false,
    budget = BUDGET,
  } = opts;

  let identity = String(persona.identity || '');
  const constraints = String(persona.constraints || '');
  let summaryText = [yesterdaySummary, summary].filter(Boolean).join(' ').trim();
  let factList = topFacts(facts, budget.factsMax);
  let summaryStep = 0;

  const composeSystem = () => {
    const parts = [];
    if (identity) parts.push(`【身份】\n${identity}`);
    if (factList.length) parts.push(`【记忆】\n${factList.map(factText).join('\n')}`);
    if (summaryText) parts.push(`【摘要】\n${summaryText}`);
    if (constraints) parts.push(`【约束】\n${constraints}`);
    if (newChapter) {
      parts.push('（角色设定刚刚更新：请严格按最新设定回复，忽略历史对话中的旧语气与旧身份。）');
    }
    return parts.join('\n\n');
  };

  // 裁剪顺序：摘要 → 事实 → 身份（FR-328）
  let system = composeSystem();
  let guard = 0;
  while (est(system) > budget.system && guard < 20) {
    guard += 1;
    if (summaryText && summaryStep < budget.summarySteps.length) {
      const limit = budget.summarySteps[summaryStep];
      summaryStep += 1;
      if (summaryText.length > limit) {
        summaryText = summaryText.slice(0, limit) + '…';
      } else {
        summaryText = '';
      }
    } else if (factList.length) {
      factList = factList.slice(0, -1);
    } else if (identity.length > budget.identityMax) {
      identity = identity.slice(0, budget.identityMax) + '…';
    } else {
      break;
    }
    system = composeSystem();
  }

  // 历史裁剪：从最老开始丢，保留至少一轮
  let history = recent.filter((m) => m && m.content).map((m) => ({ role: m.role, content: m.content }));
  let historyTokens = est(history.map((m) => m.content).join('\n'));
  while (historyTokens > budget.history && history.length > 2) {
    history = history.slice(2);
    historyTokens = est(history.map((m) => m.content).join('\n'));
  }

  const messages = [...history];
  if (userText) messages.push({ role: 'user', content: userText });

  return {
    system,
    messages,
    budget: {
      systemTokens: est(system),
      historyTokens,
      facts: factList.length,
      summaryChars: summaryText.length,
      historyTurns: Math.floor(history.length / 2),
    },
  };
}

module.exports = { build, est, BUDGET, FACT_LABELS };
