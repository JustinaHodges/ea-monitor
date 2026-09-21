#ifndef EAMONITOR_HTTP_MQH
#define EAMONITOR_HTTP_MQH

// 券商服务器时间 → 真正 GMT unix（成交日切按北京时间依赖此转换）
long EAMon_ServerGmtOffset()
{
   return (long)(TimeCurrent() - TimeGMT());
}

long EAMon_ToGmt(const datetime serverTime)
{
   return (long)serverTime - EAMon_ServerGmtOffset();
}

datetime EAMon_GmtToServer(const long gmtSec)
{
   if(gmtSec <= 0)
      return 0;
   return (datetime)(gmtSec + EAMon_ServerGmtOffset());
}

string EAMon_BytesToHex(const uchar &bytes[])
{
   string hex = "";
   int n = ArraySize(bytes);
   for(int i = 0; i < n; i++)
      hex += StringFormat("%02x", bytes[i]);
   return hex;
}

bool EAMon_ToUtf8(const string text, uchar &out[])
{
   int n = StringToCharArray(text, out, 0, WHOLE_ARRAY, CP_UTF8);
   if(n <= 0)
      return false;
   ArrayResize(out, n - 1);
   return true;
}

bool EAMon_Sha256(const uchar &data[], uchar &hash[])
{
   uchar dummy[];
   ArrayResize(dummy, 0);
   int got = CryptEncode(CRYPT_HASH_SHA256, data, dummy, hash);
   return (got >= 32);
}

bool EAMon_Sha256Hex(const string text, string &outHex)
{
   uchar data[];
   if(!EAMon_ToUtf8(text, data))
      return false;
   uchar hash[];
   if(!EAMon_Sha256(data, hash))
      return false;
   outHex = EAMon_BytesToHex(hash);
   return true;
}

bool EAMon_HmacSha256Hex(const string secret, const string message, string &outHex)
{
   uchar key[];
   uchar msg[];
   if(!EAMon_ToUtf8(secret, key))
      return false;
   if(!EAMon_ToUtf8(message, msg))
      return false;

   uchar keyblock[];
   ArrayResize(keyblock, 64);
   ArrayInitialize(keyblock, 0);

   int klen = ArraySize(key);
   if(klen > 64)
   {
      uchar hashed[];
      if(!EAMon_Sha256(key, hashed))
         return false;
      ArrayCopy(keyblock, hashed, 0, 0, 32);
   }
   else
      ArrayCopy(keyblock, key, 0, 0, klen);

   uchar ipad[];
   uchar opad[];
   ArrayResize(ipad, 64);
   ArrayResize(opad, 64);
   for(int i = 0; i < 64; i++)
   {
      ipad[i] = (uchar)(keyblock[i] ^ 0x36);
      opad[i] = (uchar)(keyblock[i] ^ 0x5c);
   }

   uchar innerSrc[];
   ArrayResize(innerSrc, 64 + ArraySize(msg));
   ArrayCopy(innerSrc, ipad, 0, 0, 64);
   ArrayCopy(innerSrc, msg, 64, 0, ArraySize(msg));

   uchar innerHash[];
   if(!EAMon_Sha256(innerSrc, innerHash))
      return false;

   uchar outerSrc[];
   ArrayResize(outerSrc, 64 + 32);
   ArrayCopy(outerSrc, opad, 0, 0, 64);
   ArrayCopy(outerSrc, innerHash, 64, 0, 32);

   uchar outerHash[];
   if(!EAMon_Sha256(outerSrc, outerHash))
      return false;

   outHex = EAMon_BytesToHex(outerHash);
   return true;
}

string EAMon_JsonEsc(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", "\\r");
   StringReplace(s, "\n", "\\n");
   StringReplace(s, "\t", "\\t");
   return s;
}

string EAMon_Num(const double v, const int digits)
{
   return DoubleToString(v, digits);
}

int EAMon_JsonIntAfter(const string json, const string key, const int defVal)
{
   return (int)EAMon_JsonLongAfter(json, key, defVal);
}

