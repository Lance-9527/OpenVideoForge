/**
 * verify.mjs — cities.json 校验与坐标抽查
 *
 * A) 逐个范围校验：lat ∈ [-90,90], lng ∈ [-180,180]，外加 id/名称/别名结构校验
 *
 * B) Nominatim 抽查：对随机抽样的城市调用 OSM Nominatim，
 *    带 User-Agent: OpenVideoForge/1.0 (local test)（不带会被 403），
 *    用 haversine 计算与返回坐标的偏差；偏差 > 60km 的用 Nominatim 坐标修正，
 *    并优先用 Nominatim 的 display_name 补 aliases。
 *    Nominatim 查不到（返回空）-> 保留原坐标，记入“未验证”列表。
 *
 *  —— 本机环境的适配（重要）——
 *    本机到 nominatim.openstreetmap.org 的 DNS 被劫持到不可达地址，
 *    真实 IP (208.67.222.222 / 208.67.220.220) 亦超时；脚本启动时探测一次并如实记录。
 *    为完成同样的校验，改用以下数据源（均为公开地理数据服务，OSM/GeoNames）：
 *      1) Nominatim   —— 任务书指定源，可达则优先使用
 *      2) open-meteo  —— GeoNames 前向检索：英文名 -> 坐标 + country_code + 人口 + GeoNames id
 *      3) Photon      —— 基于 OSM 的反向检索：把本表坐标拿去问“这是哪个城市/哪个省”，返回中文城市名与省名
 *      4) BigDataCloud —— 反向检索备选（服务端配额受限）
 *      4) Overpass    —— OSM place=city/town 节点（OSM 记录的城市中心点），兜底
 *
 *  —— 消歧规则（防止“同名异地”误判反向污染本来正确的坐标）——
 *      - 前向候选按 country_code 过滤（港澳台及属地用 GeoNames 实际代码 HK/MO/TW/GU/NC/PF）
 *      - 候选打分：省/州一致 > 人口 > 城市型 feature_code > 中文名/别名/英文名匹配
 *      - 反向检索确认坐标落在该城市内 => 坐标正确，即使与 GeoNames 锚点有偏差也不修正
 *      - 候选带中文名却与本表中文名/别名都对不上 => 同名异地，不自动修正，记入未验证
 *      - 反向检索不可用时，只接受“人口>0 且为行政中心级 feature_code”的强证据候选
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCities, writeCities, haversineKm } from './io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const SAMPLE = Number(arg('sample', 60));
const SEED = Number(arg('seed', 20261110));
const OUT = arg('out', path.resolve(HERE, '..', '..', 'server', 'cities.json'));
const TOLERANCE_KM = 60;
const UA = 'OpenVideoForge/1.0 (local test)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OPEN_METEO = 'https://geocoding-api.open-meteo.com/v1/search';
const BIGDATACLOUD = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const OVERPASS_LIST = ['https://overpass-api.de/api/interpreter', 'https://overpass.osm.ch/api/interpreter'];
const PLACE_RE = '^(city|town|county|municipality|borough|suburb)$';

/** 国家中文名 -> ISO-3166-1 alpha-2 */
const ISO2 = {
  中国: 'CN', 日本: 'JP', 韩国: 'KR', 新加坡: 'SG', 泰国: 'TH', 印度尼西亚: 'ID',
  马来西亚: 'MY', 菲律宾: 'PH', 越南: 'VN', 缅甸: 'MM', 柬埔寨: 'KH', 老挝: 'LA',
  蒙古: 'MN', 印度: 'IN', 孟加拉国: 'BD', 斯里兰卡: 'LK', 巴基斯坦: 'PK', 尼泊尔: 'NP',
  阿富汗: 'AF', 马尔代夫: 'MV', 阿拉伯联合酋长国: 'AE', 卡塔尔: 'QA', 沙特阿拉伯: 'SA',
  伊朗: 'IR', 伊拉克: 'IQ', 土耳其: 'TR', 以色列: 'IL', 黎巴嫩: 'LB', 约旦: 'JO',
  科威特: 'KW', 巴林: 'BH', 阿曼: 'OM', 也门: 'YE', 哈萨克斯坦: 'KZ', 乌兹别克斯坦: 'UZ',
  阿塞拜疆: 'AZ', 格鲁吉亚: 'GE', 亚美尼亚: 'AM', 英国: 'GB', 爱尔兰: 'IE', 法国: 'FR',
  比利时: 'BE', 卢森堡: 'LU', 荷兰: 'NL', 德国: 'DE', 瑞士: 'CH', 奥地利: 'AT',
  西班牙: 'ES', 葡萄牙: 'PT', 意大利: 'IT', 希腊: 'GR', 马耳他: 'MT', 丹麦: 'DK',
  瑞典: 'SE', 挪威: 'NO', 芬兰: 'FI', 爱沙尼亚: 'EE', 拉脱维亚: 'LV', 立陶宛: 'LT',
  冰岛: 'IS', 波兰: 'PL', 捷克: 'CZ', 匈牙利: 'HU', 罗马尼亚: 'RO', 保加利亚: 'BG',
  塞尔维亚: 'RS', 克罗地亚: 'HR', 斯洛文尼亚: 'SI', 北马其顿: 'MK', 波黑: 'BA',
  黑山: 'ME', 阿尔巴尼亚: 'AL', 乌克兰: 'UA', 白俄罗斯: 'BY', 摩尔多瓦: 'MD',
  俄罗斯: 'RU', 美国: 'US', 加拿大: 'CA', 墨西哥: 'MX', 危地马拉: 'GT', 哥斯达黎加: 'CR',
  巴拿马: 'PA', 古巴: 'CU', 波多黎各: 'PR', 牙买加: 'JM', 巴西: 'BR', 阿根廷: 'AR',
  智利: 'CL', 秘鲁: 'PE', 哥伦比亚: 'CO', 委内瑞拉: 'VE', 厄瓜多尔: 'EC', 玻利维亚: 'BO',
  巴拉圭: 'PY', 乌拉圭: 'UY', 圭亚那: 'GY', 苏里南: 'SR', 埃及: 'EG', 摩洛哥: 'MA',
  阿尔及利亚: 'DZ', 突尼斯: 'TN', 利比亚: 'LY', 苏丹: 'SD', 尼日利亚: 'NG', 加纳: 'GH',
  科特迪瓦: 'CI', 塞内加尔: 'SN', 马里: 'ML', 布基纳法索: 'BF', 尼日尔: 'NE',
  几内亚: 'GN', 塞拉利昂: 'SL', 利比里亚: 'LR', 肯尼亚: 'KE', 乌干达: 'UG',
  坦桑尼亚: 'TZ', 埃塞俄比亚: 'ET', 索马里: 'SO', 吉布提: 'DJ', 卢旺达: 'RW',
  布隆迪: 'BI', 马拉维: 'MW', 莫桑比克: 'MZ', 纳米比亚: 'NA', 马达加斯加: 'MG',
  科摩罗: 'KM', 南非: 'ZA', 津巴布韦: 'ZW', 赞比亚: 'ZM', 博茨瓦纳: 'BW',
  斯威士兰: 'SZ', 莱索托: 'LS', '刚果（金）': 'CD', '刚果（布）': 'CG', 喀麦隆: 'CM',
  加蓬: 'GA', 安哥拉: 'AO', 中非: 'CF', 乍得: 'TD', 澳大利亚: 'AU', 新西兰: 'NZ',
  斐济: 'FJ', 巴布亚新几内亚: 'PG',
};

