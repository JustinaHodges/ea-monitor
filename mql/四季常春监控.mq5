#property copyright "四季常春监控"
#property version   "1.00"
#property description "四季常春监控上报模块：心跳/成交上报到 Cloudflare，不交易。"
#include "EAMonitorHttp.mqh"
#include "EAMonitorSettings.mqh"

input group "对接设置"
input string InpApiBase        = "https://www.688118.xyz"; // 监控后台地址
input string InpTerminalId     = "";                                          // 实例ID
input string InpApiSecret      = "";                                          // 私钥

input group "本机信息"
input string InpComputerId     = "HOME-PC";   // 电脑编号
input string InpComputerName   = "";          // 电脑名称（可留空）

input group "EA信息"
input string InpEaName         = "EAMonitor"; // EA名称
input string InpEaVersion      = "1.0.0";     // EA版本
input string InpStrategyTag    = "monitor";   // 策略标签
input int    InpMagic          = 0;           // Magic（0=不限）

input group "上报设置"
input int    InpIntervalSec     = 30;  // 心跳间隔（秒，最短5）
input int    InpBackfillMonths  = 2;   // 补传月数（2=本月+上月）
input bool   InpUploadTrades    = true; // 上传成交记录
input bool   InpUploadLogs      = true; // 上传日志
input bool   InpReportAllMagic  = true; // 上报全部Magic持仓

datetime g_started = 0;
ulong    g_lastDeal = 0;
bool     g_histReady = false;
string   g_lastErr = "";
datetime g_lastBeat = 0;
datetime g_lastFloatSample = 0;
double   g_todayMinFloating = 0;
double   g_minFloating = 0;      // EA 启动以来见到的最低浮盈（越负越深）
int      g_floatDayKey = 0;      // 北京日 YYYYMMDD

int EAMon_BeijingDayKey()
{
   datetime bj = TimeGMT() + 8 * 3600;
   MqlDateTime dt;
   TimeToStruct(bj, dt);
   return dt.year * 10000 + dt.mon * 100 + dt.day;
}

void EAMon_SampleFloating()
{
   double fpl = AccountInfoDouble(ACCOUNT_PROFIT);
   int day = EAMon_BeijingDayKey();
   if(g_floatDayKey == 0 || day != g_floatDayKey)
   {
      g_floatDayKey = day;
      g_todayMinFloating = fpl;
   }
   else if(fpl < g_todayMinFloating)
      g_todayMinFloating = fpl;
   if(fpl < g_minFloating)
      g_minFloating = fpl;
   g_lastFloatSample = TimeGMT();
}

int OnInit()
{
   EAMon_ApplyInputs(
      InpApiBase, InpTerminalId, InpApiSecret,
      InpComputerId, InpComputerName,
      InpEaName, InpEaVersion, InpStrategyTag,
      InpMagic, InpIntervalSec,
      InpUploadTrades, InpUploadLogs, InpReportAllMagic);

   // 本机有没有记忆文件 = 是不是第一次在这台电脑成功跑过
   g_isFirstEver = !EAMon_SettingsFileExists();

   if(StringLen(g_apiBase) < 8 || StringLen(g_terminalId) == 0 || StringLen(g_apiSecret) == 0)
   {
      Print("EAMonitor: 请填写 监控后台地址 / 实例ID / 私钥（首次填写后会自动记住）");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(g_intervalSec < 5)
      return INIT_PARAMETERS_INCORRECT;

   EAMon_SaveSettingsFile();
   g_started = TimeGMT();
   g_backfillMonths = MathMax(1, InpBackfillMonths);
   g_backfillFrom = EAMon_CalcBackfillFrom(g_backfillMonths);
   g_backfillPending = true;
   g_backfillDoneAck = false;
   g_serverStatusKnown = false;
   g_floatDayKey = EAMon_BeijingDayKey();
   g_todayMinFloating = AccountInfoDouble(ACCOUNT_PROFIT);
   g_minFloating = g_todayMinFloating;
   EventSetTimer(1); // 每秒采样浮亏，心跳仍按间隔上报
   Print("EAMonitor: 请在MT5允许WebRequest网址 ", g_apiBase);
   if(g_isFirstEver)
      Print("EAMonitor: 【本机首次】尚无记忆文件，已保存实例ID=", g_terminalId);
   else
      Print("EAMonitor: 【本机非首次】已识别记忆，实例ID=", g_terminalId);
   Print("EAMonitor: 补传范围=本月+近 ", g_backfillMonths, " 个自然月（从 ",
         TimeToString(g_backfillFrom, TIME_DATE|TIME_MINUTES), " 起）；将向服务器确认断点");
   EAMon_SendHeartbeat();
   if(g_uploadTrades)
      EAMon_SendNewDeals();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(StringLen(g_terminalId) > 0 && StringLen(g_apiSecret) > 0)
      EAMon_SaveSettingsFile();
   EventKillTimer();
}

void OnTick()
{
   EAMon_SampleFloating();
}

void OnTimer()
{
   EAMon_SampleFloating();
   if(TimeGMT() - g_lastBeat >= g_intervalSec)
      EAMon_SendHeartbeat();
   if(g_uploadTrades)
      EAMon_SendNewDeals();
}

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(!g_uploadTrades)
      return;
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
      EAMon_SendNewDeals();
}

