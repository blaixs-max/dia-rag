"use client";

import { useEffect, useRef, useState } from "react";
import FormattedContent from "../components/FormattedContent";
import {
  BookIcon,
  CheckIcon,
  CloseIcon,
  ExternalIcon,
  ImageIcon,
  LifeBuoyIcon,
  PaperclipIcon,
  SendIcon,
  SparkIcon,
  SpinnerIcon,
  ThumbDownIcon,
  ThumbUpIcon,
} from "../components/icons";

type Source = { n: number; url: string; title: string; category: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  image?: string; // data URL (for display)
  sources?: Source[];
  conversationId?: string;
  feedback?: "up" | "down" | null;
};

const SUGGESTIONS = [
  "e-Fatura nasıl kesilir?",
  "Stok kartı nasıl oluşturulur?",
  "Cari hesap ekstresi nasıl alınır?",
  "Web servis API'sine nasıl bağlanılır?",
];

function useSessionId() {
  const [id, setId] = useState("");
  useEffect(() => {
    let s = localStorage.getItem("dia_session");
    if (!s) {
      s = crypto.randomUUID();
      localStorage.setItem("dia_session", s);
    }
    setId(s);
  }, []);
  return id;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [correctionFor, setCorrectionFor] = useState<number | null>(null);
  const [correctionText, setCorrectionText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sessionId = useSessionId();

  const scrollToBottom = () => {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    );
  };

  // Auto-grow the composer textarea.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 168) + "px";
  }, [input]);

  function fileToDataUrl(file: File) {
    const reader = new FileReader();
    reader.onload = () => setPendingImage(reader.result as string);
    reader.readAsDataURL(file);
  }

  function onPaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find((i) =>
      i.type.startsWith("image/")
    );
    if (item) {
      const file = item.getAsFile();
      if (file) fileToDataUrl(file);
    }
  }

  async function send(text: string) {
    const q = text.trim();
    if ((!q && !pendingImage) || loading) return;
    const img = pendingImage;
    setInput("");
    setPendingImage(null);

    const userMsg: Message = { role: "user", content: q, image: img || undefined };
    const next = [...messages, userMsg];
    setMessages([...next, { role: "assistant", content: "" }]);
    setLoading(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          image: img || undefined,
          sessionId,
        }),
      });

      let sources: Source[] = [];
      const hdr = res.headers.get("x-sources");
      if (hdr) {
        try {
          // atob yields a Latin-1 byte string; decode those bytes as UTF-8
          // so Turkish characters in source titles aren't mojibaked.
          const bytes = Uint8Array.from(atob(hdr), (c) => c.charCodeAt(0));
          sources = JSON.parse(new TextDecoder("utf-8").decode(bytes));
        } catch {
          /* ignore */
        }
      }
      const conversationId = res.headers.get("x-conversation-id") || undefined;

      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: "assistant",
            content: acc,
            sources,
            conversationId,
            feedback: null,
          };
          return copy;
        });
        scrollToBottom();
      }
    } catch (e) {
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content: `Bir hata oluştu: ${(e as Error).message}`,
        };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  async function sendFeedback(
    index: number,
    helpful: boolean,
    correction?: string
  ) {
    const msg = messages[index];
    if (!msg?.conversationId) return;
    setMessages((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], feedback: helpful ? "up" : "down" };
      return copy;
    });
    setCorrectionFor(null);
    setCorrectionText("");
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: msg.conversationId,
          helpful,
          correction,
        }),
      });
    } catch {
      /* best effort */
    }
  }

  const canSend = !loading && (!!input.trim() || !!pendingImage);

  return (
    <div className="app">
      <header className="top">
        <div className="logo" aria-hidden="true">
          <LifeBuoyIcon />
        </div>
        <div className="title">
          <h1>DİA Asistan</h1>
          <p>Ekran görüntüsü at, DİA hakkında adım adım yardım al</p>
        </div>
        <span className="header-badge">
          <span className="dot" />
          Dökümanlarla desteklenir
        </span>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <ImageIcon />
            </div>
            <h2>DİA&apos;da takıldığın ekranın görüntüsünü at</h2>
            <p>
              Ekran görüntüsünü yapıştır veya yükle, sorunu yaz. Yanıtlar DİA
              dökümanlarından gelir ve kaynak bağlantılarıyla birlikte sunulur —
              geri bildiriminle zamanla gelişir.
            </p>
            <div className="hint">
              <ImageIcon />
              <span>
                Görseli <kbd>Ctrl</kbd> + <kbd>V</kbd> ile yapıştır ya da 📎 ile
                yükle
              </span>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  <SparkIcon />
                  <span>{s}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const isTyping =
              m.role === "assistant" && !m.content && loading && isLast;
            const showBubble = !!m.content || isTyping;
            return (
              <div key={i} className={`msg ${m.role}`}>
                <div className="avatar" aria-hidden="true">
                  {m.role === "user" ? "S" : <LifeBuoyIcon />}
                </div>
                <div className="msg-body">
                  {m.image && (
                    <img className="shot" src={m.image} alt="Ekran görüntüsü" />
                  )}

                  {showBubble && (
                    <div className="bubble">
                      {isTyping ? (
                        <span className="typing" aria-label="Yazıyor">
                          <span />
                          <span />
                          <span />
                        </span>
                      ) : m.role === "assistant" ? (
                        <div className="prose">
                          <FormattedContent text={m.content} />
                        </div>
                      ) : (
                        m.content
                      )}
                    </div>
                  )}

                  {m.sources && m.sources.length > 0 && (
                    <div className="sources">
                      <span className="lbl">
                        <BookIcon />
                        Kaynaklar
                      </span>
                      <div className="src-list">
                        {m.sources.map((s) =>
                          s.url ? (
                            <a
                              key={s.n}
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <span className="src-n">[{s.n}]</span>
                              <span>{s.title || s.url}</span>
                              <ExternalIcon
                                style={{ width: 13, height: 13, opacity: 0.6 }}
                              />
                            </a>
                          ) : (
                            <span key={s.n} className="src-local">
                              <span className="src-n">[{s.n}]</span>
                              <span>
                                {s.title}
                                <span className="src-tag">
                                  {s.category === "learned"
                                    ? "(öğrenilmiş)"
                                    : "(dahili)"}
                                </span>
                              </span>
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {m.role === "assistant" &&
                    m.conversationId &&
                    m.content &&
                    !(loading && isLast) && (
                      <div className="feedback">
                        {m.feedback ? (
                          <span
                            className={`fb-thanks${
                              m.feedback === "down" ? " note" : ""
                            }`}
                          >
                            <CheckIcon />
                            {m.feedback === "up"
                              ? "Teşekkürler, öğrendim!"
                              : "Teşekkürler, not aldım."}
                          </span>
                        ) : (
                          <>
                            <span className="fb-q">İşine yaradı mı?</span>
                            <button
                              className="fb-btn up"
                              onClick={() => sendFeedback(i, true)}
                            >
                              <ThumbUpIcon />
                              Evet
                            </button>
                            <button
                              className="fb-btn down"
                              onClick={() => {
                                setCorrectionFor(i);
                                setCorrectionText("");
                              }}
                            >
                              <ThumbDownIcon />
                              Hayır
                            </button>
                          </>
                        )}
                      </div>
                    )}

                  {correctionFor === i && (
                    <div className="correction">
                      <textarea
                        value={correctionText}
                        onChange={(e) => setCorrectionText(e.target.value)}
                        placeholder="Doğrusu neydi? (opsiyonel) — yazarsan bunu öğrenirim"
                        rows={2}
                        autoFocus
                      />
                      <div className="correction-actions">
                        <button
                          className="btn-primary"
                          onClick={() => sendFeedback(i, false, correctionText)}
                        >
                          Gönder
                        </button>
                        <button
                          className="btn-ghost"
                          onClick={() => setCorrectionFor(null)}
                        >
                          Vazgeç
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {pendingImage && (
        <div className="pending">
          <img src={pendingImage} alt="Eklenecek ekran görüntüsü" />
          <div className="pending-info">
            <div className="pending-title">Ekran görüntüsü eklendi</div>
            <div className="pending-sub">Sorunla birlikte gönderilecek</div>
          </div>
          <button
            type="button"
            className="remove"
            onClick={() => setPendingImage(null)}
          >
            <CloseIcon />
            Kaldır
          </button>
        </div>
      )}

      <div className="composer-wrap">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) fileToDataUrl(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-btn"
            title="Ekran görüntüsü ekle"
            aria-label="Ekran görüntüsü ekle"
            onClick={() => fileRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Sorunu yaz veya ekran görüntüsü yapıştır (Ctrl+V)…"
            rows={1}
          />
          <button
            type="submit"
            className="send-btn"
            disabled={!canSend}
            aria-label="Gönder"
            title="Gönder"
          >
            {loading ? <SpinnerIcon className="spin" /> : <SendIcon />}
          </button>
        </form>
      </div>
    </div>
  );
}