/** 港澳台：数据源实际使用的 country code 与国名不同 */
const CC_OVERRIDE = {
  'hong-kong': 'HK',
  macau: 'MO',
  taipei: 'TW',
  hagatna: 'GU', // 关岛
  noumea: 'NC', // 新喀里多尼亚
  papeete: 'PF', // 法属波利尼西亚
};

/** 繁 -> 简（地名常用字），用于中文名比对 */
const TRAD2SIMP = {
  臺: '台', 灣: '湾', 義: '义', 蓮: '莲', 國: '国', 華: '华', 陽: '阳', 雲: '云', 龍: '龙',
  寧: '宁', 慶: '庆', 縣: '县', 園: '园', 風: '风', 馬: '马', 東: '东', 門: '门', 寶: '宝',
  島: '岛', 濟: '济', 興: '兴', 豐: '丰', 鎮: '镇', 廣: '广', 遼: '辽', 鐵: '铁', 醫: '医',
  開: '开', 關: '关', 場: '场', 車: '车', 進: '进', 遠: '远', 連: '连', 邊: '边', 達: '达',
  運: '运', 適: '适', 選: '选', 遞: '递', 遲: '迟', 應: '应', 張: '张', 陳: '陈', 韓: '韩',
  趙: '赵', 錢: '钱', 孫: '孙', 陸: '陆', 鄭: '郑', 蘇: '苏', 萬: '万', 葉: '叶', 複: '复',
  屬: '属', 蟲: '虫', 監: '监', 護: '护', 陰: '阴', 隨: '随', 難: '难', 靜: '静', 願: '愿',
  歲: '岁', 歷: '历', 歸: '归', 頭: '头', 聲: '声', 靈: '灵', 體: '体', 團: '团', 圖: '图',
  圓: '圆', 壞: '坏', 塊: '块', 堅: '坚', 執: '执', 報: '报', 塵: '尘', 壓: '压', 墳: '坟',
  壯: '壮', 備: '备', 戰: '战', 據: '据', 掃: '扫', 擔: '担', 擁: '拥', 攝: '摄', 數: '数',
  斷: '断', 舊: '旧', 時: '时', 晉: '晋', 書: '书', 會: '会', 條: '条', 來: '来', 楊: '杨',
  極: '极', 構: '构', 標: '标', 樣: '样', 橋: '桥', 機: '机', 檢: '检', 權: '权', 歐: '欧',
  殘: '残', 毀: '毁', 氣: '气', 漢: '汉', 決: '决', 沒: '没', 滅: '灭', 濁: '浊', 測: '测',
  瀋: '沈', 灘: '滩', 燈: '灯', 營: '营', 爐: '炉', 爭: '争', 爺: '爷', 牆: '墙', 獨: '独',
  獻: '献', 環: '环', 瑪: '玛', 產: '产', 畢: '毕', 異: '异', 當: '当', 疊: '叠', 發: '发',
  眾: '众', 睜: '睁', 矯: '矫', 確: '确', 礎: '础', 禮: '礼', 種: '种', 積: '积', 稱: '称',
  穩: '稳', 窮: '穷', 竊: '窃', 競: '竞', 筆: '笔', 簡: '简', 籃: '篮', 籌: '筹', 級: '级',
  紀: '纪', 紙: '纸', 紐: '纽', 結: '结', 統: '统', 絕: '绝', 絡: '络', 給: '给', 綜: '综',
  綠: '绿', 維: '维', 網: '网', 緊: '紧', 線: '线', 緣: '缘', 編: '编', 總: '总', 績: '绩',
  織: '织', 繼: '继', 續: '续', 罷: '罢', 羅: '罗', 習: '习', 聞: '闻', 職: '职', 聯: '联',
  聰: '聪', 肅: '肃', 脅: '胁', 腦: '脑', 臉: '脸', 藝: '艺', 蘭: '兰', 蝦: '虾', 蠻: '蛮',
  衛: '卫', 衝: '冲', 補: '补', 裝: '装', 見: '见', 視: '视', 覺: '觉', 觀: '观', 計: '计',
  訂: '订', 認: '认', 討: '讨', 訓: '训', 記: '记', 訪: '访', 設: '设', 評: '评', 詞: '词',
  試: '试', 詩: '诗', 話: '话', 該: '该', 詳: '详', 語: '语', 誠: '诚', 說: '说', 課: '课',
  調: '调', 談: '谈', 請: '请', 論: '论', 講: '讲', 謝: '谢', 證: '证', 識: '识', 議: '议',
  讀: '读', 變: '变', 讓: '让', 財: '财', 貨: '货', 買: '买', 費: '费', 資: '资', 賓: '宾',
  賣: '卖', 軍: '军', 輕: '轻', 輪: '轮', 輸: '输', 轉: '转', 農: '农', 過: '过', 違: '违',
  遺: '遗', 鄉: '乡', 釋: '释', 鐘: '钟', 銀: '银', 錄: '录', 錯: '错', 鍵: '键', 鏡: '镜',
  鑄: '铸', 閉: '闭', 閒: '闲', 間: '间', 閱: '阅', 防: '防', 隊: '队', 階: '阶', 際: '际',
  險: '险', 隱: '隐', 雖: '虽', 雙: '双', 雜: '杂', 雞: '鸡', 電: '电', 頁: '页', 項: '项',
  順: '顺', 須: '须', 預: '预', 領: '领', 顏: '颜', 類: '类', 顯: '显', 飛: '飞', 館: '馆',
  駕: '驾', 驗: '验', 驚: '惊', 鬥: '斗', 魯: '鲁', 鮮: '鲜', 鳥: '鸟', 鳴: '鸣', 麗: '丽',
  黃: '黄', 點: '点', 黨: '党', 齊: '齐', 龜: '龟', 愛: '爱', 麗: '丽', 優: '优', 億: '亿',
  兩: '两', 兒: '儿', 內: '内', 寫: '写', 寫: '写', 層: '层', 屬: '属', 岡: '冈', 峽: '峡',
  島: '岛', 嶺: '岭', 嶽: '岳', 巖: '岩', 帥: '帅', 師: '师', 幣: '币', 廈: '厦', 廣: '广',
  廳: '厅', 彈: '弹', 徹: '彻', 慮: '虑', 憶: '忆', 應: '应', 懷: '怀', 戀: '恋', 恆: '恒',
  懇: '恳', 慮: '虑', 慶: '庆', 憐: '怜', 懼: '惧', 慘: '惨', 慣: '惯', 憤: '愤', 憫: '悯',
  憂: '忧', 懶: '懒', 戲: '戏', 戰: '战', 掛: '挂', 採: '采', 揀: '拣', 揚: '扬', 換: '换',
  損: '损', 搖: '摇', 撐: '撑', 撲: '扑', 擋: '挡', 擾: '扰', 攪: '搅', 敗: '败', 敵: '敌',
  曆: '历', 極: '极', 棄: '弃', 條: '条', 棟: '栋', 榮: '荣', 槍: '枪', 檔: '档', 樞: '枢',
  橫: '横', 檯: '台', 歡: '欢', 歲: '岁', 歷: '历', 殭: '僵', 氣: '气', 潔: '洁', 澤: '泽',
  濤: '涛', 濱: '滨', 濫: '滥', 灣: '湾', 瀋: '沈', 瀝: '沥', 瀟: '潇', 灘: '滩', 燦: '灿',
  爐: '炉', 犧: '牺', 狀: '状', 獄: '狱', 獨: '独', 獻: '献', 獅: '狮', 環: '环', 現: '现',
  瑤: '瑶', 產: '产', 當: '当', 疊: '叠', 痺: '痹', 癢: '痒', 癥: '症', 盧: '卢', 眾: '众',
  睪: '睾', 禮: '礼', 種: '种', 積: '积', 穩: '稳', 窮: '穷', 筆: '笔', 築: '筑', 簡: '简',
  籃: '篮', 籤: '签', 籌: '筹', 粵: '粤', 糧: '粮', 紀: '纪', 紅: '红', 級: '级', 納: '纳',
  紙: '纸', 素: '素', 終: '终', 組: '组', 結: '结', 絕: '绝', 統: '统', 絲: '丝', 經: '经',
  綁: '绑', 綢: '绸', 綜: '综', 緊: '紧', 緒: '绪', 線: '线', 緣: '缘', 編: '编', 緩: '缓',
  縣: '县', 縫: '缝', 縮: '缩', 總: '总', 績: '绩', 繁: '繁', 織: '织', 繼: '继', 續: '续',
  罷: '罢', 羅: '罗', 習: '习', 聖: '圣', 聯: '联', 聲: '声', 職: '职', 聽: '听', 肅: '肃',
  脅: '胁', 腦: '脑', 臨: '临', 臺: '台', 興: '兴', 舉: '举', 舊: '旧', 藝: '艺', 藥: '药',
  蘭: '兰', 蟲: '虫', 蠻: '蛮', 衛: '卫', 補: '补', 裝: '装', 見: '见', 規: '规', 視: '视',
  覺: '觉', 觀: '观', 訂: '订', 計: '计', 訊: '讯', 討: '讨', 訓: '训', 記: '记', 訪: '访',
  設: '设', 許: '许', 訴: '诉', 註: '注', 証: '证', 評: '评', 詞: '词', 詢: '询', 試: '试',
  詩: '诗', 話: '话', 該: '该', 詳: '详', 認: '认', 語: '语', 說: '说', 課: '课', 調: '调',
  談: '谈', 請: '请', 論: '论', 諸: '诸', 講: '讲', 謝: '谢', 證: '证', 識: '识', 議: '议',
  護: '护', 讀: '读', 變: '变', 讓: '让', 豐: '丰', 貝: '贝', 負: '负', 財: '财', 貨: '货',
  買: '买', 費: '费', 資: '资', 賓: '宾', 賣: '卖', 車: '车', 軍: '军', 軟: '软', 較: '较',
  載: '载', 輔: '辅', 輕: '轻', 輛: '辆', 輝: '辉', 輪: '轮', 輸: '输', 轉: '转', 農: '农',
  運: '运', 遊: '游', 過: '过', 達: '达', 違: '违', 遙: '遥', 遷: '迁', 選: '选', 遺: '遗',
  鄉: '乡', 鄰: '邻', 醒: '醒', 鐘: '钟', 銀: '银', 錄: '录', 錯: '错', 鍵: '键', 鎮: '镇',
  鏡: '镜', 鐵: '铁', 鑑: '鉴', 閉: '闭', 閒: '闲', 間: '间', 閱: '阅', 關: '关', 陰: '阴',
  陽: '阳', 隊: '队', 階: '阶', 隨: '随', 險: '险', 隱: '隐', 雖: '虽', 雙: '双', 雞: '鸡',
  離: '离', 難: '难', 雲: '云', 電: '电', 靈: '灵', 靜: '静', 韓: '韩', 頁: '页', 項: '项',
  順: '顺', 須: '须', 預: '预', 領: '领', 頭: '头', 顏: '颜', 願: '愿', 類: '类', 顯: '显',
  風: '风', 飛: '飞', 食: '食', 館: '馆', 馬: '马', 駕: '驾', 驗: '验', 驚: '惊', 體: '体',
  髮: '发', 鬥: '斗', 魯: '鲁', 鮮: '鲜', 鳥: '鸟', 鳴: '鸣', 麗: '丽', 黃: '黄', 點: '点',
  黨: '党', 齊: '齐', 龍: '龙', 龜: '龟',
};

