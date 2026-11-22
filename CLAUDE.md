# CLAUDE.md

## 溝通

- 一律使用繁體中文。
- 一則訊息一個目的；先講結論。技術細節寫進 commit message 與這份文件，不要灌進對話。

## 專案

AI 線上客服 Demo（虛構書店「拾頁書店」），純 Google Apps Script（V8），比照同層的 `iris`、`christina` 專案。
架構與首次設定見 README。所有 `.gs` 共用一個全域命名空間，沒有 import。

## 部署（改完就推，網址不變）

- `git push` 到 main 會觸發 `.githooks/pre-push`：`node tests/run.cjs` → `clasp push --force` → `clasp deploy -i <DEPLOYMENT_ID>`。
- `DEPLOYMENT_ID` 只寫在 `Config.gs`，hook 從那裡讀。**不要另建部署**，否則 Telegram webhook 與商店網址會變。
- hook 讀的是工作目錄，推之前先 commit 乾淨。
- 新 clone 要先 `git config core.hooksPath .githooks`。

## 規則

- **新增業務規則放 `Store.gs`**：網頁、AI 工具、後台三條路都呼叫它，不要在 WebApi 或 Tools 另寫一份。
- **工具**：`Tools.definitions()` 與 `execute()` 的 switch 一起改；回傳一律帶 `ok`。session / channel 從 `ctx` 拿，不可接受模型參數。
- **LLM 只經過 `NvidiaService.chat`**（OpenAI 格式，含重試看錶與備援模型），不要在別處直接打 NVIDIA。
- **手動執行的函式放 `DevTools.gs`**；`doGet`／`doPost`／`webApi`／`dailyCleanUp` 靠名字被呼叫，不可改名或搬走。
- **Sheet 欄位**定義在 `DB.SCHEMA`；新增欄位加在最後並重跑 `setupSheets()`（只補表頭不動資料）。
- 網頁 API 走 `doPost`（`source:'web'`），fetch 失敗時前端自動改用 `google.script.run.webApi`，兩條路進同一個 `WebApi.handle`。
- 改了行為就補測試（`tests/run.cjs`）；用到新的 GAS API 要在 `tests/gas-mock.cjs` 補模擬。
- 日誌用 `Logger.info/warning/error/ai`，寫進 `console.log` 分頁。

## 踩過的坑（2026/11/22 驗收）

- **Telegram 路徑的 doPost 不可回 ContentService**：`/exec` 會把它包成 302，Telegram 不跟轉址、一直重送，`max_connections=1` 下還會卡住後面所有訊息。什麼都不回才會是 200。
- **Sheet 會自動轉型**：`'0900…'` 變數字（電話掉 0）、日期字串變 Date。所以 `DB` 寫入一律加前導 `'`、讀取把 Date 轉回字串；`tests/gas-mock.cjs` 也模擬了這個轉型，不要拿掉。
- **網頁請求不可換路重送**：fetch 成功過之後的失敗不能改走 `google.script.run` 重送（請求可能已到伺服器）；`createOrder`／`chat` 另有 `requestId` 冪等保護。
- **LLM 歷史只有文字、沒有上一輪工具結果**：模型會猜書籍編號。`create_order` 因此要求品項附書名、由 `Tools.checkItemTitles` 比對，這道伺服器端檢查不可省。
- **模型選擇**：`gemma-4-31b-it`（iris 用的）當天單次 150–270 秒，不適合即時客服；現用 `nemotron-3.5-lightning`（約 0.5–8 秒）、備援 `mistral-large-4`。換模型先跑 `DevTools.testNimCandidates`，用 Script Property 切換不必部署。
