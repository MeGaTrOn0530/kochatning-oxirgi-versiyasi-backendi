/*
 * Ko'chat Platforma — ESP32 Harorat Sensori (WiFi Manager bilan)
 * Sensor: DHT22 (harorat + namlik)
 *
 * Kerakli kutubxonalar (Arduino IDE > Library Manager):
 *   - "DHT sensor library" by Adafruit
 *   - "ArduinoJson" by Benoit Blanchon
 *   (WiFi, WebServer, Preferences — ESP32 uchun o'rnatilgan)
 *
 * PINLAR:
 *   DHT22 DATA → GPIO 4
 *   Tugma      → GPIO 0  (ko'pchilik ESP32 platasida BOOT tugmasi)
 *   LED        → GPIO 2  (ichki LED)
 *
 * ISHLASH TARTIBI:
 *   1. Birinchi ishga tushganda yoki WiFi 2 marta ulanmasa →
 *      ESP32 o'zi WiFi tarqatadi: "KoChatSensor_Setup" (parol: kochat123)
 *   2. Telefon/kompyuterdan shu WiFi ga ulab, brauzer ochib 192.168.4.1 ga kiring
 *   3. WiFi nomi va parolini yozing → "Saqlash" bosing → ESP32 qayta ishga tushadi
 *   4. Istalgan vaqt BOOT tugmasini 3 soniya bosib tursangiz — AP mode qayta ochiladi
 */

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ─── O'ZGARMAS SOZLAMALAR ────────────────────────────────────────────────────

const char* SERVER_URL = "https://tyutorkpi.sies.uz/kochat/api/sensors/reading";
const char* API_KEY    = "sk_0IQH2HOMHoHGwUO48aTLh60apDxBCr1BcPbOW5iZ";   // ← Admin paneldan API key

#define DHT_PIN           4
#define DHT_TYPE          DHT22
#define BTN_PIN           0    // BOOT tugmasi (GPIO 0)
#define LED_PIN           2    // Ichki LED
#define SEND_INTERVAL_MS  (5 * 60 * 1000)   // 5 daqiqa
#define WIFI_TIMEOUT_MS   12000              // 12 soniya ulash vaqti
#define MAX_ATTEMPTS      2                  // Shuncha marta urinib bo'lmasa AP mode

const char* AP_SSID     = "KoChatSensor_Setup";
const char* AP_PASSWORD = "kochat123";

// ─────────────────────────────────────────────────────────────────────────────

DHT dht(DHT_PIN, DHT_TYPE);
Preferences prefs;
WebServer server(80);

unsigned long lastSendTime    = 0;
unsigned long btnPressedAt    = 0;
bool          apModeActive    = false;

// ─── HTML SAHIFALAR ──────────────────────────────────────────────────────────