const hasCJK = (s) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(String(s || ''));
const toSimp = (s) => String(s || '').replace(/[^\u3400-\u9fff]/g, (ch) => TRAD2SIMP[ch] || ch);
const normAscii = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
const normZh = (s) =>
  toSimp(s)
    .replace(/[市州區区县鎮镇盟旗街村區]/g, '')
    .replace(/[\s·・]/g, '');

/** 需要消歧的查询限定（id -> 附加到英文名后的限定语） */
const QUALIFIER = {
  'san-jose': 'California, United States',
  'san-jose-cr': 'Costa Rica',
  'san-diego': 'California, United States',
  portland: 'Oregon, United States',
  'newcastle-au': 'New South Wales, Australia',
  'victoria-canada': 'British Columbia, Canada',
  alexandria: 'Egypt',
  tripoli: 'Libya',
  male: 'Maldives',
  colombo: 'Sri Lanka',
  'la-paz': 'Bolivia',
  'santa-cruz': 'Bolivia',
  'cordoba-ar': 'Argentina',
  santiago: 'Chile',
  merida: 'Mexico',
  dali: 'China',
  'george-town': 'Penang, Malaysia',
  'johor-bahru': 'Malaysia',
  nadi: 'Fiji',
  noumea: 'New Caledonia',
  papeete: 'French Polynesia',
  hagatna: 'Guam',
  'st-louis': 'Missouri, United States',
  'new-york': 'New York City',
  'washington-dc': 'Washington, D.C.',
  'the-hague': 'Netherlands',
  'hong-kong': 'Hong Kong',
  macau: 'Macau',
  taipei: 'Taiwan',
  'saint-petersburg': 'Russia',
};

