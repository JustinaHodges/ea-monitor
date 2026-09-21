#property copyright "四季常春监控公益版"
#property version   "1.00"
#property description "四季常春监控公益版上报模块：心跳/成交上报到 Cloudflare，不交易。"
#property strict

#include "EAMonitorHttp.mqh"
#include "EAMonitorSettings.mqh"

input string InpApiBase        = "https://520.16881488.xyz"; // 监控后台地址
input string InpTerminalId     = "";                                          // 实例ID（可留空=用本机上次记忆）
input string InpApiSecret      = "";                                          // 私钥（可留空=用本机上次记忆）
input string InpComputerId     = "HOME-PC";                                   // 电脑编号
input string InpComputerName   = "";                                          // 电脑名称（可留空）
input string InpEaName         = "EAMonitor";                                 // EA名称
input string InpEaVersion      = "1.0.0";                                     // EA版本
input string InpStrategyTag    = "monitor";                                   // 策略标签
input int    InpMagic          = 0;                                           // Magic（0=不限）
input int    InpIntervalSec    = 30;                                          // 心跳间隔（秒，最短5）
input int    InpBackfillMonths = 2;                                           // 补传月数（2=本月+上月）
input bool   InpUploadTrades   = true;                                        // 上传成交记录
input bool   InpUploadLogs     = true;                                        // 上传日志
input bool   InpReportAllMagic = true;                                        // 上报全部Magic持仓

datetime g_started = 0;
int      g_lastTicket = 0;
bool     g_histReady = false;
string   g_lastErr = "";
datetime g_lastBeat = 0;
datetime g_lastFloatSample = 0;
double   g_todayMinFloating = 0;
double   g_minFloating = 0;
int      g_floatDayKey = 0;

int EAMon_BeijingDayKey()
{
   datetime bj = TimeGMT() + 8 * 3600;
   int y = TimeYear(bj);
   int m = TimeMonth(bj);
   int d = TimeDay(bj);
   return y * 10000 + m * 100 + d;
}

void EAMon_SampleFloating()
{
   double fpl = AccountProfit();
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
   g_todayMinFloating = AccountProfit();
   g_minFloating = g_todayMinFloating;
   EventSetTimer(1);
   Print("EAMonitor: 请在MT4允许WebRequest网址 ", g_apiBase);
   if(g_isFirstEver)
      Print("EAMonitor: 【本机首次】尚无记忆文件，已保存实例ID=", g_terminalId);
   else
      Print("EAMonitor: 【本机非首次】已识别记忆，实例ID=", g_terminalId);
   Print("EAMonitor: 补传范围=近 ", g_backfillMonths, " 个自然月（从 ",
         TimeToStr(g_backfillFrom, TIME_DATE|TIME_MINUTES), " 起）；将向服务器确认断点");
   EAMon_SendHeartbeat();
   if(g_uploadTrades)
      EAMon_SendNewHistory();
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
      EAMon_SendNewHistory();
}

bool EAMon_MagicOk(const int magic)
{
   if(g_reportAllMagic || g_magic == 0)
      return true;
   return magic == g_magic;
}

