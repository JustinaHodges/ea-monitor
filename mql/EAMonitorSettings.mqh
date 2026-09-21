//+------------------------------------------------------------------+
//| 本机记住 EA 参数：重新挂图表 / 重启终端后自动回填                 |
//| 文件：Terminal Common\Files\EAMonitor_settings.ini               |
//+------------------------------------------------------------------+
#ifndef EA_MONITOR_SETTINGS_MQH
#define EA_MONITOR_SETTINGS_MQH

#define EAMON_SET_FILE "EAMonitor_settings.ini"

string g_apiBase;
string g_terminalId;
string g_apiSecret;
string g_computerId;
string g_computerName;
string g_eaName;
string g_eaVersion;
string g_strategyTag;
int    g_magic;
int    g_intervalSec;
bool   g_uploadTrades;
bool   g_uploadLogs;
bool   g_reportAllMagic;
bool   g_isFirstEver = true;   // 本机是否第一次成功跑过（有无记忆文件）
bool   g_firstOnServer = true; // 服务器上该实例ID是否还没有任何成交记录
int    g_serverTradeCount = -1;// 服务器已存成交条数（-1=尚未查询）
bool   g_serverStatusKnown = false;
int    g_backfillMonths = 2;   // 补传月数：2=本月+上月
datetime g_backfillFrom = 0;    // 补传起始时间（上月1号 00:00）
bool   g_backfillPending = true;
bool   g_backfillDoneAck = false; // 已完成本窗口扫描（含 0 成交），告知服务器停止 force_backfill
long   g_resumeFromTs = 0;     // 服务器断点时间（最后成交或上次在线）
string g_serverLastTicket = ""; // 服务器上最后一笔票据
long   g_serverLastTicketNum = 0;

// monthsBack=1 → 上月1号（覆盖本月+上月）
datetime EAMon_StartOfMonthBack(const int monthsBack)
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int y = dt.year;
   int m = dt.mon - monthsBack;
   while(m < 1)
   {
      m += 12;
      y--;
   }
   string s = StringFormat("%04d.%02d.01 00:00:00", y, m);
   return StringToTime(s);
}

datetime EAMon_CalcBackfillFrom(const int months)
{
   int n = MathMax(1, months);
   // n=2 → 从「当前月往前 1 个月」的月初开始
   return EAMon_StartOfMonthBack(n - 1);
}