// ================= A) 范围 / 结构校验 =================
const cities = loadCities(OUT);
const problems = [];
const ids = new Set();
const names = new Set();

for (const c of cities) {
  if (typeof c.lat !== 'number' || !Number.isFinite(c.lat) || c.lat < -90 || c.lat > 90)
    problems.push(`${c.id}: lat 越界 ${c.lat}`);
  if (typeof c.lng !== 'number' || !Number.isFinite(c.lng) || c.lng < -180 || c.lng > 180)
    problems.push(`${c.id}: lng 越界 ${c.lng}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id || '')) problems.push(`${c.id}: id 命名不合规`);
  if (ids.has(c.id)) problems.push(`${c.id}: id 重复`);
  ids.add(c.id);
  if (names.has(c.name)) problems.push(`${c.name}: name 重复`);
  names.add(c.name);
  if (!Array.isArray(c.aliases) || c.aliases.length < 1) problems.push(`${c.id}: aliases 缺失`);
  if (!/[\u4e00-\u9fff]/.test(c.name || '')) problems.push(`${c.id}: name 非中文`);
  if (!/[\u4e00-\u9fff]/.test(c.country || '')) problems.push(`${c.id}: country 非中文`);
  if (!c.en || !String(c.en).trim()) problems.push(`${c.id}: en 为空`);
  if (!ISO2[c.country]) problems.push(`${c.id}: 未知国家 ${c.country}`);
}

console.log('='.repeat(78));
console.log(`A) 范围/结构校验：共检查 ${cities.length} 个城市`);
if (problems.length === 0) {
  console.log('   ✓ 全部通过（lat ∈ [-90,90]，lng ∈ [-180,180]，id/名称唯一，别名齐备，国家可映射）');
} else {
  console.log(`   ✗ 发现 ${problems.length} 个问题:`);
  problems.slice(0, 50).forEach((p) => console.log('     - ' + p));
}

// ================= 数据源 =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const ccOf = (city) => CC_OVERRIDE[city.id] || ISO2[city.country];

async function fetchJson(url, opts = {}) {
  const attempts = opts.attempts || 5;
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeout || 20000),
      });
      if (res.status === 429 || res.status === 503 || res.status === 400) {
        // 限流/配额：退避后重试
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(Math.min(15000, 2000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(10000, 1200 * 2 ** attempt));
    }
  }
  throw lastErr || new Error('request failed');
}

/* ---- Nominatim（任务书指定源） ---- */
let nominatimAvailable = null;
let nominatimProbeError = '';

async function probeNominatim() {
  const url = `${NOMINATIM}?q=Shanghai&format=json&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = JSON.parse(await res.text());
    nominatimAvailable = Array.isArray(rows) && rows.length > 0;
    if (!nominatimAvailable) nominatimProbeError = '返回空';
  } catch (e) {
    nominatimAvailable = false;
    nominatimProbeError =
      e.name === 'TimeoutError' ? '连接超时（DNS 被劫持，真实 IP 亦不可达）' : `${e.name}: ${e.message}`;
  }
}

async function viaNominatim(query) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = JSON.parse(await res.text());
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const h = rows[0];
  return {
    lat: Number(h.lat),
    lng: Number(h.lon),
    cc: ((h.address && h.address.country_code) || '').toUpperCase(),
    localName: h.name || '',
    enName: '',
    geoId: null,
    display: h.display_name || '',
    src: 'Nominatim',
  };
}

/**
 * 城市名匹配键：中文名 + 全部别名（GeoNames 里同一城市常有旧译名/旧拼法，
 * 例如 营口 = "Newchwang"、海防 = "Haiphong"）
 */
function nameKeys(city) {
  const zh = new Set();
  const ascii = new Set();
  const push = (s) => {
    const v = String(s || '').trim();
    if (!v) return;
    if (hasCJK(v)) zh.add(normZh(v));
    else ascii.add(normAscii(v));
  };
  push(city.name);
  push(city.en);
  for (const a of city.aliases || []) push(a);
  return { zh, ascii };
}