void EAMon_PushMagic(int &magics[], string &names[], string &symbols[], int &posCnt[], int &pendCnt[], double &fpl[],
                     const int magic, const string name, const string symbol, const bool pending, const double profit)
{
   if(!EAMon_MagicOk(magic))
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

string EAMon_SplitOrders(const bool wantPending)
{
   string json = "[";
   bool first = true;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;
      int type = OrderType();
      bool pending = (type > OP_SELL);
      if(pending != wantPending)
         continue;
      if(!EAMon_MagicOk(OrderMagicNumber()))
         continue;
      if(!first)
         json += ",";
      first = false;
      string side = (type == OP_BUY || type == OP_BUYLIMIT || type == OP_BUYSTOP) ? "buy" : "sell";
      json += "{";
      json += "\"ticket\":\"" + IntegerToString(OrderTicket()) + "\",";
      json += "\"magic\":" + IntegerToString(OrderMagicNumber()) + ",";
      json += "\"symbol\":\"" + EAMon_JsonEsc(OrderSymbol()) + "\",";
      json += "\"kind\":\"" + (wantPending ? "pending" : "position") + "\",";
      json += "\"side\":\"" + side + "\",";
      json += "\"volume\":" + EAMon_Num(OrderLots(), 2) + ",";
      json += "\"price_open\":" + EAMon_Num(OrderOpenPrice(), 5) + ",";
      json += "\"price_current\":" + EAMon_Num(pending ? MarketInfo(OrderSymbol(), MODE_BID) : OrderClosePrice(), 5) + ",";
      json += "\"sl\":" + EAMon_Num(OrderStopLoss(), 5) + ",";
      json += "\"tp\":" + EAMon_Num(OrderTakeProfit(), 5) + ",";
      json += "\"profit\":" + EAMon_Num(pending ? 0 : (OrderProfit() + OrderSwap() + OrderCommission()), 2) + ",";
      json += "\"spread\":" + IntegerToString((int)MarketInfo(OrderSymbol(), MODE_SPREAD)) + ",";
      json += "\"comment\":\"" + EAMon_JsonEsc(OrderComment()) + "\",";
      json += "\"open_time\":" + IntegerToString((int)EAMon_ToGmt(OrderOpenTime()));
      json += "}";
   }
   json += "]";
   return json;
}

void EAMon_CollectMagics(int &magics[], string &names[], string &symbols[], int &posCnt[], int &pendCnt[], double &fpl[])
{
   ArrayResize(magics, 0);
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;
      bool pending = (OrderType() > OP_SELL);
      EAMon_PushMagic(magics, names, symbols, posCnt, pendCnt, fpl,
                      OrderMagicNumber(), OrderComment(), OrderSymbol(), pending,
                      pending ? 0 : (OrderProfit() + OrderSwap() + OrderCommission()));
   }
   if(ArraySize(magics) == 0)
      EAMon_PushMagic(magics, names, symbols, posCnt, pendCnt, fpl, g_magic, g_eaName, Symbol(), false, 0);
}

void EAMon_SendHeartbeat()
{
   EAMon_SampleFloating();
   int magics[];
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
      eas += "\"timeframe\":\"" + EAMon_Timeframe(Period()) + "\",";
      eas += "\"started_at\":" + IntegerToString((int)g_started) + ",";
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
   body += "\"platform\":\"MT4\",";
   body += "\"mt_build\":" + IntegerToString(TerminalInfoInteger(TERMINAL_BUILD)) + ",";
   body += "\"broker\":\"" + EAMon_JsonEsc(AccountCompany()) + "\",";
   body += "\"server\":\"" + EAMon_JsonEsc(AccountServer()) + "\",";
   body += "\"account\":\"" + IntegerToString(AccountNumber()) + "\",";
   body += "\"account_name\":\"" + EAMon_JsonEsc(AccountName()) + "\",";
   body += "\"currency\":\"" + EAMon_JsonEsc(AccountCurrency()) + "\",";
   body += "\"leverage\":" + IntegerToString(AccountLeverage()) + ",";
   body += "\"report_interval\":" + IntegerToString(g_intervalSec) + ",";
   body += "\"broker_gmt_offset\":" + IntegerToString(EAMon_ServerGmtOffset()) + ",";
   body += "\"balance\":" + EAMon_Num(AccountBalance(), 5) + ",";
   body += "\"equity\":" + EAMon_Num(AccountEquity(), 5) + ",";
   body += "\"floating_pl\":" + EAMon_Num(AccountProfit(), 5) + ",";
   body += "\"today_min_floating\":" + EAMon_Num(g_todayMinFloating, 5) + ",";
   body += "\"min_floating\":" + EAMon_Num(g_minFloating, 5) + ",";
   body += "\"margin\":" + EAMon_Num(AccountMargin(), 5) + ",";
   body += "\"free_margin\":" + EAMon_Num(AccountFreeMargin(), 5) + ",";
   body += "\"margin_level\":" + EAMon_Num(AccountMargin() > 0 ? (100.0 * AccountEquity() / AccountMargin()) : 0, 2) + ",";
   body += "\"last_error\":\"" + EAMon_JsonEsc(g_lastErr) + "\",";
   if(g_backfillDoneAck)
      body += "\"backfill_done\":true,";
   body += "\"positions\":" + EAMon_SplitOrders(false) + ",";
   body += "\"pending\":" + EAMon_SplitOrders(true) + ",";
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

      if(forceBackfill)
      {
         if(g_histReady || g_lastTicket > 0)
            Print("EAMonitor: 服务器要求重新补传，重置历史扫描（本月+上月）");
         g_histReady = false;
         g_lastTicket = 0;
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
                  " 尚无成交，将补传 ", TimeToStr(g_backfillFrom, TIME_DATE), " 起（本月+上月）全部成交");
         else if(cnt > 0)
            Print("EAMonitor: 【断点续传】实例ID=", g_terminalId,
                  " 已存 ", g_serverTradeCount, " 条；服务器最后票据=", g_serverLastTicket,
                  " 时间=", IntegerToString((int)g_resumeFromTs),
                  "；将只补传此之后的成交");
         else if(g_backfillDoneAck)
            Print("EAMonitor: 服务器已确认无历史成交，停止强制补传（有新成交仍会上报）");
      }
   }
}