void EAMon_PushMagic(long &magics[], string &names[], string &symbols[], int &posCnt[], int &pendCnt[], double &fpl[],
                     const long magic, const string name, const string symbol, const bool pending, const double profit)
{
   if(!g_reportAllMagic && magic != g_magic)
      return;
   int idx = -1;
   for(int i = 0; i < ArraySize(magics); i++)
      if(magics[i] == magic)
         idx = i;
   if(idx < 0)
   {
      idx = ArraySize(magics);
      ArrayResize(magics, idx + 1);
      ArrayResize(names, idx + 1);
      ArrayResize(symbols, idx + 1);
      ArrayResize(posCnt, idx + 1);
      ArrayResize(pendCnt, idx + 1);
      ArrayResize(fpl, idx + 1);
      magics[idx] = magic;
      names[idx] = name;
      symbols[idx] = symbol;
      posCnt[idx] = 0;
      pendCnt[idx] = 0;
      fpl[idx] = 0;
   }
   if(pending)
      pendCnt[idx]++;
   else
   {
      posCnt[idx]++;
      fpl[idx] += profit;
   }
   if(symbols[idx] == "")
      symbols[idx] = symbol;
}

string EAMon_PositionsJson(const bool pending)
{
   string json = "[";
   bool first = true;
   if(!pending)
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0)
            continue;
         if(!g_reportAllMagic && (long)PositionGetInteger(POSITION_MAGIC) != g_magic)
            continue;
         if(!first)
            json += ",";
         first = false;
         json += "{";
         json += "\"ticket\":\"" + IntegerToString((long)ticket) + "\",";
         json += "\"magic\":" + IntegerToString((long)PositionGetInteger(POSITION_MAGIC)) + ",";
         json += "\"symbol\":\"" + EAMon_JsonEsc(PositionGetString(POSITION_SYMBOL)) + "\",";
         json += "\"kind\":\"position\",";
         json += "\"side\":\"" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell") + "\",";
         json += "\"volume\":" + EAMon_Num(PositionGetDouble(POSITION_VOLUME), 2) + ",";
         json += "\"price_open\":" + EAMon_Num(PositionGetDouble(POSITION_PRICE_OPEN), 5) + ",";
         json += "\"price_current\":" + EAMon_Num(PositionGetDouble(POSITION_PRICE_CURRENT), 5) + ",";
         json += "\"sl\":" + EAMon_Num(PositionGetDouble(POSITION_SL), 5) + ",";
         json += "\"tp\":" + EAMon_Num(PositionGetDouble(POSITION_TP), 5) + ",";
         json += "\"profit\":" + EAMon_Num(PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP), 2) + ",";
         json += "\"spread\":" + IntegerToString((int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_SPREAD)) + ",";
         json += "\"comment\":\"" + EAMon_JsonEsc(PositionGetString(POSITION_COMMENT)) + "\",";
         json += "\"open_time\":" + IntegerToString(EAMon_ToGmt((datetime)PositionGetInteger(POSITION_TIME)));
         json += "}";
      }
   }
   else
   {
      for(int i = OrdersTotal() - 1; i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0)
            continue;
         if(!g_reportAllMagic && (long)OrderGetInteger(ORDER_MAGIC) != g_magic)
            continue;
         ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_SELL)
            continue;
         if(!first)
            json += ",";
         first = false;
         string side = "pending";
         if(type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_BUY_STOP || type == ORDER_TYPE_BUY_STOP_LIMIT)
            side = "buy";
         else
            side = "sell";
         json += "{";
         json += "\"ticket\":\"" + IntegerToString((long)ticket) + "\",";
         json += "\"magic\":" + IntegerToString((long)OrderGetInteger(ORDER_MAGIC)) + ",";
         json += "\"symbol\":\"" + EAMon_JsonEsc(OrderGetString(ORDER_SYMBOL)) + "\",";
         json += "\"kind\":\"pending\",";
         json += "\"side\":\"" + side + "\",";
         json += "\"volume\":" + EAMon_Num(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + ",";
         json += "\"price_open\":" + EAMon_Num(OrderGetDouble(ORDER_PRICE_OPEN), 5) + ",";
         json += "\"price_current\":" + EAMon_Num(SymbolInfoDouble(OrderGetString(ORDER_SYMBOL), SYMBOL_BID), 5) + ",";
         json += "\"sl\":" + EAMon_Num(OrderGetDouble(ORDER_SL), 5) + ",";
         json += "\"tp\":" + EAMon_Num(OrderGetDouble(ORDER_TP), 5) + ",";
         json += "\"profit\":0,";
         json += "\"spread\":" + IntegerToString((int)SymbolInfoInteger(OrderGetString(ORDER_SYMBOL), SYMBOL_SPREAD)) + ",";
         json += "\"comment\":\"" + EAMon_JsonEsc(OrderGetString(ORDER_COMMENT)) + "\",";
         json += "\"open_time\":" + IntegerToString(EAMon_ToGmt((datetime)OrderGetInteger(ORDER_TIME_SETUP)));
         json += "}";
      }
   }
   json += "]";
   return json;
}

