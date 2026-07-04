/**
 * TaxJournalPage — Journal fiscal VTC (Lot D)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sélecteur de mois + bouton de téléchargement PDF du journal.
 * Récupère les données via GET /api/tax/journal-data?month=YYYY-MM
 * puis génère un PDF client-side avec jspdf.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { Download, FileText, Calendar, Loader2 } from "lucide-react";
import { haptic } from "@/lib/haptics";

interface JournalRow {
  date: string;
  courses: number;
  ca_ht: number;
  km_pro: number;
  carburant: number;
  charges: number;
  net: number;
}

interface JournalData {
  month: string;
  rows: JournalRow[];
  totals: {
    courses: number;
    ca_ht: number;
    km_pro: number;
    carburant: number;
    charges: number;
    net: number;
  };
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m: string): string {
  const [y, mo] = m.split("-");
  const date = new Date(Number(y), Number(mo) - 1, 1);
  return date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

async function generatePdf(data: JournalData) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // ── En-tête
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Journal fiscal VTC", 105, 20, { align: "center" });

  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.text(monthLabel(data.month), 105, 28, { align: "center" });

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `Généré le ${new Date().toLocaleDateString("fr-FR")} · VTC Intelligence`,
    105,
    34,
    { align: "center" },
  );
  doc.setTextColor(0);

  // ── Ligne de séparation
  doc.setDrawColor(200);
  doc.line(15, 38, 195, 38);

  // ── Tableau
  const startY = 46;
  const cols = [
    { label: "Date", x: 15, w: 25 },
    { label: "Courses", x: 40, w: 20 },
    { label: "CA HT €", x: 60, w: 25 },
    { label: "Km pro", x: 85, w: 22 },
    { label: "Carbur.", x: 107, w: 25 },
    { label: "Charges", x: 132, w: 25 },
    { label: "Net €", x: 157, w: 28 },
  ];

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setFillColor(240, 240, 245);
  doc.rect(15, startY - 5, 180, 7, "F");
  cols.forEach((c) => doc.text(c.label, c.x + 1, startY));

  doc.setFont("helvetica", "normal");
  let y = startY + 7;

  data.rows.forEach((row, i) => {
    if (y > 265) {
      doc.addPage();
      y = 25;
    }
    if (i % 2 === 0) {
      doc.setFillColor(250, 250, 252);
      doc.rect(15, y - 4, 180, 6, "F");
    }
    doc.text(row.date, cols[0].x + 1, y);
    doc.text(String(row.courses), cols[1].x + 1, y);
    doc.text(row.ca_ht.toFixed(2), cols[2].x + 1, y);
    doc.text(row.km_pro.toFixed(0), cols[3].x + 1, y);
    doc.text(row.carburant.toFixed(2), cols[4].x + 1, y);
    doc.text(row.charges.toFixed(2), cols[5].x + 1, y);
    doc.text(row.net.toFixed(2), cols[6].x + 1, y);
    y += 6;
  });

  // ── Totaux
  y += 4;
  if (y > 260) {
    doc.addPage();
    y = 25;
  }
  doc.setDrawColor(120);
  doc.line(15, y - 2, 195, y - 2);
  doc.setFont("helvetica", "bold");
  doc.setFillColor(235, 240, 245);
  doc.rect(15, y - 2, 180, 7, "F");
  doc.text("TOTAUX", cols[0].x + 1, y + 3);
  doc.text(String(data.totals.courses), cols[1].x + 1, y + 3);
  doc.text(data.totals.ca_ht.toFixed(2), cols[2].x + 1, y + 3);
  doc.text(data.totals.km_pro.toFixed(0), cols[3].x + 1, y + 3);
  doc.text(data.totals.carburant.toFixed(2), cols[4].x + 1, y + 3);
  doc.text(data.totals.charges.toFixed(2), cols[5].x + 1, y + 3);
  doc.text(data.totals.net.toFixed(2), cols[6].x + 1, y + 3);

  // ── Pied de page
  y += 15;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(
    "Document indicatif — à conserver 10 ans (art. L102 B du LPF). Non contractuel.",
    105,
    285,
    { align: "center" },
  );

  const filename = `journal-fiscal-${data.month}.pdf`;
  doc.save(filename);
}

export default function TaxJournalPage() {
  const [month, setMonth] = useState<string>(currentMonth());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastData, setLastData] = useState<JournalData | null>(null);

  async function handleDownload() {
    setLoading(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/api/tax/journal-data?month=${month}`, {
        headers: token
          ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token }
          : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: JournalData = await res.json();
      setLastData(data);
      await generatePdf(data);
      haptic("success");
    } catch (e: any) {
      setError(e?.message || "Erreur lors de la génération du PDF");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full bg-background px-4 py-6 pb-24">
      <div className="max-w-md mx-auto space-y-6">
        {/* ── En-tête ─────────────────────────────────────────────────────── */}
        <header className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <FileText size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Journal fiscal</h1>
            <p className="text-xs text-muted-foreground">
              PDF prêt pour votre comptable
            </p>
          </div>
        </header>

        {/* ── Sélecteur de mois ───────────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Calendar size={16} className="text-muted-foreground" />
            <span>Mois à exporter</span>
          </label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-full min-h-[56px] px-4 rounded-lg border border-border bg-background text-base focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label="Sélection du mois"
            data-testid="input-month"
          />

          <button
            onClick={handleDownload}
            disabled={loading}
            className="w-full min-h-[56px] rounded-lg bg-primary text-primary-foreground font-medium text-base flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.98] transition-transform"
            data-testid="button-download-pdf"
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                <span>Génération…</span>
              </>
            ) : (
              <>
                <Download size={18} />
                <span>Télécharger le PDF</span>
              </>
            )}
          </button>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              {error}
            </div>
          )}
        </div>

        {/* ── Récap dernier téléchargement ─────────────────────────────── */}
        {lastData && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Récapitulatif — {monthLabel(lastData.month)}
            </h2>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">Courses</div>
                <div className="font-semibold">{lastData.totals.courses}</div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">CA HT</div>
                <div className="font-semibold">
                  {lastData.totals.ca_ht.toFixed(2)} €
                </div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">Km pro</div>
                <div className="font-semibold">
                  {lastData.totals.km_pro.toFixed(0)} km
                </div>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground">Net estimé</div>
                <div className="font-semibold text-primary">
                  {lastData.totals.net.toFixed(2)} €
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Note ─────────────────────────────────────────────────────── */}
        <p className="text-xs text-muted-foreground leading-relaxed px-1">
          Document indicatif basé sur vos courses enregistrées et vos paramètres
          économiques. À conserver 10 ans (art. L102 B du LPF).
        </p>
      </div>
    </div>
  );
}