const char* HTML_CONFIG = R"rawhtml(
<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sensor WiFi Sozlamalari</title>
<style>
  body{font-family:sans-serif;background:#f0f4f8;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .box{background:#fff;border-radius:16px;padding:32px;max-width:360px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,.1)}
  h2{margin:0 0 8px;color:#1a3a2a;font-size:20px}
  p{color:#666;font-size:13px;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px}
  input{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box;margin-bottom:16px}
  input:focus{outline:none;border-color:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.15)}
  button{width:100%;padding:12px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
  button:hover{background:#15803d}
  .note{margin-top:16px;font-size:12px;color:#888;text-align:center}
</style>
</head>
<body>
<div class="box">
  <h2>&#127807; Ko'chat Sensor</h2>
  <p>WiFi tarmog'i nomini va parolini kiriting.</p>
  <form action="/save" method="POST">
    <label>WiFi nomi (SSID)</label>
    <input type="text" name="ssid" placeholder="Tarmoq nomi" required maxlength="63">
    <label>WiFi paroli</label>
    <input type="password" name="pass" placeholder="Parol" maxlength="63">
    <button type="submit">Saqlash va ulanish</button>
  </form>
  <p class="note">Saqlangandan so'ng qurilma qayta ishga tushadi.</p>
</div>
</body>
</html>
)rawhtml";

const char* HTML_SAVED = R"rawhtml(
<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saqlandi</title>
<style>
  body{font-family:sans-serif;background:#f0f4f8;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .box{background:#fff;border-radius:16px;padding:32px;max-width:360px;width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.1)}
  h2{color:#16a34a;margin:0 0 12px}
  p{color:#555;font-size:14px}
</style>
</head>
<body>
<div class="box">
  <h2>&#10003; Saqlandi!</h2>
  <p>Qurilma yangi WiFi ga ulanmoqda...<br>Biroz kuting.</p>
</div>
</body>
</html>
)rawhtml";

// ─── AP (HOTSPOT) MODE ────────────────────────────────────────────────────────

void startAPMode() {
  apModeActive = true;
  Serial.println("\n[AP] Hotspot ishga tushmoqda...");

  WiFi.disconnect(true);
  delay(200);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  Serial.printf("[AP] SSID: %s | Parol: %s\n", AP_SSID, AP_PASSWORD);
  Serial.printf("[AP] IP: %s\n", WiFi.softAPIP().toString().c_str());
  Serial.println("[AP] Brauzerda: 192.168.4.1");

  // Config sahifasi
  server.on("/", HTTP_GET, []() {
    server.send(200, "text/html; charset=utf-8", HTML_CONFIG);
  });

  // Captive portal — boshqa URL lar ham / ga yo'naltiriladi
  server.onNotFound([]() {
    server.sendHeader("Location", "http://192.168.4.1", true);
    server.send(302, "text/plain", "");
  });

  // Forma yuborilganda
  server.on("/save", HTTP_POST, []() {
    String newSsid = server.arg("ssid");
    String newPass = server.arg("pass");

    if (newSsid.length() == 0) {
      server.send(400, "text/plain", "SSID bo'sh bo'lmasligi kerak.");
      return;
    }

    // Flash ga saqlash
    prefs.begin("wifi", false);
    prefs.putString("ssid", newSsid);
    prefs.putString("pass", newPass);
    prefs.end();

    Serial.printf("[AP] Yangi WiFi saqlandi: %s\n", newSsid.c_str());
    server.send(200, "text/html; charset=utf-8", HTML_SAVED);

    delay(2000);
    ESP.restart();
  });

  server.begin();

  // AP modeda LED tez-tez milt etadi
  Serial.println("[AP] Ulanish kutilmoqda...");
  while (apModeActive) {
    server.handleClient();
    // LED: ikki marta tez milt — AP mode signali
    for (int i = 0; i < 2; i++) {
      digitalWrite(LED_PIN, HIGH); delay(80);
      digitalWrite(LED_PIN, LOW);  delay(80);
    }
    delay(1200);

    // Tugma bosilsa AP ni o'chirish (ixtiyoriy)
    if (digitalRead(BTN_PIN) == LOW) {
      delay(50);
      if (digitalRead(BTN_PIN) == LOW) {
        Serial.println("[AP] Tugma bosildi, qayta urinmoqda...");
        delay(1000);
        ESP.restart();
      }
    }
  }
}

// ─── WIFI GA ULANISH ──────────────────────────────────────────────────────────

bool connectWiFi() {
  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();

  if (ssid.length() == 0) {
    Serial.println("[WiFi] Saqlangan WiFi yo'q.");
    return false;
  }

  Serial.printf("[WiFi] %s ga ulanmoqda", ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_TIMEOUT_MS) {
      Serial.println("\n[WiFi] Timeout — ulanmadi.");
      return false;
    }
    delay(300);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));  // Ulanish jarayonida milt
  }

  Serial.printf("\n[WiFi] Ulandi! IP: %s\n", WiFi.localIP().toString().c_str());
  blinkLed(3, 100);
  return true;
}

// ─── SETUP ───────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(LED_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  digitalWrite(LED_PIN, LOW);

  dht.begin();
  Serial.println("\n=== Ko'chat Platforma Sensor ===");

  // Urinishlar
  int attempts = 0;
  bool connected = false;

  while (attempts < MAX_ATTEMPTS && !connected) {
    attempts++;
    Serial.printf("[WiFi] Urinish %d/%d...\n", attempts, MAX_ATTEMPTS);
    connected = connectWiFi();

    if (!connected && attempts < MAX_ATTEMPTS) {
      Serial.println("[WiFi] 5 soniya kutmoqda...");
      // Signal: ulanmadi
      blinkLed(4, 120);
      delay(4000);
    }
  }

  if (!connected) {
    Serial.println("[WiFi] Ulanib bo'lmadi — AP mode ochilmoqda.");
    blinkLed(6, 80);  // Ulanmadi signali
    startAPMode();    // Bu loop ichida qoladi
  }
}

// ─── LOOP ─────────────────────────────────────────────────────────────────────

void loop() {
  // BOOT tugmasi 3 soniya bosilsa — AP mode ochiladi
  if (digitalRead(BTN_PIN) == LOW) {
    if (btnPressedAt == 0) btnPressedAt = millis();
    if (millis() - btnPressedAt > 3000) {
      Serial.println("[BTN] 3 soniya bosildi — AP mode ochilmoqda.");
      blinkLed(5, 80);
      startAPMode();
    }
  } else {
    btnPressedAt = 0;
  }

  // WiFi uzilgan bo'lsa qayta ulash
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Uzildi, qayta ulanmoqda...");
    if (!connectWiFi()) {
      blinkLed(4, 120);
    }
    return;
  }

  // Har 5 daqiqada harorat yuborish
  unsigned long now = millis();
  if (lastSendTime == 0 || (now - lastSendTime) >= SEND_INTERVAL_MS) {
    readAndSend();
    lastSendTime = now;
  }

  delay(200);
}

// ─── SENSORDAN O'QISH VA YUBORISH ────────────────────────────────────────────

void readAndSend() {
  float humidity    = dht.readHumidity();
  float temperature = dht.readTemperature();

  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("[Sensor] O'qishda xatolik!");
    blinkLed(5, 60);
    return;
  }

  Serial.printf("[Sensor] Harorat: %.1f°C | Namlik: %.1f%%\n", temperature, humidity);

  StaticJsonDocument<128> doc;
  doc["apiKey"]      = API_KEY;
  doc["temperature"] = round(temperature * 10) / 10.0;
  doc["humidity"]    = round(humidity * 10) / 10.0;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  int code = http.POST(body);

  if (code == 200 || code == 201) {
    Serial.printf("[HTTP] OK (%d)\n", code);
    blinkLed(1, 400);
  } else if (code > 0) {
    Serial.printf("[HTTP] Server xatosi: %d\n", code);
    blinkLed(3, 150);
  } else {
    Serial.printf("[HTTP] Ulanish xatosi: %s\n", http.errorToString(code).c_str());
    blinkLed(4, 100);
  }

  http.end();
}

// ─── LED YORDAMCHI ───────────────────────────────────────────────────────────

void blinkLed(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(ms);
    digitalWrite(LED_PIN, LOW);  delay(ms);
  }
}