void EAMon_CollectMagics(long &magics[], string &names[], string &symbols[], int &posCnt[], int &pendCnt[], double &fpl[])
{
   ArrayResize(magics, 0);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetTicket(i) == 0)
         continue;
      EAMon_PushMagic(magics, names, symbols, posCnt, pendCnt, fpl,
                      (long)PositionGetInteger(POSITION_MAGIC),
                      PositionGetString(POSITION_COMMENT),
                      PositionGetString(POSITION_SYMBOL),
                      false,
                      PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP));
   }
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderGetTicket(i) == 0)
         continue;
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type == ORDER_TYPE_BUY || type == ORDER_TYPE_SELL)
         continue;
      EAMon_PushMagic(magics, names, symbols, posCnt, pendCnt, fpl,
                      (long)OrderGetInteger(ORDER_MAGIC),
                      OrderGetString(ORDER_COMMENT),
                      OrderGetString(ORDER_SYMBOL),
                      true,
                      0);
   }
   if(ArraySize(magics) == 0)
      EAMon_PushMagic(magics, names, symbols, posCnt, pendCnt, fpl, g_magic, g_eaName, _Symbol, false, 0);
}

void EAMon_SendHeartbeat()
{
   EAMon_SampleFloating();
   long magics[];
   string names[];
   string symbols[];
   int posCnt[];
   int pendCnt[];
   double fpl[];
   EAMon_CollectMagics(magics, names, symbols, posCnt, pendCnt, fpl);

   string eas = "[";
   for(int i = 0; i < ArraySize(magics); i++)
   {
      if(i > 0)
         eas += ",";
      string eaName = names[i];
      if(StringLen(eaName) == 0)
         eaName = g_eaName;
      eas += "{";
      eas += "\"ea_name\":\"" + EAMon_JsonEsc(eaName) + "\",";
      eas += "\"ea_version\":\"" + EAMon_JsonEsc(g_eaVersion) + "\",";
      eas += "\"strategy_tag\":\"" + EAMon_JsonEsc(g_strategyTag) + "\",";
      eas += "\"magic\":" + IntegerToString(magics[i]) + ",";
      eas += "\"symbol\":\"" + EAMon_JsonEsc(symbols[i]) + "\",";
      eas += "\"timeframe\":\"" + EAMon_Timeframe(_Period) + "\",";
      eas += "\"started_at\":" + IntegerToString((long)g_started) + ",";
      eas += "\"status\":\"running\",";
      eas += "\"last_error\":\"" + EAMon_JsonEsc(g_lastErr) + "\",";
      eas += "\"position_count\":" + IntegerToString(posCnt[i]) + ",";
      eas += "\"pending_count\":" + IntegerToString(pendCnt[i]) + ",";
      eas += "\"floating_pl\":" + EAMon_Num(fpl[i], 5);
      eas += "}";
   }
   eas += "]";

   string pc = g_computerName;
   if(StringLen(pc) == 0)
      pc = TerminalInfoString(TERMINAL_NAME);

   string body = "{";
   body += "\"computer_id\":\"" + EAMon_JsonEsc(g_computerId) + "\",";
   body += "\"computer_name\":\"" + EAMon_JsonEsc(pc) + "\",";
   body += "\"terminal_id\":\"" + EAMon_JsonEsc(g_terminalId) + "\",";
   body += "\"platform\":\"MT5\",";
   body += "\"mt_build\":" + IntegerToString(TerminalInfoInteger(TERMINAL_BUILD)) + ",";
   body += "\"broker\":\"" + EAMon_JsonEsc(AccountInfoString(ACCOUNT_COMPANY)) + "\",";
   body += "\"server\":\"" + EAMon_JsonEsc(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   body += "\"account\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   body += "\"account_name\":\"" + EAMon_JsonEsc(AccountInfoString(ACCOUNT_NAME)) + "\",";
   body += "\"currency\":\"" + EAMon_JsonEsc(AccountInfoString(ACCOUNT_CURRENCY)) + "\",";
   body += "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   body += "\"report_interval\":" + IntegerToString(g_intervalSec) + ",";
   body += "\"broker_gmt_offset\":" + IntegerToString(EAMon_ServerGmtOffset()) + ",";
   body += "\"balance\":" + EAMon_Num(AccountInfoDouble(ACCOUNT_BALANCE), 5) + ",";
   body += "\"equity\":" + EAMon_Num(AccountInfoDouble(ACCOUNT_EQUITY), 5) + ",";
   body += "\"floating_pl\":" + EAMon_Num(AccountInfoDouble(ACCOUNT_PROFIT), 5) + ",";
   body += "\"today_min_floating\":" + EAMon_Num(g_todayMinFloating, 5) + ",";
   body += "\"min_floating\":" + EAMon_Num(g_minFloating, 5) + ",";
   body += "\"margin\":" + EAMon_Num(AccountInfoDouble(ACCOUNT_MARGIN), 5) + ",";
   body += "\"free_margin\":" + EAMon_Num(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 5) + ",";
   body += "\"margin_level\":" + EAMon_Num(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   body += "\"last_error\":\"" + EAMon_JsonEsc(g_lastErr) + "\",";
   if(g_backfillDoneAck)
      body += "\"backfill_done\":true,";
   body += "\"positions\":" + EAMon_PositionsJson(false) + ",";
   body += "\"pending\":" + EAMon_PositionsJson(true) + ",";
   body += "\"eas\":" + eas;
   body += "}";

   string err, resp;
   int code = EAMon_PostEx(g_apiBase, "/api/v1/heartbeat", g_terminalId, g_apiSecret, body, err, resp);
   if(code < 200 || code >= 300)
   {
      g_lastErr = err;
      Print("EAMonitor heartbeat failed: ", err);
      if(g_uploadLogs)
         EAMon_SendLog("error", err);
   }
   else
   {
      g_lastErr = "";
      g_lastBeat = TimeGMT();
      bool firstSrv = EAMon_JsonHasTrue(resp, "\"first_on_server\":");
      bool forceBackfill = EAMon_JsonHasTrue(resp, "\"force_backfill\":");
      int cnt = EAMon_JsonIntAfter(resp, "\"trade_count\":", 0);
      long lastTradeTs = EAMon_JsonLongAfter(resp, "\"last_trade_ts\":", 0);
      long lastSeenBefore = EAMon_JsonLongAfter(resp, "\"last_seen_before\":", 0);
      long resumeTs = EAMon_JsonLongAfter(resp, "\"resume_from_ts\":", 0);
      string lastTicket = EAMon_JsonStrAfter(resp, "\"last_trade_ticket\":");
      if(cnt <= 0)
         resumeTs = 0;
      else if(resumeTs <= 0)
         resumeTs = (lastTradeTs > 0 ? lastTradeTs : 0);

      bool changed = (!g_serverStatusKnown || firstSrv != g_firstOnServer || cnt != g_serverTradeCount
         || resumeTs != g_resumeFromTs || lastTicket != g_serverLastTicket);
      g_firstOnServer = firstSrv;
      g_serverTradeCount = cnt;
      g_resumeFromTs = resumeTs;
      g_serverLastTicket = lastTicket;
      g_serverLastTicketNum = (StringLen(lastTicket) > 0 ? StringToInteger(lastTicket) : 0);
      g_serverStatusKnown = true;

      // 仅当服务器明确要求强制补传时才重置（无成交账户扫过一次后不再刷屏）
      if(forceBackfill)
      {
         if(g_histReady || g_lastDeal > 0)
            Print("EAMonitor: 服务器要求重新补传，重置历史扫描（本月+上月）");
         g_histReady = false;
         g_lastDeal = 0;
         g_backfillPending = true;
         g_backfillDoneAck = false;
         g_firstOnServer = true;
         g_resumeFromTs = 0;
         g_serverLastTicket = "";
         g_serverLastTicketNum = 0;
      }

      if(changed && !forceBackfill)
      {
         if(g_firstOnServer)
            Print("EAMonitor: 【服务器首次】实例ID=", g_terminalId,
                  " 尚无成交，将补传 ", TimeToString(g_backfillFrom, TIME_DATE), " 起（本月+上月）全部成交");
         else if(cnt > 0)
            Print("EAMonitor: 【断点续传】实例ID=", g_terminalId,
                  " 已存 ", g_serverTradeCount, " 条；服务器最后票据=", g_serverLastTicket,
                  " 时间=", IntegerToString(g_resumeFromTs),
                  "；将只补传此之后的成交");
         else if(g_backfillDoneAck)
            Print("EAMonitor: 服务器已确认无历史成交，停止强制补传（有新成交仍会上报）");
      }
   }
}

bool EAMon_UploadOneDeal(const ulong ticket, ulong &maxTicket, int &uploaded);
bool EAMon_DealJson(const ulong ticket, string &outJson);
bool EAMon_FlushTradeBatch(string &parts[], int &nParts, ulong &maxTicket, int &uploaded);

void EAMon_SendLog(const string level, const string message)
{
   string body = "{";
   body += "\"computer_id\":\"" + EAMon_JsonEsc(g_computerId) + "\",";
   body += "\"terminal_id\":\"" + EAMon_JsonEsc(g_terminalId) + "\",";
   body += "\"ea_name\":\"" + EAMon_JsonEsc(g_eaName) + "\",";
   body += "\"magic\":" + IntegerToString(g_magic) + ",";
   body += "\"level\":\"" + EAMon_JsonEsc(level) + "\",";
   body += "\"message\":\"" + EAMon_JsonEsc(message) + "\",";
   body += "\"ts\":" + IntegerToString((long)TimeGMT());
   body += "}";
   string err;
   EAMon_Post(g_apiBase, "/api/v1/logs", g_terminalId, g_apiSecret, body, err);
}

void EAMon_SendNewDeals()
{
   if(!g_serverStatusKnown)
   {
      EAMon_SendHeartbeat();
      if(!g_serverStatusKnown)
         return;
   }

   // 补传窗口：本月+上月（可配置月数）；断点续传时取「断点前1小时」与窗口的较晚者
   datetime winFrom = g_backfillFrom;
   if(winFrom <= 0)
      winFrom = EAMon_CalcBackfillFrom(g_backfillMonths);
   datetime from = winFrom;
   if(!g_firstOnServer && g_resumeFromTs > 0)
   {
      // resume_from_ts 是服务器存的 GMT；HistorySelect 要券商服务器时间
      datetime resumeFrom = EAMon_GmtToServer(g_resumeFromTs - 3600);
      if(resumeFrom > from)
         from = resumeFrom;
   }

   if(!HistorySelect(from, TimeCurrent()))
      return;
   int total = HistoryDealsTotal();
   if(!g_histReady)
   {
      g_lastDeal = (!g_firstOnServer && g_serverLastTicketNum > 0) ? (ulong)g_serverLastTicketNum : 0;
      // 账户历史为空：视为本窗口已扫完（新户/无成交），不再每轮刷屏重试
      if(g_firstOnServer && total <= 0)
      {
         if(!g_backfillDoneAck)
            Print("EAMonitor: 本月+上月账户历史为 0 笔，标记补传完成（以后有成交会照常上报）");
         g_histReady = true;
         g_backfillPending = false;
         g_backfillDoneAck = true;
         return;
      }
      g_histReady = true;
      g_backfillPending = true;
      if(g_firstOnServer)
         Print("EAMonitor: 首次建档，补传 ", TimeToString(from, TIME_DATE|TIME_MINUTES),
               " ~ 现在（本月+上月），历史扫描 ", total, " 条");
      else
         Print("EAMonitor: 断点续传，从票据>", g_serverLastTicket,
               " / ", TimeToString(from, TIME_DATE|TIME_MINUTES),
               " 起；历史扫描 ", total, " 条");
   }

   ulong maxTicket = g_lastDeal;
   int uploaded = 0;
   int skippedFilter = 0;
   string batch[];
   int batchN = 0;
   ArrayResize(batch, 0);

   // 从旧到新：按时间窗口把缺口补齐（不再按 600 条截断）
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0 || ticket <= g_lastDeal)
         continue;
      long dealTs = (long)HistoryDealGetInteger(ticket, DEAL_TIME);
      long dealGmt = EAMon_ToGmt((datetime)dealTs);
      if(dealTs < (long)winFrom)
      {
         if(ticket > maxTicket)
            maxTicket = ticket;
         continue;
      }
      if(!g_firstOnServer && g_resumeFromTs > 0 && dealGmt < g_resumeFromTs && ticket <= (ulong)g_serverLastTicketNum)
      {
         if(ticket > maxTicket)
            maxTicket = ticket;
         continue;
      }

      string one;
      if(!EAMon_DealJson(ticket, one))
      {
         skippedFilter++;
         // 首次补传时不要把「被过滤」的票据当成已处理上限，否则 Magic 设错会永久漏传
         if(!g_firstOnServer && ticket > maxTicket)
            maxTicket = ticket;
         continue;
      }
      ArrayResize(batch, batchN + 1);
      batch[batchN] = one;
      batchN++;
      if(ticket > maxTicket)
         maxTicket = ticket;

      // 每 30 笔打一包，加快首发/补传
      if(batchN >= 30)
      {
         if(!EAMon_FlushTradeBatch(batch, batchN, maxTicket, uploaded))
            break;
      }
   }
   if(batchN > 0)
      EAMon_FlushTradeBatch(batch, batchN, maxTicket, uploaded);

   if(uploaded > 0)
      Print("EAMonitor: 本次上传成交 ", uploaded, " 笔");
   else if(g_firstOnServer && skippedFilter > 0 && total > 0)
      Print("EAMonitor: 历史有 ", total, " 条，但过滤后可上报 0 笔（检查 InpReportAllMagic / InpMagic）。已跳过过滤 ",
            skippedFilter, " 条");
   if(g_backfillPending)
   {
      // 扫完本窗口即结束补传（含 0 笔上传的空账户），避免无限重置
      g_backfillPending = false;
      g_backfillDoneAck = true;
      if(uploaded > 0)
         Print("EAMonitor: 补传阶段结束（本月+上月已对齐），之后只上传新成交");
      else if(g_firstOnServer)
         Print("EAMonitor: 补传扫描结束，本窗口无可上报成交；已通知服务器停止强制补传");
      else
         Print("EAMonitor: 补传阶段结束（本月+上月已对齐），之后只上传新成交");
   }
   if(uploaded > 0 || !g_firstOnServer)
      g_lastDeal = maxTicket;
}

