-- 參考分類（非財務資料）：分析分類與修繕分類的初始值，之後可在網站「科目／廠商設定」自行調整。
-- 執行時機：執行完 migrations 之後，在 SQL Editor 執行一次。重複執行不會產生重複資料。

insert into public.analysis_categories (side, name, is_repair, sort_order, description) values
  ('income',  '管理費收入',             false, 1, '住戶繳納的管理費'),
  ('income',  '車位管理費收入',         false, 2, '汽車位、機車位管理費'),
  ('income',  '其他收入',               false, 3, '利息、臨停、回饋金、門禁卡、影印等'),
  ('income',  '管理費折扣（收入減項）', false, 4, '報表列於收入、金額為負數的折扣分攤'),
  ('expense', '管理服務費',             false, 1, null),
  ('expense', '保全服務費',             false, 2, null),
  ('expense', '清潔及環境維護費',       false, 3, '環境維護、垃圾清運、園藝景觀'),
  ('expense', '公共設施及設備維護費',   false, 4, '公設保養合約'),
  ('expense', '修繕費',                 true,  5, '公共設備、建築物、公共設施修繕'),
  ('expense', '水電費',                 false, 6, '公共電費、水費、分攤電費'),
  ('expense', '行政費用',               false, 7, '郵資、電話、勞務、租賃、桶裝水、停車位租金等'),
  ('expense', '保險費',                 false, 8, '公共意外責任險等'),
  ('expense', '社區活動及福利',         false, 9, '節慶活動、佈置、盆栽、慰勞金'),
  ('expense', '其他支出',               false, 10, null)
on conflict (side, name) do nothing;

insert into public.repair_categories (name, keywords, sort_order) values
  ('電梯',           array['電梯','升降'], 1),
  ('管線／給排水',   array['管線','水管','逆止閥','接頭','給水','排水','揚水','污水','馬桶'], 2),
  ('防水',           array['防水','漏水','壁癌','矽利康'], 3),
  ('照明',           array['照明','燈','LED'], 4),
  ('門禁／監控',     array['門禁','監控','攝影機','鏡頭','對講'], 5),
  ('空調',           array['空調','冷氣'], 6),
  ('馬達／泵浦',     array['馬達','泵浦','幫浦'], 7),
  ('消防',           array['消防','滅火','偵煙'], 8),
  ('地坪／建築',     array['地坪','epoxy','Epoxy','油漆','外牆','磁磚'], 9),
  ('機電',           array['機電','配電','電力'], 10),
  ('其他公共設備',   array[]::text[], 11)
on conflict (name) do nothing;
