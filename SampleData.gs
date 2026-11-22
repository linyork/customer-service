/**
 * SampleData
 * @description Demo 用的範例書籍與 FAQ（DevTools.seedSampleData 寫入試算表）
 *
 * 書目全部是虛構的，避免使用真實出版品的書名與內容。
 */
var SampleData = {
  products: [
    { id: 'B001', title: '霧港謀殺案', author: '沈默言', category: '推理', price: 380, stock: 12,
      description: '港都濃霧夜裡，一具屍體出現在燈塔下。退休刑警與年輕記者聯手，在潮汐退去前找出真相。', color: '#3d5a80', active: true },
    { id: 'B002', title: '第十三號房客', author: '沈默言', category: '推理', price: 360, stock: 5,
      description: '老公寓裡從沒人見過的房客，每月準時交租。直到某天，房東收到一封來自十三號房的求救信。', color: '#293241', active: true },
    { id: 'B003', title: '午後的貓與咖啡', author: '林小窗', category: '散文', price: 320, stock: 20,
      description: '一位咖啡店主人記錄十年來的客人與店貓，溫柔又帶點幽默的日常散文集。', color: '#c08552', active: true },
    { id: 'B004', title: '把日子過成詩', author: '林小窗', category: '散文', price: 300, stock: 0,
      description: '關於慢下來的四十篇短文：早餐、散步、整理抽屜，以及好好告別。', color: '#d4a373', active: true },
    { id: 'B005', title: '星海拓荒者', author: '韓宇辰', category: '科幻', price: 450, stock: 8,
      description: '人類第一艘世代飛船啟航三百年後，船上的孩子們開始懷疑：目的地真的存在嗎？', color: '#22223b', active: true },
    { id: 'B006', title: '演算法之心', author: '韓宇辰', category: '科幻', price: 420, stock: 15,
      description: '一個被設計來調解糾紛的 AI，第一次面對它無法計算的問題：原諒。', color: '#4a4e69', active: true },
    { id: 'B007', title: '小資理財入門', author: '陳穩健', category: '商業理財', price: 350, stock: 25,
      description: '從記帳、緊急預備金到指數化投資，寫給社會新鮮人的第一本理財書。', color: '#2a9d8f', active: true },
    { id: 'B008', title: '一人公司實戰手冊', author: '陳穩健', category: '商業理財', price: 480, stock: 7,
      description: '接案、定價、報稅、找客戶，把一個人的事業經營得長久的實務指南。', color: '#264653', active: true },
    { id: 'B009', title: '給孩子的台灣山林圖鑑', author: '吳青山', category: '兒童', price: 520, stock: 6,
      description: '全彩手繪，介紹台灣中低海拔常見的六十種動植物，附親子步道路線。', color: '#6a994e', active: true },
    { id: 'B010', title: '小狐狸找月亮', author: '吳青山', category: '兒童', price: 280, stock: 18,
      description: '月亮不見了！小狐狸出發去問森林裡的朋友。適合 3–6 歲的睡前繪本。', color: '#f4a261', active: true },
    { id: 'B011', title: '寫給設計師的 JavaScript', author: '周程式', category: '電腦資訊', price: 580, stock: 10,
      description: '用畫面與互動當例子，從零開始學會讓網頁動起來。附線上練習範例。', color: '#e9c46a', active: true },
    { id: 'B012', title: '用 AI 打造你的客服系統', author: '周程式', category: '電腦資訊', price: 620, stock: 9,
      description: '以 Google Apps Script、試算表與 LLM API 為例，一步步做出能接單、查單、轉真人的 AI 客服。', color: '#e76f51', active: true }
  ],
  faq: [
    { question: '運費怎麼算？', answer: '單筆訂單滿 NT$1,000 免運，未滿酌收運費 NT$60。' },
    { question: '多久會出貨？', answer: '付款完成（或選擇貨到付款）後 1–2 個工作天內出貨，宅配約 1–2 天送達。週末與國定假日不出貨。' },
    { question: '有哪些付款方式？', answer: '提供「銀行轉帳」與「貨到付款」兩種。轉帳帳號：拾頁銀行（999）帳號 0000-1234-5678，請於下單後 3 天內完成轉帳，並告知訂單編號與帳號末五碼。' },
    { question: '可以退換貨嗎？', answer: '收到商品 7 天內，書籍保持全新未拆封可申請退換貨。若有破損、缺頁、裝訂錯誤，請拍照聯繫客服，我們負擔來回運費更換。' },
    { question: '可以取消訂單嗎？', answer: '狀態為「待付款」或「待出貨」的訂單可直接取消；已出貨的訂單請改辦退貨。' },
    { question: '有實體門市嗎？', answer: '目前僅提供線上購書，門市籌備中。' },
    { question: '客服時間？', answer: 'AI 客服 24 小時在線；真人客服服務時間為週一至週五 10:00–18:00。' },
    { question: '可以開統編嗎？', answer: '可以，下單時在備註填寫統一編號與抬頭即可，發票會隨書寄出。' }
  ]
};