bool EAMon_DealJson(const ulong ticket, string &outJson)
{
   outJson = "";
   ENUM_DEAL_TYPE type = (ENUM_DEAL_TYPE)HistoryDealGetInteger(ticket, DEAL_TYPE);
   if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL)
      return false;
   long magic = (long)HistoryDealGetInteger(ticket, DEAL_MAGIC);
   // InpMagic=0 表示不限；或开启上报全部 Magic
   if(!g_reportAllMagic && g_magic != 0 && magic != g_magic)
      return false;
   string side = (type == DEAL_TYPE_BUY ? "buy" : "sell");
   long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
   string entryStr = "in";
   if(entry == DEAL_ENTRY_OUT)
      entryStr = "out";
   else if(entry == DEAL_ENTRY_INOUT)
      entryStr = "inout";
   outJson = "{";
   outJson += "\"computer_id\":\"" + EAMon_JsonEsc(g_computerId) + "\",";
   outJson += "\"terminal_id\":\"" + EAMon_JsonEsc(g_terminalId) + "\",";
   outJson += "\"account\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   outJson += "\"ea_name\":\"" + EAMon_JsonEsc(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\",";
   outJson += "\"ticket\":\"" + IntegerToString((long)ticket) + "\",";
   outJson += "\"magic\":" + IntegerToString(magic) + ",";
   outJson += "\"symbol\":\"" + EAMon_JsonEsc(HistoryDealGetString(ticket, DEAL_SYMBOL)) + "\",";
   outJson += "\"side\":\"" + side + "\",";
   outJson += "\"entry\":\"" + entryStr + "\",";
   outJson += "\"volume\":" + EAMon_Num(HistoryDealGetDouble(ticket, DEAL_VOLUME), 2) + ",";
   outJson += "\"price\":" + EAMon_Num(HistoryDealGetDouble(ticket, DEAL_PRICE), 5) + ",";
   outJson += "\"profit\":" + EAMon_Num(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + ",";
   outJson += "\"commission\":" + EAMon_Num(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) + ",";
   outJson += "\"swap\":" + EAMon_Num(HistoryDealGetDouble(ticket, DEAL_SWAP), 2) + ",";
   outJson += "\"comment\":\"" + EAMon_JsonEsc(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\",";
   outJson += "\"ts\":" + IntegerToString(EAMon_ToGmt((datetime)HistoryDealGetInteger(ticket, DEAL_TIME)));
   outJson += "}";
   return true;
}

bool EAMon_FlushTradeBatch(string &parts[], int &nParts, ulong &maxTicket, int &uploaded)
{
   if(nParts <= 0)
      return true;
   string body = "{\"trades\":[";
   for(int i = 0; i < nParts; i++)
   {
      if(i > 0)
         body += ",";
      body += parts[i];
   }
   body += "]}";
   string err;
   int code = EAMon_Post(g_apiBase, "/api/v1/trades", g_terminalId, g_apiSecret, body, err);
   if(code >= 200 && code < 300)
   {
      uploaded += nParts;
      nParts = 0;
      ArrayResize(parts, 0);
      return true;
   }
   g_lastErr = err;
   Print("EAMonitor trade batch upload failed: ", err);
   return false;
}

// 兼容：单笔上传（定时里新成交极少时也可走批量路径）
bool EAMon_UploadOneDeal(const ulong ticket, ulong &maxTicket, int &uploaded)
{
   string one;
   if(!EAMon_DealJson(ticket, one))
   {
      if(ticket > maxTicket)
         maxTicket = ticket;
      return true;
   }
   string batch[1];
   batch[0] = one;
   int n = 1;
   if(ticket > maxTicket)
      maxTicket = ticket;
   return EAMon_FlushTradeBatch(batch, n, maxTicket, uploaded);
}
