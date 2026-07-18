import { Editor } from "./Recipe";
import type { Recipe } from "../api";

const empty: Recipe = {
  id: "", name: "", category: "小炒", cover: "", source: "", created: "",
  ingredients: [], steps: [], tips: [], times: 0, rating: null,
};

export default function NewRecipe() {
  return <Editor r={empty} onDone={r => { location.hash = r.id ? `#/recipe/${r.id}` : "#/"; }} />;
}