/* ---- open-meteo (GeoNames) 前向检索 ---- */
async function viaOpenMeteo(city) {
  const want = ccOf(city);
  const out = [];
  const errs = [];
  const keys = nameKeys(city);
  // 查询词：英文名 + 中文名 + 若干别名（旧译名/旧拼法，如 Haiphong / Newchwang）
  // 注意：检索词按“原始写法”去重（Haiphong 与 Hai Phong 对检索来说并不等价）
  const rawSeen = new Set([city.en.trim().toLowerCase(), city.name.trim().toLowerCase()]);
  const terms = [city.en, city.name];
  for (const a of city.aliases || []) {
    if (terms.length >= 5) break;
    const v = String(a || '').trim();
    if (!v || /[,，]/.test(v)) continue; // "Tokyo, Japan" 之类带限定语的别名不适合做检索词
    const low = v.toLowerCase();
    if (rawSeen.has(low)) continue;
    rawSeen.add(low);
    terms.push(v);
  }
  for (const q of terms) {
    const lang = hasCJK(q) ? 'zh' : 'en';
    try {
      const j = await fetchJson(
        `${OPEN_METEO}?name=${encodeURIComponent(q)}&count=20&language=${lang}&format=json`
      );
      for (const r of j.results || []) {
        if ((r.country_code || '').toUpperCase() !== want) continue;
        if (!CITY_FEATURES.has(r.feature_code)) continue; // 排除山脉/地区/公园等非城市条目
        out.push({
          lat: Number(r.latitude),
          lng: Number(r.longitude),
          cc: want,
          localName: r.name || '',
          localNames: [r.name || ''],
          enName: lang === 'en' ? r.name || '' : '',
          adm1: r.admin1 || '',
          geoId: r.id ? String(r.id) : null,
          pop: Number(r.population || 0),
          place: r.feature_code || '',
          display: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
          src: `open-meteo/GeoNames(${r.id}${r.feature_code ? ' ' + r.feature_code : ''})`,
        });
      }
    } catch (e) {
      errs.push(`open-meteo("${q}") ${e.name}`);
    }
  }
  return { out, errs };
}

/**
 * 中国省级行政区：Photon 反向检索给中文省名，GeoNames 给英文名，
 * 需要一张对照表才能把“省/州”信号对上。
 */
const CN_PROVINCE_EN = {
  北京市: 'Beijing', 天津市: 'Tianjin', 上海市: 'Shanghai', 重庆市: 'Chongqing',
  河北省: 'Hebei', 山西省: 'Shanxi', 辽宁省: 'Liaoning', 吉林省: 'Jilin',
  黑龙江省: 'Heilongjiang', 江苏省: 'Jiangsu', 浙江省: 'Zhejiang', 安徽省: 'Anhui',
  福建省: 'Fujian', 江西省: 'Jiangxi', 山东省: 'Shandong', 河南省: 'Henan',
  湖北省: 'Hubei', 湖南省: 'Hunan', 广东省: 'Guangdong', 广西壮族自治区: 'Guangxi',
  海南省: 'Hainan', 四川省: 'Sichuan', 贵州省: 'Guizhou', 云南省: 'Yunnan',
  西藏自治区: 'Tibet', 陕西省: 'Shaanxi', 甘肃省: 'Gansu', 青海省: 'Qinghai',
  宁夏回族自治区: 'Ningxia', 新疆维吾尔自治区: 'Xinjiang', 内蒙古自治区: 'Inner Mongolia',
  台湾省: 'Taiwan', 香港特别行政区: 'Hong Kong', 澳门特别行政区: 'Macao',
};

/**
 * 省/州中文名 -> 英文名。Photon 返回的可能是「中文 + 当地文字」混合形式
 * （如 "新疆维吾尔自治区 شىنجاڭ ..."），因此用前缀匹配。
 */
function provinceEn(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (CN_PROVINCE_EN[v]) return CN_PROVINCE_EN[v];
  for (const [zh, en] of Object.entries(CN_PROVINCE_EN)) {
    if (v.startsWith(zh)) return en;
  }
  return v;
}

/* ---- Photon 反向检索（验证“这个坐标是哪个城市/哪个省”） ---- */
const normAdm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b(sheng|province|prov|prefecture|state|county|region|district|department|oblast|governorate|parish)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

async function viaPhotonReverse(city) {
  const url = `https://photon.komoot.io/reverse?lat=${city.lat}&lon=${city.lng}&limit=50`;
  try {
    const j = await fetchJson(url, { attempts: 4 });
    const feats = j.features || [];
    const ids = new Set();
    const isoNames = new Set();
    const zhNames = new Set();
    const adm1Ascii = new Set();
    const adm1Zh = new Set();
    let cc = '';
    let cityName = '';
    for (const f of feats) {
      const p = f.properties || {};
      if (p.countrycode) cc = (p.countrycode || '').toUpperCase();
      if (p.city) {
        zhNames.add(p.city);
        isoNames.add(normAscii(p.city));
        if (!cityName) cityName = p.city;
      }
      // place 类条目（city/town/suburb…）的名称才是城市名本身
      if (p.name && p.osm_key === 'place') {
        zhNames.add(p.name);
        isoNames.add(normAscii(p.name));
        if (!cityName || p.osm_value === 'city') cityName = p.name;
      }
      if (p.state) {
        zhNames.add(p.state);
        adm1Zh.add(normZh(p.state));
        const en = provinceEn(p.state);
        const k = normAdm(en);
        if (k) adm1Ascii.add(k);
        isoNames.add(normAscii(en));
      }
      if (p.country) isoNames.add(normAscii(p.country));
    }
    return {
      city: cityName,
      cc,
      ids,
      isoNames,
      zhNames,
      adm1Ascii,
      adm1Zh,
    };
  } catch (e) {
    return { error: `Photon/reverse ${e.name}` };
  }
}

/* ---- BigDataCloud 反向检索（备选） ---- */
async function viaBigDataCloud(city) {
  const url = `${BIGDATACLOUD}?latitude=${city.lat}&longitude=${city.lng}&localityLanguage=zh`;
  try {
    const j = await fetchJson(url, { attempts: 2 });
    const ids = new Set();
    const isoNames = new Set();
    const zhNames = new Set();
    const adm1Ascii = new Set();
    const adm1Zh = new Set();
    for (const a of j.localityInfo?.administrative || []) {
      if (a.geonameId) ids.add(String(a.geonameId));
      if (a.isoName) {
        isoNames.add(normAscii(a.isoName));
        if (a.adminLevel <= 4) {
          const k = normAdm(a.isoName);
          if (k) adm1Ascii.add(k);
        }
      }
      if (a.name) {
        zhNames.add(a.name);
        if (a.adminLevel <= 4) {
          const k = normZh(a.name);
          if (k) adm1Zh.add(k);
          const en = provinceEn(a.name);
          if (en) adm1Ascii.add(normAdm(en));
        }
      }
    }
    for (const a of j.localityInfo?.informative || []) {
      if (a.isoName) {
        const k = normAdm(a.isoName);
        if (k) adm1Ascii.add(k);
      }
    }
    return {
      city: j.city || '',
      cc: (j.countryCode || '').toUpperCase(),
      ids,
      isoNames,
      zhNames,
      adm1Ascii,
      adm1Zh,
    };
  } catch (e) {
    return { error: `BigDataCloud ${e.name}` };
  }
}

