import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});
const content = `品牌：山野煮茶（杭州西湖区文三路店，10月20日开业）
一、产品与价格（均为含税零售价）
1. 陈皮普洱礼盒：380元/盒（250g，约20泡）
2. 桂花乌龙礼盒：268元/盒（200g，约18泡）
3. 五指毛桃祛湿茶礼盒：328元/盒（200g）
4. 门店现煮单杯：陈皮普洱18元、桂花乌龙16元、祛湿茶20元
二、开业活动（10月20日—11月5日）
1. 开业首杯9.9元（每人限一次，需扫码入会）
2. 会员储值：充500送80，充1000送200，储值卡可全场通用
3. 三人同行第二杯半价（限现煮单杯）
三、目标人群与卖点
主打25—35岁女性白领，熬夜、久坐、手脚冰凉、脾胃虚弱；核心卖点是门店现煮、可选温度和甜度、0添加香精、药材来自新会陈皮与云南普洱原产地。
四、门店信息
地址：杭州市西湖区文三路128号1层；营业时间10:00—22:00；门店面积42㎡，含8个堂食座位。`;
const { data, error } = await cloud.database.from("knowledge_docs").insert([{
  title: "山野煮茶｜产品价格与开业政策（2026秋）",
  doc_type: "价格体系",
  source: "门店运营手册.docx",
  content,
  chunks: Math.ceil(content.replace(/\s/g, "").length / 300),
  owner_name: "运营负责人",
}]).select();
if (error) console.log("ERR", error.message);
else console.log("已导入 #" + data[0].id, data[0].title, "content=" + data[0].content.length + "字");