bool EAMon_SettingsFileExists()
{
   int h = FileOpen(EAMON_SET_FILE, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(h == INVALID_HANDLE)
      return false;
   FileClose(h);
   return true;
}

string EAMon_Trim(string s)
{
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
}

string EAMon_ReadIniValue(const string raw, const string key)
{
   string prefix = key + "=";
   int p = StringFind(raw, prefix);
   if(p < 0)
      return "";
   int start = p + StringLen(prefix);
   int end = StringFind(raw, "\n", start);
   string val = (end < 0) ? StringSubstr(raw, start) : StringSubstr(raw, start, end - start);
   val = EAMon_Trim(val);
   StringReplace(val, "\r", "");
   return val;
}

bool EAMon_LoadSettingsFile()
{
   int h = FileOpen(EAMON_SET_FILE, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(h == INVALID_HANDLE)
      return false;
   string raw = "";
   while(!FileIsEnding(h))
      raw += FileReadString(h) + "\n";
   FileClose(h);
   if(StringLen(raw) < 8)
      return false;

   string v;
   v = EAMon_ReadIniValue(raw, "ApiBase");       if(StringLen(v) > 0) g_apiBase = v;
   v = EAMon_ReadIniValue(raw, "TerminalId");    if(StringLen(v) > 0) g_terminalId = v;
   v = EAMon_ReadIniValue(raw, "ApiSecret");     if(StringLen(v) > 0) g_apiSecret = v;
   v = EAMon_ReadIniValue(raw, "ComputerId");    if(StringLen(v) > 0) g_computerId = v;
   v = EAMon_ReadIniValue(raw, "ComputerName");  if(StringLen(v) > 0) g_computerName = v;
   v = EAMon_ReadIniValue(raw, "EaName");        if(StringLen(v) > 0) g_eaName = v;
   v = EAMon_ReadIniValue(raw, "EaVersion");     if(StringLen(v) > 0) g_eaVersion = v;
   v = EAMon_ReadIniValue(raw, "StrategyTag");   if(StringLen(v) > 0) g_strategyTag = v;
   v = EAMon_ReadIniValue(raw, "Magic");         if(StringLen(v) > 0) g_magic = (int)StringToInteger(v);
   v = EAMon_ReadIniValue(raw, "IntervalSec");   if(StringLen(v) > 0) g_intervalSec = (int)StringToInteger(v);
   v = EAMon_ReadIniValue(raw, "UploadTrades");  if(StringLen(v) > 0) g_uploadTrades = (v == "1" || v == "true" || v == "True");
   v = EAMon_ReadIniValue(raw, "UploadLogs");    if(StringLen(v) > 0) g_uploadLogs = (v == "1" || v == "true" || v == "True");
   v = EAMon_ReadIniValue(raw, "ReportAllMagic");if(StringLen(v) > 0) g_reportAllMagic = (v == "1" || v == "true" || v == "True");
   return (StringLen(g_terminalId) > 0 && StringLen(g_apiSecret) > 0);
}

bool EAMon_SaveSettingsFile()
{
   int h = FileOpen(EAMON_SET_FILE, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(h == INVALID_HANDLE)
   {
      Print("EAMonitor: 无法保存参数到本机文件，错误=", GetLastError());
      return false;
   }
   FileWriteString(h, "ApiBase=" + g_apiBase + "\n");
   FileWriteString(h, "TerminalId=" + g_terminalId + "\n");
   FileWriteString(h, "ApiSecret=" + g_apiSecret + "\n");
   FileWriteString(h, "ComputerId=" + g_computerId + "\n");
   FileWriteString(h, "ComputerName=" + g_computerName + "\n");
   FileWriteString(h, "EaName=" + g_eaName + "\n");
   FileWriteString(h, "EaVersion=" + g_eaVersion + "\n");
   FileWriteString(h, "StrategyTag=" + g_strategyTag + "\n");
   FileWriteString(h, "Magic=" + IntegerToString(g_magic) + "\n");
   FileWriteString(h, "IntervalSec=" + IntegerToString(g_intervalSec) + "\n");
   FileWriteString(h, "UploadTrades=" + (g_uploadTrades ? "1" : "0") + "\n");
   FileWriteString(h, "UploadLogs=" + (g_uploadLogs ? "1" : "0") + "\n");
   FileWriteString(h, "ReportAllMagic=" + (g_reportAllMagic ? "1" : "0") + "\n");
   FileClose(h);
   return true;
}

// 输入框有值优先；关键项为空则从本机记忆补全（不覆盖你已经填的）
void EAMon_ApplyInputs(
   const string apiBase, const string terminalId, const string apiSecret,
   const string computerId, const string computerName,
   const string eaName, const string eaVersion, const string strategyTag,
   const int magic, const int intervalSec,
   const bool uploadTrades, const bool uploadLogs, const bool reportAllMagic)
{
   g_apiBase = apiBase;
   g_terminalId = terminalId;
   g_apiSecret = apiSecret;
   g_computerId = computerId;
   g_computerName = computerName;
   g_eaName = eaName;
   g_eaVersion = eaVersion;
   g_strategyTag = strategyTag;
   g_magic = magic;
   g_intervalSec = intervalSec;
   g_uploadTrades = uploadTrades;
   g_uploadLogs = uploadLogs;
   g_reportAllMagic = reportAllMagic;

   // 先读出文件里的旧值到临时变量
   string fBase = "", fId = "", fSecret = "", fCid = "", fCname = "";
   string fEa = "", fVer = "", fTag = "";
   int fMagic = 0, fInterval = 30;
   bool fTrades = true, fLogs = true, fAll = true;
   bool hasFile = false;

   int h = FileOpen(EAMON_SET_FILE, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(h != INVALID_HANDLE)
   {
      string raw = "";
      while(!FileIsEnding(h))
         raw += FileReadString(h) + "\n";
      FileClose(h);
      if(StringLen(raw) >= 8)
      {
         hasFile = true;
         fBase = EAMon_ReadIniValue(raw, "ApiBase");
         fId = EAMon_ReadIniValue(raw, "TerminalId");
         fSecret = EAMon_ReadIniValue(raw, "ApiSecret");
         fCid = EAMon_ReadIniValue(raw, "ComputerId");
         fCname = EAMon_ReadIniValue(raw, "ComputerName");
         fEa = EAMon_ReadIniValue(raw, "EaName");
         fVer = EAMon_ReadIniValue(raw, "EaVersion");
         fTag = EAMon_ReadIniValue(raw, "StrategyTag");
         string v;
         v = EAMon_ReadIniValue(raw, "Magic");         if(StringLen(v) > 0) fMagic = (int)StringToInteger(v);
         v = EAMon_ReadIniValue(raw, "IntervalSec");   if(StringLen(v) > 0) fInterval = (int)StringToInteger(v);
         v = EAMon_ReadIniValue(raw, "UploadTrades");  if(StringLen(v) > 0) fTrades = (v == "1" || v == "true" || v == "True");
         v = EAMon_ReadIniValue(raw, "UploadLogs");    if(StringLen(v) > 0) fLogs = (v == "1" || v == "true" || v == "True");
         v = EAMon_ReadIniValue(raw, "ReportAllMagic");if(StringLen(v) > 0) fAll = (v == "1" || v == "true" || v == "True");
      }
   }

   if(!hasFile)
      return;

   // 字符串：输入为空才用记忆
   if(StringLen(EAMon_Trim(g_apiBase)) < 8 && StringLen(fBase) >= 8) g_apiBase = fBase;
   if(StringLen(EAMon_Trim(g_terminalId)) == 0 && StringLen(fId) > 0) g_terminalId = fId;
   if(StringLen(EAMon_Trim(g_apiSecret)) == 0 && StringLen(fSecret) > 0) g_apiSecret = fSecret;
   if(StringLen(EAMon_Trim(g_computerId)) == 0 && StringLen(fCid) > 0) g_computerId = fCid;
   if(StringLen(EAMon_Trim(g_computerName)) == 0 && StringLen(fCname) > 0) g_computerName = fCname;
   if(StringLen(EAMon_Trim(g_eaName)) == 0 && StringLen(fEa) > 0) g_eaName = fEa;
   if(StringLen(EAMon_Trim(g_eaVersion)) == 0 && StringLen(fVer) > 0) g_eaVersion = fVer;
   if(StringLen(EAMon_Trim(g_strategyTag)) == 0 && StringLen(fTag) > 0) g_strategyTag = fTag;

   // 若 ID/私钥是靠记忆补上的，顺带恢复其它常用项（避免每次默认 HOME-PC）
   const bool restoredAuth =
      (StringLen(EAMon_Trim(terminalId)) == 0 && StringLen(g_terminalId) > 0) ||
      (StringLen(EAMon_Trim(apiSecret)) == 0 && StringLen(g_apiSecret) > 0);
   if(restoredAuth)
   {
      if(StringLen(fCid) > 0) g_computerId = fCid;
      if(StringLen(fCname) > 0) g_computerName = fCname;
      if(StringLen(fEa) > 0) g_eaName = fEa;
      if(StringLen(fVer) > 0) g_eaVersion = fVer;
      if(StringLen(fTag) > 0) g_strategyTag = fTag;
      g_magic = fMagic;
      if(fInterval >= 5) g_intervalSec = fInterval;
      g_uploadTrades = fTrades;
      g_uploadLogs = fLogs;
      g_reportAllMagic = fAll;
      Print("EAMonitor: 已从本机记忆恢复参数（实例ID/私钥等）");
   }
}

#endif