long EAMon_JsonLongAfter(const string json, const string key, const long defVal)
{
   int p = StringFind(json, key);
   if(p < 0)
      return defVal;
   int i = p + StringLen(key);
   while(i < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == ' ' || ch == '\t' || ch == ':' || ch == '"')
      {
         i++;
         continue;
      }
      break;
   }
   string num = "";
   while(i < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '-')
         num += ShortToString(ch);
      else
         break;
      i++;
   }
   if(StringLen(num) == 0)
      return defVal;
   return StringToInteger(num);
}

string EAMon_JsonStrAfter(const string json, const string key)
{
   int p = StringFind(json, key);
   if(p < 0)
      return "";
   int i = p + StringLen(key);
   while(i < StringLen(json) && (StringGetCharacter(json, i) == ' ' || StringGetCharacter(json, i) == '\t' || StringGetCharacter(json, i) == ':'))
      i++;
   if(i >= StringLen(json) || StringGetCharacter(json, i) != '"')
      return "";
   i++;
   string out = "";
   while(i < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '"')
         break;
      if(ch == '\\' && i + 1 < StringLen(json))
      {
         i++;
         out += ShortToString(StringGetCharacter(json, i));
      }
      else
         out += ShortToString(ch);
      i++;
   }
   return out;
}

bool EAMon_JsonHasTrue(const string json, const string key)
{
   return (StringFind(json, key + "true") >= 0);
}

int EAMon_Post(const string apiBase, const string path, const string terminalId, const string secret, const string body, string &err)
{
   string resp;
   return EAMon_PostEx(apiBase, path, terminalId, secret, body, err, resp);
}

int EAMon_PostEx(const string apiBase, const string path, const string terminalId, const string secret, const string body, string &err, string &respOut)
{
   err = "";
   respOut = "";
   string url = apiBase;
   if(StringLen(url) == 0)
   {
      err = "empty api";
      return -1;
   }
   if(StringGetCharacter(url, StringLen(url) - 1) == '/')
      url = StringSubstr(url, 0, StringLen(url) - 1);
   url += path;

   long ts = (long)TimeGMT();
   string bodyHash;
   if(!EAMon_Sha256Hex(body, bodyHash))
   {
      err = "sha256 failed";
      return -2;
   }
   string canonical = IntegerToString(ts) + "\nPOST\n" + path + "\n" + bodyHash;
   string sig;
   if(!EAMon_HmacSha256Hex(secret, canonical, sig))
   {
      err = "hmac failed";
      return -3;
   }

   string headers = "Content-Type: application/json; charset=utf-8\r\n";
   headers += "X-EA-Id: " + terminalId + "\r\n";
   headers += "X-EA-Timestamp: " + IntegerToString(ts) + "\r\n";
   headers += "X-EA-Signature: " + sig + "\r\n";

#ifdef __MQL5__
   uchar post[];
   if(!EAMon_ToUtf8(body, post))
   {
      err = "utf8 failed";
      return -4;
   }
   uchar result[];
   string resultHeaders;
   ResetLastError();
   int code = WebRequest("POST", url, headers, 8000, post, result, resultHeaders);
#else
   char post[];
   int n = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(n <= 0)
   {
      err = "utf8 failed";
      return -4;
   }
   ArrayResize(post, n - 1);
   char result[];
   string resultHeaders;
   ResetLastError();
   int code = WebRequest("POST", url, headers, 8000, post, result, resultHeaders);
#endif

   if(code == -1)
   {
      int e = GetLastError();
      err = "WebRequest error " + IntegerToString(e) + " (add URL in Tools -> Options -> Expert Advisors)";
      return e;
   }
#ifdef __MQL5__
   respOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
#else
   respOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
#endif
   if(code < 200 || code >= 300)
   {
      err = "HTTP " + IntegerToString(code) + " " + respOut;
      return code;
   }
   return code;
}

string EAMon_Timeframe(const int tf)
{
   switch(tf)
   {
      case PERIOD_M1: return "M1";
      case PERIOD_M5: return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_M30: return "M30";
      case PERIOD_H1: return "H1";
      case PERIOD_H4: return "H4";
      case PERIOD_D1: return "D1";
      case PERIOD_W1: return "W1";
      case PERIOD_MN1: return "MN1";
   }
   return IntegerToString(tf);
}

#endif
