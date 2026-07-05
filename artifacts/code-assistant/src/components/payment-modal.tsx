import { useState, useRef, useCallback, useEffect } from "react";

interface MyPayment {
  id: number;
  status: string;
  declaredAmount: number;
  confirmedAmount: number | null;
  createdAt: string;
}

interface PaymentInfo {
  cardNumber: string;
  cardOwner: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPlanActivated: () => void;
}

export function PaymentModal({ open, onClose, onPlanActivated }: Props) {
  const [amount, setAmount]                 = useState("");
  const [file, setFile]                     = useState<File | null>(null);
  const [dragOver, setDragOver]             = useState(false);
  const [submitStatus, setSubmitStatus]     = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg]             = useState("");
  const [myPayments, setMyPayments]         = useState<MyPayment[]>([]);
  const [paymentInfo, setPaymentInfo]       = useState<PaymentInfo | null>(null);
  const fileInputRef                        = useRef<HTMLInputElement>(null);
  const pollRef                             = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch card info + user's payments when modal opens
  useEffect(() => {
    if (!open) return;
    setSubmitStatus("idle");
    setErrorMsg("");

    fetch("/api/payments/info")
      .then((r) => r.json())
      .then((d: PaymentInfo) => setPaymentInfo(d))
      .catch(() => {});

    void refreshPayments();

    // Poll for confirmation
    pollRef.current = setInterval(() => { void refreshPayments(); }, 8000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const refreshPayments = async () => {
    try {
      const r = await fetch("/api/payments/my");
      const d = await r.json() as MyPayment[];
      if (Array.isArray(d)) {
        setMyPayments(d);
        if (d.some((p) => p.status === "confirmed")) {
          onPlanActivated();
        }
      }
    } catch {}
  };

  const handleFile = useCallback((f: File) => {
    if (f.size > 5 * 1024 * 1024) { setErrorMsg("Fayl 5 MB dan oshmasligi kerak."); return; }
    setFile(f);
    setErrorMsg("");
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleSubmit = async () => {
    if (!amount.trim() || !file) { setErrorMsg("Summa va chek faylini kiriting."); return; }
    const amountNum = parseInt(amount.replace(/\D/g, ""), 10);
    if (isNaN(amountNum) || amountNum <= 0) { setErrorMsg("To'g'ri summa kiriting."); return; }

    setSubmitStatus("sending");
    setErrorMsg("");

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          declaredAmount: amountNum,
          receiptData: base64,
          receiptMimeType: file.type || "application/octet-stream",
          receiptFileName: file.name,
        }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Xato yuz berdi.");
      }

      setSubmitStatus("sent");
      setAmount("");
      setFile(null);
      void refreshPayments();
    } catch (err) {
      setSubmitStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Xato yuz berdi.");
    }
  };

  if (!open) return null;

  const pendingPayment = myPayments.find((p) => p.status === "pending");
  const confirmedPayment = myPayments.find((p) => p.status === "confirmed");

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#0d0d1a] border border-[#2a2a3a] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-[#1e1e2e] flex items-center justify-between sticky top-0 bg-[#0d0d1a] z-10">
          <div>
            <h2 className="text-base font-semibold text-[#c0caf5]">💎 Premium kirish</h2>
            <p className="text-[11px] text-[#565f89] mt-0.5">Barcha AI modellarini ochish uchun to'lov qiling</p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#1a1a2e] text-[#565f89] hover:text-[#a9b1d6] transition-colors text-sm"
          >✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">

          {/* Confirmed! */}
          {confirmedPayment && (
            <div className="bg-[#9ece6a]/10 border border-[#9ece6a]/30 rounded-xl p-4 text-center">
              <div className="text-3xl mb-2">🎉</div>
              <p className="text-sm font-semibold text-[#9ece6a]">Premium faollashtirildi!</p>
              <p className="text-xs text-[#565f89] mt-1">Endi barcha modellardan foydalana olasiz.</p>
              <button
                onClick={onClose}
                className="mt-3 px-4 py-2 rounded-xl text-xs font-medium text-[#0d0d1a] transition-colors"
                style={{ background: "#9ece6a" }}
              >
                Yaxshi, davom eting →
              </button>
            </div>
          )}

          {/* Card info */}
          {!confirmedPayment && (
            <div className="bg-gradient-to-br from-[#7aa2f7]/10 to-[#bb9af7]/10 border border-[#7aa2f7]/20 rounded-xl p-4">
              <p className="text-[10px] text-[#565f89] uppercase tracking-wider mb-2">Karta raqami (pul o'tkazing)</p>
              {paymentInfo?.cardNumber ? (
                <>
                  <button
                    onClick={() => navigator.clipboard.writeText(paymentInfo.cardNumber.replace(/\s/g, ""))}
                    className="text-lg font-mono font-bold text-[#c0caf5] tracking-[0.2em] select-all hover:text-[#7aa2f7] transition-colors text-left w-full"
                    title="Nusxa olish"
                  >
                    {paymentInfo.cardNumber}
                  </button>
                  <p className="text-xs text-[#a9b1d6] mt-1">{paymentInfo.cardOwner}</p>
                  <p className="text-[10px] text-[#565f89] mt-2">📋 Raqamni bosish orqali nusxa oling</p>
                </>
              ) : (
                <p className="text-sm text-[#565f89] italic">Karta raqami belgilanmagan (admin sozlaishi kerak)</p>
              )}
            </div>
          )}

          {/* Pending notice */}
          {pendingPayment && !confirmedPayment && submitStatus !== "sent" && (
            <div className="bg-[#e0af68]/10 border border-[#e0af68]/30 rounded-xl p-3 flex gap-3 items-start">
              <span className="text-xl mt-0.5">⏳</span>
              <div>
                <p className="text-xs font-medium text-[#e0af68]">To'lov tekshirilmoqda</p>
                <p className="text-[11px] text-[#565f89] mt-0.5">
                  Summa:{" "}
                  <span className="text-[#a9b1d6] font-mono">
                    {(pendingPayment.confirmedAmount ?? pendingPayment.declaredAmount).toLocaleString()} so'm
                  </span>
                </p>
                <p className="text-[11px] text-[#565f89]">Admin tasdiqlashini kuting (1–24 soat).</p>
              </div>
            </div>
          )}

          {/* Success state */}
          {submitStatus === "sent" && !confirmedPayment && (
            <div className="bg-[#9ece6a]/10 border border-[#9ece6a]/30 rounded-xl p-4 text-center">
              <div className="text-3xl mb-2">✅</div>
              <p className="text-sm font-medium text-[#9ece6a]">To'lov ma'lumoti yuborildi!</p>
              <p className="text-xs text-[#565f89] mt-1">Admin tasdiqlashini kuting. Bu sahifa yangilanishini kuzating.</p>
            </div>
          )}

          {/* Submission form */}
          {!confirmedPayment && submitStatus !== "sent" && (
            <>
              {/* Amount */}
              <div>
                <label className="text-[11px] text-[#565f89] mb-1.5 block uppercase tracking-wider">
                  To'langan summa (so'm)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="Masalan: 50000"
                  className="w-full bg-[#1a1a2e] border border-[#2a2a3a] focus:border-[#7aa2f7]/50 rounded-xl px-4 py-3 text-sm text-[#c0caf5] placeholder-[#3b3f5c] outline-none transition-colors font-mono"
                />
              </div>

              {/* File drop zone */}
              <div>
                <label className="text-[11px] text-[#565f89] mb-1.5 block uppercase tracking-wider">
                  Chek (rasm yoki PDF)
                </label>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => { if (!file) fileInputRef.current?.click(); }}
                  className={`border-2 border-dashed rounded-xl p-5 text-center transition-all ${
                    dragOver
                      ? "border-[#7aa2f7] bg-[#7aa2f7]/5 scale-[1.01] cursor-copy"
                      : file
                      ? "border-[#9ece6a]/50 bg-[#9ece6a]/5 cursor-default"
                      : "border-[#2a2a3a] hover:border-[#3a3a5a] hover:bg-[#1a1a2e]/50 cursor-pointer"
                  }`}
                >
                  {file ? (
                    <div className="flex items-center gap-3 justify-center">
                      <span className="text-2xl">{file.type.startsWith("image/") ? "🖼️" : "📄"}</span>
                      <div className="text-left min-w-0">
                        <p className="text-xs text-[#9ece6a] font-medium truncate max-w-[180px]">{file.name}</p>
                        <p className="text-[10px] text-[#565f89]">{(file.size / 1024).toFixed(0)} KB</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); setFile(null); }}
                        className="ml-auto text-[#565f89] hover:text-[#f7768e] text-sm px-1 flex-shrink-0"
                      >✕</button>
                    </div>
                  ) : (
                    <>
                      <div className="text-3xl mb-2">📤</div>
                      <p className="text-xs text-[#565f89]">Chek rasmini bu yerga tashlang yoki bosing</p>
                      <p className="text-[10px] text-[#3b3f5c] mt-1">JPG · PNG · PDF — max 5 MB</p>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    // Reset value so same file can be re-selected
                    e.target.value = "";
                  }}
                />
              </div>

              {errorMsg && <p className="text-xs text-[#f7768e]">{errorMsg}</p>}

              <button
                onClick={() => void handleSubmit()}
                disabled={submitStatus === "sending" || !amount || !file}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "#7aa2f7", color: "#0d0d1a" }}
              >
                {submitStatus === "sending" ? "Yuborilmoqda…" : "✅ To'lovni yuborish"}
              </button>
            </>
          )}

          {/* History */}
          {myPayments.length > 0 && (
            <div className="border-t border-[#1e1e2e] pt-4">
              <p className="text-[10px] text-[#3b3f5c] uppercase tracking-wider mb-2">To'lovlar tarixi</p>
              <div className="space-y-2">
                {myPayments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[#565f89] font-mono">
                      {(p.confirmedAmount ?? p.declaredAmount).toLocaleString()} so'm
                    </span>
                    <span
                      className={`text-[10px] font-medium ${
                        p.status === "confirmed"
                          ? "text-[#9ece6a]"
                          : p.status === "rejected"
                          ? "text-[#f7768e]"
                          : "text-[#e0af68]"
                      }`}
                    >
                      {p.status === "confirmed" ? "✅ Tasdiqlangan" : p.status === "rejected" ? "❌ Rad etilgan" : "⏳ Kutilmoqda"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