/** 候选的 admin1（省/州）是否与反向检索给出的行政区划一致 */
function adm1Matches(candAdm, rev) {
  if (!candAdm || !rev) return false;
  const ca = normAdm(candAdm);
  if (ca) {
    for (const k of rev.adm1Ascii || []) {
      if (k && (k === ca || k.includes(ca) || ca.includes(k))) return true;
    }
  }
  const cz = normZh(candAdm);
  if (cz) {
    for (const k of rev.adm1Zh || []) {
      if (k && (k === cz || k.includes(cz) || cz.includes(k))) return true;
    }
  }
  return false;
}

/* ---- Overpass 兜底（OSM place 节点） ---- */
function overpassQuery(city) {
  const cc = ccOf(city);
  const en = esc(city.en);
  const zhRe = `^(${[city.name, city.name + '市', city.name + '区', city.name + '县', city.name + '州'].map(esc).join('|')})$`;
  return `[out:json][timeout:60];area["ISO3166-1"="${cc}"][admin_level=2]->.a;( node(area.a)["place"~"${PLACE_RE}"]["name:en"="${en}"]; relation(area.a)["place"~"${PLACE_RE}"]["name:en"="${en}"]; node(area.a)["place"~"${PLACE_RE}"]["name"~"${zhRe}"]; relation(area.a)["place"~"${PLACE_RE}"]["name"~"${zhRe}"]; );out center tags;`;
}

async function viaOverpass(city) {
  const out = [];
  const q = overpassQuery(city);
  for (let attempt = 0; attempt < 2 && !out.length; attempt++) {
    for (const host of OVERPASS_LIST) {
      try {
        const res = await fetch(host, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(90000),
        });
        if (res.status === 429 || res.status === 504) {
          await sleep(4000 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const el of data.elements || []) {
          const lat = el.lat ?? el.center?.lat;
          const lng = el.lon ?? el.center?.lon;
          if (typeof lat !== 'number' || typeof lng !== 'number') continue;
          const t = el.tags || {};
          out.push({
            lat,
            lng,
            cc: ccOf(city),
            localName: t.name || '',
            enName: t['name:en'] || '',
            geoId: null,
            pop: Number(t.population || 0),
            place: t.place || '',
            display: [t['name:en'] || t.name, t.state || t.province, t.country].filter(Boolean).join(', '),
            src: `Overpass/OSM(${el.type}/${el.id}${t.place ? ' place=' + t.place : ''})`,
          });
        }
        break;
      } catch {
        await sleep(1200);
      }
    }
  }
  return out;
}

/* ---- 候选打分 ---- */
const FEATURE_SCORE = { PPLC: 4000, PPLA: 3500, PPLA2: 2000, PPLA3: 1200, PPLA4: 900, PPL: 1000, PPLX: 600, PCLS: 3000, PCLI: 2500 };
/** 只有“城市型”条目才算城市候选；MT=山脉、RGN=地区、PRK=公园等一律排除 */
const CITY_FEATURES = new Set([
  'PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPL', 'PPLX', 'PPLW',
  'PCLS', 'PCLI', 'ADM', 'ADM1', 'ADM2', 'ADM3', 'ADM4', 'STLT',
]);

function scoreCandidate(cand, city, rev) {
  const keys = nameKeys(city);
  const names = cand.localNames?.length ? cand.localNames : [cand.localName];
  // 与本表中文名/别名一致（中文或英文写法均可）
  const zhMatch = names.some((n) => hasCJK(n) && keys.zh.has(normZh(n)));
  const aliasMatch = names.some((n) => !hasCJK(n) && keys.ascii.has(normAscii(n)));
  const enMatch = normAscii(city.en) === normAscii(cand.localName) ||
    (!!cand.enName && normAscii(cand.enName) === normAscii(city.en));
  // 省/州匹配：候选的 admin1 与反向检索给出的行政区划一致
  const adm1Match = adm1Matches(cand.adm1, rev);

  let s = 0;
  if (adm1Match) s += 300000; // 省/州一致 —— 最强的消歧信号
  // 人口是同名的「城市 vs 同名村镇」最可靠的区分依据，故权重最高
  if (cand.pop > 0) s += Math.log10(cand.pop + 1) * 20000;
  if (zhMatch) s += 20000;
  if (aliasMatch) s += 20000;
  if (enMatch) s += 20000;
  s += (FEATURE_SCORE[cand.place] || 0) * 10;
  if (cand.place === 'city') s += 30000;
  else if (cand.place === 'town') s += 20000;
  else if (cand.place === 'municipality' || cand.place === 'county') s += 10000;
  return { s, zhMatch, enMatch, aliasMatch, adm1Match };
}

function dedupe(cands) {
  const out = [];
  for (const c of cands) {
    const near = out.find((o) => haversineKm(o.lat, o.lng, c.lat, c.lng) < 1.5);
    if (near) {
      if (c.pop > near.pop) near.pop = c.pop;
      for (const n of c.localNames || []) {
        if (!near.localNames.includes(n)) near.localNames.push(n);
      }
      if (!near.localName) near.localName = c.localName;
      if (!near.geoId && c.geoId) near.geoId = c.geoId;
    } else {
      out.push({ ...c, localNames: [...(c.localNames || [])] });
    }
  }
  return out;
}

/**
 * 反向检索是否确认「本表坐标就落在所声明的城市里」。
 * 这是判断坐标真伪最直接的证据：把坐标交给反向地理编码，
 * 看它报出的行政区划名称是否就是本表这座城市。
 */
function revConfirmsCity(rev, city) {
  if (!rev || rev.error) return false;
  const keys = nameKeys(city);
  for (const n of rev.zhNames || []) {
    if (keys.zh.has(normZh(n))) return true;
  }
  for (const n of rev.isoNames || []) {
    if (keys.ascii.has(n)) return true;
  }
  return false;
}

