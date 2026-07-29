// 「贴教程链接/文案 → AI 整理 → 存回菜谱」——recipe/index.tsx「改一笔」页、
// record/index.tsx 记新菜时顺手补做法，两处共用同一份判定逻辑，别各写一份走岔。
import { api, type Recipe } from "./api";

interface Extracted {
  name: string; category: string; ingredients: Recipe["ingredients"]; steps: string[]; tips: string[];
  kcal: number | null; minutes: number | null; difficulty?: string | null; video_can_retry: boolean;
}

async function saveExtracted(recipeId: string, x: Extracted, link: string | null, source: string): Promise<Recipe> {
  // PUT 是 merge 语义（body 带的字段覆盖）：只写做法相关字段；菜名/分类是这道菜的身份，不让 AI 改
  const patch: Partial<Recipe> = { id: recipeId, ingredients: x.ingredients, steps: x.steps, tips: x.tips };
  if (x.kcal != null) patch.kcal = x.kcal;
  if (x.minutes != null) patch.minutes = x.minutes;
  if (x.difficulty) patch.difficulty = x.difficulty;  // 翻牌子的「只要简单省事的」靠它
  // servings 不收：几餐由记一餐后的回填流程问本人，AI 猜的分餐数会带偏 kcal/餐 显示
  if (link && source === "") patch.source = link;  // 顺手补上教程来源（不覆盖已有）
  await api.saveRecipe(patch);
  return api.recipe(recipeId);
}

export interface ExtractResult { recipe: Recipe; videoCanRetry: boolean; link: string | null }

export async function extractAndApply(recipeId: string, raw: string, source: string): Promise<ExtractResult> {
  // 粘的是分享链接（抖音/小红书/B站口令等）→ 服务端抓文案；纯文字 → 直接整理
  const link = raw.match(/https?:\/\/\S+/)?.[0] ?? null;
  const isLinkMode = !!link && raw.replace(/https?:\/\/\S+/, "").trim().length < 80;
  // 本地 claude-cli 可能 30s+：60s 还没回就温和失败（不重试，避免重复写）
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("管家研读超时了——稍后再试，或先手动补几笔")), 60000));
  const x = await Promise.race([
    api.aiExtract(isLinkMode ? "" : raw, source, isLinkMode ? link ?? undefined : undefined),
    timeout,
  ]);
  const linkUsed = isLinkMode ? link : null;
  const recipe = await saveExtracted(recipeId, x, linkUsed, source);
  return { recipe, videoCanRetry: x.video_can_retry, link: linkUsed };
}

/** 看视频出菜谱——真花钱、真慢（约一两分钟），只应该在用户主动点了「看视频再试一次」时调用。*/
export async function extractFromVideoAndApply(recipeId: string, link: string, source: string): Promise<Recipe> {
  const x = await api.aiExtractVideo(link);
  return saveExtracted(recipeId, x, link, source);
}
