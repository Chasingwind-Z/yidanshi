import type { Recipe, ShopItem } from "./api";

export const SEASONING = /油|盐|糖|生抽|老抽|酱|醋|料酒|淀粉|胡椒|花椒|八角|香叶|桂皮|鸡精|味精|蚝油|冰糖|辣椒面|孜然/;

/** 把若干道菜的食材并入现有清单：同名合并用量、去重菜名，勾选状态保留 */
export function mergeShopping(existing: ShopItem[], recipes: Recipe[]): ShopItem[] {
  const map = new Map(existing.map(x => [x.name, { ...x }]));
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      const e = map.get(ing.name);
      if (e) {
        const rs = new Set(e.recipes.split("、").filter(Boolean));
        if (!rs.has(r.name)) {
          rs.add(r.name);
          e.recipes = [...rs].join("、");
          if (ing.amount) e.amounts = e.amounts ? `${e.amounts} + ${ing.amount}` : ing.amount;
        }
      } else {
        map.set(ing.name, { name: ing.name, amounts: ing.amount ?? "", recipes: r.name,
          checked: false, seasoning: SEASONING.test(ing.name) });
      }
    }
  }
  return [...map.values()].sort((a, b) => Number(a.seasoning) - Number(b.seasoning));
}
