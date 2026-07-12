/**
 * Screenshot analysis for the DİA help assistant.
 * Given the user's DİA screenshot(s) + their text, produce:
 *  - searchQuery: a Turkish query to retrieve relevant docs
 *  - screen: a short description of which DİA screen/module is shown
 */
import { generateText, type ImagePart } from "./generate";

export type ScreenAnalysis = { searchQuery: string; screen: string };

const SYSTEM = `Sen DİA ERP arayüzünü tanıyan bir görsel analiz asistanısın.
Sana bir DİA ekran görüntüsü ve kullanıcının sorusu verilir.
Görevin: ekranın hangi modül/pencere olduğunu ve kullanıcının ne yapmaya çalıştığını anlamak.
SADECE şu JSON formatında yanıt ver, başka hiçbir şey yazma:
{"screen": "kısa ekran/modül açıklaması", "searchQuery": "dökümanlarda aranacak Türkçe sorgu"}`;

export async function analyzeScreenshot(
  images: ImagePart[],
  userText: string
): Promise<ScreenAnalysis> {
  const prompt = userText?.trim()
    ? `Kullanıcının sorusu/mesajı: "${userText}"\n\nEkran görüntüsünü incele ve JSON üret.`
    : `Kullanıcı sadece ekran görüntüsü gönderdi, metin yazmadı. Ekranı incele, muhtemel yardım ihtiyacını tahmin et ve JSON üret.`;

  const raw = await generateText(
    SYSTEM,
    [{ role: "user", content: prompt, images }],
    400
  );

  // Lenient JSON parse (model may wrap in code fences or prose).
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      const searchQuery = String(obj.searchQuery || obj.query || "").trim();
      const screen = String(obj.screen || "").trim();
      if (searchQuery) return { searchQuery, screen };
    } catch {
      /* fall through */
    }
  }
  // Fallback: use the user's text (or a generic query) if parsing failed.
  return {
    searchQuery: userText?.trim() || "DİA genel kullanım yardım",
    screen: raw.slice(0, 200),
  };
}
