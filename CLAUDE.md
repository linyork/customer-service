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