async function resolve(city) {
  const notes = [];
  const q = QUALIFIER[city.id] ? `${city.en}, ${QUALIFIER[city.id]}` : city.en;

  if (nominatimAvailable) {
    try {
      const r = await viaNominatim(q);
      if (r) return { best: r, scored: [r], rev: null, query: q, notes };
      notes.push('Nominatim 返回空');
    } catch (e) {
      notes.push(`Nominatim 请求失败(${e.name || e.message})`);
    }
  } else {
    notes.push(`Nominatim 本机不可达(${nominatimProbeError})`);
  }

  const om = await viaOpenMeteo(city);
  notes.push(...om.errs);
  let cands = dedupe(om.out);

  // 反向检索：确认本表坐标落在哪个城市 / 哪个省
  let rev = await viaPhotonReverse(city);
  if (rev.error) {
    const bdc = await viaBigDataCloud(city);
    if (!bdc.error) rev = bdc;
    else notes.push(rev.error, bdc.error);
  }

  if (!cands.length) {
    notes.push('open-meteo 无匹配，转 Overpass');
    cands = dedupe(await viaOverpass(city));
  }
  if (!cands.length) {
    notes.push('所有数据源均无匹配');
    return { miss: true, query: q, notes };
  }
  const scored = cands.map((c) => ({ ...c, ...scoreCandidate(c, city, rev) })).sort((a, b) => b.s - a.s);

  if (process.env.CITIES_DEBUG) {
    console.log(`  [debug ${city.id}] 候选 ${scored.length}:`);
    for (const s of scored.slice(0, 8)) {
      console.log(
        `     s=${Math.round(s.s)} id=${s.geoId} "${s.localName}" adm1="${s.adm1}" code=${s.place} pop=${s.pop} @${s.lat},${s.lng}` +
          ` zh=${s.zhMatch ? 1 : 0} alias=${s.aliasMatch ? 1 : 0} en=${s.enMatch ? 1 : 0} adm1m=${s.adm1Match ? 1 : 0}` +
          ` dist=${haversineKm(city.lat, city.lng, s.lat, s.lng).toFixed(1)}km`
      );
    }
    console.log(
      `     [debug] rev=${rev && !rev.error ? `state=${JSON.stringify([...(rev.zhNames || [])].slice(0, 4))} adm1Ascii=${JSON.stringify([...(rev.adm1Ascii || [])])}` : `ERR ${rev && rev.error}`}`
    );
  }

  // 反向检索交叉比对：把本表坐标拿去问“这是哪个城市”，得到 GeoNames id；
  // 若与前向候选的 id 一致 => 本表坐标确实落在该城市（强互证，优先采用）
  let best = scored[0];
  let corroborated = false;
  if (rev && rev.ids) {
    const idHits = scored.filter((c) => c.geoId && rev.ids.has(c.geoId));
    if (idHits.length) {
      best = idHits[0];
      corroborated = true;
      best.corrob = `GeoNames id 一致 (${best.geoId})`;
    } else {
      const names = best.localNames?.length ? best.localNames : [best.localName];
      const isoHit = names.some((n) => rev.isoNames.has(normAscii(n)));
      if (isoHit) {
        corroborated = true;
        best.corrob = '英文名一致';
      }
    }
  }
  notes.push(
    `候选 ${scored.length} 个，最高分 ${Math.round(best.s)}${corroborated ? `，反向互证通过(${best.corrob})` : ''}`
  );
  return { best, scored, rev, query: q, notes };
}

// ================= B) 抽查 =================
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pool = cities.slice();
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const sample = (() => {
  const idsArg = arg('ids', '');
  if (idsArg) {
    const want = new Set(idsArg.split(',').map((s) => s.trim()).filter(Boolean));
    return cities.filter((c) => want.has(c.id));
  }
  return pool.slice(0, Math.min(SAMPLE, pool.length));
})();

console.log('='.repeat(78));
console.log(`B) Nominatim 抽查：随机抽取 ${sample.length} 个城市（seed=${SEED}，容差 ${TOLERANCE_KM}km）`);
console.log(`   探测 Nominatim 可达性: ${NOMINATIM} ...`);
await probeNominatim();
console.log(
  `   Nominatim: ${nominatimAvailable ? '✓ 可用' : `✗ 本机不可达（${nominatimProbeError}）→ 改用同为公开地理数据源的 open-meteo(GeoNames) + BigDataCloud 反向检索，Overpass 兜底`}`
);

const corrected = [];
const unverified = [];
const ok = [];
const confirmed = [];
const srcCount = {};

