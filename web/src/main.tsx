import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { captureTokenFromUrl, installFetchAuth } from "./token";

captureTokenFromUrl();  // 主人魔法链接 ?token=xxx → 存下并抹掉地址栏
installFetchAuth();     // /api/ 请求自动带令牌；没设令牌时无感

createRoot(document.getElementById("root")!).render(<App />);