void EAMon_SendLog(const string level, const string message)
{
   string body = "{";
   body += "\"computer_id\":\"" + EAMon_JsonEsc(g_computerId) + "\",";
   body += "\"terminal_id\":\"" + EAMon_JsonEsc(g_terminalId) + "\",";
   body += "\"ea_name\":\"" + EAMon_JsonEsc(g_eaName) + "\",";
   body += "\"magic\":" + IntegerToString(g_magic) + ",";
   body += "\"level\":\"" + EAMon_JsonEsc(level) + "\",";
   body += "\"message\":\"" + EAMon_JsonEsc(message) + "\",";
   body += "\"ts\":" + IntegerToString((int)TimeGMT());
   body += "}";
   string err;
   EAMon_Post(g_apiBase, "/api/v1/logs", g_terminalId, g_apiSecret, body, err);
}

void EAMon_SendNewHistory()
{
   if(!g_serverStatusKnown)
   {
      EAMon_SendHeartbeat();
      if(!g_serverStatusKnown)
         return;
   }

   datetime winFrom = g_backfillFrom;
   if(winFrom <= 0)
      winFrom = EAMon_CalcBackfillFrom(g_backfillMonths);

   int total = OrdersHistoryTotal();
   if(!g_histReady)
   {
      g_lastTicket = (!g_firstOnServer && g_serverLastTicketNum > 0) ? (int)g_serverLastTicketNum : 0;
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
         Print("EAMonitor: 首次建档，补传 ", TimeToStr(winFrom, TIME_DATE|TIME_MINUTES),
               " ~ 现在（本月+上月），历史 ", total, " 条");
      else
         Print("EAMonitor: 断点续传，服务器最后票据=", g_serverLastTicket,
               " ts=", IntegerToString((int)g_resumeFromTs),
               "；窗口从 ", TimeToStr(winFrom, TIME_DATE|TIME_MINUTES), " 起");
   }
   int maxTicket = g_lastTicket;
   int uploaded = 0;
   int skippedFilter = 0;
   string batch = "";
   int batchN = 0;

   for(int i = 0; i < total; i++)
   {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY))
         continue;
      int ticket = OrderTicket();
      if(ticket <= g_lastTicket)
         continue;
      int type = OrderType();
      if(type != OP_BUY && type != OP_SELL)
      {
         if(!g_firstOnServer && ticket > maxTicket)
            maxTicket = ticket;
         skippedFilter++;
         continue;
      }
      if(!EAMon_MagicOk(OrderMagicNumber()))
      {
         if(!g_firstOnServer && ticket > maxTicket)
            maxTicket = ticket;
         skippedFilter++;
         continue;
      }
      int closeTs = (int)OrderCloseTime();
      int closeGmt = (int)EAMon_ToGmt((datetime)closeTs);
      if(closeTs < (int)winFrom)
      {
         if(ticket > maxTicket)
            maxTicket = ticket;
         continue;
      }
      if(!g_firstOnServer && g_resumeFromTs > 0)
      {
         if(closeGmt < (int)g_resumeFromTs && ticket <= (int)g_serverLastTicketNum)
         {
            if(ticket > maxTicket)
               maxTicket = ticket;
            continue;
         }
      }
      string side = (type == OP_BUY ? "buy" : "sell");
      string one = "{";
      one += "\"computer_id\":\"" + EAMon_JsonEsc(g_computerId) + "\",";
      one += "\"terminal_id\":\"" + EAMon_JsonEsc(g_terminalId) + "\",";
      one += "\"account\":\"" + IntegerToString(AccountNumber()) + "\",";
      one += "\"ea_name\":\"" + EAMon_JsonEsc(OrderComment()) + "\",";
      one += "\"ticket\":\"" + IntegerToString(ticket) + "\",";
      one += "\"magic\":" + IntegerToString(OrderMagicNumber()) + ",";
      one += "\"symbol\":\"" + EAMon_JsonEsc(OrderSymbol()) + "\",";
      one += "\"side\":\"" + side + "\",";
      one += "\"entry\":\"out\",";
      one += "\"volume\":" + EAMon_Num(OrderLots(), 2) + ",";
      one += "\"price\":" + EAMon_Num(OrderClosePrice(), 5) + ",";
      one += "\"sl\":" + EAMon_Num(OrderStopLoss(), 5) + ",";
      one += "\"tp\":" + EAMon_Num(OrderTakeProfit(), 5) + ",";
      one += "\"profit\":" + EAMon_Num(OrderProfit(), 2) + ",";
      one += "\"commission\":" + EAMon_Num(OrderCommission(), 2) + ",";
      one += "\"swap\":" + EAMon_Num(OrderSwap(), 2) + ",";
      one += "\"comment\":\"" + EAMon_JsonEsc(OrderComment()) + "\",";
      one += "\"ts\":" + IntegerToString(closeGmt);
      one += "}";
      if(batchN > 0)
         batch += ",";
      batch += one;
      batchN++;
      if(ticket > maxTicket)
         maxTicket = ticket;
      if(batchN >= 30)
      {
         string body = "{\"trades\":[" + batch + "]}";
         string err;
         int code = EAMon_Post(g_apiBase, "/api/v1/trades", g_terminalId, g_apiSecret, body, err);
         if(code < 200 || code >= 300)
         {
            g_lastErr = err;
            Print("EAMonitor trade batch upload failed: ", err);
            break;
         }
         uploaded += batchN;
         batch = "";
         batchN = 0;
      }
   }
   if(batchN > 0)
   {
      string body = "{\"trades\":[" + batch + "]}";
      string err;
      int code = EAMon_Post(g_apiBase, "/api/v1/trades", g_terminalId, g_apiSecret, body, err);
      if(code >= 200 && code < 300)
         uploaded += batchN;
      else
      {
         g_lastErr = err;
         Print("EAMonitor trade batch upload failed: ", err);
      }
   }
   if(uploaded > 0)
      Print("EAMonitor: 本次上传成交 ", uploaded, " 笔");
   else if(g_firstOnServer && skippedFilter > 0 && total > 0)
      Print("EAMonitor: 历史有 ", total, " 条，过滤后可上报 0 笔（检查 InpReportAllMagic / InpMagic）");
   if(g_backfillPending)
   {
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
      g_lastTicket = maxTicket;
}