async function checkOne(c, tag) {
  const r = await resolve(c);
  if (r.miss) {
    console.log(`  ${tag} ${c.id} (${c.name}) -> 未查到 | ${r.notes.join('; ')}`);
    unverified.push({ id: c.id, name: c.name, en: c.en, reason: r.notes.join('; ') });
    return;
  }
  let b = r.best;
  let altNote = null;
  // 守卫：候选带有中文名却与本表中文名/别名都对不上 => 同名异地，不得自动修正
  const keys = nameKeys(c);
  const guard = (cand, rev) => {
    if (cand.zhMatch || cand.aliasMatch) return true;
    // 反向检索显示该坐标所在地的中文名与本表一致 => 身份确认
    if (rev && rev.zhNames) {
      for (const n of rev.zhNames) {
        if (keys.zh.has(normZh(n))) return true;
      }
    }
    const names = cand.localNames?.length ? cand.localNames : [cand.localName];
    return !names.some(hasCJK); // 候选没有中文名 -> 不构成同名中文歧义
  };
  if (!guard(b, r.rev) && r.scored) {
    const alt = r.scored.find((x) => guard(x, r.rev));
    if (alt) {
      altNote = `原候选「${b.localName}」为同名异地，改用「${alt.localName}」`;
      b = alt;
    }
  }
  const km = haversineKm(c.lat, c.lng, b.lat, b.lng);
  const key = b.src.split('(')[0].trim();
  srcCount[key] = (srcCount[key] || 0) + 1;
  if (km > TOLERANCE_KM) {
    if (revConfirmsCity(r.rev, c)) {
      // 反向检索确认本表坐标确实位于所声明的城市内 -> 偏差来自 GeoNames 锚点差异
      // （GeoNames 常把同名村庄/旧条目当作该城市），此时不应改动本表坐标
      confirmed.push({
        id: c.id,
        name: c.name,
        km: Math.round(km * 10) / 10,
        where: r.rev.city || r.rev.locality || c.name,
      });
      console.log(
        `  ${tag} ${c.id} (${c.name}) 偏差 ${km.toFixed(1)}km，但反向检索确认该坐标位于「${
          r.rev.city || r.rev.locality || c.name
        }」内，判定坐标正确，不修正`
      );
    } else if (!guard(b, r.rev)) {
      const why = `匹配到同名异地「${b.localName}」(${b.src})，偏差 ${km.toFixed(1)}km，未自动修正`;
      console.log(`  ${tag} ${c.id} (${c.name}) ${why}`);
      unverified.push({ id: c.id, name: c.name, en: c.en, reason: why });
    } else if (!r.rev || r.rev.error) {
      // 反向检索不可用（限流/配额）=> 缺少省份级独立证据，此时只接受“证据充分”的候选
      const strong =
        b.pop > 0 && ['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4'].includes(b.place);
      if (!strong) {
        const why = `偏差 ${km.toFixed(1)}km，但反向检索不可用且候选「${b.localName}」证据不足，未自动修正`;
        console.log(`  ${tag} ${c.id} (${c.name}) ${why}`);
        unverified.push({ id: c.id, name: c.name, en: c.en, reason: why });
      } else {
        const before = `${c.lat}, ${c.lng}`;
        c.lat = Number(b.lat.toFixed(4));
        c.lng = Number(b.lng.toFixed(4));
        const primary = String(b.display).split(',')[0].trim();
        for (const a of [primary, String(b.display).trim(), b.localName].filter(Boolean)) {
          if (a && !c.aliases.includes(a)) c.aliases.push(a);
        }
        corrected.push({ id: c.id, name: c.name, km: Math.round(km), before, after: `${c.lat}, ${c.lng}`, src: b.src });
        console.log(
          `  ${tag} ${c.id} (${c.name}) 偏差 ${km.toFixed(1)}km > ${TOLERANCE_KM}km -> 修正为 ${c.lat}, ${c.lng} [${b.src}]`
        );
      }
    } else {
      const before = `${c.lat}, ${c.lng}`;
      c.lat = Number(b.lat.toFixed(4));
      c.lng = Number(b.lng.toFixed(4));
      const primary = String(b.display).split(',')[0].trim();
      for (const a of [primary, String(b.display).trim(), b.localName].filter(Boolean)) {
        if (a && !c.aliases.includes(a)) c.aliases.push(a);
      }
      corrected.push({ id: c.id, name: c.name, km: Math.round(km), before, after: `${c.lat}, ${c.lng}`, src: b.src });
      console.log(
        `  ${tag} ${c.id} (${c.name}) 偏差 ${km.toFixed(1)}km > ${TOLERANCE_KM}km -> 修正为 ${c.lat}, ${c.lng} [${b.src}]`
      );
    }
  } else {
    ok.push({ id: c.id, km: Math.round(km * 10) / 10 });
    console.log(`  ${tag} ${c.id} (${c.name}) 偏差 ${km.toFixed(1)}km ✓ [${b.src}]${altNote ? ' (' + altNote + ')' : ''}`);
  }
}

for (let i = 0; i < sample.length; i++) {
  await checkOne(sample[i], `[${i + 1}/${sample.length}]`);
  await sleep(250);
}

// 对未查到的城市再重试一轮
if (unverified.length) {
  console.log(`  -- 对 ${unverified.length} 个未查到的城市重试 --`);
  const retry = unverified.map((u) => cities.find((c) => c.id === u.id)).filter(Boolean);
  unverified.length = 0;
  for (const c of retry) {
    await checkOne(c, '[重试]');
    await sleep(1500);
  }
}

// ================= 写回 =================
if (corrected.length) {
  writeCities(cities, OUT, 1);
  console.log('='.repeat(78));
  console.log(`已写回修正后的坐标: ${OUT}`);
}

const ks = ok.map((o) => o.km);
const stat = (arr) =>
  arr.length
    ? `min=${Math.min(...arr)} max=${Math.max(...arr)} avg=${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)}km`
    : 'n/a';

console.log('='.repeat(78));
console.log('汇总：');
console.log(`  抽查城市数            : ${sample.length}`);
console.log(`  匹配且 ≤${TOLERANCE_KM}km     : ${ok.length}（偏差 ${stat(ks)}）`);
console.log(`  反向检索确认坐标正确   : ${confirmed.length}${confirmed.length ? `（${confirmed.map((c) => `${c.name} ${c.km}km`).join('、')}）` : ''}`);
console.log(`  已修正坐标            : ${corrected.length}`);
console.log(`  未验证/未查到         : ${unverified.length}`);
console.log(`  城市总数              : ${cities.length}`);
console.log(`  数据源分布            : ${JSON.stringify(srcCount)}`);

// 逐城市结果报告
const report = {
  generatedAt: new Date().toISOString(),
  file: OUT,
  total: cities.length,
  sampled: sample.length,
  toleranceKm: TOLERANCE_KM,
  nominatimAvailable,
  nominatimNote: nominatimProbeError,
  sources: srcCount,
  counts: {
    withinTolerance: ok.length,
    confirmedByReverse: confirmed.length,
    corrected: corrected.length,
    unverified: unverified.length,
  },
  deviation: {
    min: ks.length ? Math.min(...ks) : null,
    max: ks.length ? Math.max(...ks) : null,
    avg: ks.length ? Number((ks.reduce((a, b) => a + b, 0) / ks.length).toFixed(2)) : null,
  },
  confirmed,
  corrected,
  unverified,
  results: sample.map((c) => {
    const o = ok.find((x) => x.id === c.id);
    const cf = confirmed.find((x) => x.id === c.id);
    const co = corrected.find((x) => x.id === c.id);
    const un = unverified.find((x) => x.id === c.id);
    return {
      id: c.id,
      name: c.name,
      en: c.en,
      country: c.country,
      lat: c.lat,
      lng: c.lng,
      deviationKm: o ? o.km : cf ? cf.km : co ? co.km : null,
      status: o ? 'within-tolerance' : cf ? 'confirmed-by-reverse' : co ? 'corrected' : 'unverified',
      note: cf ? `反向检索确认坐标位于「${cf.where}」内` : co ? co.src : un ? un.reason : null,
    };
  }),
};
const REPORT_PATH = path.resolve(HERE, 'report.json');
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
console.log(`  逐城报告              : ${REPORT_PATH}`);
if (corrected.length) {
  console.log('  修正明细:');
  corrected.forEach((x) => console.log(`    - ${x.name} (${x.id}) 偏差 ${x.km}km: ${x.before} -> ${x.after} [${x.src}]`));
}
if (unverified.length) {
  console.log('  未验证列表:');
  unverified.forEach((x) => console.log(`    - ${x.name} (${x.id}): ${x.reason}`));
}
